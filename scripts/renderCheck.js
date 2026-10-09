/**
 * 真实渲染检查：用「真实布局引擎 + 真实消息流」跑一遍 dist/webview.js，
 * 断言最终 DOM 里确实有方框、连线、文字、符号角标，且坐标落在可视范围内。
 *
 * 为什么需要这个文件：字符串级断言骗过我们好几轮——
 * 「HTML 里有 script 标签」通过了但脚本被 CSP 拒；「URI 生成了」通过了但被
 * localResourceRoots 拦掉。只有真正构造 DOM 并检查渲染结果，才暴露了那些问题。
 *
 * 时序说明（曾经踩坑，务必保留）：webview 收到 sessionUpdate 会**同步**重绘，
 * 并替换掉节点容器的子元素。所以针对某个会话的断言，必须在注入下一个会话之前完成。
 * 本文件据此分两段：
 *   ① 初始会话（s-callers）→ 静态结构 + 符号角标 + 加减号几何
 *   ② 延迟回调里 → 注入宽会话（s-center）→ 居中滚动量 + 滚轮不缩放
 *
 * 运行：node scripts/renderCheck.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

const log = (message) => console.log(message);

// ------------------------------------------------------------ 桩 DOM

function createElement(tagName) {
  return {
    tagName,
    attributes: new Map(),
    children: [],
    listeners: new Map(),
    style: {},
    _textContent: '',
    parentNode: undefined,
    clientWidth: 0,
    clientHeight: 0,
    classList: {
      _set: new Set(),
      add(name) {
        this._set.add(name);
      },
      remove(name) {
        this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
      toggle(name, force) {
        const has = this._set.has(name);
        const should = force === undefined ? !has : Boolean(force);
        if (should) {
          this._set.add(name);
        } else {
          this._set.delete(name);
        }
      },
    },
    // 真实 DOM：设置 textContent 会清空子节点，这里必须一致，否则统计失真
    get textContent() {
      return this._textContent;
    },
    set textContent(value) {
      this._textContent = String(value);
      this.children = [];
    },
    get className() {
      return String(this.getAttribute('class') ?? '');
    },
    // classList.add/remove 会写 className，所以要提供 setter
    set className(value) {
      this.setAttribute('class', String(value));
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    /** 量宽会把探测节点临时挂到 <svg> 上再摘掉，所以必须有 remove()。 */
    remove() {
      const parent = this.parentNode;
      if (!parent) {
        return;
      }
      const index = parent.children.indexOf(this);
      if (index >= 0) {
        parent.children.splice(index, 1);
      }
      this.parentNode = undefined;
    },
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, []);
      }
      this.listeners.get(type).push(handler);
    },
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
    },
    /**
     * 模拟排版后的字形包围盒。
     *
     * 宽度必须**随文字内容变化**：方框宽度自适应就是靠 getBBox().width 量的，
     * 若这里永远返回固定值，就测不出「方框贴内容、加减号不压文字」。
     * 按「字符数 × 字号 × 系数」估算，粗体略宽。
     */
    getBBox() {
      if (this.tagName !== 'text') {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      const size = Number.parseFloat(this.getAttribute('font-size') ?? '') || 12;
      const bold = String(this.getAttribute('font-weight') ?? '') === '600';
      const text = String(this.textContent ?? '');
      const width = text.length * size * (bold ? 0.66 : 0.6);
      const height = size * 0.66;
      const dy = Number.parseFloat(this.getAttribute('dy') ?? '0') || 0;
      const baseY = Number(this.getAttribute('y') ?? 0);
      return { x: 0, y: baseY + dy - size * 0.72, width, height };
    },
    getCTM() {
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    },
    querySelectorAll(selector) {
      if (selector !== '.expander .sign') {
        return [];
      }
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.tagName === 'text' && child.className.includes('sign')) {
            out.push(child);
          }
          walk(child);
        }
      };
      walk(this);
      return out;
    },
    querySelector() {
      return null;
    },
    dispatch(type, event = {}) {
      for (const handler of this.listeners.get(type) ?? []) {
        handler({
          type,
          target: this,
          currentTarget: this,
          preventDefault() {},
          stopPropagation() {},
          ...event,
        });
      }
    },
    /** 递归统计某标签名出现次数（含自身）。 */
    count(tagName) {
      let total = this.tagName === tagName ? 1 : 0;
      for (const child of this.children) {
        total += child.count(tagName);
      }
      return total;
    },
    /** 递归展开所有后代（含自身）。 */
    flatten(result = []) {
      result.push(this);
      for (const child of this.children) {
        child.flatten(result);
      }
      return result;
    },
  };
}

const byId = new Map();
for (const id of [
  'tabs',
  'toolbar',
  'box-menu',
  'summary',
  'empty',
  'canvas',
  'svg',
  'viewport',
  'edges',
  'nodes',
]) {
  byId.set(id, createElement(id === 'svg' ? 'svg' : 'div'));
}

// 右键菜单里要有两个菜单项（复制元素 / 复制地址），与真实模板一致
const boxMenuEl = byId.get('box-menu');
for (const [action, label] of [
  ['copyElement', '复制元素'],
  ['copyLocation', '复制地址'],
]) {
  const item = createElement('button');
  item.setAttribute('data-action', action);
  const text = createElement('span');
  text.textContent = label;
  item.appendChild(text);
  boxMenuEl.appendChild(item);
}
boxMenuEl.hidden = true;
// webview 用 boxMenuEl.contains(target) 判断点击是否落在菜单内
boxMenuEl.contains = (target) => {
  let node = target;
  while (node) {
    if (node === boxMenuEl) {
      return true;
    }
    node = node.parentNode;
  }
  return false;
};

// ------------------------------------------------------------ 工具栏（真实 HTML）

// 工具栏按钮来自真实模板：直接解析 graph.html，确保按钮与内联 SVG 都真的存在。
// 这些按钮在 webview 里是用 getElementById 注册点击事件的，
// 少一个就会出现「点了没反应」，所以必须在 HTML 层面断言。
const htmlSource = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'graph.html'), 'utf8');
const toolbarHtml = /<div id="toolbar"[\s\S]*?<\/div>/.exec(htmlSource);
assert(toolbarHtml !== null, 'graph.html 里没有 #toolbar（标签下面那一小栏）');
const toolbarButtons = [...toolbarHtml[0].matchAll(/<button id="([^"]+)"/g)].map((m) => m[1]);
const expectedButtons = [
  'btn-close-all',
  'btn-expand-all',
  'btn-collapse-all',
  'btn-copy-tab',
  'btn-settings',
];
for (const id of expectedButtons) {
  assert(
    toolbarButtons.includes(id),
    `工具栏缺少按钮 ${id}（实际有：${toolbarButtons.join(', ')}）`
  );
}
const toolbarSvgCount = (toolbarHtml[0].match(/<svg/g) ?? []).length;
assert(
  toolbarSvgCount === expectedButtons.length,
  `工具栏应有 ${expectedButtons.length} 个内联 SVG 图标，实际 ${toolbarSvgCount} 个`
);
// 内联 SVG 必须真的带路径（否则按钮是空白方块）
const toolbarPaths = [...toolbarHtml[0].matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
assert(
  toolbarPaths.length === expectedButtons.length,
  `工具栏应有 ${expectedButtons.length} 条图标路径，实际 ${toolbarPaths.length} 条`
);
for (const d of toolbarPaths) {
  assert(d.length > 100, `工具栏图标路径太短，可能是空占位：${d.slice(0, 40)}`);
}
// 不应再用 codicon 图标字体（webview 里不保证可用）
assert(
  !toolbarHtml[0].includes('codicon'),
  '工具栏不应依赖 codicon 图标字体（webview 里不保证可用），应改用内联 SVG'
);
console.log(
  `诊断: 工具栏 ${toolbarButtons.length} 个按钮、${toolbarPaths.length} 条内联 SVG 路径`
);

// ------------------------------------------------ 工具栏按钮的点击行为

const toolbarEl = byId.get('toolbar');
for (const id of expectedButtons) {
  // 真实结构是 button > svg > path；这里给每个按钮建一个元素并接到 toolbar 上，
  // 同时登记进 byId —— webview 是用 getElementById 找按钮注册事件的。
  const button = createElement('button');
  button.setAttribute('id', id);
  button.appendChild(createElement('svg'));
  toolbarEl.appendChild(button);
  byId.set(id, button);
}

// 真实 HTML 结构是 svg > viewport > (edges, nodes)
const svg = byId.get('svg');
const nodesEl = byId.get('nodes');
const edgesEl = byId.get('edges');
const canvasEl = byId.get('canvas');
const viewportEl = byId.get('viewport');
svg.appendChild(viewportEl);
viewportEl.appendChild(edgesEl);
viewportEl.appendChild(nodesEl);

const windowListeners = {};
const posted = [];

global.document = {
  getElementById: (id) => byId.get(id) ?? null,
  createElement: (tag) => createElement(tag),
  createElementNS: (_ns, tag) => createElement(tag),
  addEventListener() {},
};
global.window = {
  addEventListener(type, handler) {
    (windowListeners[type] = windowListeners[type] || []).push(handler);
  },
  // 右键菜单要靠视口尺寸做边界收边，缺了这两个会算出 NaN 坐标
  innerWidth: 1000,
  innerHeight: 700,
};
global.acquireVsCodeApi = () => ({
  postMessage: (message) => posted.push(message),
  getState: () => undefined,
  setState: () => {},
});
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
global.SVGElement = createElement('svg');

/** 异步的 requestAnimationFrame：回调排队，等下一个宏任务统一执行。 */
const frameQueue = [];
global.requestAnimationFrame = (callback) => {
  frameQueue.push(callback);
  return frameQueue.length;
};
global.cancelAnimationFrame = () => {};

function flushFrames() {
  const pending = frameQueue.splice(0, frameQueue.length);
  for (const callback of pending) {
    callback(0);
  }
}

// extension.js 需要 require('vscode')，注入最小桩
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') {
    return global.__vscodeStub;
  }
  return originalLoad(request, parent, isMain);
};
global.__vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: {},
  commands: { executeCommand: () => Promise.resolve(), registerCommand: () => ({ dispose() {} }) },
  extensions: { getExtension: () => undefined },
  Uri: {
    file: (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` }),
    parse: (value) => ({ toString: () => value }),
  },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Window: 10, Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Active: -1 },
  SymbolKind: { Function: 11, Method: 5, Constructor: 8, Key: 19 },
  ThemeIcon: class {},
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  MarkdownString: class {
    appendCodeblock() {}
    appendMarkdown() {}
  },
  Range: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Selection: class {},
  Location: class {
    constructor(uri, range) {
      this.uri = uri;
      this.range = range;
    }
  },
};

// 用真实布局引擎生成夹具（不手写坐标，否则测的是夹具不是布局）
const extensionBundle = require(path.join(ROOT, 'dist', 'extension.js'));
const { createLayout, NODE_HEIGHT } = extensionBundle.__layout;
const layoutBoxes = createLayout(
  {
    root: {
      id: 'root',
      name: 'bsp_boot',
      file: 'bsp_boot.h',
      line: 23,
      direction: 'callers',
      depth: 0,
      isCycle: false,
      children: ['child'],
      loaded: true,
      kind: 'function',
    },
    child: {
      id: 'child',
      name: 'app_main',
      file: 'main.c',
      line: 5,
      direction: 'callers',
      depth: 1,
      isCycle: false,
      children: [],
      parent: 'root',
      loaded: true,
      kind: 'function',
    },
  },
  'root'
).boxes;
log(
  `诊断: 真实布局 = root.x=${layoutBoxes.root.x} child.x=${layoutBoxes.child.x} ` +
    `宽=${layoutBoxes.root.width} 高=${layoutBoxes.root.height}`
);

// 加载真实产物
// eslint-disable-next-line no-new-func
new Function(fs.readFileSync(path.join(ROOT, 'dist', 'webview.js'), 'utf8'))();

function sendToWebview(message) {
  for (const handler of windowListeners.message ?? []) {
    handler({ data: message });
  }
}

// ------------------------------------------------------------ 夹具

function makeSession(direction) {
  return {
    id: `s-${direction}`,
    title: 'bsp_boot',
    description: 'bsp_boot.h:23',
    direction,
    engineLabel: 'clangd 22.1.6',
    rootId: 'root',
    nodes: {
      root: {
        id: 'root',
        name: 'bsp_boot',
        detail: 'void bsp_boot(void)',
        file: 'components/BSP/boot/bsp_boot.h',
        line: 23,
        direction,
        depth: 0,
        isCycle: false,
        children: ['child'],
        loaded: true,
        canExpand: false,
        kind: 'function',
      },
      child: {
        id: 'child',
        name: 'app_main',
        file: 'main/main.c',
        line: 5,
        callSite: { file: 'main/main.c', line: 8, text: 'bsp_boot();' },
        direction,
        depth: 1,
        isCycle: false,
        children: [],
        parent: 'root',
        loaded: true,
        // 设成可展开，这样它会渲染「加号」而不是叶子的圆点——
        // 加号的横竖两条矩形正是最需要检查居中的形状
        canExpand: true,
        kind: 'enum',
      },
    },
    edges: [
      {
        id: 'root->child',
        from: direction === 'callers' ? 'child' : 'root',
        to: direction === 'callers' ? 'root' : 'child',
        depth: 1,
      },
    ],
    boxes: layoutBoxes,
    collapsedCount: 0,
  };
}

// ------------------------------------------------------------ ① 初始会话

sendToWebview({
  type: 'init',
  sessions: [makeSession('callers')],
  summaries: [],
  activeId: 's-callers',
});

assert(
  posted.some((message) => message.type === 'ready'),
  'webview 没有发出 ready：脚本可能没跑起来（资源被拦或 CSP 拒绝）'
);
log(`诊断: webview 主动发出的消息 = ${posted.map((message) => message.type).join(',')}`);
for (const message of posted) {
  if (message.type === 'error') {
    log(`诊断: webview 内部错误 = ${message.message ?? JSON.stringify(message)}`);
  }
}

const all = svg.flatten();
const rects = all.filter((element) => element.tagName === 'rect');
const paths = all.filter((element) => element.tagName === 'path');
const texts = all.filter((element) => element.tagName === 'text');
const viewBox = String(svg.getAttribute('viewBox'));
// 只有 class 含 box 的 rect 才是节点方框（图标里的 rect 不算）
const boxRects = rects.filter((element) => element.className.split(/\s+/).includes('box'));
const boxWidth = Number(boxRects[0]?.getAttribute('width'));
const boxHeight = Number(boxRects[0]?.getAttribute('height'));

log(`诊断: viewBox = ${viewBox}`);
log(
  `诊断: DOM 里 rect=${rects.length}（其中方框 ${boxRects.length}）path=${paths.length} text=${texts.length}`
);

assert(boxRects.length >= 2, `方框数不足：期望至少 2 个，实际 ${boxRects.length}`);
assert(paths.length >= 1, `连线数不足：期望至少 1 个，实际 ${paths.length}`);
assert(texts.length >= 4, `文字不足：期望至少 4 个，实际 ${texts.length}`);

const textContents = texts.map((element) => element.textContent);
assert(
  textContents.some((value) => value.includes('bsp_boot')),
  `方框文字里没有名称：${textContents.join(' | ')}`
);
assert(
  textContents.some((value) => value.includes('bsp_boot.h:23')),
  `方框文字里没有 文件:行号：${textContents.join(' | ')}`
);

// 位置必须落在 viewBox 可视范围内
const parts = viewBox.trim().split(/\s+/).map(Number);
assert(parts.every((value) => Number.isFinite(value)), `viewBox 非法：${viewBox}`);
const [vx, vy, vw, vh] = parts;
const boxPositions = [];
for (const rect of boxRects) {
  const x = Number(rect.getAttribute('x') ?? 0);
  const y = Number(rect.getAttribute('y') ?? 0);
  boxPositions.push({ x, y });
  assert(
    x >= vx - 1 && x <= vx + vw + 1 && y >= vy - 1 && y <= vy + vh + 1,
    `方框坐标 (${x},${y}) 落在 viewBox (${vx},${vy},${vw},${vh}) 之外，用户会看不到`
  );
}

const leftMost = Math.min(...boxPositions.map((position) => position.x));
assert(
  leftMost >= vx && leftMost - vx <= 40,
  `第一个方框离左边缘太远：leftMost=${leftMost}, viewBox.x=${vx}（应 <= 40）`
);

// 每个方框：两行文字 + 一个符号角标
const nodesGroup = byId.get('nodes');
const textsPerBox = nodesGroup.children.map((group) => group.count('text'));
assert(
  textsPerBox.every((count) => count === 2 || count === 3),
  `每个方框的文字行数不对：${textsPerBox.join(',')}`
);

let iconGroups = 0;
let iconShapes = 0;
for (const group of nodesGroup.children) {
  const icon = group.children.find((child) => child.className.startsWith('kind-icon'));
  if (!icon) {
    continue;
  }
  iconGroups += 1;
  iconShapes += icon.flatten().length - 1;
}
assert(
  iconGroups === nodesGroup.children.length,
  `符号角标数量不足：节点 ${nodesGroup.children.length} 个，角标 ${iconGroups} 个`
);
assert(iconShapes >= iconGroups, `符号角标里没有图形（共 ${iconShapes} 个图元）`);
log(`诊断: 符号角标 ${iconGroups} 个，共 ${iconShapes} 个图元`);

// 加减号：小正方形外壳 + 几何图形符号
let expanderChecked = 0;
let plusChecked = 0;
let minusChecked = 0;
for (const group of nodesGroup.children) {
  const expander = group.children.find((child) => child.className.startsWith('expander'));
  assert(expander !== undefined, '方框里找不到加减号（expander）');
  const match = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(expander.getAttribute('transform') ?? '');
  assert(match !== null, '加减号没有定位信息');
  assert(Number(match[2]) <= 24, `加减号应在名称那一行（y<=24），实际 y=${match[2]}`);

  const ring = expander.children.find((child) => child.className === 'ring');
  assert(ring !== undefined, '加减号外面缺少视觉外壳（.ring）');
  assert(ring.tagName === 'rect', `视觉外壳应是小正方形（<rect>），实际 <${ring.tagName}>`);
  const ringW = Number(ring.getAttribute('width'));
  const ringH = Number(ring.getAttribute('height'));
  assert(ringW === ringH, `正方形宽高必须相等，实际 ${ringW}×${ringH}`);
  const rx = ring.getAttribute('rx');
  assert(rx === '0' || rx === null, `正方形不应有圆角，实际 rx=${rx}`);

  // 符号（加减号）必须是几何图形，且中心严格落在正方形中心（本地坐标原点）
  const sign = expander.children.find((child) => child.className.startsWith('sign'));
  assert(sign !== undefined, '加减号缺少符号元素（.sign）');
  const shapes = sign.children.filter((child) => child.className.includes('sign-shape'));
  assert(shapes.length >= 1, `加减号里没有图形（子元素 ${sign.children.length} 个）`);

  // 逐个图形检查：其几何中心必须（近似）在原点
  for (const shape of shapes) {
    let cx;
    let cy;
    if (shape.tagName === 'rect') {
      cx = Number(shape.getAttribute('x')) + Number(shape.getAttribute('width')) / 2;
      cy = Number(shape.getAttribute('y')) + Number(shape.getAttribute('height')) / 2;
    } else if (shape.tagName === 'circle') {
      cx = Number(shape.getAttribute('cx'));
      cy = Number(shape.getAttribute('cy'));
    } else {
      continue; // 加载态的圆弧不做中心检查
    }
    assert(
      Math.abs(cx) <= 0.01 && Math.abs(cy) <= 0.01,
      `加减号图形没有居中：中心 (${cx},${cy})（应接近 0,0）`
    );
  }

  // 加号必须由「横 + 竖」两条矩形组成；减号只有一条扁矩形。
  // 注意必须按 class 分词判断：'expander collapse' 里也含 'expand' 子串！
  const modeClasses = expander.className.split(/\s+/);
  if (modeClasses.includes('expand')) {
    assert(shapes.length === 2, `加号应由两条矩形组成，实际 ${shapes.length} 条`);
    // 一横一竖：按面积区分出「扁的那条」与「高的那条」
    const boxes = shapes.map((shape) => ({
      width: Number(shape.getAttribute('width')),
      height: Number(shape.getAttribute('height')),
    }));
    const flat = boxes.reduce((a, b) => (a.width / a.height > b.width / b.height ? a : b));
    const tall = boxes.reduce((a, b) => (a.height / a.width > b.height / b.width ? a : b));
    assert(
      flat.width > flat.height && tall.height > tall.width,
      `加号应是一横一竖，实际 宽=${boxes.map((b) => b.width).join('/')} 高=${boxes.map((b) => b.height).join('/')}`
    );
    plusChecked += 1;
  }
  if (modeClasses.includes('collapse')) {
    assert(shapes.length === 1, `减号应只有一条矩形，实际 ${shapes.length} 条`);
    const width = Number(shapes[0].getAttribute('width'));
    const height = Number(shapes[0].getAttribute('height'));
    assert(width > height * 2, `减号应是扁矩形，实际 ${width}×${height}`);
    minusChecked += 1;
  }

  // 不应再用文字渲染加减号（字体度量会导致偏移）
  assert(
    sign.children.every((child) => child.tagName !== 'text'),
    '加减号不应再用 <text> 渲染（字体度量会导致不居中）'
  );

  expanderChecked += 1;
}
assert(expanderChecked >= 2, `应当检查到至少 2 个加减号，实际 ${expanderChecked}`);
assert(plusChecked >= 1, '没有检查到加号（expand 模式）');
assert(minusChecked >= 1, '没有检查到减号（collapse 模式）');

// 箭头必须是 90° 折线（只含 L），不能是曲线。
// 注意：图标也是 path，且字形本身就用 Q 二次贝塞尔，所以这里必须先按 class 过滤出连线。
const edgePaths = paths.filter((element) => element.className.split(/\s+/).includes('edge'));
assert(edgePaths.length >= 1, `连线路径数为 ${edgePaths.length}，应该至少 1 条`);
for (const element of edgePaths) {
  const d = String(element.getAttribute('d') ?? '');
  assert(d.includes('L'), `箭头应当是折线，实际 d=${d}`);
  assert(!d.includes('C') && !d.includes('Q'), `箭头不应包含曲线指令，实际 d=${d}`);
}

// 单击只选中（高亮），跳转仍然只在双击时发生。
// 注意：单击事件**是绑定的**（用于高亮选中），所以不能断言「不绑 click」，
// 而要断言「单击不会触发跳转」——这个更贴近需求，下面单独测。
assert(
  (nodesGroup.children[0].listeners.get('click') ?? []).length > 0,
  '方框应当绑定单击事件（用于高亮选中）'
);
assert(
  (nodesGroup.children[0].listeners.get('dblclick') ?? []).length > 0,
  '方框应当绑定双击事件（用于跳转）'
);
assert(
  (nodesGroup.children[0].listeners.get('contextmenu') ?? []).length > 0,
  '方框应当绑定右键事件（用于复制菜单）'
);

// 方框颜色必须是「偏深的紫色」，不能是粉色
const cssSource = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'graph.css'), 'utf8');
const borderMatch = /--node-border:\s*(#[0-9a-fA-F]{6})/.exec(cssSource);
assert(borderMatch !== null, 'CSS 里找不到 --node-border 颜色定义');
const borderHex = borderMatch[1];
const red = parseInt(borderHex.slice(1, 3), 16);
const green = parseInt(borderHex.slice(3, 5), 16);
const blue = parseInt(borderHex.slice(5, 7), 16);
assert(blue > red && blue > green, `方框颜色不是紫色系：${borderHex}（蓝色分量应最高）`);
assert(red < 170, `方框颜色太亮、会显得像粉色：${borderHex}（红分量应 < 170）`);
assert(blue < 220, `方框颜色太浅：${borderHex}`);
log(`诊断: 方框边框色 = ${borderHex}（紫色且偏深）；方框 ${boxWidth}×${boxHeight}`);

// 标签栏：标题只有元素名（方向由图标表达）＋ 一个方向图标
const tabsEl = byId.get('tabs');
assert(tabsEl.children.length >= 1, `应当渲染出标签，实际 ${tabsEl.children.length} 个`);
for (const tab of tabsEl.children) {
  const label = tab.children.find((child) => child.className.includes('tab-label'));
  assert(label !== undefined, '标签里缺少文字（.tab-label）');
  const labelText = String(label.textContent);
  assert(
    !/被调用[:：]|调用[:：]/.test(labelText),
    `标签标题不应再带方向前缀，实际 ${JSON.stringify(labelText)}`
  );
  assert(labelText.length > 0, '标签标题为空');

  const icon = tab.children.find((child) => child.className.includes('tab-direction'));
  assert(icon !== undefined, `标签「${labelText}」右侧缺少方向图标`);
  const codicon = String(icon.getAttribute('data-codicon') ?? '');
  assert(
    codicon === 'call-incoming' || codicon === 'call-outgoing',
    `方向图标的 codicon 不对：${codicon}`
  );
  // 图标必须真的带路径（否则是空白方块）
  const path = icon.children.find((child) => child.tagName === 'path');
  assert(path !== undefined, '方向图标里没有 <path>');
  assert(
    String(path.getAttribute('d') ?? '').length > 100,
    '方向图标的路径太短，可能是空占位'
  );
  // 图标要紧跟在文字之后
  assert(
    tab.children.indexOf(icon) === tab.children.indexOf(label) + 1,
    '方向图标应紧跟在元素名右侧'
  );
}
{
  const first = tabsEl.children[0];
  const icon = first.children.find((child) => child.className.includes('tab-direction'));
  assert(
    String(icon.className).includes('callers'),
    `callers 会话应当用「箭头进来」的图标，实际 class=${icon.className}`
  );
  const codicon = icon.getAttribute('data-codicon');
  assert(codicon === 'call-incoming', `callers 应映射到 call-incoming，实际 ${codicon}`);
  console.log(
    `诊断: 标签 ${tabsEl.children.length} 个，标题无方向前缀、右侧带方向图标（首个 = ${codicon}）`
  );
}

// ------------------------------------------------ 方框宽度自适应 + 加减号不压文字

{
  // 同一批数据里混入「很短的」和「很长的」内容：
  // 短名的方框必须明显更窄（否则就是没自适应），长名的必须更宽（能装下内容）。
  const nodes = {};
  const ids = [];
  const cases = [
    ['wshort', 'f', 'a.c', 1],
    ['wlong', 'a_very_long_function_name_here', 'components/BSP/boot/bsp_boot_impl.c', 120],
  ];
  for (const [id, name, file, line] of cases) {
    ids.push(id);
    nodes[id] = {
      id,
      name,
      file,
      line,
      direction: 'callers',
      depth: id === 'wshort' ? 0 : 1,
      isCycle: false,
      canExpand: true,
      children: id === 'wshort' ? ['wlong'] : [],
      loaded: true,
      kind: 'function',
    };
  }
  const boxes = {};
  for (const [id, name, file, line] of cases) {
    // 故意用同一个宽度，让 webview 必须靠自适应把它们区分开
    boxes[id] = { x: id === 'wshort' ? 0 : 420, y: 0, width: 300, height: NODE_HEIGHT };
  }
  posted.length = 0;
  sendToWebview({
    type: 'sessionUpdate',
    session: {
      id: 'width-check',
      title: '宽度检查',
      description: '',
      direction: 'callers',
      engineLabel: 'clangd',
      rootId: 'wshort',
      nodes,
      edges: [{ id: 'e', from: 'wshort', to: 'wlong', depth: 1 }],
      boxes,
      collapsedCount: 0,
    },
  });

  const boxInfo = (id) => {
    const group = nodesGroup.children.find(
      (child) => child.getAttribute('data-node') === id
    );
    assert(group !== undefined, `找不到方框 ${id}`);
    const rect = group.children.find((child) => child.className === 'box');
    const name = group.children.find((child) => child.className === 'name');
    const loc = group.children.find((child) => child.className === 'loc');
    const expander = group.children.find((child) =>
      String(child.className).startsWith('expander')
    );
    return {
      group,
      width: Number(rect.getAttribute('width')),
      nameEnd: Number(name.getAttribute('x')) + Number(name.getBBox().width),
      locEnd: Number(loc.getAttribute('x')) + Number(loc.getBBox().width),
      expander,
      expanderX: expander
        ? Number(/translate\(([-\d.]+)/.exec(expander.getAttribute('transform'))[1])
        : undefined,
    };
  };

  const short = boxInfo('wshort');
  const long = boxInfo('wlong');
  assert(
    long.width > short.width + 40,
    `方框宽度没有随内容自适应：短名 ${short.width}，长名 ${long.width}（应明显更宽）`
  );
  for (const info of [short, long]) {
    const textEnd = Math.max(info.nameEnd, info.locEnd);
    assert(
      info.width > textEnd,
      `文字溢出方框：宽 ${info.width}，文字到 ${textEnd.toFixed(1)}`
    );
  }
  // 加减号（小正方形）左侧必须留出至少 6px，不能压到文字上
  for (const info of [short, long]) {
    if (!info.expander) {
      continue;
    }
    const signLeft = info.expanderX - 13 / 2;
    const textEnd = Math.max(info.nameEnd, info.locEnd);
    assert(
      signLeft - textEnd >= 6,
      `加减号压到文字了：加减号左边 ${signLeft.toFixed(1)}，文字到 ${textEnd.toFixed(1)}`
    );
  }
  log(
    `诊断: 方框宽度自适应 短名 ${short.width} / 长名 ${long.width}；` +
      `加减号与文字最小间距 ${Math.min(
        Math.max(short.nameEnd, short.locEnd) >= 0 ? short.expanderX - 13 / 2 - Math.max(short.nameEnd, short.locEnd) : 0,
        long.expanderX - 13 / 2 - Math.max(long.nameEnd, long.locEnd)
      ).toFixed(1)}px`
  );

  // 边必须接在两个方框**各自的**边缘上（宽度不同，不能都用 from 的宽度）。
  // 这条曾是真 bug：宽度自适应后，两个锚点都取 from 的宽度，目标方框就接不上。
  const edge = edgesEl.children.find((child) => String(child.className).includes('edge'));
  assert(edge !== undefined, '没有画出连线');
  const d = String(edge.getAttribute('d'));
  const xs = [...d.matchAll(/[ML] ([-\d.]+) /g)].map((m) => Number(m[1]));
  const shortX = Number(/translate\(([-\d.]+)/.exec(short.group.getAttribute('transform'))[1]);
  const longX = Number(/translate\(([-\d.]+)/.exec(long.group.getAttribute('transform'))[1]);
  // 向右的流：从短方框右边缘出发，接到长方框左边缘
  assert(
    xs.includes(shortX + short.width),
    `连线没有从短方框右边缘（${shortX + short.width}）出发：${d}`
  );
  assert(
    xs.includes(longX),
    `连线没有接到长方框左边缘（${longX}）：${d}`
  );
  log(
    `诊断: 连线两端锚点正确（${shortX + short.width} → ${longX}）：${d.slice(0, 70)}`
  );
}

// ------------------------------------------------ 工具栏在标签栏之上 + 标签防重叠

{
  // 需求：小菜单栏（工具栏）要在小标签栏**上面**
  const toolbarIndex = htmlSource.indexOf('id="toolbar"');
  const tabsIndex = htmlSource.indexOf('id="tabs"');
  assert(toolbarIndex >= 0 && tabsIndex >= 0, 'HTML 里应当同时有 #toolbar 与 #tabs');
  assert(
    toolbarIndex < tabsIndex,
    '工具栏必须排在标签栏**前面**（出现在上面），实际反了'
  );
  log('诊断: 工具栏在标签栏之上（HTML 顺序正确）');

  // 需求：标签宽度要自适应内容、左右不能重叠。
  // 这两条靠 CSS 保证，而桩里没有排版引擎，所以直接断言关键规则存在。
  const cssSource = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'graph.css'), 'utf8');
  const tabRule = /\.tab\s*\{([^}]*)\}/.exec(cssSource);
  assert(tabRule !== null, 'CSS 里找不到 .tab 规则');
  const tabBody = tabRule[1];
  assert(
    /min-width:\s*0/.test(tabBody),
    '.tab 必须设 min-width: 0 —— 否则 flex 项被 nowrap 文字撑住不缩，标签会过宽并相互重叠'
  );
  assert(
    /max-width:\s*\d+px/.test(tabBody),
    '.tab 应当有 max-width 上限，超长标题才会走省略号而不是撑爆'
  );
  const labelRule = /\.tab\s+\.tab-label\s*\{([^}]*)\}/.exec(cssSource);
  assert(labelRule !== null, 'CSS 里找不到 .tab .tab-label 规则');
  assert(
    /min-width:\s*0/.test(labelRule[1]),
    '.tab-label 必须设 min-width: 0，否则省略号不会生效、文字会溢出标签'
  );
  assert(
    /text-overflow:\s*ellipsis/.test(labelRule[1]),
    '.tab-label 应当用省略号截断过长标题'
  );
  log('诊断: 标签样式含 min-width:0 与 max-width（宽度自适应、不重叠）');
}

// ------------------------------------------------ 折叠后其余方框仍可见

{
  // 复现用户报的问题：折叠一个方框后，同列的其它方框「看不见了」。
  // 可能原因：折叠让内容尺寸变小 → viewBox 重新计算 → 滚动位置被钳制跑掉，
  // 于是剩下的方框落到可视区之外。
  const nodes = {};
  // 注意 parent 必须填对：webview 判断「某个方框是否被祖先收起」是靠**父链**往上找的
  // （isVisible 沿 parent 遍历）。漏填 parent 会让父链为空、方框永远可见，
  // 从而测不出「收起全部」是否生效 —— 曾经就在这里漏过。
  const mk = (id, name, depth, children, parent) => {
    nodes[id] = {
      id,
      name,
      file: 'demo.cpp',
      line: 10 + depth,
      direction: 'callers',
      depth,
      isCycle: false,
      canExpand: children.length > 0,
      children,
      parent,
      loaded: true,
      kind: 'function',
    };
  };
  // 根 + 两个调用者（同列上下排列），第一个调用者还有自己的子节点
  mk('r', 'root_fn', 0, ['c1', 'c2'], undefined);
  mk('c1', 'caller_one', 1, ['g1'], 'r');
  mk('c2', 'caller_two', 1, [], 'r');
  mk('g1', 'grand_child', 2, [], 'c1');
  const boxes = {
    r: { x: 0, y: 0, width: 200, height: NODE_HEIGHT },
    c1: { x: 300, y: 0, width: 200, height: NODE_HEIGHT },
    c2: { x: 300, y: 60, width: 200, height: NODE_HEIGHT },
    g1: { x: 600, y: 0, width: 200, height: NODE_HEIGHT },
  };
  posted.length = 0;
  sendToWebview({
    type: 'sessionUpdate',
    session: {
      id: 'collapse-check',
      title: '折叠检查',
      description: '',
      direction: 'callers',
      engineLabel: 'clangd',
      rootId: 'r',
      nodes,
      edges: [
        { id: 'e1', from: 'c1', to: 'r', depth: 1 },
        { id: 'e2', from: 'c2', to: 'r', depth: 1 },
        { id: 'e3', from: 'g1', to: 'c1', depth: 2 },
      ],
      boxes,
      collapsedCount: 0,
    },
  });

  const idsNow = () =>
    byId.get('nodes').children.map((child) => child.getAttribute('data-node'));
  assert(
    idsNow().sort().join(',') === 'c1,c2,g1,r',
    `折叠前应显示 4 个方框，实际 ${idsNow().join(',')}`
  );

  // 点 c1 的减号折叠它
  const boxOf = (id) =>
    nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  const expander = boxOf('c1').children.find((child) =>
    String(child.className).startsWith('expander')
  );
  // 模式判定（曾经写错：已展开且有子节点的节点拿到 expand 模式，
  // 于是减号永不出现、点下去是空操作、折叠分支成了死代码）
  assert(
    String(expander.className).includes('collapse'),
    `已展开且有子节点的方框应当显示「减号」(collapse)，实际 ${expander.className}`
  );
  assert(
    String(boxOf('c2').children.find((child) =>
      String(child.className).startsWith('expander')
    ).className).includes('leaf'),
    '没有子节点的方框应当是叶子样式'
  );
  expander.dispatch('mousedown', { stopPropagation() {}, preventDefault() {} });
  for (const handler of windowListeners.mouseup ?? []) {
    handler({});
  }

  const after = idsNow();
  assert(!after.includes('g1'), `折叠 c1 后它的子节点应隐藏，实际仍在：${after.join(',')}`);
  for (const id of ['r', 'c1', 'c2']) {
    assert(after.includes(id), `折叠 c1 后 ${id} 应当仍然可见，实际只剩 ${after.join(',')}`);
  }
  // 其余方框必须还落在 viewBox 之内（否则就是"看不见了"）
  const vb = String(svg.getAttribute('viewBox')).trim().split(/\s+/).map(Number);
  const [vx, vy, vw, vh] = vb;
  for (const group of nodesGroup.children) {
    const t = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(group.getAttribute('transform'));
    const gx = Number(t[1]);
    const gy = Number(t[2]);
    assert(
      gx >= vx - 1 && gx <= vx + vw + 1 && gy >= vy - 1 && gy <= vy + vh + 1,
      `折叠后方框 ${group.getAttribute('data-node')} 落在 viewBox 之外（${gx},${gy} 不在 ${vb.join(' ')}）`
    );
  }
  log(
    `诊断: 折叠 c1 后仍可见 ${after.join(',')}，全部在 viewBox [${vb.join(' ')}] 内`
  );

  // 折叠后该方框必须变回「加号」，且再点能重新展开
  const collapsedExpander = boxOf('c1').children.find((child) =>
    String(child.className).startsWith('expander')
  );
  assert(
    String(collapsedExpander.className).includes('expand'),
    `折叠后的方框应当显示「加号」(expand)，实际 ${collapsedExpander.className}`
  );
  collapsedExpander.dispatch('mousedown', { stopPropagation() {}, preventDefault() {} });
  for (const handler of windowListeners.mouseup ?? []) {
    handler({});
  }
  assert(
    idsNow().includes('g1'),
    '折叠后再点加号应当把子节点重新显示出来'
  );
  log('诊断: 折叠 → 变加号 → 再展开，往复正常');

  // ---- 工具栏「收起全部」必须连第一级也收起（只留根） ----
  {
    const collapseAllBtn = byId.get('btn-collapse-all');
    const expandAllBtn = byId.get('btn-expand-all');
    assert(collapseAllBtn !== undefined && expandAllBtn !== undefined, '工具栏按钮缺失');

    collapseAllBtn.dispatch('click', {});
    const ids = idsNow();
    assert(
      ids.length === 1 && ids[0] === 'r',
      `「收起全部」后应当只剩根方框，实际 ${ids.join(',')}`
    );
    log('诊断: 收起全部 → 只剩根方框');

    // ---- 再点「展开全部」必须重新显示（曾经这里什么都不发生） ----
    posted.length = 0;
    expandAllBtn.dispatch('click', {});
    const expandMsg = posted.some((m) => m.type === 'expandAll');
    assert(expandMsg, '「展开全部」应当向宿主发出 expandAll');
    // 模拟宿主把数据补发回来（真实流程：宿主 postSession）
    sendToWebview({
      type: 'sessionUpdate',
      session: {
        id: 'collapse-check',
        title: '折叠检查',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'r',
        nodes,
        edges: [
          { id: 'e1', from: 'c1', to: 'r', depth: 1 },
          { id: 'e2', from: 'c2', to: 'r', depth: 1 },
          { id: 'e3', from: 'g1', to: 'c1', depth: 2 },
        ],
        boxes,
        collapsedCount: 0,
      },
    });
    const afterExpandIds = idsNow().sort();
    assert(
      afterExpandIds.join(',') === 'c1,c2,g1,r',
      `「收起全部」后再点「展开全部」应当重新显示全部方框，实际 ${afterExpandIds.join(',')}`
    );
    log('诊断: 收起全部 → 展开全部 → 方框全部恢复（往复有效）');

    // ---- 点「根方框」自己的减号：根保持可见，只有它的下一层收起 ----
    // 用户报过「按了之后第一个源方框不折叠，从第二级开始折叠」——
    // 那是加减号模式判定错误的后果。这里明确锁住正确行为。
    const minus = boxOf('r').children.find((child) =>
      String(child.className).startsWith('expander')
    );
    assert(
      String(minus.className).includes('collapse'),
      `根方框（有子节点且已展开）应当显示减号，实际 ${minus.className}`
    );
    minus.dispatch('mousedown', { stopPropagation() {}, preventDefault() {} });
    for (const handler of windowListeners.mouseup ?? []) {
      handler({});
    }
    const rootCollapsedIds = idsNow();
    assert(
      rootCollapsedIds.length === 1 && rootCollapsedIds[0] === 'r',
      `点根方框的减号后应当只剩根，实际 ${rootCollapsedIds.join(',')}`
    );
    assert(
      String(
        boxOf('r').children.find((child) => String(child.className).startsWith('expander'))
          .className
      ).includes('expand'),
      '收起后根方框的减号应当变成加号'
    );
    log('诊断: 点根方框减号 → 只剩根（第一级也随之收起），且按钮变加号');
  }
}

// ------------------------------------------------ 实测宽度回传 → 列间隙收紧

{
  // 需求背景：宿主没有排版引擎，排布列位置只能按字符数估宽；估宽偏大 → 列被推远
  // → 箭头很长。所以 webview 量准后回传，宿主用真实宽度排列各列。
  // 这里验证：① 回传的消息确实是实测宽度；② 用实测宽度重排后，列间隙明显收紧，
  // 且不小于设计下限。
  const before = posted.length;
  sendToWebview({
    type: 'sessionUpdate',
    session: {
      id: 'feedback-check',
      title: '回传检查',
      description: '',
      direction: 'callees',
      engineLabel: 'clangd',
      rootId: 'f0',
      nodes: {
        f0: {
          id: 'f0',
          name: 'short_name',
          file: 'a.c',
          line: 1,
          direction: 'callees',
          depth: 0,
          isCycle: false,
          canExpand: false,
          children: ['f1'],
          loaded: true,
          kind: 'function',
        },
        f1: {
          id: 'f1',
          name: 'another_short_name',
          file: 'b.c',
          line: 2,
          direction: 'callees',
          depth: 1,
          isCycle: false,
          canExpand: false,
          children: [],
          loaded: true,
          kind: 'function',
        },
      },
      edges: [{ id: 'e', from: 'f0', to: 'f1', depth: 1 }],
      // 故意给一个偏大的宽度，模拟「宿主估宽偏大」
      boxes: {
        f0: { x: 0, y: 0, width: 400, height: NODE_HEIGHT },
        f1: { x: 456, y: 0, width: 400, height: NODE_HEIGHT },
      },
      collapsedCount: 0,
    },
  });

  const reports = posted.slice(before).filter((m) => m.type === 'reportWidths');
  assert(reports.length >= 1, 'webview 渲染后没有回传实测宽度（宿主会一直用偏大的估宽排列）');
  const widths = reports[reports.length - 1].widths;
  assert(Array.isArray(widths) && widths.length === 2, `回传的宽度条目数不对：${JSON.stringify(widths)}`);
  for (const item of widths) {
    assert(
      typeof item.width === 'number' && item.width > 0 && item.width < 400,
      `回传的宽度不是真实测量值（应当明显小于夹具里硬写的 400）：${JSON.stringify(item)}`
    );
  }
  console.log(
    `诊断: webview 回传实测宽度 ${widths.map((w) => `${w.id}=${w.width}`).join(', ')}`
  );

  // 用实测宽度重排：列间隙应当收紧到设计值附近
  const measured = new Map(widths.map((w) => [w.id, w.width]));
  const relaid = createLayout(
    {
      f0: { id: 'f0', name: 'short_name', file: 'a.c', line: 1, direction: 'callees', depth: 0, isCycle: false, children: ['f1'], loaded: true, kind: 'function' },
      f1: { id: 'f1', name: 'another_short_name', file: 'b.c', line: 2, direction: 'callees', depth: 1, isCycle: false, children: [], loaded: true, kind: 'function' },
    },
    'f0',
    measured
  );
  const gap = relaid.boxes.f1.x - (relaid.boxes.f0.x + relaid.boxes.f0.width);
  console.log(
    `诊断: 用实测宽度重排 → f0 宽 ${relaid.boxes.f0.width}，f1 x=${relaid.boxes.f1.x}，列间隙 ${gap}px`
  );
  assert(
    gap === 52,
    `列间隙应当严格等于设计的 COLUMN_GAP(52)，实际 ${gap}px`
  );
  assert(
    relaid.boxes.f0.width === measured.get('f0'),
    '用实测宽度重排时，方框宽度应当直接采用实测值'
  );
}

log('OK: 真实消息流下 DOM 里有方框、连线、文字、符号角标，坐标在可视范围内');

// ------------------------------------------------ 工具栏按钮真的会发消息

for (const [buttonId, expectedType] of [
  ['btn-expand-all', 'expandAll'],
  ['btn-settings', 'openSettings'],
  ['btn-copy-tab', 'copyTabText'],
  ['btn-collapse-all', undefined], // 收起全部是纯前端行为，不发消息
  ['btn-close-all', 'closeAllTabs'],
]) {
  const button = byId.get(buttonId);
  assert(button !== undefined, `找不到工具栏按钮 ${buttonId}`);
  // 只统计与按钮语义相关的消息。`reportWidths` 是「实测宽度回传」的内部信号，
  // 任何会触发重绘的操作都可能带上它，不能算作按钮发出的指令。
  const relevant = (message) => message.type !== 'reportWidths';
  const before = posted.length;
  button.dispatch('click', {});
  const fresh = posted.slice(before).filter(relevant).map((message) => message.type);
  if (expectedType === undefined) {
    assert(
      fresh.length === 0,
      `${buttonId} 应当是纯前端行为（不发消息），实际发了 ${fresh.join(',')}`
    );
  } else {
    assert(
      fresh.includes(expectedType),
      `${buttonId} 点击后应发出 ${expectedType} 消息，实际 ${fresh.join(',') || '（无）'}`
    );
  }
}
log('诊断: 工具栏 5 个按钮的点击行为都正确（展开/设置/复制标签/关闭发消息，收起全部纯前端）');

// ------------------------------------------------ 单击高亮 + 方框右键菜单

{
  // 注意：单击/选中会触发重绘（render 会重建节点元素），
  // 所以每次断言前都要按 data-node 重新取元素，不能留着旧引用。
  const nodeId = nodesGroup.children[0].getAttribute('data-node');
  const boxOf = () =>
    nodesGroup.children.find((child) => child.getAttribute('data-node') === nodeId);

  // 单击只选中（高亮），不跳转；跳转仍然是双击
  const beforeClick = posted.length;
  boxOf().dispatch('click', { stopPropagation() {} });
  const clickMessages = posted.slice(beforeClick).map((message) => message.type);
  assert(
    !clickMessages.includes('openLocation'),
    `单击方框不应触发跳转（那是双击的事），实际发了 ${clickMessages.join(',')}`
  );
  const afterClick = boxOf();
  assert(
    String(afterClick.className).split(/\s+/).includes('selected'),
    `单击后该方框应当被标记为 selected（高亮），实际 class=${afterClick.className}`
  );
  assert(
    clickMessages.includes('selectNode'),
    `单击后应当把选中状态告知宿主，实际 ${clickMessages.join(',') || '（无）'}`
  );
  console.log('诊断: 单击方框 → 只高亮选中，不跳转');

  // 右键：在鼠标位置弹出菜单，且菜单里就是「复制元素 / 复制地址」
  // 同样注意引用新鲜度：webview 每次 render 都会重新取 #box-menu，
  // 所以这里也每次重新取，别留着旧引用。
  const menu = () => byId.get('box-menu');
  assert(menu().hidden === true, '菜单初始应当是隐藏的');
  boxOf().dispatch('contextmenu', {
    preventDefault() {},
    stopPropagation() {},
    clientX: 120,
    clientY: 80,
  });
  assert(menu().hidden === false, '右键方框后菜单应当弹出');
  const menuItems = menu().children.map((child) => child.getAttribute('data-action'));
  assert(
    menuItems.includes('copyElement') && menuItems.includes('copyLocation'),
    `菜单项不对：${menuItems.join(', ')}`
  );
  assert(
    menu().style.left === '120px' && menu().style.top === '80px',
    `菜单应当出现在鼠标位置，实际 left=${menu().style.left} top=${menu().style.top}`
  );
  console.log(
    `诊断: 右键方框 → 弹出菜单（${menuItems.join(', ')}），位置 ${menu().style.left},${menu().style.top}`
  );

  // 点菜单项：发出对应复制消息，并且菜单关闭
  const beforeMenuClick = posted.length;
  const menuBefore = menu();
  // 直接取菜单上注册的 click 处理函数并调用：
  // 这样测的是「处理逻辑」本身，不受桩的 dispatch/事件冒泡差异影响。
  const menuHandlers = menuBefore.listeners.get('click') ?? [];
  assert(menuHandlers.length >= 1, '菜单上没有注册 click 处理函数');
  for (const handler of menuHandlers) {
    handler({
      type: 'click',
      target: menuBefore.children[0],
      currentTarget: menuBefore,
      stopPropagation() {},
      preventDefault() {},
    });
  }
  const sent = posted[posted.length - 1];
  assert(
    sent.nodeId === nodeId,
    `复制消息应当带上被右键的那个节点，实际 nodeId=${sent.nodeId}（期望 ${nodeId}）`
  );
  assert(menu().hidden === true, '点了菜单项后菜单应当关闭');

  // 第二个菜单项要发 copyNodeLocation
  const boxAgain = boxOf();
  boxAgain.dispatch('contextmenu', {
    preventDefault() {},
    stopPropagation() {},
    clientX: 10,
    clientY: 10,
  });
  const beforeMenuClick2 = posted.length;
  for (const handler of menu().listeners.get('click') ?? []) {
    handler({
      type: 'click',
      target: menu().children[1],
      currentTarget: menu(),
      stopPropagation() {},
      preventDefault() {},
    });
  }
  const menuMessages2 = posted.slice(beforeMenuClick2).map((message) => message.type);
  assert(
    menuMessages2.includes('copyNodeLocation'),
    `点「复制地址」应发出 copyNodeLocation，实际 ${menuMessages2.join(',') || '（无）'}`
  );
  console.log('诊断: 菜单两项分别发出 copyNodeName / copyNodeLocation，且带正确的 nodeId');

  // 双击：既选中（高亮）又跳转
  const beforeDbl = posted.length;
  boxOf().dispatch('dblclick', { preventDefault() {}, stopPropagation() {} });
  const dblMessages = posted.slice(beforeDbl).map((message) => message.type);
  assert(
    dblMessages.includes('openLocation'),
    `双击方框应当跳转，实际发了 ${dblMessages.join(',') || '（无）'}`
  );
  console.log('诊断: 双击方框 → 跳转（并保持选中高亮）');

  // ---- 方框纵向紧凑度 ----
  // 需求：元素名与路径的行距、以及文字到上下边框的距离都要小。
  // 这里按几何常量断言，防止以后改回去又变松。
  const nameText = boxOf().children.find((child) => child.className === 'name');
  const locText = boxOf().children.find((child) => child.className === 'loc');
  assert(nameText !== undefined && locText !== undefined, '方框里应当有名称与路径两行文字');
  const nameY = Number(nameText.getAttribute('y'));
  const locY = Number(locText.getAttribute('y'));
  const boxHeight = Number(
    boxOf().children.find((child) => child.className === 'box').getAttribute('height')
  );
  const rootRectRaw = boxOf().children.find((child) => child.className === 'box')
    .getAttribute('height');
  const lineGap = locY - nameY;
  assert(
    lineGap >= 16,
    `元素名与路径的行距过小，两行显得挤：${lineGap}px（真实字体下需 ≥16px）`
  );
  assert(
    lineGap <= 20,
    `元素名与路径的行距过大：${lineGap}px（应 ≤20px）`
  );
  assert(
    nameY >= 12 && nameY <= 20,
    `名称基线不合理：${nameY}（应在 12~20）`
  );
  assert(
    boxHeight <= 45,
    `方框高度仍然偏大：${boxHeight}px（应 ≤45px，最早是 50px）`
  );
  // 上下留白：**不再要求对称**。
  // 需求优先顺序是「行间空隙要够大」+「路径到下边框要小」，加大行距必然占空间，
  // 所以下留白比上留白大是预期结果。这里只防止它过分失衡或反过来被压没。
  // 13px 粗体名称墨迹约在基线上方 9px；12px 路径墨迹约在基线上方 8px、下方 2px
  const topPad = nameY - 9;
  const bottomPad = boxHeight - (locY + 2);
  assert(
    bottomPad >= 2,
    `路径到方框下边框的留白太小（${bottomPad}px），文字会贴着边框`
  );
  assert(
    bottomPad - topPad <= 8,
    `下留白（${bottomPad}px）比上留白（${topPad}px）大太多，方框会显得下坠`
  );
  console.log(
    `诊断: 方框高 ${boxHeight}，行距 ${lineGap}，名称基线 ${nameY}，上留白 ${topPad}，下留白 ${bottomPad}`
  );
}

// ------------------------------------------------------------ ② 延迟：加减号几何 + 宽会话

setTimeout(() => {
  // webview 在下一帧用 getBBox 精确居中加减号，先把帧回调跑掉
  flushFrames();

  // 此时仍是初始会话的 DOM（宽会话尚未注入），可安全校验加减号
  let centeredChecked = 0;
  for (const group of nodesGroup.children) {
    const expander = group.children.find((child) => child.className.startsWith('expander'));
    const sign = expander?.children.find((child) => child.className.startsWith('sign'));
    assert(sign !== undefined, '加减号不见了');
    const shapes = sign.children.filter((child) => child.className.includes('sign-shape'));
    assert(shapes.length >= 1, '加减号图形不见了');
    centeredChecked += 1;
  }
  assert(centeredChecked >= 2, `应当检查到至少 2 个加减号，实际 ${centeredChecked}`);
  log(`诊断: ${centeredChecked} 个加减号使用几何图形，中心严格在正方形中心`);

  // ---- 宽会话：居中滚动量 + 滚轮不缩放 ----
  canvasEl.clientWidth = 200;
  canvasEl.clientHeight = 200;
  const wideBoxes = {};
  const wideNodes = {};
  const WIDE_COLUMNS = 5;
  const WIDE_STRIDE = 300;
  for (let depth = 0; depth < WIDE_COLUMNS; depth += 1) {
    // 这里给的是**布局宽度**，webview 会按文字实测宽度覆盖它（自适应方框宽度）
    wideBoxes[`d${depth}`] = {
      x: depth * WIDE_STRIDE,
      y: 0,
      width: layoutBoxes.root.width,
      height: layoutBoxes.root.height,
    };
    wideNodes[`d${depth}`] = {
      id: `d${depth}`,
      name: `fn${depth}`,
      file: 'wide.c',
      line: depth + 1,
      direction: 'callers',
      depth,
      isCycle: false,
      children: depth < WIDE_COLUMNS - 1 ? [`d${depth + 1}`] : [],
      parent: depth === 0 ? undefined : `d${depth - 1}`,
      loaded: true,
      canExpand: false,
      kind: 'function',
    };
  }
  sendToWebview({
    type: 'sessionUpdate',
    session: {
      id: 's-center',
      title: 'fn0',
      description: 'wide.c:1',
      direction: 'callers',
      engineLabel: 'clangd',
      rootId: 'd0',
      nodes: wideNodes,
      edges: [],
      boxes: wideBoxes,
      collapsedCount: 0,
    },
  });

  // 期望滚动量：wanted = 方框中心 - 画布一半；scrollLeft = wanted - viewBox.x
  // （viewBox 尺寸 = 内容尺寸，无缩放），再按实际可滚动范围钳制。
  // 注意：必须等宽会话真的渲染完再读尺寸，所以计算放在下面的 setTimeout 里。
  const MARGIN_LEFT = 16;
  const MARGIN_TOP = 10;

  setTimeout(() => {
    // 方框宽度是**按内容自适应**的：绘制时用实测宽度覆盖布局给的宽度，
    // 所以期望的居中偏移要按「DOM 里实际画出来的那个方框」算。
    const rootGroup = nodesGroup.children.find(
      (child) => child.getAttribute('data-node') === 'd0'
    );
    assert(rootGroup !== undefined, '宽会话里找不到根方框 d0');
    const rootRect = rootGroup.children.find((child) => child.className === 'box');
    const wideWidth = Number(rootRect.getAttribute('width'));
    const wideHeight = Number(rootRect.getAttribute('height'));
    const svgWidth = Number(svg.getAttribute('width'));
    const svgHeight = Number(svg.getAttribute('height'));
    const maxScrollX = Math.max(0, svgWidth - canvasEl.clientWidth);
    const maxScrollY = Math.max(0, svgHeight - canvasEl.clientHeight);
    const wantedX = wideWidth / 2 - canvasEl.clientWidth / 2;
    const wantedY = wideHeight / 2 - canvasEl.clientHeight / 2;
    const expectedScrollLeft = Math.min(maxScrollX, Math.max(0, wantedX - -MARGIN_LEFT));
    const expectedScrollTop = Math.min(maxScrollY, Math.max(0, wantedY - -MARGIN_TOP));
    log(
      `诊断: 宽会话根方框实测 ${wideWidth}×${wideHeight}（布局给的 ${layoutBoxes.root.width}），` +
        `Svg ${svgWidth}×${svgHeight}`
    );
    log(
      `诊断: 居中检查 scrollLeft=${canvasEl.scrollLeft}（期望 ${Math.round(expectedScrollLeft)}，` +
        `可滚动宽度 ${Math.round(maxScrollX)}）`
    );
    assert(
      Math.abs(canvasEl.scrollLeft - expectedScrollLeft) <= 1,
      `根方框没有居中：scrollLeft=${canvasEl.scrollLeft}，期望 ${Math.round(expectedScrollLeft)}`
    );
    assert(
      Math.abs(canvasEl.scrollTop - expectedScrollTop) <= 1,
      `根方框没有垂直居中：scrollTop=${canvasEl.scrollTop}，期望 ${Math.round(expectedScrollTop)}`
    );

    // 滚轮不得改变 SVG 尺寸或 viewBox（缩放功能已按需求移除）
    const widthBefore = Number(svg.getAttribute('width'));
    const heightBefore = Number(svg.getAttribute('height'));
    const viewBoxBefore = String(svg.getAttribute('viewBox'));
    for (const handler of canvasEl.listeners.get('wheel') ?? []) {
      handler({
        deltaY: -100,
        ctrlKey: true,
        metaKey: false,
        clientX: 100,
        clientY: 40,
        preventDefault() {},
        stopPropagation() {},
      });
    }
    const widthAfter = Number(svg.getAttribute('width'));
    const heightAfter = Number(svg.getAttribute('height'));
    log(`诊断: 派发 Ctrl+滚轮后 SVG ${widthBefore}x${heightBefore} → ${widthAfter}x${heightAfter}`);
    assert(
      widthAfter === widthBefore && heightAfter === heightBefore,
      `滚轮改变了 SVG 元素尺寸（${widthBefore}x${heightBefore} → ${widthAfter}x${heightAfter}）`
    );
    assert(
      String(svg.getAttribute('viewBox')) === viewBoxBefore,
      `滚轮改变了 viewBox：缩放功能已移除`
    );

    log('OK: 新查询把根方框居中；Ctrl+滚轮不再缩放，SVG 尺寸恒等于内容尺寸');
  }, 20);
}, 20);
