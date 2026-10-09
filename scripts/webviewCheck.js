/**
 * Webview 渲染契约测试：在桩 DOM 里加载打包后的 dist/webview.js，
 * 断言渲染出的 viewBox 必须是有限数字。
 *
 * 背景：曾经把 contentWidth = bounds.width / canvas.clientWidth 缓存下来，
 * 而面板刚创建时 clientWidth 可能是 0 → 算出 Infinity → viewBox 失效 →
 * 整个图什么都不画（用户看到的就是「没有任何显示」）。这个测试专门守住这一点。
 *
 * 运行：node scripts/webviewCheck.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEBVIEW = path.join(ROOT, 'dist', 'webview.js');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

// ------------------------------------------------------------ 桩 DOM

const attributes = new Map();

function makeElement(key, clientWidth = 0, clientHeight = 0) {
  const element = {
    __key: key,
    tagName: key,
    children: [],
    _textContent: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    clientWidth,
    clientHeight,
    listeners: {},
    // 真实 DOM 里设置 textContent 会清空子节点，这里必须一致，否则统计会失真
    get textContent() {
      return this._textContent;
    },
    set textContent(value) {
      this._textContent = String(value);
      this.children = [];
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
    },
    /** 量宽会把探测节点临时挂上再摘掉，所以必须有 remove()。 */
    remove() {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
        this.parentNode = undefined;
      }
    },
    /**
     * 方框宽度自适应依赖它量文字：必须**随内容变化**返回宽度，
     * 否则量出来是 0，方框会塌成最小尺寸（viewBox 也跟着缩到 16×16）。
     */
    getBBox() {
      if (this.tagName !== 'text') {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      const size = Number.parseFloat(String(this.getAttribute('font-size') ?? '')) || 12;
      const bold = String(this.getAttribute('font-weight') ?? '') === '600';
      const text = String(this._textContent ?? '');
      return {
        x: 0,
        y: Number(this.getAttribute('y') ?? 0) - size * 0.72,
        width: text.length * size * (bold ? 0.66 : 0.6),
        height: size * 0.66,
      };
    },
    setAttribute(name, value) {
      attributes.set(`${this.__key}:${name}`, value);
    },
    getAttribute(name) {
      return attributes.get(`${this.__key}:${name}`);
    },
    removeAttribute(name) {
      attributes.delete(`${this.__key}:${name}`);
    },
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return element;
}

// 关键：clientWidth = 0，模拟「面板刚创建、还没量到尺寸」
const elements = new Map();
for (const id of ["tabs","toolbar","box-menu","summary","empty","canvas","svg","viewport","edges","nodes"]) {
  elements.set(id, makeElement(id));
}

const windowListeners = {};

global.document = {
  getElementById: (id) => elements.get(id) ?? null,
  createElement: (tag) => makeElement(tag, 0, 0),
  createElementNS: (_ns, tag) => makeElement(tag, 0, 0),
  addEventListener() {},
};

// svg > viewport > (edges, nodes)：脚本会把图形元素 append 到 edges/nodes，
// 所以要按真实结构把这几层串起来，否则统计不到子元素。
elements.get('viewport').appendChild(elements.get('edges'));
elements.get('viewport').appendChild(elements.get('nodes'));
elements.get('svg').appendChild(elements.get('viewport'));

const posted = [];
global.window = {
  addEventListener(type, handler) {
    (windowListeners[type] = windowListeners[type] || []).push(handler);
  },
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

// ------------------------------------------------------------ 加载 webview 脚本

require(WEBVIEW);

assert(
  posted.some((message) => message && message.type === 'ready'),
  'webview 没有发出 ready 消息'
);
assert(
  (windowListeners.message ?? []).length > 0,
  'webview 没有注册 message 监听器'
);

function sendToWebview(message) {
  for (const handler of windowListeners.message ?? []) {
    handler({ data: message });
  }
}

// ------------------------------------------------------------ 投喂一帧数据

function makeSession(direction) {
  const nodes = {
    root: {
      id: 'root',
      name: 'leafAdd',
      file: 'demo.cpp',
      line: 12,
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
      name: 'compute',
      file: 'demo.cpp',
      line: 21,
      callSite: { file: 'demo.cpp', line: 24, text: 'int sum = leafAdd(x, 1);' },
      direction,
      depth: 1,
      isCycle: false,
      children: [],
      parent: 'root',
      loaded: true,
      canExpand: false,
      kind: 'function',
    },
  };
  return {
    id: `s-${direction}`,
    title: '被调用:leafAdd',
    description: 'demo.cpp:12',
    direction,
    engineLabel: 'C/C++ (cpptools) 1.34.4',
    rootId: 'root',
    nodes,
    edges: [
      {
        id: 'root->child',
        from: direction === 'callers' ? 'child' : 'root',
        to: direction === 'callers' ? 'root' : 'child',
        depth: 1,
      },
    ],
    boxes: {
      root: { x: 0, y: 0, width: 280, height: 84 },
      child: { x: 410, y: 0, width: 280, height: 84 },
    },
    collapsedCount: 0,
  };
}

sendToWebview({
  type: 'init',
  sessions: [makeSession('callers')],
  summaries: [
    {
      id: 's-callers',
      title: '被调用:leafAdd',
      description: 'demo.cpp:12',
      direction: 'callers',
    },
  ],
  activeId: 's-callers',
});

const viewBox = attributes.get('svg:viewBox');
console.log(`诊断: 注入的 viewBox = ${String(viewBox)}（画布 clientWidth=0）`);
assert(
  typeof viewBox === 'string' && viewBox.length > 0,
  'webview 没有设置 viewBox，图形不会被渲染'
);
const parts = String(viewBox)
  .trim()
  .split(/\s+/)
  .map(Number);
assert(parts.length === 4, `viewBox 应该有 4 个数字，实际 ${viewBox}`);
assert(
  parts.every((value) => Number.isFinite(value)),
  `viewBox 必须是有限数字，实际 ${viewBox}（这就是「什么都不显示」的原因）`
);
assert(parts[2] > 0 && parts[3] > 0, `viewBox 宽高必须为正，实际 ${viewBox}`);
assert(
  parts[2] > 100 && parts[3] > 40,
  `viewBox 可视区域太小（${parts[2]}x${parts[3]}），方框会被挡在窗口外——用户坐标必须等于像素`
);

// SVG 画布尺寸必须与 viewBox 一致，这样 1 用户单位 = 1 像素，字号才不会随窗口变化
const width = Number(attributes.get('svg:width'));
const height = Number(attributes.get('svg:height'));
assert(
  width === parts[2] && height === parts[3],
  `SVG 尺寸(${width}x${height})必须与 viewBox(${parts[2]}x${parts[3]})一致，否则文字会被拉伸`
);

// 检查确实创建了节点与连线
const countDeep = (element) =>
  element.children.reduce((sum, child) => sum + 1 + countDeep(child), 0);
const nodeCount = countDeep(elements.get('nodes'));
const edgeCount = countDeep(elements.get('edges'));
console.log(`诊断: 渲染出 ${nodeCount} 个节点元素、${edgeCount} 个连线元素`);
assert(nodeCount > 0, '没有渲染任何节点元素');
assert(edgeCount > 0, '没有渲染任何连线元素');

// 连线路径必须真的落在 viewBox 之内。
// 这一条是为了抓「方框宽度自适应失效」：量宽返回 0 时方框塌成最小宽度，
// 而箭头还按旧几何画，就会跑到可视区外面 —— 看起来就是「箭头没了」。
const edgePaths = [];
const collectPaths = (element) => {
  for (const child of element.children) {
    if (child.tagName === 'path') {
      edgePaths.push(String(child.getAttribute('d') ?? ''));
    }
    collectPaths(child);
  }
};
collectPaths(elements.get('edges'));
assert(edgePaths.length > 0, '连线里没有 <path>');
const viewLeft = parts[0];
const viewRight = parts[0] + parts[2];
for (const d of edgePaths) {
  const xs = [...d.matchAll(/[ML] ([-\d.eE]+) /g)].map((m) => Number(m[1]));
  assert(xs.length > 0, `连线路径解析不出坐标：${d}`);
  for (const x of xs) {
    assert(
      x >= viewLeft - 1 && x <= viewRight + 1,
      `连线坐标 x=${x} 落在 viewBox [${viewLeft}, ${viewRight}] 之外（箭头会看不见）：${d}`
    );
  }
}
console.log(`诊断: ${edgePaths.length} 条连线都在可视区内`);

// 标签栏也要有内容
const tabCount = countDeep(elements.get('tabs'));
console.log(`诊断: 渲染出 ${tabCount} 个标签元素`);
assert(tabCount > 0, '没有渲染标签栏');

console.log('OK: clientWidth=0 时仍渲染出有效 viewBox、节点、连线与标签');
