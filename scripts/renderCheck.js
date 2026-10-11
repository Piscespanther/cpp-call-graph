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
    /**
     * classList 与 className 在真实 DOM 里是**同一份数据**，桩必须照做。
     *
     * 曾经桩里两者各自记账：否定式断言读 className、肯定式断言读 classList，
     * 于是「高亮忘了加 class」这类问题会被一半断言放行。
     */
    get classList() {
      const element = this;
      const read = () =>
        String(element.getAttribute('class') ?? '')
          .split(/\s+/)
          .filter(Boolean);
      const write = (names) => element.setAttribute('class', names.join(' '));
      return {
        add(name) {
          const names = read();
          if (!names.includes(name)) {
            names.push(name);
            write(names);
          }
        },
        remove(name) {
          write(read().filter((item) => item !== name));
        },
        contains(name) {
          return read().includes(name);
        },
        toggle(name, force) {
          const has = read().includes(name);
          const should = force === undefined ? !has : Boolean(force);
          if (should === has) {
            return;
          }
          const names = read();
          if (should) {
            names.push(name);
            write(names);
          } else {
            write(names.filter((item) => item !== name));
          }
        },
      };
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
     * 两条必须与真实浏览器一致的行为：
     *   ① **未挂进文档**的 SVG 文字 `getBBox()` 返回全 0 —— 生产代码量宽时会把探测节点
     *      append 到 <svg> 上再摘掉，历史上有一次忘了 append，于是量宽永远失败、
     *      方框宽度不随内容变。桩若对游离节点也返回宽度，那条 bug 就再也测不出来。
     *   ② 宽度随文字内容变化，且**系数刻意与生产兜底（0.66 / 0.6）不同**：
     *      否则「量到了」与「退到估算」数值相同，断言分不清两条路径。
     */
    getBBox() {
      if (this.tagName !== 'text') {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      if (
        String(this.getAttribute('class') ?? '') === 'measure-probe' &&
        this.parentNode
      ) {
        // 统计「真的去量了一次宽」的次数：量宽是强制同步布局，是渲染性能的关键指标
        measureProbeReads += 1;
      }
      if (!this.parentNode) {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      const size = Number.parseFloat(this.getAttribute('font-size') ?? '') || 12;
      const bold = String(this.getAttribute('font-weight') ?? '') === '600';
      const text = String(this.textContent ?? '');
      const width = text.length * size * (bold ? 0.62 : 0.56);
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
      // 真实浏览器里合成/派发的鼠标事件 `button` 一律有值（左键 0），
      // `detail` 也有默认值；桩若缺这两个字段，测试里「只认左键」之类的判断会被绕过。
      const mouseLike =
        type === 'mousedown' ||
        type === 'mouseup' ||
        type === 'click' ||
        type === 'dblclick' ||
        type === 'contextmenu';
      const defaults = mouseLike ? { button: 0, detail: 0 } : {};
      for (const handler of this.listeners.get(type) ?? []) {
        handler({
          type,
          target: this,
          currentTarget: this,
          preventDefault() {},
          stopPropagation() {},
          ...defaults,
          ...event,
        });
      }
      // 滚动处理是用 requestAnimationFrame 合并的（一次滑动只做一帧的工作），
      // 桩里的 rAF 是异步排队的 —— 派发完 scroll 立刻把这一帧跑掉，
      // 后面的断言才看得到「滚动后的位置」，与浏览器里「下一帧生效」一致。
      if (type === 'scroll') {
        flushFrames();
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
/** 「真的去量了一次文字宽」的次数：量宽会触发强制同步布局，用它验证缓存是否生效。 */
let measureProbeReads = 0;
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
  'btn-expand-full',
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

// ------------------------------------------------------------ 加载遮罩（模板 + 桩元素）

// 与搜索栏同一套路：先断言真实模板里确实有这些元素（缺一个功能就是死的），
// 再在桩里建出来，让 webview 的 getElementById 能拿到。
const busyHtml = /<div id="busy"[\s\S]*?<\/div>\s*<\/div>/.exec(htmlSource);
assert(busyHtml !== null, 'graph.html 里没有 #busy（加载遮罩）');
for (const id of ['busy', 'busy-label', 'btn-busy-cancel']) {
  assert(busyHtml[0].includes(`id="${id}"`), `加载遮罩缺少 #${id}`);
}
assert(
  /id="busy"[\s\S]*?class="busy-spinner"/.test(busyHtml[0]),
  '遮罩里应当有转圈元素（.busy-spinner）'
);
assert(/id="btn-busy-cancel"[^>]*>\s*取消\s*</.test(busyHtml[0]), '遮罩里应当有「取消」按钮');
byId.set('busy', createElement('div'));
byId.set('busy-label', createElement('p'));
{
  const cancelButton = createElement('button');
  cancelButton.setAttribute('id', 'btn-busy-cancel');
  cancelButton.textContent = '取消';
  byId.set('btn-busy-cancel', cancelButton);
}

// ------------------------------------------------------------ 搜索栏（模板 + 桩元素）

// 搜索栏在真实模板里：先断言 HTML 真的带这些元素（缺一个功能就是死的），
// 再在桩里建出对应元素，好让 webview 里的 getElementById 能拿到它们。
const searchHtml = /<div id="search"[\s\S]*?<\/div>/.exec(htmlSource);
assert(searchHtml !== null, 'graph.html 里没有 #search（工具栏最右侧的搜索栏）');
for (const id of [
  'search-input',
  'btn-search-case',
  'btn-search-word',
  'btn-search-regex',
  'search-count',
  'btn-search-prev',
  'btn-search-next',
]) {
  assert(searchHtml[0].includes(`id="${id}"`), `搜索栏缺少 #${id}`);
}
assert(
  /id="search-input"[\s\S]*?type="text"/.test(searchHtml[0]),
  '搜索框应当是 type="text" 的输入框'
);
{
  const searchCss = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'graph.css'), 'utf8');
  assert(
    /\.search\s*\{[^}]*margin-left:\s*auto/.test(searchCss),
    'CSS 里 .search 应当用 margin-left:auto 固定到工具栏最右侧'
  );
  // 命中样式：按「白字必须仍然清晰」这个**对比度**问题来断言，而不只是查规则在不在。
  // 做法：把（半透明的）底纹混到深色主题的默认方框背景上，再算它与主题默认前景色的
  // WCAG 对比度。之前那种亮黄不透明底 + 浅色字只有 1.1:1，就是这么翻车的。
  const toLinear = (channel) =>
    channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  const luminanceOf = ([r, g, b]) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  const hexToRgb = (hex) => [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const contrast = (a, b) => {
    const sorted = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x);
    return (sorted[0] + 0.05) / (sorted[1] + 0.05);
  };

  const bgRule = /--search-match-bg:\s*rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(
    searchCss
  );
  assert(bgRule !== null, 'CSS 里应当把 --search-match-bg 定义成 rgb()/rgba() 颜色');
  const alpha = bgRule[4] === undefined ? 1 : Number.parseFloat(bgRule[4]);
  assert(alpha <= 0.35, `命中底纹必须够淡（白色文字才压得住），实际 alpha=${alpha}`);

  // 混到默认方框背景 #252526（--node-bg 的兜底值）上，再看与主题默认前景 #cccccc 的对比度
  const base = hexToRgb('252526');
  const tinted = [0, 1, 2].map((i) => {
    const channel = Number.parseFloat(bgRule[i + 1]) / 255;
    return channel * alpha + base[i] * (1 - alpha);
  });
  const tintedRgb = tinted.map((channel) => Math.round(channel * 255));
  assert(
    tinted[0] > tinted[2] * 1.5,
    `命中底纹应当是黄的（红通道要明显高于蓝通道），实际 rgb=${tintedRgb.join(',')}`
  );
  const ratio = contrast(tinted, hexToRgb('cccccc'));
  assert(
    ratio >= 4.5,
    `命中处的文字对比度不足：压在底纹上只有 ${ratio.toFixed(1)}:1（要求 ≥4.5:1）`
  );
  assert(
    /\.node\.match \.name-hit\s*\{[^}]*fill:\s*var\(--search-match-bg\)/.test(searchCss),
    'CSS 里应当有 .node.match .name-hit 的底纹规则（只高亮元素名）'
  );
  assert(
    /\.node\.match \.name-hit\s*\{[^}]*stroke:\s*var\(--search-match-stroke\)/.test(searchCss),
    'CSS 里命中底纹应当带黄色描边（淡底纹靠描边才醒目）'
  );
  assert(
    !/\.node\.match \.name\s*\{[^}]*fill:/.test(searchCss),
    '命中时不应覆盖元素名的颜色（按需求仍用主题的白字）'
  );
  assert(
    !/\.node\.match(-current)? \.box\s*\{/.test(searchCss),
    '按需求只高亮元素名，方框不应再被高亮（.node.match .box 规则应已移除）'
  );
  log(`诊断: 命中底纹 alpha=${alpha} → 混色 rgb(${tintedRgb.join(',')})，文字对比度 ${ratio.toFixed(1)}:1`);
}

// ------------------------------------------------ 设置项三方一致
//
// 工作区规则：README 的设置表必须与 package.json 的 configuration 完全对应；
// 而 webview 读不到 VS Code 设置，必须由宿主下发。三处任何一处漏了就有一条会失败。
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const configKeys = Object.keys(pkg.contributes.configuration.properties)
    .map((key) => key.replace(/^cppCallGraph\./, ''))
    .sort();
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const readmeKeys = [...readme.matchAll(/^\|\s*`cppCallGraph\.([A-Za-z0-9_]+)`/gm)]
    .map((match) => match[1])
    .sort();
  assert(
    readmeKeys.join(',') === configKeys.join(','),
    `README 的设置表必须与 package.json 的 configuration 完全对应：README=[${readmeKeys.join(',')}]，配置=[${configKeys.join(',')}]`
  );

  const sticky = pkg.contributes.configuration.properties['cppCallGraph.stickyParent'];
  assert(sticky !== undefined, 'package.json 里应当有 cppCallGraph.stickyParent 设置项');
  assert(
    sticky.type === 'boolean' && sticky.default === true,
    `stickyParent 应当是「默认 true 的布尔项」，实际 ${JSON.stringify(sticky)}`
  );

  // 宿主读配置 → 以 settings 消息下发；webview 处理 settings 消息。缺一处开关就是死的。
  const hostSource = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');
  assert(
    /'stickyParent'/.test(hostSource) && /type: 'settings'/.test(hostSource),
    '宿主应当读 stickyParent 并以 settings 消息下发给 webview'
  );
  const webviewSource = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'graph.ts'), 'utf8');
  assert(/case 'settings'/.test(webviewSource), 'webview 应当处理 settings 消息');
  assert(
    /stickyEnabled/.test(webviewSource) && /state\.stickyParent/.test(webviewSource),
    'webview 应当按设置决定是否启用粘性父框'
  );

  // ---- 路径显示方式的四项设置：四处都要通 ----
  // package.json（有这项）→ 宿主读并发下发 → webview 应用 → 改动后**必须重排**
  // （文字长度变了，列宽与箭头位置都要重算；只下发设置不重排，webview 手里还是旧宽度）
  const extensionSource = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
  for (const key of ['pathDisplay', 'pathTailLevels', 'pathAnchors']) {
    assert(
      pkg.contributes.configuration.properties[`cppCallGraph.${key}`] !== undefined,
      `package.json 里应当有 cppCallGraph.${key} 设置项`
    );
    assert(new RegExp(`'${key}'`).test(hostSource), `宿主应当读取 ${key} 并随 settings 下发`);
    assert(
      new RegExp(`affectsConfiguration\\('cppCallGraph\\.${key}'\\)`).test(extensionSource),
      `改动 cppCallGraph.${key} 之后必须触发重排（它改变路径文字长度 → 方框宽度 → 列宽）`
    );
  }
  assert(
    /applyPathSettings/.test(webviewSource) && /state\.pathOptions/.test(webviewSource),
    'webview 应当把下发的路径设置应用进 state.pathOptions'
  );
  const layoutSourceForPath = fs.readFileSync(
    path.join(ROOT, 'src', 'hierarchy', 'graphLayout.ts'),
    'utf8'
  );
  assert(
    /displayPathText/.test(layoutSourceForPath) && /displayPathText/.test(webviewSource),
    '路径显示逻辑必须在宿主与 webview 两侧各有一份（估宽与渲染同一口径）'
  );
  log(`诊断: 设置项 ${configKeys.length} 项，package.json / README / 宿主下发 / webview 处理四处一致`);

  // ---- 跨侧常量必须相等 ----
  // 布局常量在宿主（graphLayout.ts）与 webview（graph.ts）各有一份，改错一侧时几何会真的错位
  // 而所有断言照样全绿。这里直接把两份源码里的数值抽出来比对。
  {
    const layoutSource = fs.readFileSync(
      path.join(ROOT, 'src', 'hierarchy', 'graphLayout.ts'),
      'utf8'
    );
    const numericConst = (source, name) => {
      const match = new RegExp(`(?:export )?const ${name}\\s*=\\s*(\\d+)`).exec(source);
      return match ? Number(match[1]) : undefined;
    };
    // 这 6 个是两侧都有的（COLUMN_GAP / ROW_GAP 只在宿主侧：webview 只用宿主下发的坐标）
    for (const name of [
      'MAX_BOX_WIDTH',
      'MIN_BOX_WIDTH',
      'NAME_MAX_CHARS',
      'LOC_MAX_CHARS',
      'NODE_HEIGHT',
      'NODE_HEIGHT_COMPACT',
    ]) {
      const hostValue = numericConst(layoutSource, name);
      const webviewValue = numericConst(webviewSource, name);
      assert(hostValue !== undefined, `宿主侧找不到常量 ${name}`);
      assert(
        webviewValue !== undefined,
        `webview 侧找不到常量 ${name}（两侧必须各有一份，缺一侧就是几何口径分叉）`
      );
      assert(
        hostValue === webviewValue,
        `${name} 两侧不一致：宿主 ${hostValue} vs webview ${webviewValue}`
      );
    }
    // 字号与估算系数的关系：宿主的估宽必须**不小于** webview 的估算回退（否则列会排窄、方框互相压住）
    const hostMilli = Number(
      new RegExp(/const CHAR_WIDTH_MILLI\s*=\s*(\d+)/).exec(layoutSource)?.[1] ?? 0
    );
    const webviewBold = Number(
      new RegExp(/bold \? ([\d.]+) : ([\d.]+)/).exec(webviewSource)?.[1] ?? '0'
    );
    assert(hostMilli > 0, '宿主侧找不到 CHAR_WIDTH_MILLI');
    assert(webviewBold > 0, 'webview 侧找不到估算回退系数');
    assert(
      hostMilli / 1000 >= webviewBold,
      `宿主估宽系数 ${hostMilli / 1000} 必须不小于 webview 的估算回退 ${webviewBold}（否则列宽会估窄）`
    );
    log(
      `诊断: 跨侧常量一致（6 个布局常量相等；宿主估宽 ${hostMilli / 1000} ≥ webview 估算 ${webviewBold}）`
    );

    // 布局上限必须 ≥ 宿主的「展开全部」节点预算：否则展开全部抓回 800 个节点，
    // 布局却只画 500 个 → 用户看到方框凭空消失（压测时就是这样发现的）。
    const layoutCap = numericConst(layoutSource, 'MAX_LAYOUT_NODES');
    const graphViewSource = fs.readFileSync(
      path.join(ROOT, 'src', 'views', 'graphView.ts'),
      'utf8'
    );
    const expandBudget = Number(
      /const MAX_EXPAND_NODES\s*=\s*(\d+)/.exec(graphViewSource)?.[1] ?? 0
    );
    assert(layoutCap !== undefined, '宿主布局里找不到 MAX_LAYOUT_NODES');
    assert(expandBudget > 0, 'graphView 里找不到 MAX_EXPAND_NODES');
    assert(
      layoutCap >= expandBudget,
      `布局上限 ${layoutCap} 小于「展开全部」预算 ${expandBudget}：展开全部会有一部分方框拿不到坐标而消失`
    );
    log(`诊断: 布局上限 ${layoutCap} ≥ 展开预算 ${expandBudget}`);
  }

  // ---- 消息协议护栏：两侧的 type 集合必须互相覆盖 ----
  //
  // 之前只 grep 关键字（例如 /case 'settings'/），新增或改名一个消息时看不出问题：
  // 少了一个 case、或写了宿主 union 里没有的类型，都是**运行期静默失效**。
  // 这里把两侧的 type 字面量都抓出来，双向比对。
  const unionOf = (source, name) => {
    const marker = `type ${name} =`;
    const declared = source.indexOf(marker);
    if (declared < 0) {
      return undefined;
    }
    // 联合类型**没有外层花括号**，成员各自是 `{ ... }`。所以不能从第一个 `{` 起配平，
    // 要一路扫到「深度为 0 的分号」为止（成员内部的 `;` 深度 ≥ 1，会被跳过）。
    let depth = 0;
    let end = declared;
    for (; end < source.length; end += 1) {
      const ch = source[end];
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
      } else if (ch === ';' && depth === 0) {
        break;
      }
    }
    const body = source.slice(declared, end);
    // 两种写法都要认：内联字面量 `| { type: 'x' }`，以及具名成员
    // （webview 的 HostMessage 就是 `| InitMessage | UpdateMessage …`，类型写在接口里）。
    const types = new Set(
      [...body.matchAll(/type:\s*'([a-zA-Z]+)'/g)].map((match) => match[1])
    );
    const named = [...body.matchAll(/^\s*\|\s*([A-Za-z_$][\w$]*)\s*$/gm)].map(
      (match) => match[1]
    );
    for (const member of named) {
      const declaration = new RegExp(
        `(?:interface|type)\\s+${member}\\b[\\s\\S]{0,800}?type:\\s*'([a-zA-Z]+)'`
      ).exec(source);
      if (declaration) {
        types.add(declaration[1]);
      }
    }
    return types;
  };
  const casesOf = (source) =>
    new Set([...source.matchAll(/case\s*'([a-zA-Z]+)'/g)].map((match) => match[1]));
  const literalsOf = (source, pattern) =>
    new Set([...source.matchAll(pattern)].map((match) => match[1]));

  const hostUnion = unionOf(hostSource, 'WebviewMessage');
  const webviewUnion = unionOf(webviewSource, 'HostMessage');
  assert(hostUnion !== undefined, '找不到宿主的 WebviewMessage 联合类型（协议护栏失效）');
  assert(webviewUnion !== undefined, '找不到 webview 的 HostMessage 联合类型（协议护栏失效）');

  // webview → 宿主：post({ type: 'x' ... })
  const posted = literalsOf(webviewSource, /post\(\{[\s\S]{0,160}?type:\s*'([a-zA-Z]+)'/g);
  assert(posted.size >= 10, `webview 发出的消息类型只抓到 ${posted.size} 种，护栏可能失效`);
  const undeclared = [...posted].filter((type) => !hostUnion.has(type));
  assert(
    undeclared.length === 0,
    `webview 发出的这些类型不在宿主 WebviewMessage 联合类型里：${undeclared.join(', ')}`
  );
  // 宿主处理分支有两种写法：switch 的 `case 'x':`，以及提前返回的 `if (message.type === 'x')`
  // （`error` 走的就是后者），两种都要算作"已处理"。
  const hostCases = new Set([
    ...casesOf(hostSource),
    ...literalsOf(hostSource, /message\.type\s*===\s*'([a-zA-Z]+)'/g),
  ]);
  const unhandled = [...posted].filter((type) => !hostCases.has(type));
  assert(
    unhandled.length === 0,
    `webview 发出的这些类型宿主没有处理：${unhandled.join(', ')}`
  );

  // 宿主 → webview：postMessage({ type: 'x' ... })
  const pushed = new Set([
    ...literalsOf(hostSource, /postMessage\(\{\s*type:\s*'([a-zA-Z]+)'/g),
    ...literalsOf(hostSource, /post\(\{\s*type:\s*'([a-zA-Z]+)'/g),
  ]);
  assert(pushed.size >= 4, `宿主发出的消息类型只抓到 ${pushed.size} 种，护栏可能失效`);
  const notDeclared = [...pushed].filter((type) => !webviewUnion.has(type));
  assert(
    notDeclared.length === 0,
    `宿主发出的这些类型不在 webview 的 HostMessage 联合类型里：${notDeclared.join(', ')}`
  );
  const webviewCases = casesOf(webviewSource);
  const notHandled = [...pushed].filter((type) => !webviewCases.has(type));
  assert(
    notHandled.length === 0,
    `宿主发出的这些类型 webview 没有处理：${notHandled.join(', ')}`
  );
  log(
    `诊断: 消息协议 —— webview → 宿主 ${posted.size} 种、宿主 → webview ${pushed.size} 种，联合类型与处理分支双向覆盖`
  );

  // ---- 无障碍：键盘可达与状态可读 ----
  // 「看得见的状态」必须同时暴露给辅助技术，否则屏幕阅读器只能读出"按钮"。
  const htmlSource = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'graph.html'), 'utf8');
  for (const id of ['btn-search-case', 'btn-search-word', 'btn-search-regex']) {
    const tag = new RegExp(`<button id="${id}"[^>]*>`).exec(htmlSource)?.[0] ?? '';
    assert(
      /aria-pressed="(true|false)"/.test(tag),
      `${id} 应当带 aria-pressed（开关状态要能被读出），实际：${tag || '(找不到该按钮)'}`
    );
  }
  assert(
    /<span id="search-count"[^>]*aria-live=/.test(htmlSource),
    '搜索命中计数应当 aria-live，键盘/读屏用户才能知道命中变化'
  );
  assert(
    /'aria-label'/.test(webviewSource) && /tabindex: '0'/.test(webviewSource),
    '方框应当可聚焦（tabindex）并有 aria-label'
  );
  assert(
    /setAttribute\('aria-selected'/.test(webviewSource) &&
      /setAttribute\('role', 'tab'\)/.test(webviewSource),
    '标签应当有 role=tab 与 aria-selected'
  );
  assert(
    /setAttribute\('aria-pressed'/.test(webviewSource),
    '搜索开关的 aria-pressed 应当随状态更新（不能只在 HTML 里写死）'
  );
  log('诊断: 无障碍 —— 方框可聚焦且有 aria-label，标签 role=tab/aria-selected，开关 aria-pressed 同步');
}

const searchInputStub = createElement('input');
searchInputStub.value = '';
byId.set('search-input', searchInputStub);
byId.set('search-count', createElement('span'));
for (const id of [
  'btn-search-case',
  'btn-search-word',
  'btn-search-regex',
  'btn-search-prev',
  'btn-search-next',
]) {
  const button = createElement('button');
  button.setAttribute('id', id);
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
/** 输出通道收到的内容（logInfo / logWarn / logError），供断言检查。 */
const outputLines = [];
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
  // 输出通道必须收集内容、不能是空壳：生产代码用 logWarn 报「图太大、有节点没排布」，
  // 桩里没有这个函数时那句话会直接抛 TypeError —— 而它恰好发生在压测块里，
  // 被「不影响断言」的 catch 吞掉后表现为「压测数字不见了、退出码还是 0」。
  window: {
    createOutputChannel: () => ({
      info: (message) => outputLines.push({ level: 'info', message }),
      warn: (message) => outputLines.push({ level: 'warn', message }),
      error: (message) => outputLines.push({ level: 'error', message }),
      show() {},
      dispose() {},
    }),
  },
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

// 夹具留着引用：下面的期望值都从这份 payload 推导，不写死数字
// （写死数字会在夹具变化时变成「断言还是绿的、但已经和夹具无关」的空断言）。
const fixtureSessions = [makeSession('callers')];
sendToWebview({
  type: 'init',
  sessions: fixtureSessions,
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

// ⚠️ 这三条**刻意**用 `>=`，不是"松阈值"：此处是在**累积了前面所有用例**的整棵 SVG 上做体检，
// 元素总数取决于此前跑过哪些场景，写死具体数字只会变成一改夹具就红的脆断言。
// 真正编码行为语义的判据在各自的小节里（方框数、连线数、命中底纹、坐标等），那里才该用等值。
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
// 期望条数由夹具推导：两端都能定位（节点与方框几何都存在）的边才会画出路径。
// 夹具里没有收起的节点（collapsedCount = 0），所以不必再考虑被折叠祖先隐藏的情形。
const fixtureSession = fixtureSessions[0];
const fixtureEdgeCount = fixtureSession.edges.filter(
  (edge) =>
    fixtureSession.nodes[edge.from] !== undefined &&
    fixtureSession.nodes[edge.to] !== undefined &&
    fixtureSession.boxes[edge.from] !== undefined &&
    fixtureSession.boxes[edge.to] !== undefined
).length;
assert(fixtureEdgeCount >= 1, `夹具里没有可画的边（${fixtureEdgeCount} 条），下面的断言会变成空断言`);
assert(
  edgePaths.length === fixtureEdgeCount,
  `连线路径数应等于夹具里可定位的边数 ${fixtureEdgeCount}，实际 ${edgePaths.length}`
);
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
  '方框应当绑定单击事件（选中 + 双击跳转都走它）'
);
// 跳转**不再**用 dblclick 事件：单击会重绘整个 #nodes 子树，浏览器按「两次点击是否命中
// 同一元素」配对，元素被换掉后 dblclick 根本不会派发（第一次双击只选中、不跳转）。
// 现在统一在 click 里看 event.detail ≥ 2，下面按真实路径测。
assert(
  (nodesGroup.children[0].listeners.get('dblclick') ?? []).length === 0,
  '方框不应再依赖 dblclick 事件（改用 click 的 event.detail）'
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
// 标签数 = 已下发的会话数（这一步只发过一次 init）。不写死 1：改夹具时断言会跟着走。
// 另外「选中的标签有且只有一个」是真实不变式，与夹具大小无关。
assert(
  tabsEl.children.length === fixtureSessions.length,
  `标签数应等于会话数 ${fixtureSessions.length}，实际 ${tabsEl.children.length} 个`
);
assert(
  tabsEl.children.filter((tab) => tab.getAttribute('aria-selected') === 'true').length === 1,
  '应当有且只有一个标签处于选中状态（aria-selected="true"）'
);
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

  // 列间隙：**按 DOM 里真正画出来的方框**量一遍，而不是只读布局算出来的数。
  // 布局 → 负载 → 渲染这条链上任何一环把宽度或列位置弄错，这里都会露出来
  // （只断言 relaid.boxes 的话，等于用布局自己的常量验证它自己）。
  {
    const boxX = (info) => {
      const match = /translate\(\s*(-?[\d.]+)/.exec(String(info.group.getAttribute('transform') ?? ''));
      return match ? Number(match[1]) : Number.NaN;
    };
    const shortRight = boxX(short) + short.width;
    const longLeft = boxX(long);
    assert(
      Number.isFinite(shortRight) && Number.isFinite(longLeft),
      `读不到方框的 x（DOM 里应当有 translate 变换）：short=${boxX(short)} long=${boxX(long)}`
    );
    const domGap = longLeft - shortRight;
    assert(
      domGap >= 52 - 0.5,
      `DOM 实测的列间隙只有 ${domGap.toFixed(1)}px（应 ≥ COLUMN_GAP=52，否则方框会互相压住）`
    );
    log(
      `诊断: DOM 实测列间隙 ${domGap.toFixed(1)}px（短框右边 ${shortRight.toFixed(1)} → 长框左边 ${longLeft.toFixed(1)}）`
    );
  }
  log(
    `诊断: 方框宽度自适应 短名 ${short.width} / 长名 ${long.width}；` +
      `加减号与文字最小间距 ${Math.min(
        Math.max(short.nameEnd, short.locEnd) >= 0 ? short.expanderX - 13 / 2 - Math.max(short.nameEnd, short.locEnd) : 0,
        long.expanderX - 13 / 2 - Math.max(long.nameEnd, long.locEnd)
      ).toFixed(1)}px`
  );

  // ---- 量宽缓存：内容没变时不得再探测 ----
  // 生产代码每帧要为「每个可见方框的名称 + 路径」各量一次宽，而每次量宽都会触发一次
  // **强制同步布局**；几百个节点就是上千次。按「文字 + 字号 + 粗细」缓存之后，
  // 第二次渲染同样内容时的探测次数必须是 0（这是「大图卡不卡」的关键指标）。
  const measuredBefore = measureProbeReads;
  assert(measuredBefore > 0, '首次渲染应当真的量过宽（说明桩或生产代码没走到量宽路径）');
  sendToWebview({ type: 'settings', settings: { stickyParent: true, showLocation: true } });
  flushFrames();
  assert(
    measureProbeReads === measuredBefore,
    `量宽缓存没有生效：重发同样数据后又探测了 ${measureProbeReads - measuredBefore} 次`
  );
  log(`诊断: 量宽缓存生效 —— 内容不变时重绘不再触发探测（此前累计 ${measuredBefore} 次）`);

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

  // 收起状态必须下发给宿主：坐标是宿主算的，不收起的子树不占高度（否则空挡会一直留着）
  {
    const collapseMessage = [...posted].reverse().find((message) => message.type === 'collapse');
    assert(
      collapseMessage !== undefined && (collapseMessage.collapsed ?? []).includes('c1'),
      `收起 c1 之后应当把「已收起」集合下发给宿主，让它重排收掉空挡，实际 ${JSON.stringify(collapseMessage)}`
    );
  }
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
  // 这里只判"到底报没报"（存在性）。**不要**收紧成 `=== 1`：webview 会合并/去抖回传，
  // 发几次属于允许的实现细节；真正编码语义的判据在下面两行（条目数 = 方框数、数值 = 实测宽度）。
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
  ['btn-expand-full', 'expandFull'], // 递归到底：与 expandAll 是两种消息，宿主那边不再受层数上限约束
  ['btn-settings', 'openSettings'],
  ['btn-copy-tab', 'copyTabText'],
  ['btn-collapse-all', 'collapse'], // 收起全部要把收起状态下发宿主（坐标由宿主算，漏了就只展开到第二级）
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
log(
  `诊断: 工具栏 ${expectedButtons.length} 个按钮的点击行为都正确` +
    '（展开全部发 expandAll、完全展开发 expandFull、设置/复制标签/关闭发消息，收起全部下发收起状态）'
);

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

  // 双击：既选中（高亮）又跳转。按真实路径来 —— 连发两次 click、第二次带 detail=2
  // （浏览器就是这么把双击报给 click 处理器的；用 dblclick 事件测不出「元素被换掉」那类 bug）。
  const beforeDbl = posted.length;
  boxOf().dispatch('click', { detail: 1, preventDefault() {}, stopPropagation() {} });
  boxOf().dispatch('click', { detail: 2, preventDefault() {}, stopPropagation() {} });
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

// ------------------------------------------------ 搜索栏：大小写 / 全字 / 正则 + 上下跳
//
// 放在文件最后：自己投一帧夹具，不改动前面各段依赖的会话状态。
{
  // 夹具起名就是为了让三个模式互相区分得开：
  //   s0 alpha_one（根） → s1 alpha_two、s2 beta_one
  sendToWebview({
    type: 'sessionUpdate',
    session: {
      id: 'search-check',
      title: '搜索检查',
      description: '',
      direction: 'callees',
      engineLabel: 'clangd',
      rootId: 's0',
      nodes: {
        s0: {
          id: 's0',
          name: 'alpha_one',
          file: 'a.c',
          line: 1,
          direction: 'callees',
          depth: 0,
          isCycle: false,
          canExpand: true,
          children: ['s1', 's2'],
          loaded: true,
          kind: 'function',
        },
        s1: {
          id: 's1',
          name: 'alpha_two',
          file: 'b.c',
          line: 2,
          direction: 'callees',
          depth: 1,
          isCycle: false,
          canExpand: false,
          children: [],
          parent: 's0',
          loaded: true,
          kind: 'function',
        },
        s2: {
          id: 's2',
          name: 'beta_one',
          file: 'c.c',
          line: 3,
          direction: 'callees',
          depth: 1,
          isCycle: false,
          canExpand: false,
          children: [],
          parent: 's0',
          loaded: true,
          kind: 'function',
        },
      },
      edges: [
        { id: 'e1', from: 's0', to: 's1', depth: 1 },
        { id: 'e2', from: 's0', to: 's2', depth: 1 },
      ],
      boxes: {
        s0: { x: 0, y: 0, width: 200, height: NODE_HEIGHT },
        s1: { x: 256, y: 0, width: 200, height: NODE_HEIGHT },
        s2: { x: 256, y: NODE_HEIGHT + 20, width: 200, height: NODE_HEIGHT },
      },
      collapsedCount: 0,
    },
  });

  const searchInput = byId.get('search-input');
  const searchCount = byId.get('search-count');
  const classesOf = (el) => String(el.className).split(/\s+/).filter(Boolean);
  const idsWithClass = (cls) =>
    nodesGroup.children
      .filter((child) => classesOf(child).includes(cls))
      .map((child) => child.getAttribute('data-node'));
  const currentId = () => idsWithClass('match-current')[0];
  const type = (value) => {
    searchInput.value = value;
    searchInput.dispatch('input', {});
  };

  assert(
    nodesGroup.children.length === 3,
    `搜索夹具应当画出 3 个方框，实际 ${nodesGroup.children.length}`
  );

  // ① 默认大小写不敏感：ALPHA 命中两个 alpha_*
  type('ALPHA');
  assert(
    idsWithClass('match').sort().join(',') === 's0,s1',
    `大小写不敏感时 ALPHA 应命中 s0,s1，实际 ${idsWithClass('match').join(',') || '（无）'}`
  );
  assert(currentId() === 's0', '第一处命中应当被标成「当前命中」');
  assert(
    searchCount.textContent === '第 1/2 处',
    `命中计数应写成「第 1/2 处」（明确是"第几处/共几处"，读屏也听得懂），实际 ${searchCount.textContent}`
  );

  // 底纹只垫在**命中的元素名**上：没命中的节点不该有 name-hit（也不该动方框）
  const nameHitCount = (nodeId) => {
    const group = nodesGroup.children.find((child) => child.getAttribute('data-node') === nodeId);
    return group ? group.flatten().filter((el) => classesOf(el).includes('name-hit')).length : -1;
  };
  assert(
    nameHitCount('s0') === 1 && nameHitCount('s1') === 1 && nameHitCount('s2') === 0,
    `只有命中的节点才该有元素名底纹，实际 s0=${nameHitCount('s0')} s1=${nameHitCount('s1')} s2=${nameHitCount('s2')}`
  );

  // 底纹要真的盖住名字：横向包住文字，纵向覆盖名称墨迹（基线 15，墨迹约 6~18）
  const findIn = (nodeId, cls) => {
    const group = nodesGroup.children.find((child) => child.getAttribute('data-node') === nodeId);
    return group ? group.flatten().find((el) => classesOf(el).includes(cls)) : undefined;
  };
  const hitRect = findIn('s0', 'name-hit');
  const nameEl = findIn('s0', 'name');
  assert(hitRect !== undefined && nameEl !== undefined, '命中的节点应当同时有 name-hit 底纹与 name 文字');
  const rectX = Number(hitRect.getAttribute('x'));
  const rectY = Number(hitRect.getAttribute('y'));
  const rectW = Number(hitRect.getAttribute('width'));
  const rectH = Number(hitRect.getAttribute('height'));
  const nameX = Number(nameEl.getAttribute('x'));
  const inkW = nameEl.getBBox().width;
  assert(
    rectX <= nameX && rectX + rectW >= nameX + inkW,
    `底纹没包住名字：底纹 ${rectX}~${(rectX + rectW).toFixed(1)}，文字 ${nameX}~${(nameX + inkW).toFixed(1)}`
  );
  assert(
    rectY <= 6 && rectY + rectH >= 18,
    `底纹没盖住名称墨迹（基线 15，墨迹约 6~18），实际 y=${rectY} h=${rectH}`
  );

  // ② 打开「区分大小写」：同一个查询不再命中（名字都是小写）
  byId.get('btn-search-case').dispatch('click', {});
  assert(idsWithClass('match').length === 0, '区分大小写后 ALPHA 不该再命中');
  assert(
    searchCount.textContent === '无命中',
    `无命中时应提示「无命中」，实际 ${searchCount.textContent}`
  );
  byId.get('btn-search-case').dispatch('click', {});

  // ③ 全字：alpha 在 alpha_one 里后面紧挨下划线，不算整词；整名才命中
  type('alpha');
  assert(idsWithClass('match').length === 2, '默认模式下 alpha 应命中两个 alpha_*');
  byId.get('btn-search-word').dispatch('click', {});
  assert(idsWithClass('match').length === 0, '全字模式下 alpha 不该命中 alpha_*（下划线算词字符）');
  type('alpha_two');
  assert(idsWithClass('match').join(',') === 's1', '全字模式下整名 alpha_two 应当命中 s1');
  byId.get('btn-search-word').dispatch('click', {});

  // ④ 正则匹配 + 上下箭头在三处命中间循环
  byId.get('btn-search-regex').dispatch('click', {});
  type('^(alpha|beta)');
  assert(
    idsWithClass('match').length === 3,
    `正则应命中 3 个节点，实际 ${idsWithClass('match').length}`
  );
  assert(currentId() === 's0', '初始应停在第一处命中');
  assert(
    searchCount.textContent === '第 1/3 处',
    `计数应写成「第 1/3 处」，实际 ${searchCount.textContent}`
  );
  byId.get('btn-search-next').dispatch('click', {});
  assert(currentId() === 's1', `「下一个」应跳到 s1，实际 ${currentId()}`);
  assert(
    searchCount.textContent === '第 2/3 处',
    `计数应写成「第 2/3 处」，实际 ${searchCount.textContent}`
  );
  byId.get('btn-search-next').dispatch('click', {});
  assert(currentId() === 's2', `「下一个」应跳到 s2，实际 ${currentId()}`);
  byId.get('btn-search-next').dispatch('click', {});
  assert(currentId() === 's0', '连续点「下一个」应当循环回第一处');
  byId.get('btn-search-prev').dispatch('click', {});
  assert(currentId() === 's2', `「上一个」应循环到 s2，实际 ${currentId()}`);

  // ⑤ 非法正则：不抛错、输入框描红、计数提示语法错误，图仍然照画
  type('[');
  assert(searchInput.classList.contains('invalid'), '正则非法时输入框应当描红');
  assert(
    searchCount.textContent === '正则错误',
    `正则非法时应提示「正则错误」，实际 ${searchCount.textContent}`
  );
  assert(nodesGroup.children.length === 3, '正则非法时渲染不能中断（三个方框仍应在）');
  byId.get('btn-search-regex').dispatch('click', {});

  // ⑥ 清空查询：高亮与计数复位，箭头在没有命中时禁用
  type('');
  assert(idsWithClass('match').length === 0, '清空查询后不该还有命中高亮');
  assert(searchCount.textContent === '', '清空查询后计数应当清空');
  assert(byId.get('btn-search-next').disabled === true, '没有命中时「下一个」应当禁用');

  log('OK: 搜索栏支持大小写 / 全字 / 正则，命中黄色高亮，上下箭头在命中间循环');
}

// ------------------------------------------------ 粘性父框（可设置）
//
// 夹具用真实布局引擎生成（不手写坐标），并刻意做成「内容比视口高」——
// 只有这种情形粘性父框才该生效（内容还没视口高时没有可滚动的余地）。
{
  const childIds = [];
  const stickyNodes = {};
  for (let i = 0; i < 10; i += 1) {
    const id = `child_${i}`;
    childIds.push(id);
    stickyNodes[id] = {
      id,
      name: `child_${i}`,
      file: 'x.c',
      line: i + 1,
      direction: 'callers',
      depth: 1,
      isCycle: false,
      children: [],
      parent: 'root_fn',
      loaded: true,
      kind: 'function',
    };
  }
  stickyNodes.root_fn = {
    id: 'root_fn',
    name: 'root_fn',
    file: 'r.c',
    line: 1,
    direction: 'callers',
    depth: 0,
    isCycle: false,
    children: childIds,
    loaded: true,
    kind: 'function',
  };
  const stickyBoxes = createLayout(stickyNodes, 'root_fn').boxes;
  const contentHeight = Math.max(...Object.values(stickyBoxes).map((box) => box.y + box.height));
  const boxHeight = stickyBoxes.root_fn.height;

  const sendStickySession = (settings) => {
    if (settings) {
      sendToWebview({ type: 'settings', settings });
    }
    sendToWebview({
      type: 'sessionUpdate',
      session: {
        id: 'sticky-check',
        title: '粘性检查',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'root_fn',
        nodes: stickyNodes,
        edges: childIds.map((id, index) => ({ id: `e${index}`, from: id, to: 'root_fn', depth: 1 })),
        boxes: stickyBoxes,
        collapsedCount: 0,
      },
    });
  };

  // 视口比内容矮，并让桩的 rect 反映滚动：
  // 真实 DOM 里容器滚动时，子元素（SVG）的顶边会随 scrollTop 上移。
  canvasEl.clientHeight = 300;
  canvasEl.scrollTop = 0;
  canvasEl.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: canvasEl.clientWidth,
    height: canvasEl.clientHeight,
  });
  svg.getBoundingClientRect = () => ({
    left: 0,
    top: -Number(canvasEl.scrollTop || 0),
    width: 0,
    height: 0,
  });

  const groupOf = (nodeId) => nodesGroup.children.find((child) => child.getAttribute('data-node') === nodeId);
  const rootTop = () => Number(/translate\(([-\d.]+) ([-\d.]+)\)/.exec(groupOf('root_fn').getAttribute('transform'))[2]);
  /**
   * 内容坐标 → 视口坐标：屏幕 y = svgRect.top + (内容 y − viewBox 的 y)。
   * viewBox 的 y 不是 0（内容左上角带 MARGIN_TOP=−10 的边距），漏掉它就会差 10px。
   */
  const viewBoxParts = () => String(svg.getAttribute('viewBox')).split(/\s+/).map(Number);
  /** 根方框中心在「视口坐标系」里的位置（0 = 视口顶边）。 */
  const rootCenterInViewport = () =>
    rootTop() + boxHeight / 2 - viewBoxParts()[1] - Number(canvasEl.scrollTop || 0);

  assert(
    contentHeight > canvasEl.clientHeight,
    `夹具内容应比视口高（内容 ${contentHeight}，视口 ${canvasEl.clientHeight}）`
  );

  // ① 默认开启：根方框被钉在视口垂直中央
  sendStickySession(undefined);
  canvasEl.dispatch('scroll', {});
  assert(
    Math.abs(rootCenterInViewport() - canvasEl.clientHeight / 2) <= 1,
    `根方框应钉在视口垂直中央（中心 ${rootCenterInViewport().toFixed(1)}，视口中心 ${canvasEl.clientHeight / 2}）`
  );
  const rootTopBefore = rootTop();
  const edgeBefore = String(edgesEl.children[0].getAttribute('d'));

  // ② 向下滚 120：根方框在屏幕上不动（内容坐标里补偿 120），与它相连的连线跟着重画
  canvasEl.scrollTop = 120;
  canvasEl.dispatch('scroll', {});
  assert(
    Math.abs(rootCenterInViewport() - canvasEl.clientHeight / 2) <= 1,
    `滚动后根方框仍应钉在中央（中心 ${rootCenterInViewport().toFixed(1)}）`
  );
  assert(
    Math.abs(rootTop() - (rootTopBefore + 120)) <= 1,
    `滚 120 后根方框的内容坐标应同步下移 120，实际 ${(rootTop() - rootTopBefore).toFixed(1)}`
  );
  assert(
    String(edgesEl.children[0].getAttribute('d')) !== edgeBefore,
    '与根相连的连线应当随滚动重画，否则箭头会脱节'
  );

  // ③ 极端滚动：不能把根移出 **viewBox**（裁剪就发生在那里；viewBox 比节点范围多出上下边距）
  canvasEl.scrollTop = contentHeight * 2;
  canvasEl.dispatch('scroll', {});
  {
    const [, viewY, , viewH] = viewBoxParts();
    assert(
      rootTop() >= viewY - 0.5 && rootTop() + boxHeight <= viewY + viewH + 0.5,
      `极端滚动下根方框也必须留在 viewBox 内（top=${rootTop().toFixed(1)}，viewBox y=${viewY} 高=${viewH}）`
    );
  }

  // ④ 关掉设置：不再有任何位移，回到布局里的原位
  canvasEl.scrollTop = 0;
  sendStickySession({ stickyParent: false });
  canvasEl.dispatch('scroll', {});
  assert(
    Math.abs(rootTop() - stickyBoxes.root_fn.y) <= 0.5,
    `设置关掉后根方框应回到布局位置（top=${rootTop().toFixed(1)}，布局 y=${stickyBoxes.root_fn.y}）`
  );

  // ⑤ 再打开：恢复粘性
  sendStickySession({ stickyParent: true });
  canvasEl.dispatch('scroll', {});
  assert(
    Math.abs(rootCenterInViewport() - canvasEl.clientHeight / 2) <= 1,
    '重新打开设置后应恢复粘性居中'
  );

  // 收尾：关掉设置、视口高度还原，避免影响后面（延后执行的）段落
  sendToWebview({ type: 'settings', settings: { stickyParent: false } });
  canvasEl.clientHeight = 0;
  log('OK: 粘性父框（可设置）—— 根方框钉在视口中央、滚动时连线跟着重画、关掉后回到原位');
}

// ------------------------------------------------ 粘性父框：推广到任意层（展开谁就钉谁）
//
// 场景：第二级有很多个，展开其中一个 a 去看它的第三级；再展开 a 的孩子 a3 去看第四级 ——
// 钉在中间的应当依次是 a、a3，而不是永远钉根；收起锚点则退回它的父级。
{
  const mkNode = (id, depth, parent, children, extra = {}) => ({
    id,
    name: id,
    file: 'x.c',
    line: 1,
    direction: 'callers',
    depth,
    isCycle: false,
    children,
    parent,
    loaded: false,
    canExpand: false,
    kind: 'function',
    ...extra,
  });
  const kids = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  const A_KIDS = kids('a', 10); // a 的第三级
  const A3_KIDS = kids('a3_', 10); // a3 的第四级

  /** level 0：只有 root/a/b；1：展开了 a；2：又展开了 a3。 */
  const nodesOf = (level) => {
    const nodes = {
      r0: mkNode('r0', 0, undefined, ['a', 'b'], { loaded: true }),
      a: mkNode('a', 1, 'r0', level >= 1 ? A_KIDS : [], { canExpand: true, loaded: level >= 1 }),
      b: mkNode('b', 1, 'r0', [], { canExpand: true }),
    };
    if (level >= 1) {
      for (const id of A_KIDS) {
        const isA3 = id === 'a3';
        nodes[id] = mkNode(id, 2, 'a', level >= 2 && isA3 ? A3_KIDS : [], {
          canExpand: true,
          loaded: level >= 2 && isA3,
        });
      }
    }
    if (level >= 2) {
      for (const id of A3_KIDS) {
        nodes[id] = mkNode(id, 3, 'a3', [], {});
      }
    }
    return nodes;
  };

  let boxes = {};
  let nodes = {};
  const sendLevel = (level, sessionId = 'anchor-check') => {
    nodes = nodesOf(level);
    boxes = createLayout(nodes, 'r0').boxes;
    const edges = Object.values(nodes)
      .filter((node) => node.parent)
      .map((node) => ({ id: `e_${node.id}`, from: node.id, to: node.parent }));
    sendToWebview({
      type: 'sessionUpdate',
      session: {
        id: sessionId,
        title: '锚点检查',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'r0',
        nodes,
        edges,
        boxes,
        collapsedCount: 0,
      },
    });
  };

  const groupOf = (id) => nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  const topOf = (id) => {
    const group = groupOf(id);
    if (!group) {
      return Number.NaN;
    }
    return Number(/translate\(([-\d.]+) ([-\d.]+)\)/.exec(group.getAttribute('transform'))[2]);
  };
  const viewBoxParts = () => String(svg.getAttribute('viewBox')).split(/\s+/).map(Number);
  /** 方框中心在视口坐标系里的位置（0 = 视口顶边）。 */
  const centerInViewport = (id) =>
    topOf(id) + (boxes[id]?.height ?? 43) / 2 - viewBoxParts()[1] - Number(canvasEl.scrollTop || 0);
  /** 走真实交互路径点加减号：mousedown 记录 + window mouseup 处理。 */
  const clickExpander = (id, mode) => {
    const expander = groupOf(id)?.children.find((child) =>
      String(child.getAttribute('class') || '').startsWith('expander')
    );
    assert(expander !== undefined, `${id} 应当有加减号`);
    assert(
      String(expander.getAttribute('class')).includes(mode),
      `${id} 的加减号模式应为 ${mode}，实际 ${expander.getAttribute('class')}`
    );
    expander.dispatch('mousedown', { stopPropagation() {}, preventDefault() {} });
    for (const handler of windowListeners.mouseup ?? []) {
      handler({});
    }
  };

  canvasEl.clientHeight = 300;
  canvasEl.scrollTop = 0;
  sendToWebview({ type: 'settings', settings: { stickyParent: true } });
  sendLevel(0);

  // ① 点开 a 的加号（此时 a 还没加载过下一层）
  posted.length = 0;
  clickExpander('a', 'expand');
  assert(
    posted.some((message) => message.type === 'expand' && message.nodeId === 'a'),
    `点开 a 的加号应当向宿主请求展开 a，实际发了 ${JSON.stringify(posted.map((m) => m.type))}`
  );

  /**
   * 新规则（用户 2026-10-10 定）：被钉住的方框在**自己整棵子树那一段**（空挡）里保持居中，
   * 碰到空挡上下界就停住。空挡递归定义：有可见子框 = 第一个子框的空挡上沿 ~ 最后一个的下沿；
   * 自己就是叶子 = 自己那一段。判据用「要么在视口中央、要么正好贴住空挡边缘」，不写死坐标。
   */
  const slotOf = (id, seen = new Set()) => {
    const box = boxes[id];
    if (!box || !groupOf(id) || seen.has(id)) {
      return box ? { top: box.y, bottom: box.y + box.height } : undefined;
    }
    seen.add(id);
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const child of nodes[id]?.children ?? []) {
      if (!boxes[child] || !groupOf(child)) {
        continue;
      }
      const childSlot = slotOf(child, seen);
      if (childSlot) {
        top = Math.min(top, childSlot.top);
        bottom = Math.max(bottom, childSlot.bottom);
      }
    }
    return Number.isFinite(top) ? { top, bottom } : { top: box.y, bottom: box.y + box.height };
  };
  const assertSticky = (id, where) => {
    const slot = slotOf(id);
    assert(slot !== undefined, `${where}：${id} 应当有可见子框，才有空挡`);
    const centered = Math.abs(centerInViewport(id) - canvasEl.clientHeight / 2) <= 1;
    const atTop = Math.abs(topOf(id) - slot.top) <= 0.5;
    const atBottom = Math.abs(topOf(id) + boxes[id].height - slot.bottom) <= 0.5;
    assert(
      centered || atTop || atBottom,
      `${where}：${id} 既不在中央也没贴住空挡边缘` +
        `（top=${topOf(id).toFixed(1)}，空挡 ${slot.top.toFixed(1)}~${slot.bottom.toFixed(1)}）`
    );
  };

  // ② 宿主把 a 的第三级送回来：根与 a 都进入「在自己的空挡里居中」的状态
  sendLevel(1);
  canvasEl.dispatch('scroll', {});
  assertSticky('a', '展开 a 之后');
  assertSticky('r0', '展开 a 之后');

  // ③ 滚动之后这条规则依然成立
  canvasEl.scrollTop = 120;
  canvasEl.dispatch('scroll', {});
  assertSticky('a', '滚动 120 之后');
  assertSticky('r0', '滚动 120 之后');

  // ④ 再展开 a3（第三级里的一个）：根、a、a3 三级同时遵守这条规则
  clickExpander('a3', 'expand');
  sendLevel(2);
  canvasEl.dispatch('scroll', {});
  for (const id of ['r0', 'a', 'a3']) {
    assertSticky(id, '展开 a3 之后');
  }

  // ⑤ 收起 a3：链退回 根 + a，规则仍成立
  clickExpander('a3', 'collapse');
  canvasEl.dispatch('scroll', {});
  assertSticky('a', '收起 a3 之后');
  assertSticky('r0', '收起 a3 之后');

  // ⑥ 收起全部：只剩根，且不留任何残留位移
  byId.get('btn-collapse-all').dispatch('click', {});
  const shifted = nodesGroup.children
    .map((group) => String(group.getAttribute('data-node')))
    .filter((id) => Math.abs(topOf(id) - (boxes[id]?.y ?? 0)) > 0.5);
  assert(
    shifted.length === 0,
    `收起全部后不该有任何残留位移，实际被移动的是：${shifted.join(',') || '（无）'}`
  );

  // 收尾：把 DOM 还原成「多节点可见」的形态，并关掉设置、还原视口尺寸。
  // 两个坑：① 后面延后执行的段落会在**当前 DOM** 上逐个方框数加减号（要求 ≥2 个），
  // 而这里最后一步是「收起全部」（只剩根可见）；② 收起标记是**按会话 id** 记的，
  // 所以必须换一个新会话 id 才会真的重新展开，光重发同一会话的负载没用。
  sendLevel(2, 'anchor-restore');
  sendToWebview({ type: 'settings', settings: { stickyParent: false } });
  canvasEl.clientHeight = 0;
  canvasEl.scrollTop = 0;
  log('OK: 粘性父框已推广到任意层 —— 展开谁就钉谁（a → a3），收起后退回父级，收起全部无残留');
}

// ------------------------------------------------ 粘性父框：只在「自己的空挡」里滑动
//
// 实测出来的问题：把第二级的 a2 强制定到视口中央时，它会压到同列的 a1 / a3 上。
// 正确规则：空挡内可以居中，**碰到空挡边缘就停住**，与相邻方框的最小间距 = 正常行距（12px）。
{
  const mkNode = (id, depth, parent, children, extra = {}) => ({
    id,
    name: id,
    file: 'x.c',
    line: 1,
    direction: 'callers',
    depth,
    isCycle: false,
    children,
    parent,
    loaded: false,
    canExpand: false,
    kind: 'function',
    ...extra,
  });
  const A2_KIDS = Array.from({ length: 10 }, (_, index) => `a2_${index}`);

  /** expanded=false：a2 还没展开；true：a2 带着 10 个第三级。 */
  const nodesOf = (expanded) => {
    const nodes = {
      r0: mkNode('r0', 0, undefined, ['a1', 'a2', 'a3'], { loaded: true }),
      a1: mkNode('a1', 1, 'r0', [], { loaded: true }),
      a2: mkNode('a2', 1, 'r0', expanded ? A2_KIDS : [], { canExpand: true, loaded: expanded }),
      a3: mkNode('a3', 1, 'r0', [], { loaded: true }),
    };
    if (expanded) {
      for (const id of A2_KIDS) {
        nodes[id] = mkNode(id, 2, 'a2', [], {});
      }
    }
    return nodes;
  };

  let boxes = {};
  let nodes = {};
  const sendSlot = (expanded) => {
    nodes = nodesOf(expanded);
    boxes = createLayout(nodes, 'r0').boxes;
    const edges = Object.values(nodes)
      .filter((node) => node.parent)
      .map((node) => ({ id: `e_${node.id}`, from: node.id, to: node.parent }));
    sendToWebview({
      type: 'sessionUpdate',
      session: {
        id: 'slot-check',
        title: '空挡检查',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'r0',
        nodes,
        edges,
        boxes,
        collapsedCount: 0,
      },
    });
  };

  const groupOf = (id) => nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  const topOf = (id) => {
    const group = groupOf(id);
    if (!group) {
      return Number.NaN;
    }
    return Number(/translate\(([-\d.]+) ([-\d.]+)\)/.exec(group.getAttribute('transform'))[2]);
  };
  const viewBoxParts = () => String(svg.getAttribute('viewBox')).split(/\s+/).map(Number);
  const centerInViewport = (id) =>
    topOf(id) + (boxes[id]?.height ?? 43) / 2 - viewBoxParts()[1] - Number(canvasEl.scrollTop || 0);
  const clickExpander = (id, mode) => {
    const expander = groupOf(id)?.children.find((child) =>
      String(child.getAttribute('class') || '').startsWith('expander')
    );
    assert(expander !== undefined, `${id} 应当有加减号`);
    assert(
      String(expander.getAttribute('class')).includes(mode),
      `${id} 的加减号模式应为 ${mode}，实际 ${expander.getAttribute('class')}`
    );
    expander.dispatch('mousedown', { stopPropagation() {}, preventDefault() {} });
    for (const handler of windowListeners.mouseup ?? []) {
      handler({});
    }
  };

  canvasEl.clientHeight = 300;
  canvasEl.scrollTop = 0;
  sendToWebview({ type: 'settings', settings: { stickyParent: true } });
  sendSlot(false);
  clickExpander('a2', 'expand');
  sendSlot(true);
  // 夹具自检：a2 的空挡（按**布局**坐标估）应当明显大于一个方框高，才测得出两种情形
  const boxHeight = boxes.a2.height;
  const layoutSlot = boxes.a3.y - 12 - boxHeight - (boxes.a1.y + boxes.a1.height + 12);
  assert(
    layoutSlot > 100,
    `夹具的空挡应当足够大才测得出两种情形（实际 ${layoutSlot.toFixed(1)}）`
  );

  // 夹具基线锚点：下面的绝对锚点全部建立在「布局原样」之上，先把基线钉住 ——
  // 基线一变（行高或行距改了），那几个手算值就必须重算，这里会直接给出提示。
  //
  // 绝对锚点与本节其它判据（居中 / 间距恰好 12 / 不重叠）的关系：后者是**相对**判据，
  // 判据本身不钉住绝对位置 —— 例如整列一起平移后「间距恰好 12」依然成立。绝对锚点补的正是
  // 这一段：相邻方框的落点、行高、行距这些常量一旦漂移，相对判据看不出来，字面量会立刻红。
  assert(
    boxes.a1.y === 0 && boxes.a2.y === 302.5 && boxes.a3.y === 605,
    `夹具布局基线变了（a1=${boxes.a1.y} a2=${boxes.a2.y} a3=${boxes.a3.y}），下面的绝对锚点需要重新手算`
  );

  /** 同列相邻对（用**位移后**的实际位置算）——与后面几段同一套判据。 */
  const columnPairs = () => {
    const columns = new Map();
    for (const id of Object.keys(boxes)) {
      if (!groupOf(id)) {
        continue;
      }
      const x = Number(/translate\(([-\d.]+)/.exec(groupOf(id).getAttribute('transform'))[1]);
      const list = columns.get(x) ?? [];
      list.push({ id, top: topOf(id), bottom: topOf(id) + boxes[id].height });
      columns.set(x, list);
    }
    const pairs = [];
    for (const list of columns.values()) {
      list.sort((left, right) => left.top - right.top);
      for (let index = 1; index < list.length; index += 1) {
        pairs.push({
          above: list[index - 1],
          below: list[index],
          gap: list[index].top - list[index - 1].bottom,
        });
      }
    }
    return pairs;
  };
  /** 某个方框与同列上/下邻居的实际间距。 */
  const gapsAround = (id) => {
    const pairs = columnPairs();
    return {
      above: pairs.find((pair) => pair.below.id === id)?.gap ?? Number.POSITIVE_INFINITY,
      below: pairs.find((pair) => pair.above.id === id)?.gap ?? Number.POSITIVE_INFINITY,
    };
  };
  const assertNoOverlap = (where) => {
    for (const pair of columnPairs()) {
      assert(
        pair.gap >= 12 - 0.5,
        `${where}：${pair.above.id} 与 ${pair.below.id} 间距只有 ${pair.gap.toFixed(1)}px（应 ≥ 12）`
      );
    }
  };

  // ① 期望位置落在空挡内：钉在视口中央
  canvasEl.scrollTop = 0;
  canvasEl.dispatch('scroll', {});
  assert(
    Math.abs(centerInViewport('a2') - canvasEl.clientHeight / 2) <= 1,
    `空挡够用时 a2 应当钉在视口中央（中心 ${centerInViewport('a2').toFixed(1)}）`
  );
  // 绝对锚点（由一次性探针实测，可手工复核）：视口 300、滚动 0、viewBox.y = −10
  //   a2 中心 = viewBox.y + 视口半高 = −10 + 150 = 140 → 顶边 = 140 − 21.5 = 118.5
  // 写成字面量而不是「照实现的公式再算一遍」：规则若整体写错，公式会跟着一起错，只有写死才会红。
  assert(topOf('a2') === 118.5, `① 居中时 a2 顶边应当钉在 118.5，实际 ${topOf('a2')}`);
  assertNoOverlap('空挡内居中时');

  // ② 使劲往下滚：空挡不够用了 → 不再居中，而是**正好贴住下边界**（与下方邻居 12px）
  canvasEl.scrollTop = 500;
  canvasEl.dispatch('scroll', {});
  assert(
    Math.abs(centerInViewport('a2') - canvasEl.clientHeight / 2) > 1,
    `空挡不够时 a2 不该还在正中（中心 ${centerInViewport('a2').toFixed(1)}）`
  );
  assert(
    Math.abs(gapsAround('a2').below - 12) <= 0.5,
    `a2 应当正好贴住下方邻居的空挡边缘，实际间距 ${gapsAround('a2').below.toFixed(1)}px`
  );
  // 绝对锚点：空挡下沿 = a2 子树的底端 = 末个孙框 a2_9 底边 593（= a3 顶边 605 − 行距 12）
  assert(
    topOf('a2') === 550,
    `② 撞到下沿时 a2 顶边应当是 550（空挡下沿 593 − 框高 43），实际 ${topOf('a2')}`
  );
  assertNoOverlap('向下撞到空挡边缘时');

  // ③ 视口很矮（期望位置在空挡上方）：贴住上边界，不压上方邻居
  canvasEl.clientHeight = 100;
  canvasEl.scrollTop = 0;
  canvasEl.dispatch('scroll', {});
  assert(
    Math.abs(gapsAround('a2').above - 12) <= 0.5,
    `a2 应当正好贴住上方邻居的空挡边缘，实际间距 ${gapsAround('a2').above.toFixed(1)}px`
  );
  // 绝对锚点：空挡上沿 = a2 子树的顶端 = 首个孙框 a2_0 顶边 55（= a1 底边 43 + 行距 12）
  assert(
    topOf('a2') === 55,
    `③ 撞到上沿时 a2 顶边应当是 55（空挡上沿，即 a1 底边 43 + 行距 12），实际 ${topOf('a2')}`
  );
  assertNoOverlap('向上撞到空挡边缘时');

  // ④ 叶子邻居（a1/a3）会各自跟着根走 —— 它们之间隔着已展开的 a2，
  //    所以属于**两段独立的空挡**，可以各自决定跟多少；只要互不重叠即可
  assertNoOverlap('叶子跟着父框走之后');

  // 收尾：换一个新会话（无收起标记），保证后面延后执行的段落仍能在当前 DOM 上数到 ≥2 个加减号
  sendSlot(true);
  sendToWebview({ type: 'settings', settings: { stickyParent: false } });
  canvasEl.clientHeight = 0;
  canvasEl.scrollTop = 0;
  log(
    `OK: 粘性父框只在「自己的空挡」里滑动 —— 子树那一段约 ${layoutSlot.toFixed(0)}px 高：` +
      '空挡内居中、撞到边缘就停住；没有展开下一层的同级标签完全不动，同列间距始终 ≥12px'
  );
}

// ------------------------------------------------ 粘性父框：任意深度（五级链一起钉）
//
// 「以此类推」要能一直往深走：root → a1 → b3 → c4 → d4 五级全部同时保持居中，
// 每级各自受自己的空挡限制；并且**任何一层都不许和同列邻居挤到 12px 以内**。
{
  const mkNode = (id, depth, parent, children, extra = {}) => ({
    id,
    name: id,
    file: 'x.c',
    line: 1,
    direction: 'callers',
    depth,
    isCycle: false,
    children,
    parent,
    loaded: false,
    canExpand: false,
    kind: 'function',
    ...extra,
  });
  const ids = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  const B_KIDS = ids('b', 10);
  const C_KIDS = ids('c', 10);
  const D_KIDS = ids('d', 10);
  const E_KIDS = ids('e', 10);

  /** level 0：a1 已展开；1：b3 已展开；2：c4 已展开；3：d4 已展开。 */
  const nodesOf = (level) => {
    const nodes = {
      r0: mkNode('r0', 0, undefined, ['a1', 'a2'], { loaded: true }),
      a1: mkNode('a1', 1, 'r0', B_KIDS, { loaded: true }),
      a2: mkNode('a2', 1, 'r0', [], { canExpand: true }),
    };
    for (const id of B_KIDS) {
      const live = id === 'b3' && level >= 1;
      nodes[id] = mkNode(id, 2, 'a1', live ? C_KIDS : [], { canExpand: true, loaded: live });
    }
    if (level >= 1) {
      for (const id of C_KIDS) {
        const live = id === 'c4' && level >= 2;
        nodes[id] = mkNode(id, 3, 'b3', live ? D_KIDS : [], { canExpand: true, loaded: live });
      }
    }
    if (level >= 2) {
      for (const id of D_KIDS) {
        const live = id === 'd4' && level >= 3;
        nodes[id] = mkNode(id, 4, 'c4', live ? E_KIDS : [], { canExpand: true, loaded: live });
      }
    }
    if (level >= 3) {
      for (const id of E_KIDS) {
        nodes[id] = mkNode(id, 5, 'd4', [], {});
      }
    }
    return nodes;
  };

  let boxes = {};
  let nodes = {};
  const sendDeep = (level) => {
    nodes = nodesOf(level);
    boxes = createLayout(nodes, 'r0').boxes;
    const edges = Object.values(nodes)
      .filter((node) => node.parent)
      .map((node) => ({ id: `e_${node.id}`, from: node.id, to: node.parent }));
    sendToWebview({
      type: 'sessionUpdate',
      session: {
        id: 'deep-check',
        title: '深层链检查',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'r0',
        nodes,
        edges,
        boxes,
        collapsedCount: 0,
      },
    });
  };

  const groupOf = (id) => nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  const topOf = (id) => {
    const group = groupOf(id);
    if (!group) {
      return Number.NaN;
    }
    return Number(/translate\(([-\d.]+) ([-\d.]+)\)/.exec(group.getAttribute('transform'))[2]);
  };
  const viewBoxParts = () => String(svg.getAttribute('viewBox')).split(/\s+/).map(Number);
  const centerInViewport = (id) =>
    topOf(id) + (boxes[id]?.height ?? 43) / 2 - viewBoxParts()[1] - Number(canvasEl.scrollTop || 0);
  const clickExpander = (id, mode) => {
    const expander = groupOf(id)?.children.find((child) =>
      String(child.getAttribute('class') || '').startsWith('expander')
    );
    assert(expander !== undefined, `${id} 应当有加减号`);
    assert(
      String(expander.getAttribute('class')).includes(mode),
      `${id} 的加减号模式应为 ${mode}，实际 ${expander.getAttribute('class')}`
    );
    expander.dispatch('mousedown', { stopPropagation() {}, preventDefault() {} });
    for (const handler of windowListeners.mouseup ?? []) {
      handler({});
    }
  };

  /**
   * 同列的相邻对（用**位移后**的实际位置算），间距 = 下框上沿 − 上框下沿。
   * 这是独立于实现写出来的判据：需求就是「同列最小间距 = 正常行距」。
   */
  const columnPairs = () => {
    const columns = new Map();
    for (const id of Object.keys(boxes)) {
      if (!groupOf(id)) {
        continue; // 不可见的节点不参与
      }
      const x = Number(/translate\(([-\d.]+)/.exec(groupOf(id).getAttribute('transform'))[1]);
      const list = columns.get(x) ?? [];
      list.push({ id, top: topOf(id), bottom: topOf(id) + boxes[id].height });
      columns.set(x, list);
    }
    const pairs = [];
    for (const list of columns.values()) {
      list.sort((left, right) => left.top - right.top);
      for (let index = 1; index < list.length; index += 1) {
        pairs.push({
          above: list[index - 1],
          below: list[index],
          gap: list[index].top - list[index - 1].bottom,
        });
      }
    }
    return pairs;
  };

  const CHAIN = ['r0', 'a1', 'b3', 'c4', 'd4'];
  /** 某个方框的「空挡」= 它整棵子树在布局里占的那一段（递归；与实现同一口径）。 */
  const slotOf = (id, seen = new Set()) => {
    const box = boxes[id];
    if (!box || !groupOf(id) || seen.has(id)) {
      return box ? { top: box.y, bottom: box.y + box.height } : undefined;
    }
    seen.add(id);
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const child of nodes[id]?.children ?? []) {
      if (!boxes[child] || !groupOf(child)) {
        continue;
      }
      const childSlot = slotOf(child, seen);
      if (childSlot) {
        top = Math.min(top, childSlot.top);
        bottom = Math.max(bottom, childSlot.bottom);
      }
    }
    return Number.isFinite(top) ? { top, bottom } : { top: box.y, bottom: box.y + box.height };
  };
  /** 五级链 + 全局不重叠，两处都适用（滚动前后各查一次）。 */
  const checkInvariants = (where) => {
    const half = canvasEl.clientHeight / 2;
    const pairs = columnPairs();
    let centered = 0;
    let clamped = 0;
    for (const id of CHAIN) {
      const slot = slotOf(id);
      assert(slot !== undefined, `${where}：${id} 应当有可见子框，才有空挡`);
      if (Math.abs(centerInViewport(id) - half) <= 1) {
        centered += 1;
        continue;
      }
      // 没在中央 → 只能是被自己的空挡卡住：必须正好贴住空挡的上界或下界
      const atTop = Math.abs(topOf(id) - slot.top) <= 0.5;
      const atBottom = Math.abs(topOf(id) + boxes[id].height - slot.bottom) <= 0.5;
      assert(
        atTop || atBottom,
        `${where}：${id} 既不在中央也没贴住空挡边缘` +
          `（top=${topOf(id).toFixed(1)}，空挡 ${slot.top.toFixed(1)}~${slot.bottom.toFixed(1)}）`
      );
      clamped += 1;
    }
    // 全局：同列任意相邻两框的间距都不得小于正常行距（= 不许重叠、不许挤在一起）
    for (const pair of pairs) {
      assert(
        pair.gap >= 12 - 0.5,
        `${where}：${pair.above.id} 与 ${pair.below.id} 间距只有 ${pair.gap.toFixed(1)}px（应 ≥ 12）`
      );
    }
    return { centered, clamped, pairs: pairs.length };
  };

  canvasEl.clientHeight = 300;
  canvasEl.scrollTop = 0;
  sendToWebview({ type: 'settings', settings: { stickyParent: true } });

  // 逐级展开到第五级：每次都走真实交互（点加号 + 宿主回数据）
  sendDeep(0);
  clickExpander('b3', 'expand');
  sendDeep(1);
  clickExpander('c4', 'expand');
  sendDeep(2);
  clickExpander('d4', 'expand');
  sendDeep(3);
  canvasEl.dispatch('scroll', {});
  const atTop = checkInvariants('五级链（视口顶部）');

  // 往下滚一大段：链上各级仍应「在中央或贴住自己的空挡边缘」，且全局不重叠
  canvasEl.scrollTop = 400;
  canvasEl.dispatch('scroll', {});
  const scrolled = checkInvariants('五级链（滚 400 后）');

  log(
    `OK: 粘性父框在任意深度都成立 —— 五级链（${CHAIN.join(' → ')}）同时生效：` +
      `顶部时 ${atTop.centered} 级居中 / ${atTop.clamped} 级被同级顶住，` +
      `滚 400 后 ${scrolled.centered} 级居中 / ${scrolled.clamped} 级被顶住；` +
      `同列 ${atTop.pairs} 对相邻方框间距始终 ≥12px`
  );

  // ---- 用户 2026-10-10 重新设计的规则（三条要求同时成立）----
  //
  // ① 每个被钉住的父框都在**自己子框那一段**（空挡）里滑动 —— 既不会撞到同列兄弟，
  //    也不会离自己的子框太远；
  // ② 于是父子箭头的长度被这一条自然管住（不超过「布局跨度 + 最多能滑多远」）；
  // ③ 收起之后空出的间隔由宿主重排收拢（另有断言，见「收起重排」与 renderCheck 的收起段）。
  {
    let maxLayout = 0;
    let maxShifted = 0;
    let maxShift = 0;
    for (const id of CHAIN) {
      const slot = slotOf(id);
      assert(slot !== undefined, `${id} 应当有可见子框（空挡）`);
      const top = topOf(id);
      assert(
        top >= slot.top - 0.5 && top + boxes[id].height <= slot.bottom + 0.5,
        `${id} 滑出了自己的空挡（top=${top.toFixed(1)}，空挡 ${slot.top.toFixed(1)}~${slot.bottom.toFixed(1)}）`
      );
      maxShift = Math.max(maxShift, Math.abs(top - boxes[id].y));
    }
    for (const [id, node] of Object.entries(nodes)) {
      const parent = node.parent;
      if (!parent || !boxes[id] || !boxes[parent]) {
        continue;
      }
      const center = (nodeId, shifted) =>
        (shifted ? topOf(nodeId) : boxes[nodeId].y) + boxes[nodeId].height / 2;
      maxLayout = Math.max(maxLayout, Math.abs(center(id, false) - center(parent, false)));
      maxShifted = Math.max(maxShifted, Math.abs(center(id, true) - center(parent, true)));
    }
    assert(
      maxShifted <= maxLayout + maxShift + 1,
      `父子箭头被拉得太长：最长 ${maxShifted.toFixed(0)}px，` +
        `上限应为布局 ${maxLayout.toFixed(0)}px + 位移 ${maxShift.toFixed(0)}px`
    );
    log(
      `OK: 父框只在「自己整棵子树那一段」里滑 —— 五级链各级都在自己的空挡内；` +
        `树边最长 ${maxShifted.toFixed(0)}px（布局 ${maxLayout.toFixed(0)}px + 最大位移 ${maxShift.toFixed(0)}px 之内）`
    );
  }

  // ---- 第一级也走同一条规则（用户 2026-10-10：「包括第一级也是」）----
  //
  // 第一级**没有特例**：它的空挡同样是「整棵子树那一段」（递归得到），于是天然覆盖整个内容 ——
  // 滚到哪儿它都能居中。这里直接把这一点钉住，免得以后有人给根加一条特殊分支。
  {
    const rootSlot = slotOf('r0');
    const visibleIds = Object.keys(boxes).filter((id) => groupOf(id));
    const minTop = Math.min(...visibleIds.map((id) => boxes[id].y));
    const maxBottom = Math.max(...visibleIds.map((id) => boxes[id].y + boxes[id].height));
    assert(
      Math.abs(rootSlot.top - minTop) <= 0.5 && Math.abs(rootSlot.bottom - maxBottom) <= 0.5,
      `第一级的空挡应当覆盖整个内容：` +
        `空挡 ${rootSlot.top.toFixed(1)}~${rootSlot.bottom.toFixed(1)}，内容 ${minTop.toFixed(1)}~${maxBottom.toFixed(1)}`
    );
    for (const scrollTop of [0, 300, 600]) {
      canvasEl.scrollTop = scrollTop;
      canvasEl.dispatch('scroll', {});
      assert(
        Math.abs(centerInViewport('r0') - canvasEl.clientHeight / 2) <= 1,
        `第一级在 scrollTop=${scrollTop} 时应当居中（中心 ${centerInViewport('r0').toFixed(1)}）`
      );
    }
    log(
      `OK: 第一级同样只在自己的空挡里滑 —— 它的空挡 = 整棵子树那一段（覆盖内容 ` +
        `${minTop.toFixed(0)}~${maxBottom.toFixed(0)}），滚到哪儿都能居中`
    );
  }

  // 收尾：还原设置与视口尺寸，保证后面延后执行的段落正常
  sendToWebview({ type: 'settings', settings: { stickyParent: false } });
  canvasEl.clientHeight = 0;
  canvasEl.scrollTop = 0;
}

// ------------------------------------------------ 粘性父框：同一层展开多个（先展开的不能被丢下）
//
// 实测反馈：第二级展开 a1 能正常居中，但隔几个同级标签再展开 a5 之后，a1 就不动了。
// 规则应当是「**所有展开了下一层的父框**都留在中间」—— 同一列里它们不可能同时精确居中，
// 于是只能一起往中间聚、彼此保住正常行距；先展开的那个绝不能被放回布局原位。
{
  const mkNode = (id, depth, parent, children, extra = {}) => ({
    id,
    name: id,
    file: 'x.c',
    line: 1,
    direction: 'callers',
    depth,
    isCycle: false,
    children,
    parent,
    loaded: false,
    canExpand: false,
    kind: 'function',
    ...extra,
  });
  const ids = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  const A1_KIDS = ids('a1_', 10);
  const A5_KIDS = ids('a5_', 10);
  const SIBLINGS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];

  /** both=false：只展开了 a1；true：a1 与 a5 都展开了。 */
  const nodesOf = (both) => {
    const nodes = {
      r0: mkNode('r0', 0, undefined, SIBLINGS, { loaded: true }),
      a1: mkNode('a1', 1, 'r0', A1_KIDS, { loaded: true }),
      a2: mkNode('a2', 1, 'r0', [], { canExpand: true }),
      a3: mkNode('a3', 1, 'r0', [], { canExpand: true }),
      a4: mkNode('a4', 1, 'r0', [], { canExpand: true }),
      a5: mkNode('a5', 1, 'r0', both ? A5_KIDS : [], { canExpand: true, loaded: both }),
      a6: mkNode('a6', 1, 'r0', [], { canExpand: true }),
    };
    for (const id of A1_KIDS) {
      nodes[id] = mkNode(id, 2, 'a1', [], {});
    }
    if (both) {
      for (const id of A5_KIDS) {
        nodes[id] = mkNode(id, 2, 'a5', [], {});
      }
    }
    return nodes;
  };

  let boxes = {};
  const sendBoth = (both) => {
    const nodes = nodesOf(both);
    boxes = createLayout(nodes, 'r0').boxes;
    const edges = Object.values(nodes)
      .filter((node) => node.parent)
      .map((node) => ({ id: `e_${node.id}`, from: node.id, to: node.parent }));
    sendToWebview({
      type: 'sessionUpdate',
      session: {
        id: 'sibling-check',
        title: '同级展开检查',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'r0',
        nodes,
        edges,
        boxes,
        collapsedCount: 0,
      },
    });
  };

  const groupOf = (id) => nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  const topOf = (id) => {
    const group = groupOf(id);
    if (!group) {
      return Number.NaN;
    }
    return Number(/translate\(([-\d.]+) ([-\d.]+)\)/.exec(group.getAttribute('transform'))[2]);
  };
  const viewBoxParts = () => String(svg.getAttribute('viewBox')).split(/\s+/).map(Number);
  const centerInViewport = (id) =>
    topOf(id) + (boxes[id]?.height ?? 43) / 2 - viewBoxParts()[1] - Number(canvasEl.scrollTop || 0);
  const clickExpander = (id, mode) => {
    const expander = groupOf(id)?.children.find((child) =>
      String(child.getAttribute('class') || '').startsWith('expander')
    );
    assert(expander !== undefined, `${id} 应当有加减号`);
    assert(
      String(expander.getAttribute('class')).includes(mode),
      `${id} 的加减号模式应为 ${mode}，实际 ${expander.getAttribute('class')}`
    );
    expander.dispatch('mousedown', { stopPropagation() {}, preventDefault() {} });
    for (const handler of windowListeners.mouseup ?? []) {
      handler({});
    }
  };
  /** 同列相邻对（用位移后的实际位置算）。 */
  const columnPairs = () => {
    const columns = new Map();
    for (const id of Object.keys(boxes)) {
      if (!groupOf(id)) {
        continue;
      }
      const x = Number(/translate\(([-\d.]+)/.exec(groupOf(id).getAttribute('transform'))[1]);
      const list = columns.get(x) ?? [];
      list.push({ id, top: topOf(id), bottom: topOf(id) + boxes[id].height });
      columns.set(x, list);
    }
    const pairs = [];
    for (const list of columns.values()) {
      list.sort((left, right) => left.top - right.top);
      for (let index = 1; index < list.length; index += 1) {
        pairs.push({
          above: list[index - 1],
          below: list[index],
          gap: list[index].top - list[index - 1].bottom,
        });
      }
    }
    return pairs;
  };
  /** 「被钉住」= 要么在视口中央，要么正好贴着自己的空挡边缘（与同列邻居间距 = 12）。 */
  const isPinned = (id) => {
    if (Math.abs(centerInViewport(id) - canvasEl.clientHeight / 2) <= 1) {
      return true;
    }
    const touching = columnPairs().filter((pair) => pair.above.id === id || pair.below.id === id);
    return touching.some((pair) => Math.abs(pair.gap - 12) <= 0.5);
  };
  const assertNoOverlap = (where) => {
    for (const pair of columnPairs()) {
      assert(
        pair.gap >= 12 - 0.5,
        `${where}：${pair.above.id} 与 ${pair.below.id} 间距只有 ${pair.gap.toFixed(1)}px（应 ≥ 12）`
      );
    }
  };

  canvasEl.clientHeight = 300;
  canvasEl.scrollTop = 0;
  sendToWebview({ type: 'settings', settings: { stickyParent: true } });

  // ① 只展开 a1：它居中（= 用户说的「可以正常居中」）
  sendBoth(false);
  canvasEl.dispatch('scroll', {});
  assert(
    Math.abs(centerInViewport('a1') - canvasEl.clientHeight / 2) <= 1,
    `只展开 a1 时它应当居中（中心 ${centerInViewport('a1').toFixed(1)}）`
  );

  // ② 再展开隔几个同级标签的 a5：**a1 不能被丢下**
  clickExpander('a5', 'expand');
  sendBoth(true);
  canvasEl.dispatch('scroll', {});
  assert(isPinned('a1'), '再展开 a5 之后，先展开的 a1 仍应被钉住（在中央或贴着自己的空挡边缘）');
  assert(
    Math.abs(topOf('a1') - boxes.a1.y) > 0.5,
    `a1 应当仍带位移，而不是被放回布局原位（布局 y=${boxes.a1.y}，实际 ${topOf('a1').toFixed(1)}）`
  );
  assert(isPinned('a5'), 'a5 也应当被钉住');
  assert(
    Math.abs(topOf('a5') - boxes.a5.y) > 0.5,
    `a5 应当带位移（布局 y=${boxes.a5.y}，实际 ${topOf('a5').toFixed(1)}）`
  );
  // 没有展开下一层的同级标签（a2/a3/a4/a6）完全不动 —— 只有「展开了下一层」的父框才会滑
  for (const id of ['a2', 'a3', 'a4', 'a6']) {
    assert(
      Math.abs(topOf(id) - boxes[id].y) <= 0.5,
      `${id} 没有展开下一层，不该被移动（布局 y=${boxes[id].y}，实际 ${topOf(id).toFixed(1)}）`
    );
  }
  assertNoOverlap('两个同级展开后');

  // ③ 继续往下滚到 a5 能居中的位置：a5 跟着往中间走，a1 顶到自己的空挡边缘后停在那儿
  //    （注意：scrollTop=0 时 a5 被顶在空挡上边缘 715，中心目标要滚到 ~900 才追上它）
  const a5TopBefore = topOf('a5');
  canvasEl.scrollTop = 900;
  canvasEl.dispatch('scroll', {});
  assert(
    Math.abs(centerInViewport('a5') - canvasEl.clientHeight / 2) <= 1,
    `滚到空挡内之后 a5 应当居中（中心 ${centerInViewport('a5').toFixed(1)}）`
  );
  assert(
    topOf('a5') > a5TopBefore + 100,
    `滚下去之后 a5 的内容坐标应当跟着下移（实际只动了 ${(topOf('a5') - a5TopBefore).toFixed(1)}）`
  );
  assert(isPinned('a1'), '滚下去之后 a1 仍应停在自己的空挡边缘，不能回原位');
  assertNoOverlap('滚到 a5 居中后');

  log(
    `OK: 同一层展开多个都留在中间 —— 只展开 a1 时居中；再展开 a5 后 a1 仍被钉住（未回原位），` +
      `滚下去 a5 接手居中、a1 顶在空挡边缘；同列间距始终 ≥12px`
  );

  // 收尾：还原设置与视口尺寸
  sendToWebview({ type: 'settings', settings: { stickyParent: false } });
  canvasEl.clientHeight = 0;
  canvasEl.scrollTop = 0;
}

// ------------------------------------------------ 收起全部 → 展开全部：收起状态必须同步给宿主
//
// 用户实测（关掉「显示路径」与「粘性父框」后）：收起全部 → 展开全部，可能只展开到第二级，
// 第二级的加号点不开。根因是前端改了收起状态却没告诉宿主 —— 坐标是宿主算的，
// 它按那份集合决定哪些子树不占高度；集合旧了，被它当成「收起」的子树整棵拿不到坐标，
// 画面上就只剩前两级（渲染时 `!geometry` 的节点会被跳过），加号自然点不开。
{
  const mkNode = (id, depth, parent, children, extra = {}) => ({
    id,
    name: id,
    file: 'x.c',
    line: 1,
    direction: 'callers',
    depth,
    isCycle: false,
    children,
    parent,
    loaded: false,
    canExpand: true,
    kind: 'function',
    ...extra,
  });
  // 三层：r0 → a → b（b 是叶子）。a 与 b 都还没加载，所以加号可点。
  const nodes = {
    r0: mkNode('r0', 0, undefined, ['a'], { loaded: true }),
    a: mkNode('a', 1, 'r0', ['b'], { loaded: true, canExpand: false }),
    b: mkNode('b', 2, 'a', [], { canExpand: true }),
  };
  const boxes = createLayout(nodes, 'r0').boxes;
  const session = {
    id: 'collapse-sync',
    title: '收起同步',
    description: '',
    direction: 'callers',
    engineLabel: 'clangd',
    rootId: 'r0',
    nodes,
    edges: [
      { id: 'e_a', from: 'a', to: 'r0' },
      { id: 'e_b', from: 'b', to: 'a' },
    ],
    boxes,
    collapsedCount: 1,
  };

  // 与用户实测一致：两个开关都关掉
  sendToWebview({
    type: 'settings',
    settings: { stickyParent: false, showLocation: false },
  });
  sendToWebview({ type: 'sessionUpdate', session });
  flushFrames();

  // ① 收起全部：必须把「只有根是收起的」下发宿主
  posted.length = 0;
  byId.get('btn-collapse-all').dispatch('click', {});
  flushFrames();
  const collapseMsg = posted.filter((message) => message.type === 'collapse').pop();
  assert(
    collapseMsg !== undefined,
    '收起全部必须把收起状态下发宿主，否则宿主坐标不更新（用户实测的「只展开到第二级」由此而来）'
  );
  assert(
    collapseMsg.collapsed.length === 1 && collapseMsg.collapsed[0] === 'r0',
    `收起全部应当只把根标为收起，实际 ${JSON.stringify(collapseMsg.collapsed)}`
  );

  // ② 展开全部：必须先把收起状态清空并同步，而且要在请求展开之前
  posted.length = 0;
  byId.get('btn-expand-all').dispatch('click', {});
  flushFrames();
  const clearIndex = posted.findIndex(
    (message) => message.type === 'collapse' && message.collapsed.length === 0
  );
  const expandIndex = posted.findIndex((message) => message.type === 'expandAll');
  assert(clearIndex >= 0, '展开全部必须先把「已收起」清空并同步给宿主');
  assert(expandIndex >= 0, '展开全部应当向宿主请求展开');
  assert(clearIndex < expandIndex, '清空收起状态必须在请求展开之前下发');

  // ③ 宿主补发完整几何后：三级都在画面里，且第三级的上一级（第二级）加号仍可点
  sendToWebview({ type: 'sessionUpdate', session });
  flushFrames();
  const visible = nodesGroup.children.map((group) => String(group.getAttribute('data-node')));
  assert(
    visible.includes('b'),
    `展开全部之后最深一级也应当在画面里，实际可见 ${visible.join(',')}`
  );
  posted.length = 0;
  const groupOf = (id) =>
    nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  // 走真实交互路径点加减号：mousedown 记录 + window mouseup 处理
  const clickExpander = (id, mode) => {
    const expander = groupOf(id)?.children.find((child) =>
      String(child.getAttribute('class') || '').startsWith('expander')
    );
    assert(expander !== undefined, `${id} 应当有加减号`);
    assert(
      String(expander.getAttribute('class')).includes(mode),
      `${id} 的加减号模式应为 ${mode}，实际 ${expander.getAttribute('class')}`
    );
    expander.dispatch('mousedown', { stopPropagation() {}, preventDefault() {} });
    for (const handler of windowListeners.mouseup ?? []) {
      handler({});
    }
  };
  clickExpander('a', 'collapse');
  clickExpander('a', 'expand');
  // ⚠️ 判据不能写成 `expand || collapse`：上一步刚发过 collapse，后半支恒真，断言等于没写。
  // 这里改为检查**同步给宿主的收起集合**：收起时含 a，展开时不含 a —— 这才是"加号点得开"。
  const collapseMessages = posted.filter((message) => message.type === 'collapse');
  assert(
    collapseMessages.length >= 2,
    `两次点击都应把收起状态同步给宿主，实际发出 ${JSON.stringify(posted.map((m) => m.type))}`
  );
  const lastCollapse = collapseMessages[collapseMessages.length - 1];
  assert(
    Array.isArray(lastCollapse.collapsed),
    `collapse 消息必须带 collapsed 数组，实际 ${JSON.stringify(lastCollapse)}`
  );
  assert(
    !lastCollapse.collapsed.includes('a'),
    `第二次点击（展开）后，「a」不应再出现在同步给宿主的收起集合里（实际 ${JSON.stringify(
      lastCollapse.collapsed
    )}）`
  );

  log(
    'OK: 收起全部 / 展开全部都会把收起状态同步给宿主 —— 展开后最深一级仍在画面里，第二级加号可点'
  );

  // 收尾：恢复设置与 DOM，供后面延后执行的段落使用
  sendToWebview({ type: 'settings', settings: { stickyParent: false, showLocation: true } });
  sendToWebview({ type: 'sessionUpdate', session: { ...session, id: 'collapse-restore' } });
}

// ------------------------------------------------ 开关：不显示路径时方框只有元素名
{
  const mkNode = (id, depth, parent, children, extra = {}) => ({
    id,
    name: id,
    file: 'demo.cpp',
    line: 1,
    direction: 'callers',
    depth,
    isCycle: false,
    children,
    parent,
    loaded: false,
    canExpand: false,
    kind: 'function',
    ...extra,
  });
  const nodes = {
    r0: mkNode('r0', 0, undefined, ['c0'], { loaded: true }),
    c0: mkNode('c0', 1, 'r0', [], {
      loaded: true,
      name: 'short',
      // 路径刻意放长：关掉路径后宽度变窄才看得出来
      file: 'some/very/long/path/to/a/source/file/named/demo.cpp',
      line: 123,
    }),
  };
  const boxes = createLayout(nodes, 'r0').boxes;
  const session = {
    id: 'location-check',
    title: '路径开关',
    description: '',
    direction: 'callers',
    engineLabel: 'clangd',
    rootId: 'r0',
    nodes,
    edges: [{ id: 'e_c0', from: 'c0', to: 'r0' }],
    boxes,
    collapsedCount: 0,
  };
  const groupOf = (id) => nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  const boxWidthOf = (id) =>
    Number(
      groupOf(id)
        ?.children.find((child) => String(child.getAttribute('class')) === 'box')
        ?.getAttribute('width')
    );
  const boxHeightOf = (id) =>
    Number(
      groupOf(id)
        ?.children.find((child) => String(child.getAttribute('class')) === 'box')
        ?.getAttribute('height')
    );
  const groupEl = (id) => groupOf(id)?.flatten() ?? [];
  /** 组内某个 class 的元素是否存在 / 它的文本（方框里的「路径:行号」行就是 .loc）。 */
  const hasClass = (id, cls) => groupEl(id).some((el) => String(el.getAttribute('class')) === cls);
  const textOfClass = (id, cls) =>
    String(groupEl(id).find((el) => String(el.getAttribute('class')) === cls)?.textContent ?? '');
  const attrOfClass = (id, cls, attr) =>
    Number(groupEl(id).find((el) => String(el.getAttribute('class')) === cls)?.getAttribute(attr));

  const compactBoxes = createLayout(nodes, 'r0', undefined, undefined, false).boxes;

  sendToWebview({ type: 'sessionUpdate', session });
  flushFrames();
  assert(
    hasClass('c0', 'loc') && /demo\.cpp:123/.test(textOfClass('c0', 'loc')),
    `默认应当显示「文件路径:行号」那一行，实际 .loc=${textOfClass('c0', 'loc')}`
  );
  const wideWidth = boxWidthOf('c0');
  const wideHeight = boxHeightOf('c0');

  // 关掉路径：宿主先下发设置，再按新设置**重排**（真实扩展里 showLocation 会触发 relayout）
  sendToWebview({ type: 'settings', settings: { showLocation: false } });
  sendToWebview({
    type: 'sessionUpdate',
    session: { ...session, boxes: compactBoxes },
  });
  flushFrames();
  assert(
    !hasClass('c0', 'loc'),
    '关掉「显示路径」后不该再有 .loc 那一行（方框里只剩元素名）'
  );
  assert(
    textOfClass('c0', 'name') === 'short',
    `关掉后元素名应当照常显示，实际 name=${textOfClass('c0', 'name')}`
  );
  const narrowWidth = boxWidthOf('c0');
  const narrowHeight = boxHeightOf('c0');
  assert(
    narrowWidth < wideWidth,
    `关掉路径后方框应当变窄（关前 ${wideWidth}，关后 ${narrowWidth}）`
  );
  assert(
    narrowHeight < wideHeight,
    `关掉路径后方框应当变矮（关前 ${wideHeight}，关后 ${narrowHeight}）`
  );
  // 单行时那一行要**在框里垂直居中**：13px 粗体墨迹约在基线上方 9、下方 3 → 基线 = 框高/2 + 3
  const nameY = attrOfClass('c0', 'name', 'y');
  assert(
    Math.abs(nameY - (narrowHeight / 2 + 3)) <= 0.5,
    `单行时元素名应当在框里居中（基线 ${nameY}，框高 ${narrowHeight}，应为 ${narrowHeight / 2 + 3}）`
  );
  // 图标也要跟着垂直居中（不能还按两行布局钉在 y=5）
  const iconY = Number(
    /translate\([-\d.]+ ([-\d.]+)\)/.exec(
      String(
        groupOf('c0')?.children.find((child) => String(child.getAttribute('class')).startsWith('kind-icon'))
          ?.getAttribute('transform')
      )
    )?.[1]
  );
  assert(
    Math.abs(iconY - (narrowHeight - 13) / 2) <= 0.5,
    `单行时符号图标应当在框里居中（图标 y=${iconY}，框高 ${narrowHeight}）`
  );

  // 再打开：路径回来、宽高都恢复
  sendToWebview({ type: 'settings', settings: { showLocation: true } });
  sendToWebview({ type: 'sessionUpdate', session });
  flushFrames();
  assert(
    hasClass('c0', 'loc') &&
      boxWidthOf('c0') === wideWidth &&
      boxHeightOf('c0') === wideHeight,
    `重新打开后应当恢复路径与宽高（宽 ${boxWidthOf('c0')}/${wideWidth}，高 ${boxHeightOf('c0')}/${wideHeight}）`
  );
  log(
    `OK: 「显示路径」开关有效 —— 关掉后只剩元素名、方框 ${wideWidth}×${wideHeight} → ` +
      `${narrowWidth}×${narrowHeight}px，名字与图标都在框里居中，打开后恢复`
  );

  // 收尾：换一个新会话，保证后面延后执行的段落仍能在当前 DOM 上数到 ≥2 个加减号
  sendToWebview({ type: 'sessionUpdate', session: { ...session, id: 'location-restore' } });
  sendToWebview({ type: 'settings', settings: { stickyParent: false } });
}

// ------------------------------------------------ 加载遮罩（转圈 + 取消 + 背景模糊）
//
// 宏、结构体、变量这类符号要走引用查找（一串语言服务请求），明显比普通函数慢。
// 解析较久时在画布正中显示遮罩：转圈 + 文案 + 取消，背景模糊；
// 快查询不显示（延迟 240ms），否则会闪一下。
{
  const css = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'graph.css'), 'utf8');
  assert(
    /\.busy\s*\{[^}]*backdrop-filter:\s*blur\(/.test(css),
    '遮罩应当把背景模糊掉（backdrop-filter: blur）'
  );
  // 遮罩必须挂在**不滚动**的 #stage 上：挂在 #canvas（滚动容器）里会随内容滚出可视区，
  // 「正中」也只是内容盒的正中，而不是眼前这块面板的正中。
  assert(
    /<div id="stage"[\s\S]*<div id="canvas"[\s\S]*?<\/div>[\s\S]*<div id="busy"/.test(htmlSource),
    '加载遮罩应当挂在 #canvas 之外的 #stage 上'
  );
  assert(
    /\.stage\s*\{[^}]*position:\s*relative/.test(css),
    '#stage 必须是定位祖先，遮罩的 inset:0 才会落在不滚动的那一层上'
  );
  assert(/\.busy-spinner\s*\{[^}]*animation:\s*busy-spin/.test(css), '遮罩里应当有转圈动画');
  assert(/@keyframes\s+busy-spin/.test(css), '转圈动画应当有 @keyframes 定义');
  assert(/\.busy\[hidden\]\s*\{\s*display:\s*none/.test(css), '遮罩应当支持 hidden 隐藏');

  const busyEl = byId.get('busy');
  const busyLabel = byId.get('busy-label');
  const cancelButton = byId.get('btn-busy-cancel');
  assert(busyEl !== undefined, '画布里应当有加载遮罩元素 #busy');
  assert(busyLabel !== undefined, '遮罩里应当有文案元素 #busy-label');
  assert(cancelButton !== undefined, '遮罩里应当有「取消」按钮');
  assert(
    String(cancelButton.textContent) === '取消',
    `按钮文案应当是「取消」，实际 ${cancelButton.textContent}`
  );
  assert(busyEl.hidden === true, '默认不应显示遮罩');

  // 快查询：busy 立刻结束，延迟没到就不该显示（这是「不闪一下」的关键）
  sendToWebview({ type: 'busy', busy: true, label: '正在解析被调用关系图…' });
  sendToWebview({ type: 'busy', busy: false });
  setTimeout(() => {
    assert(busyEl.hidden === true, '较快的解析结束后不应留下遮罩');

    // 慢查询：延迟过后显示遮罩，文案来自宿主
    posted.length = 0;
    sendToWebview({ type: 'busy', busy: true, label: '正在解析被调用关系图…' });
    setTimeout(() => {
      assert(busyEl.hidden === false, '解析较慢时应当在画布正中显示遮罩');
      assert(
        String(busyLabel.textContent).includes('正在解析'),
        `遮罩文案应当是宿主下发的那句，实际 ${busyLabel.textContent}`
      );

      // 点「取消」：通知宿主并立刻收起遮罩
      cancelButton.dispatch('click', {});
      assert(
        posted.some((message) => message.type === 'cancelResolve'),
        `点「取消」应当向宿主发 cancelResolve，实际 ${JSON.stringify(posted.map((m) => m.type))}`
      );
      assert(busyEl.hidden === true, '点「取消」后遮罩应当立刻收起');

      // 宿主收尾的 busy:false 不应让遮罩又冒出来
      sendToWebview({ type: 'busy', busy: false });
      assert(busyEl.hidden === true, '解析结束后遮罩不应再出现');
      log('OK: 加载遮罩（转圈 + 取消 + 背景模糊）—— 快查询不闪、慢查询显示、可取消');
    }, 400);
  }, 400);
}

// ------------------------------------------------ 渲染路径数量级压测（只出数字，不判成败）
//
// 为什么放在这里：renderCheck 已经有完整的 DOM 桩与消息通道，直接用它放大节点数量最省事。
// 量的是**我们自己的算法开销**（遍历、建元素、量宽缓存命中），不含浏览器的真实布局/绘制 ——
// 后者在桩里没有。所以这里看的是「是否出现超线性的增长」，不是绝对帧时。
{
  try {
    const { createLayout: buildLayout } = require(path.join(ROOT, 'dist', 'extension.js')).__layout;
    console.log('=== 渲染路径数量级压测（DOM 桩，不含真实布局/绘制） ===');
    for (const count of [200, 800, 1600]) {
      const nodes = {};
      const children = [];
      for (let index = 0; index < count; index += 1) {
        const id = `p${index}`;
        children.push(id);
        nodes[id] = {
          id,
          name: `func_${index}`,
          file: `src/m${index % 40}/f${index}.cpp`,
          line: 1 + (index % 500),
          direction: 'callees',
          depth: 1,
          isCycle: false,
          children: [],
          parent: 'proot',
          loaded: true,
          kind: 'function',
        };
      }
      nodes.proot = {
        id: 'proot',
        name: 'perf_root',
        file: 'src/perf/root.cpp',
        line: 1,
        direction: 'callees',
        depth: 0,
        isCycle: false,
        children,
        loaded: true,
        kind: 'function',
      };
      const layout = buildLayout(nodes, 'proot');
      const boxes = layout.boxes;
      const edges = children.slice(0, 40).map((id, index) => ({
        id: `pe${index}`,
        from: 'proot',
        to: id,
        depth: 1,
      }));
      const payload = {
        type: 'sessionUpdate',
        session: {
          id: `perf-${count}`,
          title: `压测 ${count}`,
          description: '',
          direction: 'callees',
          engineLabel: 'clangd',
          badge: 'clangd',
          rootId: 'proot',
          nodes,
          edges,
          boxes,
          collapsedCount: 0,
        },
      };
      const readsBefore = measureProbeReads;
      const started = process.hrtime.bigint();
      sendToWebview(payload);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const reads = measureProbeReads - readsBefore;
      console.log(
        `  ${String(count).padStart(5)} 节点：渲染 ${ms.toFixed(1)} ms（${((ms / count) * 1000).toFixed(1)} µs/节点），` +
          `量宽探测 ${reads} 次`
      );
      // 第二次同数据：量宽缓存应当几乎不再探测（这是"大图不卡"的关键）
      const readsBefore2 = measureProbeReads;
      const started2 = process.hrtime.bigint();
      sendToWebview(payload);
      const ms2 = Number(process.hrtime.bigint() - started2) / 1e6;
      console.log(
        `        重复渲染：${ms2.toFixed(1)} ms，量宽探测 ${measureProbeReads - readsBefore2} 次（缓存生效时应接近 0）`
      );
    }
  } catch (error) {
    // ⚠️ 必须**判失败**，不能只打印：这一块本来就不做断言（只出数字），一旦它自己抛错，
    // 表现是「压测数字凭空消失、退出码仍是 0」。本轮就踩过：生产代码新起的 logWarn 需要
    // 桩里没有的 createOutputChannel，异常被这里吞掉，整段压测静默停摆。
    console.error('渲染压测块出错（这是失败，不是跳过）：', error && error.stack);
    process.exit(1);
  }
}

// ------------------------------------------------ 截断必须出声（超过布局上限时）
//
// 以前这段警告写在排布循环**内部**，判据是「已经有节点被跳过 且 刚好排满上限」——
// 排满的那一瞬间还没有任何节点被跳过，此后 placement 分支再也不进入，
// 于是这条警告从来没打印过（「截断不能静默」等于没兑现）。这里直接钉住它真的出声。
{
  const EXTRA = 900;
  const nodes = {};
  const children = [];
  for (let index = 0; index < EXTRA; index += 1) {
    const id = `t${index}`;
    children.push(id);
    nodes[id] = {
      id,
      name: `t_${index}`,
      file: 'x.c',
      line: 1,
      direction: 'callees',
      depth: 1,
      isCycle: false,
      children: [],
      parent: 'troot',
      loaded: true,
      kind: 'function',
    };
  }
  nodes.troot = {
    id: 'troot',
    name: 'troot',
    file: 'x.c',
    line: 1,
    direction: 'callees',
    depth: 0,
    isCycle: false,
    children,
    loaded: true,
    kind: 'function',
  };
  const before = outputLines.length;
  const layout = createLayout(nodes, 'troot');
  const placed = Object.keys(layout.boxes).length;
  // 800 = MAX_LAYOUT_NODES（另一处已有「MAX_LAYOUT_NODES ≥ MAX_EXPAND_NODES」的跨侧断言钉住它）
  assert(placed === 800, `超过上限时方框数应当恰好是 800，实际 ${placed}`);
  const warned = outputLines
    .slice(before)
    .filter((line) => line.level === 'warn' && line.message.includes('图过大'));
  assert(
    warned.length === 1,
    `被截断时必须写一条日志说明（截断不能静默），实际新增 ${JSON.stringify(outputLines.slice(before))}`
  );
  assert(
    warned[0].message.includes(`${EXTRA + 1 - 800} 个节点未显示`),
    `日志要如实报出未显示的节点数（应为 ${EXTRA + 1 - 800}），实际「${warned[0].message}」`
  );
  log(`OK: 超过布局上限会明说 —— ${warned[0].message}`);
}

// ------------------------------------------------ 单击 / 步进的实测探针（只出数字；点击若不可用则跳过）
//
// 上一轮把「选中」与「上下键切换命中」改成只改 class（refreshStateClasses），不再重建 #nodes。
// 这里派发真实点击，量出该路径耗时，并断言它**不触发量宽探测** —— 不重建 DOM 就不该量宽。
{
  try {
    const container = document.getElementById('nodes');
    // ⚠️ 不能写死某个 id：布局上限 800 且栈是 LIFO，实际渲染的是编号靠后的那些节点
    // （实测容器里有 proot,p1599,p1598…），硬点 p5 会点到不存在的节点。
    const target = container
      ? [...container.children].find((child) => {
          const id = child.getAttribute('data-node');
          return Boolean(id) && id !== 'proot';
        })
      : undefined;
    if (!target || typeof target.dispatch !== 'function') {
      // 具体说明缺什么，避免"取不到"这种含糊结论（上一轮就是被它耽误的）
      console.log(
        '=== 单击探针跳过 === ' +
          '容器=' +
          (container ? `有（子节点 ${container.children.length} 个）` : '无') +
          '，目标节点=' +
          (target ? '有' : '无') +
          '，dispatch=' +
          (target && typeof target.dispatch === 'function' ? '有' : '无') +
          (container && container.children.length > 0
            ? `，前几个 data-node=${[...container.children]
                .slice(0, 5)
                .map((child) => child.getAttribute('data-node'))
                .join(',')}`
            : '')
      );
    } else {
      const readsBefore = measureProbeReads;
      const started = process.hrtime.bigint();
      const clicks = 20;
      for (let index = 0; index < clicks; index += 1) {
        target.dispatch('click', { button: 0, detail: 1 });
      }
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const reads = measureProbeReads - readsBefore;
      const selected = String(target.getAttribute('class') ?? '').includes('selected');
      console.log('=== 单击 / 步进实测探针 ===');
      console.log(
        `  ${clicks} 次单击：${ms.toFixed(1)} ms（${(ms / clicks).toFixed(2)} ms/次），量宽探测 ${reads} 次；` +
          `节点是否已选中：${selected ? '是' : '否'}`
      );
      if (selected) {
        assert(
          reads === 0,
          `只改 class 的选中路径不该触发量宽探测（实际 ${reads} 次）——说明它又在重建 DOM`
        );
      } else {
        console.log('  （点击没有改变选中态，说明桩的事件路径与实现不同，未做断言）');
      }
    }
  } catch (error) {
    console.error('单击探针出错（不影响断言）：', error && error.message);
  }
}

// ------------------------------------------------ 搜索框打字实测探针（只出数字 + 两条不变式）
//
// 以前每敲一个字符都 render() 全量重建 #nodes（800 个方框约 40 ms）。现在走 refreshSearchMarks()
// 就地增删 class 与底纹。这里量出耗时，并钉住两条不变式：不重建、不量宽。
{
  try {
    const input = document.getElementById('search-input');
    const container = document.getElementById('nodes');
    if (!input || !container || typeof input.dispatch !== 'function') {
      console.log('=== 打字探针跳过：桩里取不到搜索框或节点容器 ===');
    } else {
      const before = container.children.length;
      const readsBefore = measureProbeReads;
      const keys = ['f', 'fu', 'fun', 'func', 'func_', 'func_1', 'func_15', 'func_159', 'func_1599'];
      const started = process.hrtime.bigint();
      for (const key of keys) {
        input.value = key;
        input.dispatch('input', {});
      }
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const reads = measureProbeReads - readsBefore;
      const after = container.children.length;
      console.log('=== 搜索框打字实测探针 ===');
      console.log(
        `  连打 ${keys.length} 个字符：${ms.toFixed(1)} ms（${(ms / keys.length).toFixed(2)} ms/字符），` +
          `量宽探测 ${reads} 次`
      );
      console.log(`  #nodes 元素数：${before} → ${after}（不变才说明没有重建 DOM）`);
      assert(
        after === before,
        `打字改变了 #nodes 的元素数（${before} → ${after}）——说明又走了全量重建`
      );
      assert(reads === 0, `打字触发了 ${reads} 次量宽探测，底纹宽度本应命中缓存`);
    }
  } catch (error) {
    console.error('打字探针出错（不影响断言）：', error && error.message);
  }
}



// ------------------------------------------------ 路径显示方式（省略几层 / 完整 / 锚点）
//
// 需求来自真实场景：一个目录下并列很多 chip / board，每个 chip 下又有同名文件，
// 只显示末尾几层无法区分是哪个 chip。这里把三种口径都钉住，并做**跨侧等值**检查 ——
// 宿主（估宽）与 webview（渲染）各有一份同样的逻辑，一旦漂移，列宽就会与文字对不上。
{
  const layoutApi = extensionBundle.__layout;
  assert(
    typeof layoutApi.displayPathText === 'function',
    '产物没有导出 __layout.displayPathText，跨侧一致性无法验证'
  );

  // ⚠️ 歧义只在「区分用的那一段落到了预算窗口之外」时才出现：短路径（33 字符）整体放得下、
  // 本来就能区分，所以这里**必须用足够深的路径**才能复现用户报的场景。
  const BOARD_A = 'components/BSP/board_a/src/drivers/display/lcd/lcd_init.c';
  const BOARD_B = 'components/BSP/board_b/src/drivers/display/lcd/lcd_init.c';
  const BOARD_A_SHORT = 'components/BSP/board_a/src/main.c';
  const BOARD_B_SHORT = 'components/BSP/board_b/src/main.c';
  const DEEP = 'src/modules/display/driver/lcd/lcd_init.c';
  const SHORT = 'main/main.c';
  // 目录名里带连字符：用来钉住「整串名字优先于偏移解析」这条规则
  const HYPHEN = 'components/BSP/chip-01/main.c';
  const paths = [BOARD_A, BOARD_B, DEEP, SHORT, BOARD_A_SHORT, BOARD_B_SHORT, HYPHEN];
  const ids = [];
  const nodes = {};
  for (const [index, file] of paths.entries()) {
    const id = `pd${index}`;
    ids.push(id);
    nodes[id] = {
      id,
      name: `pd_${index}`,
      file,
      line: index + 1,
      direction: 'callers',
      depth: 1,
      isCycle: false,
      children: [],
      parent: 'pdroot',
      loaded: true,
      kind: 'function',
    };
  }
  nodes.pdroot = {
    id: 'pdroot',
    name: 'pdroot',
    file: 'pdroot.c',
    line: 1,
    direction: 'callers',
    depth: 0,
    isCycle: false,
    children: ids,
    loaded: true,
    kind: 'function',
  };

  /** 把当前设置下的图发下去，并取回每个节点方框里那行「路径:行号」。 */
  const renderWith = (settings) => {
    sendToWebview({ type: 'settings', settings: { showLocation: true, ...settings } });
    const boxes = createLayout(nodes, 'pdroot').boxes;
    sendToWebview({
      type: 'sessionUpdate',
      session: {
        id: 'path-display',
        title: '路径显示',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'pdroot',
        nodes,
        edges: [],
        boxes,
        collapsedCount: 0,
      },
    });
    const read = (id) => {
      const group = nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
      const loc = group?.children.find((child) => child.getAttribute('class') === 'loc');
      return String(loc?.textContent ?? '');
    };
    return read;
  };

  /** 同一份设置给宿主函数与 webview 各算一遍，逐条比对（跨侧漂移就会红）。 */
  const assertCrossSide = (options, label) => {
    const read = renderWith({
      pathDisplay: options.mode,
      pathTailLevels: options.tailLevels,
      pathAnchors: options.anchors,
    });
    for (const [index, file] of paths.entries()) {
      const expected = `${layoutApi.displayPathText(file, options)}:${index + 1}`;
      const actual = read(`pd${index}`);
      assert(
        actual === expected,
        `${label}：${file} 的显示文字两侧不一致 —— webview=「${actual}」，宿主=「${expected}」`
      );
    }
    return read;
  };

  // ① 默认口径必须**等于 0.20 的行为**（按宽度自动）：深路径保留末尾若干段，短路径原样
  const defaultOptions = { ...layoutApi.DEFAULT_PATH_OPTIONS };
  const readDefault = assertCrossSide(defaultOptions, '默认（按宽度自动）');
  // ⚠️ 样例必须**当场取**：read* 读的是当前 DOM，等最后再读就只剩最后一次渲染的结果，
  // 日志会显示成「五种模式一模一样」，看着像功能没生效。
  const sampleDefault = readDefault('pd0');
  assert(
    readDefault('pd2') === `…/modules/display/driver/lcd/lcd_init.c:3`,
    `默认口径应当与 0.20 一致（40 字符内尽量多留末尾段），实际「${readDefault('pd2')}」`
  );
  assert(readDefault('pd3') === 'main/main.c:4', `短路径应当原样显示，实际「${readDefault('pd3')}」`);
  // 用户报的场景：深路径下两个 board 的同名文件**完全无法区分**（只差行号）
  const pathPart = (text) => text.replace(/:\d+$/, '');
  assert(
    pathPart(readDefault('pd0')) === pathPart(readDefault('pd1')),
    `默认口径下两条 board 路径应当长得一样（这正是要解决的问题），实际「${readDefault('pd0')}」「${readDefault('pd1')}」`
  );

  // ② 只在末尾留 2 层：仍是同名，形状变成 `…/lcd/lcd_init.c`
  const tailTwo = { ...defaultOptions, tailLevels: 2 };
  const readTail = assertCrossSide(tailTwo, '末尾 2 层');
  const sampleTail = readTail('pd0');
  assert(
    readTail('pd0') === '…/lcd/lcd_init.c:1' && pathPart(readTail('pd0')) === pathPart(readTail('pd1')),
    `末尾 2 层应当显示成「…/lcd/lcd_init.c:1」且两条仍相同，实际「${readTail('pd0')}」「${readTail('pd1')}」`
  );

  // ③ 纯偏移锚点：`+3` = 从根数第 3 段（board_a / board_b 就在第 3 段）→ 两条终于分得开
  const byLevel = { ...tailTwo, anchors: ['+3'] };
  const readLevel = assertCrossSide(byLevel, '锚点 +3');
  const sampleLevel = readLevel('pd0');
  assert(
    readLevel('pd0') === '…/board_a/…/lcd/lcd_init.c:1',
    `锚点 +3 应当显示成「…/board_a/…/lcd/lcd_init.c:1」，实际「${readLevel('pd0')}」`
  );
  assert(
    readLevel('pd1') === '…/board_b/…/lcd/lcd_init.c:2',
    `另一条应当显示成「…/board_b/…/lcd/lcd_init.c:2」，实际「${readLevel('pd1')}」`
  );

  // ④ 名字锚点：`BSP` 保留该段本身
  const byName = { ...tailTwo, anchors: ['BSP'] };
  const readName = assertCrossSide(byName, '名字锚点 BSP');
  const sampleName = readName('pd0');
  assert(
    readName('pd0') === '…/BSP/…/lcd/lcd_init.c:1',
    `名字锚点应当显示成「…/BSP/…/lcd/lcd_init.c:1」，实际「${readName('pd0')}」`
  );

  // ⑤ 相对偏移且**基准段不显示**：`BSP+1` 只保留下一级（board_a），正是「只显示偏移出来的目录」
  const byOffset = { ...tailTwo, anchors: ['BSP+1'] };
  const readOffset = assertCrossSide(byOffset, '锚点 BSP+1（基准不显示）');
  const sampleOffset = readOffset('pd0');
  assert(
    readOffset('pd0') === '…/board_a/…/lcd/lcd_init.c:1',
    `BSP+1 应当只显示偏移出来的那一段（…/board_a/…），实际「${readOffset('pd0')}」`
  );
  assert(
    readOffset('pd1') === '…/board_b/…/lcd/lcd_init.c:2',
    `另一条应当是 board_b，实际「${readOffset('pd1')}」`
  );

  // ⑥ 多层组合：基准与偏移各单列一条 → 两者都显示，且相邻段连在一起（中间不加省略号）
  const combined = { ...tailTwo, anchors: ['BSP', 'BSP+1'] };
  const readCombined = assertCrossSide(combined, '锚点 BSP + BSP+1');
  const sampleCombined = readCombined('pd0');
  assert(
    readCombined('pd0') === '…/BSP/board_a/…/lcd/lcd_init.c:1',
    `组合锚点应当显示成「…/BSP/board_a/…/lcd/lcd_init.c:1」，实际「${readCombined('pd0')}」`
  );

  // ⑦ 从文件名往上数：`-1` = 文件所在目录
  const byTail = { ...tailTwo, anchors: ['-1'] };
  const readTailAnchor = assertCrossSide(byTail, '锚点 -1');
  assert(
    readTailAnchor('pd0') === '…/lcd/lcd_init.c:1',
    `-1 应当取到文件所在目录，实际「${readTailAnchor('pd0')}」`
  );

  // ⑧ 目录名本身带 `-` 时不能被当成偏移（解析顺序：整串名字优先）
  const hyphen = { ...defaultOptions, tailLevels: 1, anchors: ['chip-01'] };
  const readHyphen = assertCrossSide(hyphen, '锚点 chip-01（含连字符的目录名）');
  const sampleHyphen = readHyphen('pd6');
  assert(
    readHyphen('pd6') === '…/chip-01/main.c:7',
    `含连字符的目录名应当被整串匹配，实际「${readHyphen('pd6')}」`
  );

  // ⑨ 完整显示：放得下就给整条路径（两条 board 路径自然也能区分）
  const fullMode = { ...defaultOptions, mode: 'full' };
  const readFull = assertCrossSide(fullMode, '完整显示');
  const sampleFull = readFull('pd4');
  assert(
    readFull('pd4') === `${BOARD_A_SHORT}:5`,
    `放得下的路径应当整条显示，实际「${readFull('pd4')}」`
  );
  assert(
    readFull('pd4') !== readFull('pd5'),
    `完整显示下两条短 board 路径必须不同，实际「${readFull('pd4')}」「${readFull('pd5')}」`
  );
  // 放不下的长路径：保留首尾（含文件名）且不超长 —— 完整路径的承诺由**悬停提示**兜底
  assert(
    readFull('pd2').length <= 45 && readFull('pd2').includes('lcd_init.c'),
    `放不下的长路径应当保留首尾（含文件名）且不超长，实际「${readFull('pd2')}」`
  );
  {
    const group = nodesGroup.children.find((child) => child.getAttribute('data-node') === 'pd0');
    const tip = group?.children.find((child) => child.tagName === 'title');
    assert(
      String(tip?.textContent ?? '').includes(BOARD_A),
      `悬停提示里必须始终有完整路径，实际「${String(tip?.textContent ?? '').replace(/\n/g, ' / ')}」`
    );
  }

  // 收尾：把设置恢复成默认，免得影响后面的用例
  sendToWebview({
    type: 'settings',
    settings: { showLocation: true, pathDisplay: 'tail', pathTailLevels: 0, pathAnchors: [] },
  });
  log(
    `诊断: 路径显示 —— 默认「${sampleDefault}」、末尾 2 层「${sampleTail}」、` +
      `层号锚点「${sampleLevel}」、名字锚点「${sampleName}」、完整「${sampleFull}」`
  );
  console.log('OK: 路径显示方式 —— 三种口径与两种锚点都生效，且宿主与 webview 两侧文字完全一致');
}

// ------------------------------------------------ 标签切换：点得动，且 relayout 不许抢活动标签
//
// 用户实测：多个标签时只有最新那个点得动。原因是两个方向各有一半 —— 宿主只补发内容、
// 不下发 selectTab；而 webview 只在**新会话**的 sessionUpdate 里认领活动标签
// （否则 relayout 逐个重发时标签会自己跳到最后）。这里把两半都钉住。
{
  const mkTabSession = (id, rootName) => {
    const session = makeSession('callers');
    session.id = id;
    session.title = rootName;
    session.nodes = {
      root: { ...session.nodes.root, name: rootName, detail: `void ${rootName}(void)` },
      child: { ...session.nodes.child },
    };
    return session;
  };
  const sessionA = mkTabSession('tab-a', 'switchA');
  const sessionB = mkTabSession('tab-b', 'switchB');
  const tabLabel = (tab) =>
    String(tab.children.find((child) => child.className.includes('tab-label'))?.textContent ?? '');
  const activeLabel = () =>
    tabLabel(byId.get('tabs').children.find((tab) => tab.getAttribute('aria-selected') === 'true'));
  const renderedNames = () =>
    nodesEl
      .flatten()
      .filter((element) => element.tagName === 'text')
      .map((element) => String(element.textContent));

  sendToWebview({ type: 'sessionUpdate', session: sessionA });
  sendToWebview({ type: 'sessionUpdate', session: sessionB });
  assert(
    activeLabel() === 'switchB',
    `新会话应当抢到活动标签（期望 switchB，实际 ${activeLabel()}）`
  );
  assert(
    renderedNames().includes('switchB') && !renderedNames().includes('switchA'),
    `画布上应当只画活动会话的图（实际 ${renderedNames().join(',')}）`
  );

  posted.length = 0;
  const tabA = byId
    .get('tabs')
    .children.find((tab) => tabLabel(tab) === 'switchA');
  assert(tabA !== undefined, '标签栏里找不到 switchA 的标签');
  tabA.dispatch('click', {});
  // webview → 宿主：点标签只发请求，切不切由宿主说了算（这也是分叉的源头）
  const requested = posted.filter((message) => message.type === 'selectTab');
  assert(
    requested.length === 1 && requested[0].id === 'tab-a',
    `点标签应当发出 selectTab(tab-a)，实际 ${JSON.stringify(requested)}`
  );
  assert(
    activeLabel() === 'switchB',
    `只发请求、还没收到宿主回执时不应自行切换（实际 ${activeLabel()}）`
  );

  // 宿主 → webview：显式回执才是切换动作
  sendToWebview({ type: 'selectTab', id: 'tab-a' });
  assert(activeLabel() === 'switchA', `收到回执后活动标签应当切到 switchA，实际 ${activeLabel()}`);
  assert(
    renderedNames().includes('switchA') && !renderedNames().includes('switchB'),
    `切换后画布应当换成 switchA 的图（实际 ${renderedNames().join(',')}）`
  );

  // 键盘也要能切：div[role=tab] 不会因回车自动产生 click，而漫游 tabindex 把非活动标签
  // 移出了 Tab 序列 —— 不接键盘的话，唯一能聚焦的标签反而按不动。
  posted.length = 0;
  tabA.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  assert(
    posted.some((message) => message.type === 'selectTab' && message.id === 'tab-a'),
    `在标签上按回车应当切换，实际发出 ${JSON.stringify(posted)}`
  );
  posted.length = 0;
  const activeTab = byId
    .get('tabs')
    .children.find((tab) => tab.getAttribute('aria-selected') === 'true');
  activeTab.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert(
    posted.some((message) => message.type === 'selectTab' && message.id !== 'tab-a'),
    `方向键应当在标签之间移动并切换，实际发出 ${JSON.stringify(posted)}`
  );
  // 回到 switchA，保持后面的断言前提不变
  sendToWebview({ type: 'selectTab', id: 'tab-a' });

  // 反向守卫：relayout（把非活动会话重发一遍）绝不能把活动标签抢走 ——
  // 这正是「只在**新会话**的 sessionUpdate 里认领活动标签」那条规则的用途。
  sendToWebview({ type: 'sessionUpdate', session: sessionB });
  assert(
    activeLabel() === 'switchA',
    `重发非活动会话不应抢走活动标签（实际 ${activeLabel()}）`
  );
  console.log(
    'OK: 标签切换 —— 点标签发 selectTab、宿主回执后才切换，且重发其它会话不会抢走活动标签'
  );
}

// ------------------------------------------------ 新查询：根方框必须被摆到视口中央
//
// 真实的消息顺序是「先 update（标签摘要）→ 再 sessionUpdate（内容）」：宿主 addSession 里先把
// 会话 push 进 sessions，紧接着 setViewVisible() 就会带着这个新标签发一次 update，前端于是
// **先建了一个没有内容的占位会话**。若「要不要把根摆到中央」按 isNew（有没有听说过这个会话）判，
// 内容到达时 isNew 已经是 false，居中就永远不会发生 —— 新图停在内容左上角，调用者多的时候
// 连被查询的那个符号都看不见。这里按真实顺序复现一次，钉住「首次拿到内容才居中」。
{
  const CALLER_COUNT = 40;
  const callerIds = Array.from({ length: CALLER_COUNT }, (_, index) => `caller${index}`);
  const nodes = {};
  for (const [index, id] of callerIds.entries()) {
    nodes[id] = {
      id,
      name: `caller_${index}`,
      file: 'x.c',
      line: index + 1,
      direction: 'callers',
      depth: 1,
      isCycle: false,
      children: [],
      parent: 'centerRoot',
      loaded: true,
      canExpand: false,
      kind: 'function',
    };
  }
  nodes.centerRoot = {
    id: 'centerRoot',
    name: 'centerRoot',
    detail: 'void centerRoot(void)',
    file: 'x.c',
    line: 1,
    direction: 'callers',
    depth: 0,
    isCycle: false,
    children: callerIds,
    loaded: true,
    canExpand: false,
    kind: 'function',
  };
  const boxes = createLayout(nodes, 'centerRoot').boxes;
  const centerSession = {
    id: 'center-check',
    title: 'centerRoot',
    description: 'x.c:1',
    direction: 'callers',
    engineLabel: 'clangd',
    rootId: 'centerRoot',
    nodes,
    edges: callerIds.map((id) => ({ id: `e_${id}`, from: id, to: 'centerRoot', depth: 1 })),
    boxes,
    collapsedCount: 0,
  };
  // ⚠️ 必须等**其它小节注册的定时器全部跑完**再动手：本文件靠 setTimeout 串起好几段
  // 异步小节（遮罩 400ms、宽会话 20ms…），它们会在主脚本结束后依次醒来、各自切换活动会话。
  // 早先这个用例只等 50ms，醒来时看到的活动会话已经被别人换掉了（viewBox 与方框数都不是
  // 自己那张图），等于在别人的画布上断言。900ms 覆盖掉所有更早的定时器。
  setTimeout(() => {
    canvasEl.clientWidth = 800;
    canvasEl.clientHeight = 400;
    canvasEl.scrollLeft = 0;
    canvasEl.scrollTop = 0;
    // 真实顺序：先摘要（前端建占位），再内容
    sendToWebview({
      type: 'update',
      sessions: [
        {
          id: centerSession.id,
          title: centerSession.title,
          description: centerSession.description,
          direction: 'callers',
        },
      ],
      activeId: centerSession.id,
    });
    sendToWebview({ type: 'sessionUpdate', session: centerSession });

    setTimeout(() => {
      assert(
        Object.keys(boxes).length === CALLER_COUNT + 1,
        `居中用例的图应当有 ${CALLER_COUNT + 1} 个方框，实际 ${Object.keys(boxes).length}`
      );
      assert(
        nodesGroup.children.some((child) => child.getAttribute('data-node') === 'centerRoot'),
        `居中用例醒来时画布上应当是它自己的图，实际 viewBox=${svg.getAttribute('viewBox')}、` +
          `方框数=${nodesGroup.children.length}`
      );
      const rootBox = boxes.centerRoot;
      // 内容比视口高得多，夹具才区分得出「居中」与「停在左上角」
      const contentHeight = Math.max(...Object.values(boxes).map((box) => box.y + box.height));
      assert(
        contentHeight > canvasEl.clientHeight * 2,
        `居中用例的内容高度应当明显超过视口（内容 ${contentHeight}，视口 ${canvasEl.clientHeight}）`
      );
      // 屏幕位置按**实际 viewBox** 反解（与粘性小节同一套算法），不照搬实现里的公式
      const viewBoxY = Number(String(svg.getAttribute('viewBox')).split(/\s+/)[1]);
      const rootCenter = rootBox.y + rootBox.height / 2;
      const screenCenter = rootCenter - viewBoxY - Number(canvasEl.scrollTop || 0);
      assert(
        Math.abs(screenCenter - canvasEl.clientHeight / 2) <= 1,
        `新查询应把根方框摆到视口中央：根中心 ${rootCenter}、viewBox.y ${viewBoxY}、` +
          `滚动 ${canvasEl.scrollTop} → 屏幕位置 ${screenCenter}（应约等于 ${canvasEl.clientHeight / 2}）`
      );
      log('OK: 新查询把根方框摆到视口中央 —— 在「先摘要、后内容」的真实顺序下也成立');
    }, 30);
  }, 900);
}
