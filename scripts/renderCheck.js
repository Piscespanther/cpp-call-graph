/**
 * 真实渲染检查：用「真实布局引擎 + 真实消息流」运行一次 dist/webview.js，
 * 断言最终 DOM 里确实有方框、连线、文字、符号角标，且坐标落在可视范围内。
 *
 * 为什么需要这个文件：字符串级断言骗过我们好几轮——
 * 「HTML 里有 script 标签」通过了但脚本被 CSP 拒；「URI 生成了」通过了但被
 * localResourceRoots 拦掉。只有真正构造 DOM 并检查渲染结果，才暴露了那些问题。
 *
 * 时序说明（曾经出错，务必保留）：webview 收到 sessionUpdate 会**同步**重绘，
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

/**
 * 取出源码里某个函数声明的**完整函数体**（含最外层花括号）。
 *
 * 为什么不用 `function X([\s\S]*?)\n\}` 这种一把梭的正则：函数签名可能是多行的，
 * 参数里的对象类型（`options: { stripTitles: boolean }`）本身就带一个顶格的 `}`，
 * 非贪婪匹配会在那里提前收尾，后面的结构断言全都在半截函数体上做 —— 看起来过了，
 * 实际上没有任何断言覆盖。
 *
 * 做法：① 先按三类括号配对跨过参数列表（里面的对象类型不会被误判）；
 *       ② 再从参数列表的 `)` 之后找**第一个顶格的 `\n}`** —— 那才是函数体的收尾
 *          （返回类型里的 `}` 与 `|`、`{` 同行，不在行首，因此不会被误认）。
 */
function functionBodyOf(source, name) {
  const head = `function ${name}`;
  const start = source.indexOf(head);
  assert(start >= 0, `源码里找不到 ${head}(（下面的结构断言无从谈起）`);
  let index = start + head.length;
  let depth = 0;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(' || char === '{' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0 && char === ')') {
        index += 1;
        break;
      }
    }
  }
  const tail = source.slice(index);
  const closing = tail.indexOf('\n}');
  assert(closing >= 0, `${head} 的函数体找不到收尾的顶格 '}'`);
  return source.slice(start, index + closing + 2);
}

/**
 * 生产代码会内联到导出 SVG 上的属性名（与 `EXPORT_STYLE_PROPERTIES` 一致）。
 *
 * 放在文件靠前处：源码级断言（比对生产那张表）与后面的行为断言（驱动桩计算样式）都要用；
 * 声明在 `const` 的暂时性死区之后被提前引用会直接抛 ReferenceError。
 */
const EXPORT_STYLE_PROPERTY_NAMES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
];

// ------------------------------------------------------------ 桩 DOM

/**
 * 属性表的桩：对应真实 DOM 的 `NamedNodeMap`。
 *
 * ⚠️ 这里过去是一个 `Map`：`Array.from(el.attributes)` 于是得到 `[名字, 取值]` 数组，
 * 而真实 DOM 得到的是 `Attr` 对象（读 `.name` / `.value`）。生产代码的导出净化正是按 `Attr`
 * 读的 —— 用 `Map` 时它读到的 `attribute.value` 全是 `undefined`，一个字符都不会改，
 * 断言却照旧通过。这类「桩替生产代码做假设」的假通过必须堵掉（见工作区约定第 5 节）。
 */
function createAttributeList() {
  const items = [];
  return {
    get length() {
      return items.length;
    },
    item(index) {
      return items[index] ?? null;
    },
    getNamedItem(name) {
      return items.find((attribute) => attribute.name === name) ?? null;
    },
    /** 真实语义：同名属性就地改值（它在文档序里的位置保持不变）。 */
    setNamedItem(attribute) {
      const existing = items.find((item) => item.name === attribute.name);
      if (existing === undefined) {
        items.push(attribute);
        return null;
      }
      const replaced = { ...existing };
      existing.value = attribute.value;
      return replaced;
    },
    /** 真实语义：属性不存在时抛 `NotFoundError`。 */
    removeNamedItem(name) {
      const index = items.findIndex((attribute) => attribute.name === name);
      if (index < 0) {
        throw new Error(`NotFoundError：属性 ${name} 不存在`);
      }
      return items.splice(index, 1)[0];
    },
    [Symbol.iterator]() {
      return items[Symbol.iterator]();
    },
  };
}

function createElement(tagName) {
  return {
    tagName,
    /**
     * 元素节点的 `nodeType`。真实 DOM 里 Element 恒为 1；桩过去没有这个字段，
     * 于是生产代码里「按 `nodeType` 分辨元素与文本、再递归下去」的写法在桩里
     * **一次都递归不到**（后代元素全被当成"两者都不是"跳过）—— 又一个假通过。
     */
    nodeType: 1,
    /**
     * 真实 DOM 里每个元素都能回指所属 document；量宽缓存要用
     * `ownerDocument.defaultView.getComputedStyle()` 取实际字体族，所以桩也得有。
     * 用 getter 是为了不受「createElement 先于 global.document 就绪」的顺序影响。
     */
    get ownerDocument() {
      return global.document;
    },
    attributes: createAttributeList(),
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
     * 于是「高亮遗漏 class」这类问题会被一半断言放行。
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
    /**
     * 子节点列表（真实 DOM：元素子节点与文本子节点混在同一个列表里，用 `nodeType` 区分）。
     *
     * 桩把文字存在 `_textContent` 上，它对应真实 DOM 里的**一个文本子节点**；因此这里如实给出
     * `nodeType` 1（元素）与 3（文本），且文本节点的 `nodeValue` 与 `_textContent` 是同一份数据
     * （写 `nodeValue` 等于改文字）—— 生产代码的导出净化要按 `nodeType` 分辨这两类，
     * 只看 `children` 是测不到的。
     */
    get childNodes() {
      const element = this;
      const nodes = [...this.children];
      if (this._textContent !== '') {
        nodes.push({
          nodeType: 3,
          parentNode: this,
          get nodeValue() {
            return element._textContent;
          },
          set nodeValue(value) {
            element._textContent = String(value);
          },
        });
      }
      return nodes;
    },
    setAttribute(name, value) {
      this.attributes.setNamedItem({ nodeType: 2, name, value: String(value) });
    },
    getAttribute(name) {
      const attribute = this.attributes.getNamedItem(name);
      return attribute === null ? null : attribute.value;
    },
    removeAttribute(name) {
      // 真实 removeAttribute 对不存在的属性是静默无操作（removeNamedItem 才会抛）。
      if (this.attributes.getNamedItem(name) !== null) {
        this.attributes.removeNamedItem(name);
      }
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
    /**
     * 深拷贝。导出 SVG 时生产代码会把克隆体交给 XMLSerializer，
     * 真实 DOM 的 cloneNode 会连属性与子树一起复制，桩必须照做 ——
     * 否则「导出丢了样式 / 丢了节点」在测试里永远看不见。
     */
    cloneNode(deep) {
      const copy = createElement(this.tagName);
      for (const attribute of this.attributes) {
        copy.setAttribute(attribute.name, attribute.value);
      }
      copy._textContent = this._textContent;
      if (deep) {
        for (const child of this.children) {
          copy.appendChild(child.cloneNode(true));
        }
      }
      return copy;
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
     *      append 到 <svg> 上再摘掉，历史上曾遗漏 append，于是量宽永远失败、
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
    /**
     * 只实现生产代码真正用到的三个选择器：
     *   - `'*'`：导出时按**文档序**取全部后代（内联计算样式要靠它与原节点逐一下标对应）；
     *   - `'title'`：PNG 导出要从**克隆体**里剔除 `<title>`（栅格图没有悬停提示）；
     *   - `'.expander .sign'`：加减号几何（既有用例）。
     * 其余选择器一律返回空数组：桩里没有 CSS 引擎，假装支持只会掩盖问题。
     */
    querySelectorAll(selector) {
      const out = [];
      if (selector === '.expander .sign') {
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
      }
      if (selector !== '*' && !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(selector)) {
        return [];
      }
      const walk = (node) => {
        for (const child of node.children) {
          if (selector === '*' || child.tagName === selector) {
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
/**
 * 桩里"当前生效"的字体族。
 *
 * 供 `getComputedStyle` 返回，用来验证「换字体后量宽缓存必须失效」——
 * 用户换编辑器字体时字号没变，缓存键里若没有字体族，方框宽度会沿旧字体的值。
 */
let stubFontFamily = 'Consolas, monospace';
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

// 导出菜单：五个菜单项，与真实模板的 data-format 取值一致。
// 桩里必须先建出来 —— 生产代码在加载时就用 getElementById 取它注册点击事件。
const exportMenuEl = createElement('div');
exportMenuEl.setAttribute('id', 'export-menu');
exportMenuEl.setAttribute('class', 'box-menu');
exportMenuEl.hidden = true;
for (const format of ['png', 'svg', 'md-tree', 'md-table', 'json']) {
  const item = createElement('button');
  item.setAttribute('data-format', format);
  const text = createElement('span');
  text.textContent = format;
  item.appendChild(text);
  exportMenuEl.appendChild(item);
}
byId.set('export-menu', exportMenuEl);
exportMenuEl.contains = (target) => {
  let node = target;
  while (node) {
    if (node === exportMenuEl) {
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
  'btn-export',
  'btn-settings',
];
for (const id of expectedButtons) {
  assert(
    toolbarButtons.includes(id),
    `工具栏缺少按钮 ${id}（实际有：${toolbarButtons.join(', ')}）`
  );
}
// 标签栏自有右键菜单（用户 2026-10-14 要求）：VS Code 给 webview 的默认菜单无法扩展，故自建。
// 这里先在**模板层**断言六项齐备（行为层「点击后发出的 id 集合」的断言待补，见笔记二·六）。
{
  const tabMenuHtml = /<div id="tab-menu"[\s\S]*?<\/div>/.exec(htmlSource);
  assert(tabMenuHtml !== null, 'graph.html 里没有 #tab-menu（标签栏右键菜单）');
  const actions = [...tabMenuHtml[0].matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
  for (const action of [
    'copyTabName',
    'closeSelf',
    'closeOthers',
    'closeLeft',
    'closeRight',
    'closeAll',
  ]) {
    assert(
      actions.includes(action),
      `标签菜单缺少 ${action}（实际：${actions.join(', ')}）`
    );
  }
  assert(actions.length === 6, `标签菜单应当恰好六项，实际 ${actions.length} 项`);
}
// 导出菜单（工具栏「导出」按钮的下拉）：五个格式，data-format 的集合必须**恰好**等于
// 宿主与 webview 两侧都认的那五个取值 —— 少一项就是「点了没反应」，多一项就是死菜单项。
const EXPORT_FORMATS = ['png', 'svg', 'md-tree', 'md-table', 'json'];
{
  const exportMenuHtml = /<div id="export-menu"[\s\S]*?<\/div>/.exec(htmlSource);
  assert(exportMenuHtml !== null, 'graph.html 里没有 #export-menu（导出按钮的下拉菜单）');
  assert(
    /id="export-menu"[^>]*hidden/.test(exportMenuHtml[0]),
    '#export-menu 默认必须是 hidden（未点导出按钮时不该显示）'
  );
  assert(
    /id="export-menu"[^>]*class="box-menu"/.test(exportMenuHtml[0]),
    '#export-menu 应当复用 box-menu 样式类（需求：不新增 CSS）'
  );
  // ⚠️ 逐项 includes 只能证明「没少」，所以要再加两条：条数恰好 5、且互不重复。
  // 少了这两条，「多出一项写错格式名的菜单」照样全绿（那个菜单项点了不会有任何反应）。
  const formats = [...exportMenuHtml[0].matchAll(/data-format="([^"]+)"/g)].map((m) => m[1]);
  for (const format of EXPORT_FORMATS) {
    assert(
      formats.includes(format),
      `导出菜单缺少 ${format}（实际：${formats.join(', ')}）`
    );
  }
  assert(
    formats.length === EXPORT_FORMATS.length,
    `导出菜单应当恰好 ${EXPORT_FORMATS.length} 项，实际 ${formats.length} 项：${formats.join(', ')}`
  );
  assert(
    new Set(formats).size === formats.length,
    `导出菜单的 data-format 有重复：${formats.join(', ')}`
  );
}
const toolbarSvgCount = (toolbarHtml[0].match(/<svg/g) ?? []).length;assert(
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

// ------------------------------------------------------------ 导出功能（源码级断言）
//
// 导出把「webview 抓画布」与「宿主写盘」串起来，两端各有一件事在测试桩里跑不到：
//   ① 栅格化要真实 canvas / Image（桩里没有，只有 CSP 与真实浏览器能给答案）；
//   ② 保存与落盘要真实 VS Code 的保存对话框与文件系统。
// 因此这里做**源码级**断言：钉住两侧的关键实现都还在、格式与过滤器映射没有错位。
// 「真机渲染出来的 PNG 长什么样」「路径含中文时能否真的落盘」属于未验证（不写成已完成）。
{
  const exportHostSource = fs.readFileSync(
    path.join(ROOT, 'src', 'views', 'graphView.ts'),
    'utf8'
  );
  const exportWebviewSource = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'graph.ts'), 'utf8');
  // webview 侧：序列化必须用 XMLSerializer，样式必须用 getComputedStyle 内联
  // （外部样式表不会进序列化结果，不内联就是黑图），倍数固定 2，PNG 出自 canvas
  assert(
    /XMLSerializer/.test(exportWebviewSource),
    'webview 应当用 XMLSerializer 序列化当前 SVG'
  );
  assert(
    /getComputedStyle/.test(exportWebviewSource) &&
      /getPropertyValue/.test(exportWebviewSource),
    'webview 应当用 getComputedStyle 把计算样式内联到导出克隆上（否则导出丢掉全部样式）'
  );
  assert(
    /const EXPORT_SCALE = 2\b/.test(exportWebviewSource),
    'PNG 导出倍数必须是 2（需求：2 倍分辨率）'
  );
  assert(
    /toDataURL\('image\/png'\)/.test(exportWebviewSource),
    "PNG 必须由 canvas 的 toDataURL('image/png') 产出"
  );
  assert(
    /drawImage\(/.test(exportWebviewSource),
    'PNG 栅格化应当把 SVG 图像 drawImage 到画布上'
  );
  // 透明背景：不能有 fillRect / fillStyle 这类画底色的动作（画布不画底色才是透明的）
  assert(
    !/fillRect|fillStyle|globalAlpha\s*=/.test(exportWebviewSource),
    'PNG 导出必须保持透明背景：不应在画布上填充底色'
  );
  // 超大面积与空数据都必须**报错**，不能静默产出 0 字节 / 全空的 PNG：
  // 浏览器内核在超出画布面积上限时不抛错，而是给出空数据。
  assert(
    // 打包器可能把常量折叠成字面量 268435456，两种写法都接受。
    /const MAX_CANVAS_AREA = (16384 \* 16384|268435456)\b/.test(exportWebviewSource),
    'PNG 导出应当按浏览器画布面积上限（16384 × 16384）设闸'
  );
  assert(
    /canvas\.width \* canvas\.height > MAX_CANVAS_AREA/.test(exportWebviewSource) &&
      /导出矢量图（SVG）/.test(exportWebviewSource),
    '超出画布面积上限时必须报错并指向矢量导出，而不是产出空 PNG'
  );
  assert(
    /const PNG_DATA_URL_PREFIX = 'data:image\/png;base64,'/.test(exportWebviewSource) &&
      /url\.startsWith\(PNG_DATA_URL_PREFIX\)/.test(exportWebviewSource),
    'PNG 数据必须以 data:image/png;base64, 开头并校验长度，否则空数据会被当成导出成功'
  );
  // CSP：`default-src 'none'` 会让 img-src 回退成 none，图像加载被静默拦下。
  // 两条来源都要放行：`blob:` 是主路径（绕开 Chromium 的 2 MB URL 长度上限），
  // `data:` 是后备路径（blob 加载失败时再试一次）。
  assert(
    /img-src blob: data:/.test(htmlSource),
    "graph.html 的 CSP 必须同时含 `blob:` 与 `data:`（img-src blob: data:）：blob 是主路径、data 是后备"
  );
  assert(
    /2 MB/.test(htmlSource) && /kMaxURLChars|URL 长度/.test(htmlSource),
    'graph.html 的注释必须写明「不能用 data URL 走大图」的原因（Chromium 的 2 MB URL 长度上限）'
  );

  // ---- 大图栅格化：blob URL 主路径 + data URL 后备 ----
  //
  // 真机证据：276 个节点的图序列化后 2154007 字节，base64 后约 2.87 MB，超过 Chromium 的
  // URL 长度硬上限（2 MB），`new Image()` 直接走 onerror；小图则一切正常。因此主路径必须是
  // blob URL，data URL 只作后备，且两条都失败时的文案要带上序列化字节数。
  assert(
    /URL\.createObjectURL\(/.test(exportWebviewSource),
    'PNG 栅格化应当用 URL.createObjectURL 建 blob URL 加载图像（data URL 有 2 MB URL 长度上限）'
  );
  assert(
    /URL\.revokeObjectURL\(/.test(exportWebviewSource),
    'PNG 栅格化用完必须 URL.revokeObjectURL 释放 blob URL（否则整份序列化文本一直留在内存里）'
  );
  assert(
    /new Blob\(/.test(exportWebviewSource) &&
      /image\/svg\+xml;charset=utf-8/.test(exportWebviewSource),
    'blob 必须由 new Blob([文本], { type: image/svg+xml;charset=utf-8 }) 建出来（不带 charset 时中文可能乱码）'
  );
  {
    // 释放必须发生在这两条出口上：onload 画完、onerror 之后。
    const body = functionBodyOf(exportWebviewSource, 'rasterizePng');
    const onloadAt = body.indexOf('image.onload');
    const onerrorAt = body.indexOf('image.onerror');
    assert(onloadAt >= 0 && onerrorAt > onloadAt, 'rasterizePng 应当同时实现 image.onload 与 image.onerror');
    assert(
      /releaseObjectUrl\(\)|revokeObjectURL\(/.test(body.slice(onloadAt, onerrorAt)),
      'onload 画完之后必须释放 blob URL'
    );
    assert(
      /releaseObjectUrl\(\)|revokeObjectURL\(/.test(body.slice(onerrorAt)),
      'onerror 之后也必须释放 blob URL（退到后备路径或最终失败都要释放）'
    );
    // 后备路径：data URL 的 base64 编码必须还在（小图仍可成功）。
    assert(
      /SVG_DATA_URL_PREFIX|data:image\/svg\+xml;base64,/.test(body) &&
        /encodeBase64Utf8\(prepared\.text\)/.test(body),
      'blob 加载失败时必须退回 data URL（encodeBase64Utf8 + data:image/svg+xml;base64,…）再试一次'
    );
    // 面积闸门必须**提前**：先建 canvas、先判 MAX_CANVAS_AREA，再去 new Image()。
    const canvasAt = body.indexOf("createElement('canvas')");
    const gateAt = body.indexOf('MAX_CANVAS_AREA');
    const imageAt = body.indexOf('new Image()');
    assert(
      canvasAt >= 0 && gateAt > canvasAt && imageAt > gateAt,
      `面积闸门必须在建 canvas 之后、new Image() 之前（实际下标 canvas=${canvasAt} 闸门=${gateAt} 图像=${imageAt}）`
    );
    // 失败文案必须带序列化字节数：「序列化 <字节> 字节」。
    assert(
      /序列化 \$\{[A-Za-z_$][\w$]*\} 字节/.test(body),
      'PNG 失败文案必须带上序列化字节数（例如「序列化 2154007 字节」），那是下次诊断的关键信息'
    );
  }

  // ---- 导出前的 XML 自检：函数在位、两条导出路径都调用、PNG 的预检在加载图像之前 ----
  //
  // 真机现象（2026-10-15）：「导出 PNG（2×）」失败，同时导出的 .svg 打开报错。本轮不猜根因，
  // 而是把「序列化结果本身是否合法 XML」变成可证的事实：预检不通过就拒绝写文件 / 拒绝栅格化。
  assert(
    /function checkExportXml\(/.test(exportWebviewSource) &&
      /DOMParser\(\)\.parseFromString\(/.test(exportWebviewSource),
    'webview 应当有 checkExportXml：用 DOMParser 判定序列化结果是否为合法 XML'
  );
  assert(
    /getElementsByTagName\??\.\('parsererror'\)/.test(exportWebviewSource) &&
      /querySelector\??\.\('parsererror'\)/.test(exportWebviewSource),
    'parsererror 必须同时按元素名与选择器取（不同内核下它可能是命名空间里的元素）'
  );
  // DOMParser 不存在时不得阻断：测试桩与极简环境都没有它，缺了解析器不等于结果不合法。
  assert(
    /typeof DOMParser === 'function'/.test(exportWebviewSource),
    'DOMParser 不存在时必须跳过解析器判据（否则桩环境里导出全被挡住）'
  );
  {
    const begin = functionBodyOf(exportWebviewSource, 'beginExport');
    const svgSerializeAt = begin.indexOf('buildExportSvg({ stripTitles: false })');
    const svgCheckAt = begin.indexOf('checkExportXml(prepared.text)');
    const svgPostAt = begin.indexOf(
      "post({ type: 'exportGraph', sessionId, format, data: prepared.text })"
    );
    assert(
      svgSerializeAt >= 0 && svgCheckAt > svgSerializeAt && svgPostAt > svgCheckAt,
      'SVG 路径必须在序列化之后、交给宿主写盘之前做预检' +
        `（实际 序列化=${svgSerializeAt} 预检=${svgCheckAt} 写盘=${svgPostAt}）`
    );
    const rasterize = functionBodyOf(exportWebviewSource, 'rasterizePng');
    const pngCheckAt = rasterize.indexOf('checkExportXml(prepared.text)');
    const imageAt = rasterize.indexOf('new Image()');
    const blobAt = rasterize.indexOf('createObjectURL');
    assert(
      pngCheckAt >= 0 && imageAt > pngCheckAt,
      `PNG 的预检必须在 new Image() 之前（实际 预检=${pngCheckAt} 加载图像=${imageAt}）`
    );
    assert(
      blobAt > pngCheckAt,
      '预检不通过时不得先建 blob URL：顺序应当是「预检 → 建画布 → 加载图像」'
    );
  }

  // ---- PNG 路径剔除 `<title>`、SVG 文件路径保留 ----
  //
  // 栅格图没有悬停提示，`<title>` 在大图里是体积大户；但 SVG 文件要给人用编辑器打开，
  // 提示必须留着。因此剔除开关**只**用在 PNG 调用点，且只作用于克隆体。
  {
    const body = functionBodyOf(exportWebviewSource, 'buildExportSvg');
    assert(
      /clone\.querySelectorAll\('title'\)/.test(body) && /\.remove\(\)/.test(body),
      "PNG 路径应当从**克隆体**里删除 <title>（clone.querySelectorAll('title') + remove）"
    );
    assert(
      !/source\.querySelectorAll\('title'\)/.test(body),
      '剔除 <title> 绝不能作用于真画布 source（否则用户悬停方框就再没有提示）'
    );
    const inlineAt = body.indexOf('inlineExportStyles(source, clone)');
    const stripAt = body.indexOf("clone.querySelectorAll('title')");
    assert(
      inlineAt >= 0 && stripAt > inlineAt,
      '必须先内联样式再剔除 <title>：内联靠「原节点与克隆体逐一下标对应」，先删元素会让下标错位'
    );
    const begin = functionBodyOf(exportWebviewSource, 'beginExport');
    const keepAt = begin.indexOf('buildExportSvg({ stripTitles: false })');
    const stripCallAt = begin.indexOf('buildExportSvg({ stripTitles: true })');
    const rasterizeAt = begin.indexOf('rasterizePng(prepared, sessionId)');
    assert(
      keepAt >= 0 && stripCallAt >= 0 && rasterizeAt >= 0,
      'beginExport 应当分别以 stripTitles: false（SVG）与 stripTitles: true（PNG）调用 buildExportSvg'
    );
    const svgBranch = begin.slice(keepAt, stripCallAt);
    assert(
      /post\(\{\s*type: 'exportGraph'/.test(svgBranch) && !/rasterizePng\(/.test(svgBranch),
      'SVG 分支（stripTitles: false）应当把文本交给宿主写盘，而不是走栅格化'
    );
    const pngBranch = begin.slice(stripCallAt, rasterizeAt);
    assert(
      pngBranch.length > 0 && !/stripTitles: false/.test(pngBranch),
      'PNG 分支应当用 stripTitles: true 的克隆体去栅格化'
    );
  }

  // ---- 导出前的字符净化：必须在序列化**之前**，且判定用的正则不得带 g ----
  //
  // 真机根因（8.8）：节点 id 以 NUL 作分隔符，id 随属性值进入画布，序列化后属性值里是裸
  // U+0000，内核的 XML 解析器报 `invalid character in attribute value`。修法是序列化之前
  // 把克隆体里 XML 1.0 不允许的控制字符换成可见替身 —— 这一步的**位置**是修法的一部分：
  // 排在序列化之后等于什么都没做。
  {
    const body = functionBodyOf(exportWebviewSource, 'buildExportSvg');
    const sanitizeAt = body.indexOf('sanitizeExportXmlChars(clone)');
    const serializeAt = body.indexOf('new XMLSerializer()');
    assert(sanitizeAt >= 0, 'buildExportSvg 必须在克隆体上调用 sanitizeExportXmlChars(clone)');
    assert(
      serializeAt > sanitizeAt,
      '净化必须排在序列化之前（排在之后等于没做）' +
        `（实际 净化=${sanitizeAt} 序列化=${serializeAt}）`
    );
    // 判定用的正则**不带 g**：带 g 的 test() 会用 lastIndex 在连续调用之间漏判，
    // 而净化对每个属性、每段文本各调用一次，必然连续调用。
    const testRegex =
      /const XML_INVALID_CONTROL_CHAR_TEST = \/((?:[^/\\]|\\.)*)\/([a-z]*);/.exec(
        exportWebviewSource
      );
    assert(testRegex !== null, '找不到 XML_INVALID_CONTROL_CHAR_TEST（判定用的非全局正则）');
    assert(
      !testRegex[2].includes('g'),
      `XML_INVALID_CONTROL_CHAR_TEST 不得带 g 标志（实际 /${testRegex[1]}/${testRegex[2]}）`
    );
    const scanRegex = /const XML_INVALID_CONTROL_CHARS = \/((?:[^/\\]|\\.)*)\/([a-z]*);/.exec(
      exportWebviewSource
    );
    assert(
      scanRegex !== null && scanRegex[1] === testRegex[1],
      '判定用正则与替换用正则必须是同一字符集（否则「判到却替换不掉」）' +
        `（判定 [${testRegex[1]}] / 替换 [${scanRegex === null ? '（找不到）' : scanRegex[1]}]）`
    );
    assert(scanRegex[2].includes('g'), '替换用的 XML_INVALID_CONTROL_CHARS 必须带 g');
    const sanitizeFn = functionBodyOf(exportWebviewSource, 'sanitizeXmlChars');
    assert(
      /XML_INVALID_CONTROL_CHAR_TEST\.test\(value\)/.test(sanitizeFn) &&
        /\.replace\(XML_INVALID_CONTROL_CHARS, XML_INVALID_CHAR_PLACEHOLDER\)/.test(sanitizeFn),
      'sanitizeXmlChars 应当「用非全局正则判定、用全局正则替换」'
    );
    // 净化必须同时覆盖属性值与文本节点（nodeType 用数字 1 = 元素、3 = 文本）。
    const walkFn = functionBodyOf(exportWebviewSource, 'sanitizeExportXmlChars');
    assert(
      /node\.attributes/.test(walkFn) && /setAttribute\(attribute\.name, safe\)/.test(walkFn),
      'sanitizeExportXmlChars 必须逐条改写属性值（只改值、不改名，url(#id) 引用才不受影响）'
    );
    assert(
      /nodeType === 3/.test(walkFn) && /nodeValue/.test(walkFn) && /nodeType === 1/.test(walkFn),
      'sanitizeExportXmlChars 必须按 nodeType 分辨文本节点（3）与元素（1）并递归下去'
    );
  }

  // ---- 内联计算样式：等于初始值的不写、不等于的写 ----
  {
    const tableMatch = /const SVG_INITIAL_STYLE_VALUES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(
      exportWebviewSource
    );
    assert(tableMatch !== null, '找不到 SVG_INITIAL_STYLE_VALUES 初始值表');
    const table = tableMatch[1];
    // 逐条比对（属性 → 可接受的初始值写法），防止表里写错一个值就整条规则失效。
    for (const [property, values] of Object.entries({
      fill: ['rgb(0, 0, 0)', '#000000', 'black'],
      'fill-opacity': ['1'],
      stroke: ['none'],
      'stroke-width': ['1', '1px'],
      'stroke-dasharray': ['none'],
      opacity: ['1'],
      'font-weight': ['400', 'normal'],
      'font-style': ['normal'],
      'text-anchor': ['start'],
      'dominant-baseline': ['auto'],
    })) {
      const entry = new RegExp(`['"]?${property}['"]?\\s*:\\s*\\[([^\\]]*)\\]`).exec(table);
      assert(entry !== null, `初始值表里缺少 ${property}`);
      for (const value of values) {
        assert(
          entry[1].includes(`'${value}'`),
          `初始值表里 ${property} 缺少写法 '${value}'（实际 [${entry[1].trim()}]）`
        );
      }
    }
    // font-family / font-size **不得**进入初始值表，且必须在「一律内联」名单里。
    // 键名可能带引号也可能不带，所以按「键后跟冒号」判定，而不是查字符串。
    assert(
      !/(^|[\s{])['"]?font-family['"]?\s*:/m.test(table) &&
        !/(^|[\s{])['"]?font-size['"]?\s*:/m.test(table),
      'font-family / font-size 不得进入初始值表：UA 默认值随环境而变，跳过有风险'
    );
    const alwaysMatch = /const ALWAYS_INLINE_STYLE_PROPERTIES = \[([^\]]*)\]/.exec(
      exportWebviewSource
    );
    assert(alwaysMatch !== null, '找不到 ALWAYS_INLINE_STYLE_PROPERTIES（一律内联名单）');
    assert(
      /'font-family'/.test(alwaysMatch[1]) && /'font-size'/.test(alwaysMatch[1]),
      'font-family 与 font-size 必须列入「一律内联」名单'
    );
    assert(
      /includes\(property\)\) \{\s*return false;/.test(exportWebviewSource),
      '「一律内联」必须真的挡住跳过逻辑（先判名单再查初始值表）'
    );
  }
  // 宿主侧：保存对话框 + 写文件 + 四种扩展名的过滤器映射
  assert(
    /showSaveDialog\(/.test(exportHostSource),
    '宿主应当用 vscode.window.showSaveDialog 让用户选保存位置'
  );
  assert(
    /workspace\.fs\.writeFile\(/.test(exportHostSource),
    '宿主应当用 vscode.workspace.fs.writeFile 落盘'
  );
  for (const extension of ['.png', '.svg', '.md', '.json']) {
    assert(
      exportHostSource.includes(`'${extension}'`),
      `宿主的导出格式表里缺少扩展名 ${extension}（保存对话框的 filters 会漏一种格式）`
    );
  }
  // 两侧的格式集合必须一致：模板里写了几项，宿主就要认几项、webview 就要处理几项
  for (const format of EXPORT_FORMATS) {
    assert(
      new RegExp(`'${format}':`).test(exportHostSource),
      `宿主 EXPORT_FORMATS 里缺少导出格式 ${format}`
    );
    assert(
      exportWebviewSource.includes(`'${format}'`),
      `webview 侧没有处理导出格式 ${format}`
    );
  }
  // md-tree 必须复用同一份正文逻辑：copyTree 的 buildSessionText 改成调用纯函数后，
  // 「复制」与「导出 Markdown（结构树）」不可能各走一套格式。
  const copyTreeSource = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'copyTree.ts'), 'utf8');
  assert(
    /buildMarkdownTree\(/.test(copyTreeSource),
    'copyTree.buildSessionText 应当调用 buildMarkdownTree（否则两处正文会分叉）'
  );
  assert(
    !/MAX_NODES|MAX_DEPTH/.test(copyTreeSource),
    'walk（含两个上限）应当只在 commands/exportGraph.ts 里有一份，copyTree 里不该再留一份'
  );
  // 纯函数文件不得引用 vscode API：它要在没有 VS Code 的冒烟测试里被直接调用
  const pureSource = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'exportGraph.ts'), 'utf8');
  assert(
    !/from 'vscode'/.test(pureSource) && !/\bvscode\./.test(pureSource),
    'commands/exportGraph.ts 不得引用 vscode API（否则无法在冒烟测试里直接断言）'
  );
  for (const name of ['buildMarkdownTree', 'buildMarkdownTable', 'buildJsonText']) {
    assert(
      new RegExp(`export function ${name}\\b`).test(pureSource),
      `commands/exportGraph.ts 应当导出 ${name}`
    );
  }
  // 桩里那张属性名表必须与生产代码一致，否则下面的行为断言会在错误的属性集合上跑。
  {
    const listMatch = /const EXPORT_STYLE_PROPERTIES = \[([\s\S]*?)\];/.exec(exportWebviewSource);
    assert(listMatch !== null, '找不到 EXPORT_STYLE_PROPERTIES（要内联的属性名表）');
    const names = [...listMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert(
      names.join(',') === EXPORT_STYLE_PROPERTY_NAMES.join(','),
      `桩里的属性名表必须与生产一致：生产 [${names.join(',')}]、桩 [${EXPORT_STYLE_PROPERTY_NAMES.join(',')}]`
    );
  }
  log(
    `诊断: 导出 —— 模板 ${EXPORT_FORMATS.length} 个格式，webview 用 XMLSerializer + getComputedStyle + 2 倍 canvas；` +
      '大图走 blob URL（data URL 仅作后备）、面积闸门在建 canvas 后立刻判定；' +
      'PNG 剔除 <title> 且跳过等于初始值的内联属性；宿主用 showSaveDialog + workspace.fs.writeFile，' +
      'filters 覆盖 .png/.svg/.md/.json'
  );
}

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

// ------------------------------------------------------------ 节点总数上限提示（模板 + 桩元素）

// `applyCapacityState()` 靠 getElementById('capacity-hint') 显示原因；模板里没有这个元素时
// 它会静默什么都不做（脚本不报错、用户也看不到任何反馈），所以必须先在 HTML 层面断言。
assert(
  /<div id="capacity-hint"[^>]*>/.test(htmlSource),
  'graph.html 里没有 #capacity-hint（到节点总数上限时的提示行）'
);
assert(
  /id="capacity-hint"[^>]*hidden/.test(htmlSource),
  '#capacity-hint 默认必须是 hidden（未到上限时不该占位）'
);
byId.set('capacity-hint', createElement('div'));

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
  'btn-search-path',
  'btn-search-full',
  'search-count',
  'btn-search-prev',
  'btn-search-next',
  // 临时路径过滤（搜索栏区域，用户 2026-10-15）：输入框与「已隐藏 N 个」
  'path-filter',
  'path-filter-input',
  'path-filter-count',
]) {
  assert(searchHtml[0].includes(`id="${id}"`), `搜索栏缺少 #${id}`);
}
assert(
  /id="search-input"[\s\S]*?type="text"/.test(searchHtml[0]),
  '搜索框应当是 type="text" 的输入框'
);
assert(
  /id="path-filter-input"[\s\S]*?type="text"/.test(searchHtml[0]),
  '临时路径过滤也应当是 type="text" 的输入框'
);
// 临时过滤包一层 `<span>` 而不是 `<div>`：上面那条正则按「第一个 </div>」截取 #search，
// 里面再嵌一个 div 会把搜索栏的其余元素挤到截取范围之外（断言随之假失败/假通过）。
assert(
  /<span id="path-filter"/.test(searchHtml[0]),
  '临时过滤那一段应当用 <span> 包（#search 的截取按第一个 </div> 结束）'
);
{
  const searchCss = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'graph.css'), 'utf8');
  assert(
    /\.search\s*\{[^}]*margin-left:\s*auto/.test(searchCss),
    'CSS 里 .search 应当用 margin-left:auto 固定到工具栏最右侧'
  );
  // 这一栏现在装着搜索框 + 五个开关 + 计数 + 两个箭头 + 临时过滤，宽度超过窄面板：
  // 必须能折行，否则它作为不可再缩的 flex 项会把整个工具栏顶出水平滚动条。
  assert(
    /\.search\s*\{[^}]*flex-wrap:\s*wrap/.test(searchCss),
    'CSS 里 .search 应当允许折行（窄面板下这一栏的宽度已经超过可用宽度）'
  );
  // 临时路径过滤与搜索挤在同一栏、但是两件事：CSS 里既要有它自己的样式（不能是裸控件），
  // 也要有把它们分开的视觉分隔（否则用户会以为那个输入框也是搜索框的一部分）。
  assert(
    /\.path-filter\s*\{[^}]*border-left:/.test(searchCss),
    'CSS 里 .path-filter 应当有左侧分隔线（临时过滤与搜索是两件事，视觉上要分开）'
  );
  assert(
    /\.path-filter-input\s*\{[^}]*width:/.test(searchCss),
    'CSS 里 .path-filter-input 应当有自己的宽度（沿用搜索框的宽度会把这一栏挤爆）'
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

  // 表格**形状**：每一行的单元格数必须与表头一致。
  // 立此断言的原因：上一轮新增「建议位置」列时，整理脚本按裸 `|` 切分单元格，
  // 把说明里含**转义竖线**（`a\|b`）的那几行切错、整整少了一列 —— 键集合的断言完全发现不了
  // （键还在），而在 GitHub 上那几行的说明会串进「建议位置」列。
  // ⚠️ 计的是**未转义**的竖线：`\|` 是字面竖线，不是单元格边界。
  const countPipes = (line) => {
    let count = 0;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== '|') {
        continue;
      }
      let backslashes = 0;
      for (let back = index - 1; back >= 0 && line[back] === '\\'; back -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) {
        count += 1;
      }
    }
    return count;
  };
  const readmeLines = readme.split(/\r?\n/);
  const headerLine = readmeLines.find((line) => /^\|\s*设置\s*\|/.test(line));
  assert(headerLine !== undefined, 'README 的设置表没有找到表头（`| 设置 | 默认值 | …`）');
  const expectedPipes = countPipes(headerLine);
  for (const line of readmeLines) {
    if (!/^\|\s*`cppCallGraph\./.test(line)) {
      continue;
    }
    assert(
      countPipes(line) === expectedPipes,
      `README 设置表的列数与表头不一致（表头 ${expectedPipes - 1} 列、这一行 ${
        countPipes(line) - 1
      } 列）：${line.slice(0, 48)}…`
    );
  }

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
  for (const key of ['pathDisplay', 'pathTailLevels', 'pathShowFileName', 'pathAnchors']) {
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
  // 节点总数上限是**宿主专用**设置（webview 不参与布局上限的判定），所以不进上面那份
  // 「必须下发给 webview」的清单，只钉两件事：宿主真读它、改设置会触发重排。
  const graphViewSource = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');
  assert(/maxLayoutNodes/.test(graphViewSource), '宿主没有读 maxLayoutNodes 设置');
  // 跳转语义（2026-10-14 改动，**尚未真机验收**，因此只能做源码级断言 —— 跳转依赖真实 VS Code
  // 的文档/编辑器 API，冒烟桩不具备这套能力）：
  //   ① 双击应打开「父级中引用它的位置」（节点的 callSite），而不是符号自身的定义处；
  //   ② 引用**可能跨文件**（文本搜索兜底的命中落在任意 .c/.h），必须按 callSite.file 解析；
  //   ③ 解析不出来时要保留「退回符号定义处」的兜底，避免双击变成无反应。
  assert(
    /node\?\.callSite/.test(graphViewSource),
    'openLocation 应当优先使用节点的 callSite（父级引用处）'
  );
  assert(
    /workspaceFolders[\s\S]{0,240}joinPath\(folder\.uri, callSite\.file\)/.test(graphViewSource),
    '跨文件引用必须按 callSite.file 对各工作区根解析（不能假定与父节点同文件）'
  );
  assert(
    /openTextDocument\(item\.uri\)/.test(graphViewSource),
    '找不到 callSite 时必须保留「退回符号定义处」的兜底'
  );
  assert(
    /affectsConfiguration\('cppCallGraph\.maxLayoutNodes'\)/.test(extensionSource),
    '改了 maxLayoutNodes 却没触发重排 —— extension.ts 的 onDidChangeConfiguration 漏了它'
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
    // 这 5 个是两侧都有的（COLUMN_GAP / ROW_GAP 只在宿主侧：webview 只用宿主下发的坐标）。
    // ⚠️ MAX_BOX_WIDTH / NAME_MAX_CHARS 已在 0.22 取消：宽度没有上限、名称不再截断，
    // 所以这里既不该再要求它们存在，也要**反过来**断言两侧都没有上限钳制。
    for (const name of ['MIN_BOX_WIDTH', 'LOC_MAX_CHARS', 'NODE_HEIGHT', 'NODE_HEIGHT_COMPACT']) {
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
    // 0.22 的不截断要求：两侧都不得再有宽度上限，也不得再按字符数截断名称/路径
    for (const [label, source] of [
      ['宿主', layoutSource],
      ['webview', webviewSource],
    ]) {
      assert(
        !/MAX_BOX_WIDTH/.test(source),
        `${label}侧又出现了 MAX_BOX_WIDTH —— 宽度上限会把完整文字压出方框`
      );
      assert(
        !/truncateMiddle/.test(source),
        `${label}侧又出现了 truncateMiddle —— 名称/路径不得从中间截断`
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
  for (const id of [
    'btn-search-case',
    'btn-search-word',
    'btn-search-regex',
    'btn-search-path',
    'btn-search-full',
  ]) {
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
    /<span id="path-filter-count"[^>]*aria-live=/.test(htmlSource),
    '临时过滤的「已隐藏 N 个」应当 aria-live（过滤会改变图里有什么，读屏用户要知道）'
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
// 临时路径过滤：输入框与计数（同搜索栏一样，由桩元素驱动真实的事件处理）
const pathFilterInputStub = createElement('input');
pathFilterInputStub.value = '';
byId.set('path-filter-input', pathFilterInputStub);
byId.set('path-filter-count', createElement('span'));
for (const id of [
  'btn-search-case',
  'btn-search-word',
  'btn-search-regex',
  'btn-search-path',
  'btn-search-full',
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

/**
 * SVG 属性的初始值（与规范一致；生产代码里那张表由源码级断言比对）。
 * 桩按它回答「这个元素这个属性算出来等于初始值吗」。
 */
const STUB_SVG_INITIAL_VALUES = {
  fill: 'rgb(0, 0, 0)',
  'fill-opacity': '1',
  stroke: 'none',
  'stroke-width': '1px',
  'stroke-dasharray': 'none',
  opacity: '1',
  'font-weight': '400',
  'font-style': 'normal',
  'text-anchor': 'start',
  'dominant-baseline': 'auto',
};

/**
 * 桩的「计算样式」：按元素的主类名给一张固定表。
 *
 * 真实浏览器里这些值来自 CSS 层叠与继承；桩没有 CSS 引擎，于是按类名硬编码。
 * 它要验证的是**规则本身**：「内联计算样式时，取值等于 SVG 初始值的属性不写、不等于的写」。
 * 因此表里刻意同时放了初始值与非初始值：
 *   - `box.stroke-width = '1px'`（= 初始值）、`edge.fill = 'none'`（= 初始值）、
 *     `name.text-anchor = 'start'`（= 初始值）→ 都不该出现在导出文件里；
 *   - `box.fill = 'rgb(30, 30, 30)'`、`name.font-weight = '600'` → 必须写进去。
 * 表里没有的属性一律按初始值回答；`font-family` / `font-size` 例外：它们会被继承，
 * 且生产代码规定**一律内联**，所以任何元素都要给出取值（否则那两条规则测不到）。
 *
 * ⚠️ 它证明的是「跳过规则按初始值表工作」，**不**证明真实 CSS 下各元素算出的值 ——
 * 后者要真实浏览器，属于未验证。
 */
const STUB_COMPUTED_STYLE_BY_CLASS = {
  box: { fill: 'rgb(30, 30, 30)', stroke: 'rgb(60, 60, 60)', 'stroke-width': '1px' },
  edge: {
    fill: 'none',
    stroke: 'rgb(128, 128, 128)',
    'stroke-width': '1.3px',
    'stroke-dasharray': 'none',
  },
  name: {
    fill: 'rgb(220, 220, 220)',
    'font-size': '13px',
    'font-weight': '600',
    'text-anchor': 'start',
  },
  loc: {
    fill: 'rgb(150, 150, 150)',
    'font-size': '12px',
    'font-style': 'normal',
    'dominant-baseline': 'auto',
  },
};

/** 桩里某元素某属性的计算取值（空串表示桩不提供该属性）。 */
function stubComputedValue(element, property) {
  const className = String(element?.getAttribute?.('class') ?? '');
  const primary = className.split(/\s+/).filter(Boolean)[0] ?? '';
  const table = STUB_COMPUTED_STYLE_BY_CLASS[primary] ?? {};
  if (Object.prototype.hasOwnProperty.call(table, property)) {
    return table[property];
  }
  if (property === 'font-family') {
    return stubFontFamily;
  }
  if (property === 'font-size') {
    return '13px';
  }
  return STUB_SVG_INITIAL_VALUES[property] ?? '';
}

/** 生产代码调用的 `getComputedStyle`：既要 `fontFamily`（量宽缓存键），也要 `getPropertyValue`（内联样式）。 */
function stubComputedStyle(element) {
  return {
    fontFamily: stubFontFamily,
    getPropertyValue: (property) => stubComputedValue(element, property),
  };
}

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
  // 量宽缓存键要用实际字体族；内联导出样式要按元素取计算值 —— 桩都按"当前生效的字体"如实回答
  getComputedStyle: (element) => stubComputedStyle(element),
};
global.document.defaultView = global.window;
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

/**
 * 桩开关：模拟「克隆体上的字符净化没有生效」。
 *
 * 键是属性名，值是该属性在**序列化时**写出的原始取值。真机根因的对照组 ——
 * 把生产代码里的 `sanitizeExportXmlChars(clone)` 去掉时，序列化结果里就是这些裸控制字符
 * （内核的 XML 解析器随即报 `invalid character in attribute value`）。
 * 取值长度刻意与净化后的取值相同，这样「文本其余部分逐字不变」，
 * 于是预检报出的下标可以被独立核对。
 */
let stubSerializerRawAttributeValues;

/**
 * XMLSerializer 桩：只把元素与属性按文档序拼成一段可读文本。
 *
 * 断言只关心「调用确实发生、拿到一段非空字符串、里面带 svg/viewBox/xmlns」；
 * 真实 XML 语法由浏览器负责，桩自造一套规则反而会掩盖问题。
 *
 * 已知与本机内核的差异（刻意保留，不要顺带补齐）：真实 XMLSerializer 会输出文本子节点，
 * 这个桩只输出元素与属性。因此「文本子节点里的控制字符被净化」这一条没有行为断言
 * （见开发记录 8.8 的未验证清单）。
 */
global.XMLSerializer = class {
  serializeToString(node) {
    const parts = [];
    const walk = (element) => {
      const attrs = [...element.attributes]
        .map((attribute) => {
          const raw = stubSerializerRawAttributeValues?.[attribute.name];
          const value = raw === undefined ? String(attribute.value) : raw;
          return ` ${attribute.name}="${value}"`;
        })
        .join('');
      parts.push(`<${element.tagName}${attrs}>`);
      for (const child of element.children) {
        walk(child);
      }
      parts.push(`</${element.tagName}>`);
    };
    walk(node);
    return parts.join('');
  }
};

/**
 * 桩的「解析结果」：`undefined` 表示解析通过，否则该文本就是解析器报错的内容。
 *
 * 真实内核何时给 `image/svg+xml` 插入 `parsererror` 元素，在 Node 里无法复现，
 * 因此由这个开关直接给出「有 / 没有 parsererror」两种情形，断言生产代码的**反应**。
 */
let stubParserErrorText;
/**
 * 让桩**只**通过 `querySelector` 暴露 parsererror。
 *
 * 用途：部分内核把 parsererror 放在命名空间里（带前缀的元素按标签名取不到），
 * 生产代码因此写成 `getElementsByTagName(...) ?? querySelector(...)`；打开这个开关即可
 * 验证「按元素名取不到时，第二条判据仍然生效」。
 */
let stubParserErrorOnlyBySelector = false;
/**
 * 让桩按 **XML 1.0 规则**自己判：待解析文本里出现不允许直接出现的控制字符就给出 parsererror。
 *
 * 这是桩对内核行为的**建模**，依据是真机日志原文
 * （`error on line 10 at column 3501: invalid character in attribute value`）。
 * 打开它才能测出「同一个含 NUL 的输入，净化生效时解析通过、净化关掉时解析报错」这条闭环；
 * 「真实内核在什么条件下给出 parsererror」仍要真机确认（见开发记录 8.8 的未验证清单）。
 */
let stubParserRejectInvalidXmlChars = false;

/**
 * 扫描 XML 1.0 不允许直接出现的控制字符（`\t`、`\n`、`\r` 除外）。
 *
 * 刻意**不复用**生产代码那份正则：桩若跟着生产实现一起错，判据就失去意义。
 * 不带 `g`，避免 `test()` / `exec()` 之间的 `lastIndex` 残留。
 */
const XML_INVALID_CHAR_SCAN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/**
 * DOMParser 桩：只回答「解析出来的文档里有没有 parsererror 元素」这一件事。
 *
 * ⚠️ 它证明的是「生产代码在拿到 parsererror 时确实拒绝导出」，**不**证明真实内核在什么
 * 条件下给出 parsererror —— 后者要真实浏览器，属于未验证。
 */
global.DOMParser = class {
  parseFromString(text) {
    let error = stubParserErrorText === undefined ? null : { textContent: stubParserErrorText };
    if (error === null && stubParserRejectInvalidXmlChars && typeof text === 'string') {
      const hit = XML_INVALID_CHAR_SCAN.exec(text);
      if (hit !== null) {
        const before = text.slice(0, hit.index);
        const line = before.split('\n').length;
        const column = hit.index - (before.lastIndexOf('\n') + 1) + 1;
        const code = (text.codePointAt(hit.index) ?? 0).toString(16).toUpperCase().padStart(4, '0');
        error = {
          textContent:
            `error on line ${line} at column ${column}: invalid character in attribute value` +
            `（桩按 XML 1.0 判定：位置 ${hit.index} 处是 U+${code}）`,
        };
      }
    }
    return {
      getElementsByTagName: (name) =>
        name === 'parsererror' && error !== null && !stubParserErrorOnlyBySelector ? [error] : [],
      querySelector: (selector) =>
        selector === 'parsererror' && error !== null ? error : null,
    };
  }
};

/** 异步的 requestAnimationFrame：回调排队，等下一个宏任务统一执行。 */
const frameQueue = [];
global.requestAnimationFrame = (callback) => {
  frameQueue.push(callback);
  return frameQueue.length;
};
global.cancelAnimationFrame = () => {};

function flushFrames() {
  const pending = frameQueue.splice(0, frameQueue.length);
  // ⚠️ 冲帧时把桩时钟**临时**推进一个动画周期：开启位移插值后，布局帧上的位置要在 180ms 内
  // 才收敛，而既有的粘性断言（「展开后应当居中/贴边」）是在冲帧后**立刻**读位置的。
  // 只在回调执行期间推进、随后恢复，因此不影响相机动作的过期判定与其它基于 Date.now 的逻辑。
  const realNow = Date.now();
  const shifted = realNow + 400;
  Date.now = () => shifted;
  try {
    for (const callback of pending) {
      callback(0);
    }
  } finally {
    Date.now = () => realNow;
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
      name: 'lib_boot',
      file: 'lib_boot.h',
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
    title: 'lib_boot',
    description: 'lib_boot.h:23',
    direction,
    engineLabel: 'clangd 22.1.6',
    rootId: 'root',
    nodes: {
      root: {
        id: 'root',
        name: 'lib_boot',
        detail: 'void lib_boot(void)',
        file: 'components/LIB/boot/lib_boot.h',
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
        callSite: { file: 'main/main.c', line: 8, text: 'lib_boot();' },
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
  textContents.some((value) => value.includes('lib_boot')),
  `方框文字里没有名称：${textContents.join(' | ')}`
);
assert(
  textContents.some((value) => value.includes('lib_boot.h:23')),
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
    ['wlong', 'a_very_long_function_name_here', 'components/LIB/boot/lib_boot_impl.c', 120],
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

  // 列间隙：**按 DOM 里真正画出来的方框**测量一次，而不是只读布局算出来的数。
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
  ['btn-export', undefined], // 导出按钮只弹菜单，自身不发消息（格式由菜单项决定）
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
    '（展开全部发 expandAll、完全展开发 expandFull、设置/复制标签/关闭发消息，' +
    '收起全部下发收起状态并请求完全复位）'
);

// 「收起全部」= 完全复位（用户 2026-10-14 口径）：只下发「收起标记」是不够的 ——
// 已取回的节点一直留在会话里，之后再点「展开全部」只是把旧形状搬回来（层数由历史点击决定，
// 与设置里的 maxExpandRounds 无关）。因此必须同时请求宿主丢掉已加载的展开状态。
{
  const button = byId.get('btn-collapse-all');
  const before = posted.length;
  button.dispatch('click', {});
  const fresh = posted.slice(before).filter((message) => message.type !== 'reportWidths');
  const types = fresh.map((message) => message.type);
  assert(
    types.includes('resetExpansion'),
    `收起全部点击后应发出 resetExpansion（完全复位），实际 ${types.join(',') || '（无）'}`
  );
  const reset = fresh.find((message) => message.type === 'resetExpansion');
  assert(
    typeof reset.sessionId === 'string' && reset.sessionId.length > 0,
    'resetExpansion 必须带当前活动标签的 sessionId'
  );
  const collapse = fresh.find((message) => message.type === 'collapse');
  assert(
    collapse !== undefined && Array.isArray(collapse.collapsed) && collapse.collapsed.length === 1,
    '收起全部的收起集合必须**只含根节点**（多一个都会让复位后的画面出现缺口）'
  );
  console.log('诊断: 收起全部 —— 收起集合只含根节点，并同时请求完全复位（resetExpansion）');
}

// ------------------------------------------------ 导出菜单：五个格式真的会发消息
//
// 行为层断言（不是查源码子串）：点导出按钮 → 菜单弹出且**不发消息**；
// 点每一项 → 发出的 exportGraph 消息里 format 正确，且 md-tree / md-table / json **不带 data**
// （正文必须由宿主生成 —— 带上 data 就等于前端也实现了一份，两处会分叉）。
{
  const exportButton = byId.get('btn-export');
  const exportMenu = byId.get('export-menu');
  assert(exportButton !== undefined, '找不到工具栏按钮 btn-export');
  assert(exportMenu !== undefined, '桩里没有 #export-menu（模板里有、桩里没有会让这段断言失去意义）');
  exportMenu.hidden = true;
  const relevant = (message) => message.type !== 'reportWidths';

  const beforeOpen = posted.length;
  exportButton.dispatch('click', {});
  assert(
    posted.slice(beforeOpen).filter(relevant).length === 0,
    '点导出按钮只应弹出菜单，不应直接发消息'
  );
  assert(exportMenu.hidden === false, '点导出按钮后菜单应当显示（hidden=false）');
  assert(
    typeof exportMenu.style.left === 'string' && exportMenu.style.left.endsWith('px'),
    `菜单应当贴着按钮定位（left 应当是像素值），实际 ${JSON.stringify(exportMenu.style.left)}`
  );

  const items = exportMenu.children.filter((child) =>
    child.getAttribute?.('data-format')
  );
  assert(
    items.length === EXPORT_FORMATS.length,
    `桩里的导出菜单应当有 ${EXPORT_FORMATS.length} 项，实际 ${items.length} 项`
  );

  // 点菜单项：直接取菜单上注册的 click 处理函数并调用。
  // 与方框菜单那一段同一口径：桩的 dispatch 不做事件冒泡，这样测的是「处理逻辑」本身，
  // 不受桩与浏览器的冒泡差异影响。
  const menuHandlers = exportMenu.listeners.get('click') ?? [];
  assert(menuHandlers.length >= 1, '导出菜单上没有注册 click 处理函数');

  // 「真画布上的 <title>」：PNG 路径要剔除克隆体里的标题，但**绝不能动真画布**。
  const liveTitles = () => svg.flatten().filter((element) => element.tagName === 'title');
  const titlesBefore = liveTitles().length;
  assert(
    titlesBefore > 0,
    '导出用例需要画布上至少有一个 <title>（否则「剔除只作用于克隆体」这条测不到）'
  );

  /** 按**旧口径**（凡计算值非空都写）应当写多少条内联属性。 */
  const oldInlineWrites = () => {
    let total = 0;
    for (const element of svg.flatten()) {
      for (const property of EXPORT_STYLE_PROPERTY_NAMES) {
        if (stubComputedValue(element, property)) {
          total += 1;
        }
      }
    }
    return total;
  };
  /** 其中「取值等于 SVG 初始值」的有多少条 —— 新口径应当把它们全部跳过。 */
  const initialValueWrites = () => {
    let total = 0;
    for (const element of svg.flatten()) {
      for (const property of EXPORT_STYLE_PROPERTY_NAMES) {
        if (property === 'font-family' || property === 'font-size') {
          continue;
        }
        const value = stubComputedValue(element, property);
        if (value && value === STUB_SVG_INITIAL_VALUES[property]) {
          total += 1;
        }
      }
    }
    return total;
  };
  let pngSerializedBytes;
  let svgSerializedData;

  for (const item of items) {
    const format = item.getAttribute('data-format');
    const before = posted.length;
    for (const handler of menuHandlers) {
      handler({ type: 'click', target: item, preventDefault() {}, stopPropagation() {} });
    }
    const fresh = posted.slice(before).filter(relevant);
    if (format === 'png') {
      // PNG：桩里没有真实 canvas / Image 实现，栅格化必然失败 —— 此时**必须出声**，绝不允许静默。
      // （真机上成功的栅格化属于未验证：它要真实浏览器内核，不写成已完成。）
      const exported = fresh.find(
        (message) =>
          message.type === 'exportGraph' &&
          message.format === 'png' &&
          typeof message.data === 'string'
      );
      const failure = fresh.find((message) => message.type === 'error');
      assert(
        exported !== undefined || failure !== undefined,
        `PNG 导出在桩环境里必须要么给出 exportGraph、要么给出 error，实际 ${
          fresh.map((message) => message.type).join(',') || '（无）'
        }`
      );
      if (failure !== undefined) {
        assert(
          String(failure.message).includes('导出 png 失败'),
          `PNG 失败的 error 消息应当说明是「导出 png 失败」，实际「${failure.message}」`
        );
        // 报错文案必须带序列化字节数：下次再出问题，可立即判断是「图本来就大」还是其它原因。
        const byteMatch = /序列化 (\d+) 字节/.exec(String(failure.message));
        assert(
          byteMatch !== null,
          `PNG 失败文案必须带上序列化字节数（例如「序列化 2154007 字节」），实际「${failure.message}」`
        );
        pngSerializedBytes = Number(byteMatch[1]);
        assert(
          pngSerializedBytes > 0,
          `序列化字节数应当是正数，实际 ${pngSerializedBytes}`
        );
      }
      // 剔除 <title> 只作用于克隆体：真画布上的标题数一点都不能少。
      assert(
        liveTitles().length === titlesBefore,
        `PNG 导出剔除 <title> 只应作用于克隆体，真画布上的标题数不该变（${titlesBefore} → ${liveTitles().length}）`
      );
      assert(exportMenu.hidden === true, '点完「png」菜单应当收起');
      continue;
    }
    const sent = fresh.filter((message) => message.type === 'exportGraph');
    assert(
      sent.length === 1,
      `点「${format}」应当恰好发出 1 条 exportGraph，实际 ${fresh
        .map((message) => message.type)
        .join(',') || '（无）'}`
    );
    assert(sent[0].format === format, `消息里的 format 应当是 ${format}，实际 ${sent[0].format}`);
    assert(
      typeof sent[0].sessionId === 'string' && sent[0].sessionId.length > 0,
      '导出消息必须带当前活动标签的 sessionId'
    );
    if (format === 'md-tree' || format === 'md-table' || format === 'json') {
      assert(
        sent[0].data === undefined,
        `${format} 的正文必须由宿主生成，不该带 data（实际带了 ${typeof sent[0].data}）`
      );
    } else if (format === 'svg') {
      assert(
        typeof sent[0].data === 'string' && sent[0].data.includes('<svg'),
        `svg 导出应当把序列化后的 SVG 放进 data，实际 ${String(sent[0].data).slice(0, 60)}`
      );
      assert(
        sent[0].data.includes('viewBox'),
        'svg 导出应当把内容包围盒写成 viewBox（否则导出图会被裁掉）'
      );
      assert(
        sent[0].data.includes('xmlns'),
        'svg 导出必须带 xmlns，否则单独打开这个文件浏览器不认（显示为空白）'
      );
      assert(
        sent[0].data.includes('<?xml'),
        'svg 导出应当带 XML 声明（单独保存成文件后可直接被解析）'
      );
      svgSerializedData = sent[0].data;
      // ---- SVG 文件路径必须**保留** `<title>` ----
      assert(
        /<title/.test(sent[0].data),
        'SVG 文件导出必须保留 <title>（人要在编辑器里看到悬停提示），实际序列化结果里没有 title'
      );
      // ---- 内联计算样式：等于初始值的不写、不等于的写（桩的 getComputedStyle 给取值）----
      const data = sent[0].data;
      assert(
        data.includes('fill="rgb(30, 30, 30)"') && data.includes('stroke="rgb(60, 60, 60)"'),
        '非初始值的计算样式必须内联（否则导出的图丢掉方框配色）：期望 box 的 fill/stroke 被写进去'
      );
      assert(
        data.includes(`font-family="${stubFontFamily}"`),
        'font-family 必须一律内联（UA 默认值不稳定，跳过会让导出文件换一套字体度量）'
      );
      for (const [property, value] of [
        ['stroke-width', '1px'],
        ['stroke-dasharray', 'none'],
        ['fill-opacity', '1'],
        ['opacity', '1'],
        ['font-weight', '400'],
        ['font-style', 'normal'],
        ['text-anchor', 'start'],
        ['dominant-baseline', 'auto'],
      ]) {
        assert(
          !data.includes(` ${property}="${value}"`),
          `取值等于 SVG 初始值的 ${property}（${value}）不该写进导出文件（白涨体积）`
        );
      }
      // 逐元素、逐属性核对「写没写」：
      //   写了 ⇔ 原节点本来就有这个属性（克隆原样带过来），或
      //          （桩算出的取值非空 且 该取值不等于 SVG 初始值，且该属性不在「一律内联」名单外的跳过范围）
      // 序列化文本里的标签顺序与 `svg.flatten()` 一致（两者都是按 children 递归、文档序），
      // 所以可以按下标一一对应。
      const elements = svg.flatten();
      const openTags = [...data.matchAll(/<([a-zA-Z][\w:-]*)((?:\s[^>]*?)?)>/g)].map(
        (match) => match[2]
      );
      assert(
        openTags.length === elements.length,
        `序列化出来的标签数（${openTags.length}）应当与原画布元素数（${elements.length}）一致`
      );
      let writtenByRule = 0;
      let presentInClone = 0;
      let mismatches = [];
      for (let index = 0; index < elements.length; index += 1) {
        const element = elements[index];
        for (const property of EXPORT_STYLE_PROPERTY_NAMES) {
          const present = openTags[index].includes(` ${property}="`);
          if (present) {
            presentInClone += 1;
          }
          const fromSource = element.getAttribute?.(property) !== null;
          const value = stubComputedValue(element, property);
          const alwaysInline =
            property === 'font-family' || property === 'font-size';
          const inlineRule =
            Boolean(value) &&
            (alwaysInline || value !== STUB_SVG_INITIAL_VALUES[property]);
          if (inlineRule) {
            writtenByRule += 1;
          }
          if (present !== (fromSource || inlineRule)) {
            mismatches.push(
              `${element.tagName}.${element.getAttribute?.('class') ?? ''}#${index} 的 ${property}` +
                `（原属性=${fromSource}、计算值=${JSON.stringify(value)}、序列化里写了=${present}）`
            );
          }
        }
      }
      assert(
        mismatches.length === 0,
        `内联规则与序列化结果对不上（${mismatches.length} 处）：${mismatches.slice(0, 5).join('；')}`
      );
      // 夹具必须真的**有**可跳过的东西，否则这条断言什么都证明不了。
      assert(
        initialValueWrites() > 0,
        '这个夹具里没有任何「取值等于初始值」的属性，跳过规则等于没被测到'
      );
      console.log(
        `诊断: 内联样式 —— 旧口径会写 ${oldInlineWrites()} 条；新口径规则应写 ${writtenByRule} 条，` +
          `实际序列化里带这些属性的共 ${presentInClone} 条（含原节点自带的），` +
          `跳过等于初始值的 ${initialValueWrites()} 条`
      );
    }
    assert(exportMenu.hidden === true, `点完「${format}」菜单应当收起`);
  }

  // ---- 剔除 `<title>` 真的减小了 PNG 那一份的体积 ----
  //
  // 桩里两条路径都会序列化（PNG 是在栅格化之前失败的），所以可以直接比字节数：
  // PNG 那一份少了全部 `<title>`，必须严格小于 SVG 那一份。
  assert(
    typeof pngSerializedBytes === 'number' && typeof svgSerializedData === 'string',
    '体积对比需要 PNG 失败文案里的字节数与 SVG 的序列化文本（桩环境应当两条都能拿到）'
  );
  {
    const svgBytes = Buffer.byteLength(svgSerializedData, 'utf8');
    assert(
      pngSerializedBytes < svgBytes,
      `剔除 <title> 后 PNG 那一份的序列化体积应当更小：PNG ${pngSerializedBytes} 字节、` +
        `SVG ${svgBytes} 字节（若相等说明 PNG 路径根本没剔除 title）`
    );
    // 旧口径（凡非空取值都写、title 也不剔）的体积：序列化文本 + 被跳过属性的 ` prop="value"` 字符数。
    // 这些取值都是 ASCII（颜色 / px / none / start），所以字符数即字节数。
    let skippedChars = 0;
    for (const element of svg.flatten()) {
      for (const property of EXPORT_STYLE_PROPERTY_NAMES) {
        const value = stubComputedValue(element, property);
        const alwaysInline = property === 'font-family' || property === 'font-size';
        if (value && !alwaysInline && value === STUB_SVG_INITIAL_VALUES[property]) {
          skippedChars += 4 + property.length + value.length;
        }
      }
    }
    console.log(
      `诊断: 导出体积 —— 同一张画布 SVG（保留 title）${svgBytes} 字节 / PNG 克隆（剔除 title）` +
        `${pngSerializedBytes} 字节，剔除省下 ${svgBytes - pngSerializedBytes} 字节、` +
        `画布上 ${titlesBefore} 个 <title>；` +
        `另按旧口径（不跳过初始值）复算，PNG 那一份会是约 ${pngSerializedBytes + skippedChars} 字节，` +
        `即跳过初始值再省约 ${skippedChars} 字节`
    );
  }
  log(
    `诊断: 导出菜单 ${items.length} 项 —— md-tree/md-table/json 不带 data（正文由宿主生成），` +
      'svg 交给宿主序列化文本且保留 <title>，png 剔除 <title>、跳过等于初始值的内联属性，' +
      '在桩里无法栅格化时如实报错（带序列化字节数）'
  );
}

// ------------------------------------------------ 导出前的 XML 自检（行为级）
//
// 真机现象：展开到第二级后「导出图片（PNG，2×）」失败，同时导出的 .svg 打开报错。
// 栅格化失败与「文件打开报错」都只是症状，所以本轮把「序列化结果本身是否合法 XML」
// 变成可证的事实：预检不通过就拒绝写文件、拒绝栅格化，并把诊断一次说清。
//
// 桩的能力边界：真实内核何时在解析结果里插入 parsererror 无法在 Node 里复现，
// 因此由 DOMParser 桩直接给出「有 / 没有 parsererror」两种情形，断言生产代码的**反应**；
// 「真实内核会对哪类图给出 parsererror」仍属未验证（要真机确认）。
{
  const exportMenu = byId.get('export-menu');
  const menuHandlers = exportMenu.listeners.get('click') ?? [];
  assert(menuHandlers.length >= 1, '导出菜单上没有注册 click 处理函数');
  const items = exportMenu.children.filter((child) => child.getAttribute?.('data-format'));
  const itemOf = (format) => items.find((child) => child.getAttribute('data-format') === format);
  const relevant = (message) => message.type !== 'reportWidths';
  /** 点某个导出菜单项，返回它发出的（与导出有关的）消息。 */
  const clickExport = (format) => {
    const before = posted.length;
    for (const handler of menuHandlers) {
      handler({ type: 'click', target: itemOf(format), preventDefault() {}, stopPropagation() {} });
    }
    return posted.slice(before).filter(relevant);
  };
  const failureOf = (messages) => messages.find((message) => message.type === 'error');
  const exportOf = (messages) => messages.find((message) => message.type === 'exportGraph');

  assert(
    typeof stubParserErrorText === 'undefined',
    '进入这段断言前桩必须处于「解析通过」状态（否则下面「走原路径」的用例无从判断）'
  );

  // ---- ① 解析器给出 parsererror：两条导出路径都必须失败，文案里带解析器原文 ----
  const parserErrorText = 'error on line 7 at column 3: 桩给出的解析器报错\n第二行应当被压掉';
  stubParserErrorText = parserErrorText;
  try {
    let sample = '';
    for (const format of ['svg', 'png']) {
      const messages = clickExport(format);
      const failure = failureOf(messages);
      assert(
        failure !== undefined,
        `${format} 导出在解析器报错时必须失败（不许静默当作成功），实际消息 ${
          messages.map((message) => message.type).join(',') || '（无）'
        }`
      );
      const text = String(failure.message);
      sample = sample || text;
      assert(
        text.includes('XML 解析器报错'),
        `${format} 失败文案应当写明是解析器报错，实际「${text}」`
      );
      assert(
        text.includes('桩给出的解析器报错'),
        `${format} 失败文案必须含解析器给出的原文，实际「${text}」`
      );
      assert(
        !text.includes('\n'),
        `${format} 失败文案必须压成单行（解析器原文里的换行要压掉），实际「${text}」`
      );
      assert(
        /序列化 \d+ 字节/.test(text),
        `${format} 失败文案必须带序列化字节数，实际「${text}」`
      );
      if (format === 'svg') {
        // 「拒绝写文件」的可证形式：宿主根本没有收到 exportGraph。
        assert(
          exportOf(messages) === undefined,
          `SVG 预检不通过时必须拒绝写文件（不得发出 exportGraph），实际发出 ${
            messages.map((message) => message.type).join(',') || '（无）'
          }`
        );
      } else {
        // PNG 必须在**加载图像之前**就停下：文案里不该出现「加载失败」那套。
        assert(
          text.includes('栅格化未开始'),
          `PNG 预检不通过时应当在加载图像之前终止，实际「${text}」`
        );
      }
    }
    console.log(`诊断: 解析器报错预检 —— svg 与 png 都失败且拒绝写盘，文案例：「${sample}」`);
  } finally {
    stubParserErrorText = undefined;
  }

  // ---- ② parsererror 只在命名空间元素里（按标签名取不到）时，第二条判据仍要生效 ----
  stubParserErrorText = '仅由 querySelector 取到的 parsererror';
  stubParserErrorOnlyBySelector = true;
  try {
    const failure = failureOf(clickExport('svg'));
    assert(
      failure !== undefined && String(failure.message).includes('仅由 querySelector 取到的 parsererror'),
      'parsererror 只出现在命名空间元素里（按标签名取不到）时也必须判出来' +
        `（getElementsByTagName ?? querySelector），实际「${
          failure === undefined ? '（没有失败消息）' : failure.message
        }」`
    );
  } finally {
    stubParserErrorOnlyBySelector = false;
    stubParserErrorText = undefined;
  }

  // ---- ③ 解析通过：必须继续走原路径（SVG 交给宿主；PNG 照旧尝试栅格化） ----
  {
    const svgMessages = clickExport('svg');
    const sent = exportOf(svgMessages);
    assert(
      sent !== undefined && typeof sent.data === 'string' && sent.data.includes('<svg'),
      '解析器说没问题时，SVG 导出必须照原样把序列化文本交给宿主' +
        `（实际 ${svgMessages.map((message) => message.type).join(',') || '（无）'}）`
    );
    const pngFailure = failureOf(clickExport('png'));
    assert(
      pngFailure !== undefined,
      '桩里没有真实 canvas / Image，PNG 仍应如实报错（不许静默）'
    );
    assert(
      !String(pngFailure.message).includes('合法的 XML'),
      `解析通过时 PNG 不得报「序列化结果不合法」，实际「${pngFailure.message}」`
    );
    assert(
      /序列化 \d+ 字节/.test(String(pngFailure.message)),
      `PNG 失败文案仍必须带序列化字节数，实际「${pngFailure.message}」`
    );
    console.log(
      `诊断: 解析通过时走原路径 —— svg 发出 exportGraph，png 照旧尝试栅格化并如实报错：「${pngFailure.message}」`
    );
  }

  // ---- ④ 序列化文本里的控制字符：文案含 U+XXXX 与位置、片段，且 svg 不写文件 ----
  //
  // ⚠️ 注入方式在 8.8 改过：过去是给**真画布根元素**加一个取值为 `\u0000` 的属性。现在
  // 生产代码会在序列化之前把克隆体里的控制字符换掉，那条路已经造不出「非法文本」——
  // 这恰好说明修法生效（含 NUL 的导出改由下面单独的用例做端到端断言）。因此这里改由
  // **桩开关**模拟「净化没有生效」（等价于去掉 `sanitizeExportXmlChars(clone)`）：
  // 序列化该属性时写出未净化的原始取值，序列化文本里于是重新出现裸控制字符。
  //
  // 报出的下标仍要**独立核对**：先以探针属性取值 'X' 导出一次（开关关闭），从拿到的
  // 序列化文本里量出该属性取值的位置；再让开关在该属性处写出 `\u0000`（长度相同，
  // 文本其余部分逐字不变），于是可以要求失败文案报出的下标与它**逐位相等** ——
  // 而不是「看着像个数字」就算过。
  svg.setAttribute('data-xml-probe', 'X');
  try {
    const baseline = exportOf(clickExport('svg'));
    assert(
      baseline !== undefined && typeof baseline.data === 'string',
      '核对控制字符下标需要一份「探针取值正常」时的序列化文本（这一份应当导出成功）'
    );
    const probeAt = baseline.data.indexOf('data-xml-probe="X"');
    assert(probeAt >= 0, '序列化文本里应当能定位到探针属性（否则下标核对无从谈起）');
    const expectedIndex = probeAt + 'data-xml-probe="'.length;

    stubSerializerRawAttributeValues = { 'data-xml-probe': '\u0000' };
    let sample = '';
    for (const format of ['svg', 'png']) {
      const messages = clickExport(format);
      const failure = failureOf(messages);
      assert(
        failure !== undefined,
        `${format} 导出在序列化文本含 U+0000 时必须失败（净化未生效的对照组）`
      );
      const text = String(failure.message);
      sample = sample || text;
      assert(text.includes('U+0000'), `失败文案必须含 U+0000，实际「${text}」`);
      assert(
        text.includes('控制字符 1 处'),
        `这次夹具里恰好一处控制字符，文案应当如实报 1 处，实际「${text}」`
      );
      const position = /U\+0000（位置 (\d+)/.exec(text);
      assert(
        position !== null,
        `失败文案必须给出控制字符的出现位置（下标），实际「${text}」`
      );
      assert(
        Number(position[1]) === expectedIndex,
        `控制字符的下标必须等于独立核对出的 ${expectedIndex}，实际 ${position[1]}`
      );
      assert(
        text.includes('data-xml-probe="·"'),
        `片段应当带上命中处前后的上下文、且控制字符替换成可见替身 ·，实际「${text}」`
      );
      assert(
        /序列化 \d+ 字节/.test(text),
        `失败文案必须带序列化字节数，实际「${text}」`
      );
      if (format === 'svg') {
        assert(
          exportOf(messages) === undefined,
          'SVG 预检不通过时不得写出文件（不得发出 exportGraph）'
        );
      }
    }
    console.log(
      `诊断: 控制字符预检 —— 报出的下标与独立核对的 ${expectedIndex} 逐位一致；文案例：「${sample}」`
    );
  } finally {
    stubSerializerRawAttributeValues = undefined;
    svg.removeAttribute('data-xml-probe');
  }

  // ---- ⑤ DOMParser 不存在（测试桩 / 极简环境）：不得阻断，仍按原逻辑导出 ----
  const savedDOMParser = global.DOMParser;
  delete global.DOMParser;
  try {
    const svgMessages = clickExport('svg');
    const sent = exportOf(svgMessages);
    assert(
      sent !== undefined && typeof sent.data === 'string' && sent.data.includes('<svg'),
      'DOMParser 不存在时 SVG 导出必须照原样进行（不得因缺少解析器而阻断），' +
        `实际 ${svgMessages.map((message) => message.type).join(',') || '（无）'}`
    );
    const pngFailure = failureOf(clickExport('png'));
    assert(
      pngFailure !== undefined && !String(pngFailure.message).includes('合法的 XML'),
      'DOMParser 不存在时 PNG 不得报「序列化结果不合法」，仍应按原逻辑走到栅格化那一步，' +
        `实际「${pngFailure === undefined ? '（没有失败消息）' : pngFailure.message}」`
    );
    console.log('诊断: DOMParser 不存在时不阻断 —— svg 照旧交给宿主、png 照旧走栅格化');
  } finally {
    global.DOMParser = savedDOMParser;
  }
  assert(
    typeof global.DOMParser === 'function' &&
      typeof stubParserErrorText === 'undefined' &&
      stubParserRejectInvalidXmlChars === false &&
      stubSerializerRawAttributeValues === undefined,
    '这段断言结束时必须把桩恢复原状（DOMParser 复位、解析结果与两个开关复位）'
  );
  log(
    'OK: 导出前 XML 自检 —— 解析器报错与 U+0000 控制字符都会让 svg / png 拒绝导出' +
      '（文案带诊断与「序列化 N 字节」，svg 不写文件），解析通过时照旧走原路径，' +
      'DOMParser 不存在时不阻断'
  );
}

// ------------------------------------------------ 导出前的字符净化（行为级，8.8）
//
// 真机根因（证据见开发记录 8.8.1）：节点 id 以 NUL 作分隔符（宿主 `session.ts` 的
// `ID_SEPARATOR`），而 id 会随属性值进入画布，于是序列化结果里是**裸 U+0000**；内核的
// XML 解析器报 `invalid character in attribute value` —— PNG 走 `<img>` 加载同一份文本，
// 因此必然 `onerror`。修法是在序列化之前把**克隆体**里 XML 1.0 不允许的控制字符换成可见
// 替身 `␀`（U+2400），真画布一个字符不动。
//
// 本节断言三件事：
//   ① 导出文本里不再有裸 U+0000，且出现替身 —— 用的是真机命中的属性值形态；
//   ② 真画布上那个属性仍是原始值（证明净化只动了克隆体）；
//   ③ 端到端闭环：预检桩按 XML 1.0 规则判定（文本含非法控制字符即报 parsererror）时，
//      含 NUL 的导出**成功**；把净化关掉（桩开关模拟）后同一个输入**仍然失败**，
//      证明 8.7 的预检没有被架空。
{
  const exportMenu = byId.get('export-menu');
  const menuHandlers = exportMenu.listeners.get('click') ?? [];
  const items = exportMenu.children.filter((child) => child.getAttribute?.('data-format'));
  const itemOf = (format) => items.find((child) => child.getAttribute('data-format') === format);
  const relevant = (message) => message.type !== 'reportWidths';
  /** 点某个导出菜单项，返回它发出的（与导出有关的）消息。 */
  const clickExport = (format) => {
    const before = posted.length;
    for (const handler of menuHandlers) {
      handler({ type: 'click', target: itemOf(format), preventDefault() {}, stopPropagation() {} });
    }
    return posted.slice(before).filter(relevant);
  };
  const failureOf = (messages) => messages.find((message) => message.type === 'error');
  const exportOf = (messages) => messages.find((message) => message.type === 'exportGraph');

  assert(
    typeof stubSerializerRawAttributeValues === 'undefined' && !stubParserRejectInvalidXmlChars,
    '进入这段断言前两个桩开关都必须处于关闭状态（否则测的就不是净化本身）'
  );

  /** 真画布上「属性取值含 NUL」的属性条数：用来证明净化只动了克隆体。 */
  const canvasNulAttributes = () =>
    svg
      .flatten()
      .reduce(
        (total, element) =>
          total +
          [...element.attributes].filter((attribute) => String(attribute.value).includes('\u0000'))
            .length,
        0
      );

  // 真机命中的形态：属性值是「符号名 + NUL + file URI」（节点 id 以 NUL 拼成）。
  const nulNodeId = 'lib_core_dev_read_byte\u0000file:///c%3A/work/fixture/lib_core_dev.c';
  const sanitizedNodeId = 'lib_core_dev_read_byte\u2400file:///c%3A/work/fixture/lib_core_dev.c';
  const box = nodesGroup.children[0];
  const originalNodeId = box.getAttribute('data-node');
  assert(
    typeof originalNodeId === 'string' && originalNodeId.length > 0,
    '真画布上第一个方框应当带 data-node（那是节点 id 落到 DOM 上的地方）'
  );
  assert(canvasNulAttributes() === 0, '进入用例前真画布上不该有含 NUL 的属性');

  // 预检桩改成**按 XML 1.0 规则判定**：序列化文本里出现非法控制字符就报 parsererror。
  // 这一步是闭环的关键：桩若照旧一律「解析通过」，含 NUL 的导出无论如何都会「成功」，
  // 那就证明不了修法真的消掉了非法字符。
  stubParserRejectInvalidXmlChars = true;
  try {
    box.setAttribute('data-node', nulNodeId);
    assert(canvasNulAttributes() === 1, '探针属性应当让真画布上恰好出现 1 个含 NUL 的属性');

    // ---- ① + ② 净化生效，且只作用于克隆体 ----
    const svgMessages = clickExport('svg');
    const failure = failureOf(svgMessages);
    assert(
      failure === undefined,
      '含 NUL 的导出在净化生效后必须成功（预检桩已按 XML 1.0 判定，失败即说明净化没生效）' +
        `，实际「${failure === undefined ? '' : failure.message}」`
    );
    const sent = exportOf(svgMessages);
    assert(
      sent !== undefined && typeof sent.data === 'string' && sent.data.includes('<svg'),
      '含 NUL 的 SVG 导出必须发出 exportGraph（宿主据此写文件），实际发出 ' +
        `${svgMessages.map((message) => message.type).join(',') || '（无）'}`
    );
    assert(
      !sent.data.includes('\u0000'),
      '导出文本里不得再有裸 U+0000（内核的 XML 解析器正是因为它才报 invalid character）'
    );
    assert(
      sent.data.includes(sanitizedNodeId),
      '导出文本里必须出现净化后的属性取值（NUL 换成 ␀），实际片段：' +
        `${sent.data.slice(Math.max(0, sent.data.indexOf('data-node=')), sent.data.indexOf('data-node=') + 120)}`
    );
    assert(
      sent.data.includes('\u2400'),
      '导出文本里必须出现替身 ␀（U+2400），否则「原本有个 NUL」这件事在文件里看不出来'
    );
    assert(
      box.getAttribute('data-node') === nulNodeId,
      '真画布上那个属性必须仍是原始值（含 NUL）—— 净化只许动克隆体，' +
        `实际「${String(box.getAttribute('data-node')).replace(/\u0000/g, '\\u0000')}」`
    );
    assert(
      canvasNulAttributes() === 1,
      `净化之后真画布上仍应恰好有 1 个含 NUL 的属性，实际 ${canvasNulAttributes()}（只动了克隆体才对）`
    );
    // PNG 与 SVG 共用 buildExportSvg，因此这里只断言「不再因 XML 不合法被拦下」。
    // 桩里没有真实 canvas / Image，栅格化**必然**失败，所以 PNG 无法在桩里端到端成功
    // （这是未验证项，见开发记录 8.8.3）。
    const pngMessages = clickExport('png');
    const pngFailure = failureOf(pngMessages);
    assert(
      pngFailure !== undefined,
      '桩里没有真实 canvas / Image，PNG 仍应如实报错（不许静默）'
    );
    const pngText = String(pngFailure.message);
    assert(
      !pngText.includes('合法的 XML') && !pngText.includes('控制字符') && !pngText.includes('U+0000'),
      '含 NUL 的 PNG 导出不得再因「序列化结果含非法字符」被拦下（真机症状正是 PNG 必然失败），' +
        `实际「${pngText}」`
    );
    assert(
      /序列化 \d+ 字节/.test(pngText),
      `PNG 失败文案仍必须带序列化字节数，实际「${pngText}」`
    );
    console.log(
      `诊断: 导出字符净化 —— 含 NUL 的属性值（${nulNodeId.replace(/\u0000/g, '\\u0000')}）` +
        '导出成功、文本里换成 ␀，真画布上的取值一个字符没动；' +
        `导出文本里该属性为 data-node="${sanitizedNodeId}"，` +
        '全文不含裸 U+0000；' +
        `PNG 不再是 XML 预检失败（实际失败于栅格化：「${pngText}」）`
    );

    // ---- ③ 对照：把净化关掉（桩开关模拟），真正非法的输入必须仍然失败 ----
    // 这条是「预检没被架空」的证据：净化生效时它放行，净化失效时它必须拦下并给出诊断。
    //
    // 探针属性名是**只此一处**的：桩开关按属性名替换序列化取值，若借用 `data-node`
    // （画布上每个方框都有），命中处数就不是 1，「控制字符 1 处」这条断言会失去意义。
    // 取值用 `\u0001` 而不是 NUL：换个字符类成员，顺带证明净化与预检覆盖的不只是 NUL。
    const rawProbeAttribute = 'data-export-raw-probe';
    const rawProbeValue = '\u0001';
    box.setAttribute(rawProbeAttribute, rawProbeValue);
    stubSerializerRawAttributeValues = { [rawProbeAttribute]: rawProbeValue };
    try {
      let sample = '';
      for (const format of ['svg', 'png']) {
        const messages = clickExport(format);
        const blocked = failureOf(messages);
        assert(
          blocked !== undefined,
          `净化未生效时，含 U+0001 的序列化结果必须被预检拦下（${format} 路径）`
        );
        const text = String(blocked.message);
        sample = sample || text;
        assert(
          text.includes('XML 解析器报错') && text.includes('invalid character in attribute value'),
          `${format} 失败文案应当带上预检桩给出的解析器报错原文（真机日志同为这句），` +
            `实际「${text}」`
        );
        assert(
          text.includes('U+0001') && text.includes('控制字符 1 处'),
          `${format} 失败文案应当同时给出控制字符诊断（U+0001 与命中处数），实际「${text}」`
        );
        assert(
          /序列化 \d+ 字节/.test(text),
          `${format} 失败文案必须带序列化字节数，实际「${text}」`
        );
        if (format === 'svg') {
          assert(
            exportOf(messages) === undefined,
            '净化未生效时 SVG 不得写出文件（不得发出 exportGraph）'
          );
        } else {
          assert(
            text.includes('栅格化未开始'),
            `净化未生效时 PNG 必须在加载图像之前终止，实际「${text}」`
          );
        }
      }
      console.log(`诊断: 净化未生效的对照组 —— 同一个方框仍被拦下，文案例：「${sample}」`);
    } finally {
      stubSerializerRawAttributeValues = undefined;
      box.removeAttribute(rawProbeAttribute);
    }
  } finally {
    stubParserRejectInvalidXmlChars = false;
    if (originalNodeId === null) {
      box.removeAttribute('data-node');
    } else {
      box.setAttribute('data-node', originalNodeId);
    }
  }

  assert(
    !stubParserRejectInvalidXmlChars &&
      typeof stubSerializerRawAttributeValues === 'undefined' &&
      box.getAttribute('data-node') === originalNodeId &&
      canvasNulAttributes() === 0,
    '这段断言结束时必须把桩与真画布都恢复原状（两个开关关闭、data-node 复原、真画布无 NUL）'
  );
  log(
    'OK: 导出字符净化 —— 含 NUL 的属性值经净化后导出成功（文本里是 ␀、真画布原样），' +
      '净化关掉时同一个输入仍被预检拦下'
  );
}

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
  // ③ C2：布局变化造成的位移**走插值**（滚动不走，见 ②）。
  //   做法：再送一帧「root 多了 8 个子框」的布局，目标位移必然变大；然后**接管 Date.now**
  //   把动画时钟推进到结束 —— 这样不必真等 180ms，断言仍然确定（测试桩没有时间轴）。
  {
    const extraIds = [];
    const expanded = { ...stickyNodes };
    for (let i = 0; i < 8; i += 1) {
      const id = `late_${i}`;
      extraIds.push(id);
      expanded[id] = { ...stickyNodes.child_0, id, name: id, line: 20 + i };
    }
    expanded.root_fn = { ...stickyNodes.root_fn, children: [...childIds, ...extraIds] };
    const expandedBoxes = createLayout(expanded, 'root_fn').boxes;
    const sessionOf = (nodes, boxes) => ({
      type: 'sessionUpdate',
      session: {
        id: 'sticky-check',
        title: '粘性检查',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'root_fn',
        nodes,
        edges: childIds.map((id, index) => ({ id: `e${index}`, from: id, to: 'root_fn', depth: 1 })),
        boxes,
        collapsedCount: 0,
      },
    });

    const realNow = Date.now;
    let fakeNow = realNow();
    Date.now = () => fakeNow;
    try {
      // ⚠️ 本块前面的用例把粘性**关掉**过（「关掉后回到原位」那条），这里必须显式开回来：
      // 不开的话 pinned 有、目标却是空的，动画根本不会起（第一版就踩了这个）。
      sendToWebview({ type: 'settings', settings: { stickyParent: true } });
      canvasEl.dispatch('scroll', {});
      flushFrames();
      const topBefore = rootTop();
      // 动画刚开始（进度 0）：位置应当**还在起点**，绝不能已经跳到目标
      sendToWebview(sessionOf(expanded, expandedBoxes));
      const topRightAfterSend = rootTop();
      // ⚠️ 这是「插值真的生效」的**唯一硬证据**：新布局到达时首帧必须仍画在**起点**。
      // 之前三版都失败在这里（诊断一直是 `send 后 = 终点`）：先是插错了对象（粘性位移而非总绘制 y），
      // 再是缺了布局帧上的 `lastPaintedTotal` 记录。所以这条断言必须留着。
      assert(
        Math.abs(topRightAfterSend - topBefore) <= 1,
        `新布局到达的首帧应当仍画在起点 ${topBefore.toFixed(1)}，实际 ${topRightAfterSend.toFixed(1)}` +
          `（直接画到终点就说明插值没生效）`
      );
      flushFrames();
      const topAtStart = rootTop();
      // 把时钟推到动画结束（180ms + 余量），再走一帧
      const paintStart = realNow();
      fakeNow += 260;
      flushFrames();
      const paintCost = realNow() - paintStart;
      const topAtEnd = rootTop();
      // ⚠️ 先确认这一帧确实改变了位移，否则下面的断言等于没测
      assert(
        Math.abs(topAtEnd - topBefore) > 5,
        `夹具应当让位移明显变化（起点 ${topBefore.toFixed(1)} → 终点 ${topAtEnd.toFixed(1)}）`
      );
      // 端点必须与「直接落位」的结果一致：动画只是过渡，终点不能偏。
      // 参考值用**另一个会话 id** 送同一份几何（首次渲染必然直接落位）。
      const refSession = sessionOf(expanded, expandedBoxes);
      refSession.session.id = 'sticky-ref';
      sendToWebview(refSession);
      const refTop = rootTop();
      assert(
        Math.abs(refTop - topAtEnd) <= 1,
        `插值终点应当与直接落位一致（动画 ${topAtEnd.toFixed(1)} vs 直接 ${refTop.toFixed(1)}）`
      );
      // 连线必须与方框同源：路径起点 y 等于**它自己那一侧方框**的中心 y
      // （第一条边是 child_0 → root_fn，backward 时路径从 child_0 开始，所以拿 child_0 比）
      const d = String(edgesEl.children[0].getAttribute('d'));
      const firstY = Number(/^M [-\d.]+ ([-\d.]+)/.exec(d)?.[1]);
      const child0Top = Number(
        /translate\(([-\d.]+) ([-\d.]+)\)/.exec(groupOf('child_0').getAttribute('transform'))[2]
      );
      assert(
        Math.abs(firstY - (child0Top + boxHeight / 2)) <= 1,
        `连线端点应当跟上方框（路径 y=${firstY}，child_0 中心 ${(child0Top + boxHeight / 2).toFixed(1)}）`
      );
      // 结束后再走一帧：位置必须稳定（动画已收尾，不该继续漂）
      flushFrames();
      assert(
        Math.abs(rootTop() - topAtEnd) <= 0.001,
        `动画结束后位置应当稳定（${topAtEnd.toFixed(1)} → ${rootTop().toFixed(1)}）`
      );
      log(
        `诊断: 位移插值 —— 起点 ${topBefore.toFixed(1)}，send 后 ${topRightAfterSend.toFixed(1)}、` +
          `flush 后 ${topAtStart.toFixed(1)}、推进时钟后 ${topAtEnd.toFixed(1)}（直接落位参考 ${refTop.toFixed(1)}）；` +
          `一帧重画耗时 ${paintCost.toFixed(1)}ms（可见方框 ${nodesGroup.children.length} 个）`
      );
      assert(
        paintCost < 8,
        `一帧重画耗时应当明显低于掉帧阈值（实测 ${paintCost.toFixed(1)}ms）`
      );
      // ⚠️ 回归用例（2026-10-14 用户实测「展开某个节点时当前节点不居中了」）：
      // 动画过期后若只停动画而不落位，`displayedShifts` 会停在插值中间值上，位置就永久偏了。
      // 这里把时钟推过动画窗口、再重发同一布局（几何未变）—— 位置必须仍精确居中。
      fakeNow += 1000;
      canvasEl.clientHeight = 300; // 前面的用例可能改过视口；粘性需要「内容比视口高」才生效
      sendToWebview(sessionOf(expanded, expandedBoxes));
      flushFrames();
      assert(
        Math.abs(rootCenterInViewport() - canvasEl.clientHeight / 2) <= 1,
        `动画过期后的重绘仍须把被钉住的方框保持在视口中央（中心 ` +
          `${rootCenterInViewport().toFixed(1)}，视口中心 ${canvasEl.clientHeight / 2}）`
      );
    } finally {
      Date.now = realNow;
    }
  }

  // ④ C2 的旋钮与结构：闸门、时长、以及「滚动路径不插值」这两个决定必须有源码级断言，
  //   否则以后有人把插值也接到滚动上（橡皮筋手感）或把闸门去掉（大图掉帧）都不会被发现。
  {
    const webviewSource = fs.readFileSync(
      path.join(ROOT, 'src', 'webview', 'graph.ts'),
      'utf8'
    );
    const constOf = (src, name) => Number(new RegExp(`const ${name}\\s*=\\s*(\\d+)`).exec(src)?.[1]);
    const gate = constOf(webviewSource, 'ANIM_GATE_NODES');
    const duration = constOf(webviewSource, 'ANIM_DURATION_MS');
    assert(
      gate === 250,
      `插值的可见方框数闸门应为 250（超过就落位，避免大图掉帧）。实际 ${gate}`
    );
    assert(
      /ANIM_GATE_NOTE/.test(webviewSource),
      '闸门必须有说明（ANIM_GATE_NOTE），便于后来人知道这个数字的来历'
    );
    assert(duration === 180, `插值时长应当是 180ms，实际 ${duration}`);
    assert(
      /function lerpShift\(/.test(webviewSource) && /function easeOutCubic\(/.test(webviewSource),
      '插值必须是可单独断言的纯函数（测试桩没有时间轴，只能断言函数本身与过程）'
    );
    assert(
      /snapStickyShifts\(\);\s*\n\s*paintStickyFrame\(session\);/.test(webviewSource),
      '滚动路径必须立即落位（不插值）—— 否则滚动会变成橡皮筋'
    );
    assert(
      /beginLayoutStickyAnimation\(session\)/.test(webviewSource),
      'render() 必须在布局帧上启动插值'
    );
    // ⚠️ 滚动路径的「不落位」守护**必须带时间上限**：动画窗口之外若还走「动画中」分支，
    // 画的是陈旧目标值，而滚动每帧都在更新目标 —— 两边争，用户看到居中方框高频抖动
    // （2026-07-14 实测反馈）。这两条断言把「有时间上限」与「超期清空状态」钉住。
    assert(
      /ANIM_DURATION_MS \+ 100/.test(webviewSource),
      '滚动路径的动画守护必须带时间上限（否则滚动时会高频抖动）'
    );
    assert(
      /stopStickyAnimation\(\);\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*snapStickyShifts\(\);/.test(
        webviewSource
      ) || (webviewSource.match(/stopStickyAnimation\(\);/g) ?? []).length >= 4,
      '滚动路径在超过动画窗口后必须清空动画状态（stopStickyAnimation）'
    );
    // 插值对象必须是**总绘制 y**，而不是粘性位移：用户看到的平移主要来自 box.y 重排
    // （第三轮探针实测「位移为 0 时位置仍变了 220px」）。这条断言防止有人把它改回只插位移。
    assert(
      /lastPaintedTotal/.test(webviewSource) && /box\.y \+ \(targets\.get\(id\) \?\? 0\)/.test(webviewSource),
      '插值必须以总绘制 y（box.y + 位移）为对象，并以 lastPaintedTotal 为起点'
    );
  }

  // ⑤ 闸门阈值的**实测**：250 个可见方框时，一帧插值重画（方框 transform + 连线 d）要多久。
  // 目标每帧 < 4ms（16ms 预算的 1/4，给浏览器光栅化留余量）。这条是「250 这个闸门值」的依据，
  // 不是拍脑袋 —— 目标里明确要求阈值必须实测。
  {
    const makeNode = (id, parent, children = [], depth = 1) => ({
      id,
      name: id,
      file: 'w.c',
      line: 1,
      direction: 'callers',
      depth,
      isCycle: false,
      children,
      parent,
      loaded: true,
      kind: 'function',
    });
    const WIDE = 250;
    const build = (hubChildren) => {
      const nodes = {};
      const wideIds = [];
      for (let i = 0; i < WIDE; i += 1) {
        const id = `w${i}`;
        wideIds.push(id);
        nodes[id] = makeNode(id, 'r');
      }
      const hubKids = [];
      for (let i = 0; i < hubChildren; i += 1) {
        const id = `hub_${i}`;
        hubKids.push(id);
        nodes[id] = makeNode(id, 'hub', [], 2);
      }
      nodes.hub = makeNode('hub', 'r', hubKids);
      nodes.r = makeNode('r', undefined, ['hub', ...wideIds], 0);
      return { nodes, boxes: createLayout(nodes, 'r').boxes };
    };
    const sessionOf = (built, id) => ({
      type: 'sessionUpdate',
      session: {
        id,
        title: '闸门实测',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'r',
        nodes: built.nodes,
        edges: [],
        boxes: built.boxes,
        collapsedCount: 0,
      },
    });
    // 先铺一帧（首次渲染必然落位），再用「hub 长出 40 个子框」制造整列下移 → 触发插值
    sendToWebview(sessionOf(build(0), 'gate-check'));
    flushFrames();
    sendToWebview(sessionOf(build(40), 'gate-check'));
    const visibleCount = nodesGroup.children.length;
    const started = Date.now();
    flushFrames(); // 冲一帧：tick 会重画全部方框与连线
    const perFrame = Date.now() - started;
    assert(
      visibleCount >= 250,
      `闸门实测需要 ≥250 个可见方框，实际 ${visibleCount} 个`
    );
    log(
      `诊断: 闸门实测 —— ${visibleCount} 个可见方框，一帧插值重画 ${perFrame.toFixed(1)}ms（目标 < 4ms）`
    );
    assert(
      perFrame < 4,
      `一帧重画应当 < 4ms（实测 ${perFrame.toFixed(1)}ms，${visibleCount} 个可见方框）——` +
        `若超出则需下调 ANIM_GATE_NODES，避免大图掉帧`
    );
  }

  // 关于「展开多级后最底/最顶的方框是否与下一级平齐」这个曾经反馈过的问题（2026-10-14）：
  //   用户随后确认是自己**记错了期望** —— 纵向本来就不做「整条链对齐」，粘性方框只能在
  //   **自己子树的空挡内**上下滑（`stickySubtreeSlot()` 的递归覆盖任意深度，与 0.21.0 逐行相同，
  //   对比 `git diff 1ce7540 -- src/webview/graph.ts` 可见该处没有变更行）。
  //   因此**这里不需要断言**，也不存在待修的缺陷；真正修掉的是「插值朝过期目标收敛」那一处
  //   （误差 ∝ 视口高度，用户以「窗口越扁越能对上」判定）。
  log('说明: 纵向不在整条链上对齐 —— 粘性只在本子树空挡内滑动，与 0.21.0 一致（非缺陷）');

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
  // 两个易错点：① 后面延后执行的段落会在**当前 DOM** 上逐个方框数加减号（要求 ≥2 个），
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
  // 写成字面量而不是「照实现公式重算一次」：规则若整体写错，公式会跟着一起错，只有写死才会红。
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
// 快查询不显示（延迟 240ms），否则会出现瞬时闪烁。
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

  // 快查询：busy 立刻结束，延迟没到就不该显示（这是「不出现瞬时闪烁」的关键）
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

      // 换字体必须让缓存失效：缓存键以前只有「字号 + 粗细 + 文字」，而字体族是继承来的，
      // 用户换字体时字号不变 → 旧宽度被继续命中，方框宽度与文字对不上。
      const readsBeforeFont = measureProbeReads;
      stubFontFamily = 'Fira Code, monospace';
      sendToWebview(payload);
      const readsAfterFont = measureProbeReads - readsBeforeFont;
      console.log(
        `        换字体后重渲染：量宽探测 ${readsAfterFont} 次（应为正数，说明缓存按字体族失效）`
      );
      assert(
        readsAfterFont > 0,
        `换字体后仍命中旧缓存（探测 ${readsAfterFont} 次）——方框宽度会按旧字体算`
      );
      stubFontFamily = 'Consolas, monospace';
    }
  } catch (error) {
    // ⚠️ 必须**判失败**，不能只打印：这一块本来就不做断言（只出数字），一旦它自己抛错，
    // 表现是「压测数字凭空消失、退出码仍是 0」。本轮曾出现：生产代码新起的 logWarn 需要
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
    // ⚠️ 判失败而不是只打印：这一块本来只出数字，但它自己的异常曾把「探针坏掉」伪装成
    // 「探针没输出」，退出码仍是 0。与上面渲染压测块同一口径。
    console.error('单击探针出错（这是失败，不是跳过）：', error && error.stack);
    process.exit(1);
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
    // ⚠️ 同上：探针自己出错必须是失败。否则「打字性能数字不见了」会被当成没跑到。
    console.error('打字探针出错（这是失败，不是跳过）：', error && error.stack);
    process.exit(1);
  }
}



// ------------------------------------------------ 路径显示方式（省略几层 / 完整 / 锚点）
//
// 需求来自真实场景：一个目录下并列很多 mods / group，每个 mods 下又有同名文件，
// 只显示末尾几层无法区分是哪个 mods。这里把三种口径都钉住，并做**跨侧等值**检查 ——
// 宿主（估宽）与 webview（渲染）各有一份同样的逻辑，一旦漂移，列宽就会与文字对不上。
{
  const layoutApi = extensionBundle.__layout;
  assert(
    typeof layoutApi.displayPathText === 'function',
    '产物没有导出 __layout.displayPathText，跨侧一致性无法验证'
  );

  // ⚠️ 歧义只在「区分用的那一段落到了预算窗口之外」时才出现：短路径（33 字符）整体放得下、
  // 本来就能区分，所以这里**必须用足够深的路径**才能复现用户报的场景。
  const GROUP_A = 'components/LIB/group_a/src/modules/display/sub/sub_main.c';
  const GROUP_B = 'components/LIB/group_b/src/modules/display/sub/sub_main.c';
  const GROUP_A_SHORT = 'components/LIB/group_a/src/main.c';
  const GROUP_B_SHORT = 'components/LIB/group_b/src/main.c';
  const DEEP = 'src/modules/display/driver/sub/sub_main.c';
  const SHORT = 'main/main.c';
  // 目录名里带连字符：用来钉住「整串名字优先于偏移解析」这条规则
  const HYPHEN = 'components/LIB/lib-2/main.c';
  // 同一个目录名出现两次、且**两次都不在末尾窗口里**：用来钉住后缀 `*`（全命中）这条规则
  const REPEATED = 'x/se/mid/se/mid2/z.c';
  const paths = [GROUP_A, GROUP_B, DEEP, SHORT, GROUP_A_SHORT, GROUP_B_SHORT, HYPHEN, REPEATED];
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

  /**
   * 把当前设置下的图发下去，并取回每个节点方框里那行「路径:行号」。
   *
   * ⚠️ 锚点条目必须**照着宿主真实下发的形态**喂给面板：`settingsPayload()` 会先把
   * 「方括号项去掉、圆括号剥壳」（见 `__layout.pathOnlyAnchorPatterns`）。测试里直接塞原文
   * 就不是在测真实链路了 —— 而宿主那一侧的期望值仍然按**原文**算，两边必须一致。
   */
  const renderWith = (settings) => {
    const payload = { ...settings };
    if (Array.isArray(payload.pathAnchors)) {
      payload.pathAnchors = layoutApi.pathOnlyAnchorPatterns(payload.pathAnchors);
    }
    sendToWebview({ type: 'settings', settings: { showLocation: true, ...payload } });
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

  /** 同一份设置给宿主函数与 webview 各算一次，逐条比对（跨侧漂移就会红）。 */
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
    readDefault('pd2') === `…/modules/display/driver/sub/sub_main.c:3`,
    `默认口径应当与 0.20 一致（40 字符内尽量多留末尾段），实际「${readDefault('pd2')}」`
  );
  assert(readDefault('pd3') === 'main/main.c:4', `短路径应当原样显示，实际「${readDefault('pd3')}」`);
  // 用户报的场景：深路径下两个 group 的同名文件**完全无法区分**（只差行号）
  const pathPart = (text) => text.replace(/:\d+$/, '');
  assert(
    pathPart(readDefault('pd0')) === pathPart(readDefault('pd1')),
    `默认口径下两条 group 路径应当长得一样（这正是要解决的问题），实际「${readDefault('pd0')}」「${readDefault('pd1')}」`
  );

  // ② 只在末尾留 2 层：仍是同名，形状变成 `…/sub/sub_main.c`
  const tailTwo = { ...defaultOptions, tailLevels: 2 };
  const readTail = assertCrossSide(tailTwo, '末尾 2 层');
  const sampleTail = readTail('pd0');
  assert(
    readTail('pd0') === '…/sub/sub_main.c:1' && pathPart(readTail('pd0')) === pathPart(readTail('pd1')),
    `末尾 2 层应当显示成「…/sub/sub_main.c:1」且两条仍相同，实际「${readTail('pd0')}」「${readTail('pd1')}」`
  );

  // ③ 纯偏移锚点：`+3` = 从根数第 3 段（group_a / group_b 就在第 3 段）→ 两条终于分得开
  const byLevel = { ...tailTwo, anchors: ['+3'] };
  const readLevel = assertCrossSide(byLevel, '锚点 +3');
  const sampleLevel = readLevel('pd0');
  assert(
    readLevel('pd0') === '…/group_a/…/sub/sub_main.c:1',
    `锚点 +3 应当显示成「…/group_a/…/sub/sub_main.c:1」，实际「${readLevel('pd0')}」`
  );
  assert(
    readLevel('pd1') === '…/group_b/…/sub/sub_main.c:2',
    `另一条应当显示成「…/group_b/…/sub/sub_main.c:2」，实际「${readLevel('pd1')}」`
  );

  // ④ 名字锚点：`LIB` 保留该段本身
  const byName = { ...tailTwo, anchors: ['LIB'] };
  const readName = assertCrossSide(byName, '名字锚点 LIB');
  const sampleName = readName('pd0');
  assert(
    readName('pd0') === '…/LIB/…/sub/sub_main.c:1',
    `名字锚点应当显示成「…/LIB/…/sub/sub_main.c:1」，实际「${readName('pd0')}」`
  );

  // ④·一 带括号的锚点（用户 2026-10-15 定的两种括号语义）：**这是 F0 的回归用例** ——
  // 宿主下发前会把圆括号剥壳、把方括号去掉，面板拿到的是剥过的那份，两侧文字必须逐字一致。
  // 早期只有宿主单侧做预处理，面板把 `(LIB)` 当字面段名 → 同一路径两侧文字不同
  // （webview 少了那一段、宿主多了那一段），下面这两条断言当时就会红。
  {
    const roundAnchors = { ...tailTwo, anchors: ['(LIB)'] };
    const readRound = assertCrossSide(roundAnchors, '圆括号锚点 (LIB)');
    assert(
      readRound('pd0') === '…/LIB/…/sub/sub_main.c:1',
      `圆括号条目「两处都要」：路径那行必须保留 LIB，实际「${readRound('pd0')}」`
    );
  }
  {
    const squareAnchors = { ...tailTwo, anchors: ['[LIB]'] };
    const readSquare = assertCrossSide(squareAnchors, '方括号锚点 [LIB]');
    const readNone = assertCrossSide({ ...tailTwo, anchors: [] }, '无锚点（对照组）');
    assert(
      pathPart(readSquare('pd0')) === pathPart(readNone('pd0')),
      `方括号条目只当标签：路径那行必须与无锚点逐字相同，实际「${readSquare('pd0')}」vs「${readNone(
        'pd0'
      )}」`
    );
  }

  // ④·二 上下文限定锚点（用户 2026-10-14 的消歧场景）：`group_a/src` 只在**紧跟在 group_a
  // 之后**的 `src` 上命中，两条 group 路径因此不再互相干扰；以 `/` 开头则要求从工作区根开始。
  // ⚠️ 这一条同时是 webview 那份 `resolveAnchorIndexes` 副本的**跨侧等值**检查 ——
  // 两份实现必须逐字同规则，否则这里会红。
  const byContext = { ...tailTwo, anchors: ['group_a/src'] };
  const readContext = assertCrossSide(byContext, '上下文锚点 group_a/src');
  assert(
    readContext('pd0') === '…/src/…/sub/sub_main.c:1',
    `上下文锚点应当命中 src 那一段（…/src/…/sub/sub_main.c:1），实际「${readContext('pd0')}」`
  );
  assert(
    readContext('pd1') === '…/sub/sub_main.c:2',
    `另一条不含「group_a/src」这个连续片段，不应当被锚点影响，实际「${readContext('pd1')}」`
  );
  const byRootContext = { ...tailTwo, anchors: ['/components/LIB/group_a'] };
  const readRootContext = assertCrossSide(byRootContext, '上下文锚点 /components/LIB/group_a');
  assert(
    readRootContext('pd0') === '…/group_a/…/sub/sub_main.c:1',
    `以 / 开头的上下文应当从工作区根开始匹配（…/group_a/…），实际「${readRootContext('pd0')}」`
  );
  assert(
    readRootContext('pd1') === '…/sub/sub_main.c:2',
    `group_b 那条不该被 /components/LIB/group_a 命中，实际「${readRootContext('pd1')}」`
  );

  // ④·三 前缀 `all:` = 该模式的**所有**命中（用户 2026-10-14：「可以匹配上所有的这个名字」）；
  // 段匹配器支持 `*` / `?` 通配与 `a|b` 多选（第一档语法）。
  // 夹具里 `x/se/mid/se/mid2/z.c` 有两个 `se`，`all:se` 两条都保留、`se` 只保留一条。
  // ⚠️ 窗口必须只留 1 层：留 2 层时末尾窗口本身就含第二个 `se`，两种写法看起来一样，
  // 断言就没有区分度了（第一版就是这么写的，对照组直接红）。
  // ⚠️ 同样走 assertCrossSide：webview 与宿主各有一份 `resolveAnchorIndexes`，漂移就会红。
  const byAll = { ...tailTwo, tailLevels: 1, anchors: ['all:se'] };
  const readAll = assertCrossSide(byAll, '全命中锚点 all:se');
  const repeatedText = readAll('pd7');
  assert(
    (repeatedText.match(/se/g) ?? []).length === 2,
    `all:se 应当把两个 se 都保留下来，实际「${repeatedText}」`
  );
  // 对照组：不写 `all:` 时只保留一个（否则「全命中」这条规则等于没有区分度）
  const byOne = { ...tailTwo, tailLevels: 1, anchors: ['se'] };
  const readOne = assertCrossSide(byOne, '单命中锚点 se');
  assert(
    (readOne('pd7').match(/se/g) ?? []).length === 1,
    `不写 all: 时只应保留一个 se，实际「${readOne('pd7')}」`
  );
  // 通配：`group_*` 在两条板子路径上各命中自己的那一段（跨侧等值 + 具体段名都钉住）
  const byGlob = { ...tailTwo, tailLevels: 1, anchors: ['group_*'] };
  const readGlob = assertCrossSide(byGlob, '通配锚点 group_*');
  assert(
    readGlob('pd0').includes('group_a') && readGlob('pd1').includes('group_b'),
    `group_* 应当分别命中 group_a 与 group_b，实际「${readGlob('pd0')}」「${readGlob('pd1')}」`
  );
  // 第三档语法同样跨侧等值：`**`（任意层）、`re:`（正则）、`!`（排除）
  const byAnyDepth = { ...tailTwo, tailLevels: 1, anchors: ['**/sub'] };
  const readAnyDepth = assertCrossSide(byAnyDepth, '任意层锚点（两层星号后接 sub）');
  assert(
    readAnyDepth('pd0').includes('sub'),
    `任意层写法应当命中 sub，实际「${readAnyDepth('pd0')}」`
  );
  const byRegex = { ...tailTwo, tailLevels: 1, anchors: ['re:^group_[ab]$'] };
  const readRegex = assertCrossSide(byRegex, '正则锚点 re:^group_[ab]$');
  assert(
    readRegex('pd0').includes('group_a') && readRegex('pd1').includes('group_b'),
    `正则应当分别命中 group_a 与 group_b，实际「${readRegex('pd0')}」「${readRegex('pd1')}」`
  );
  const byExclude = { ...tailTwo, tailLevels: 1, anchors: ['!group_b', 'group_*'] };
  const readExclude = assertCrossSide(byExclude, '排除锚点 !group_b');
  assert(
    readExclude('pd0').includes('group_a'),
    `未被排除的那条应当照常命中，实际「${readExclude('pd0')}」`
  );
  assert(
    !readExclude('pd1').includes('group_b'),
    `被 ! 排除的那条不得再保留锚点段，实际「${readExclude('pd1')}」`
  );

  // ⑤ 相对偏移且**基准段不显示**：`LIB+1` 只保留下一级（group_a），正是「只显示偏移出来的目录」
  const byOffset = { ...tailTwo, anchors: ['LIB+1'] };
  const readOffset = assertCrossSide(byOffset, '锚点 LIB+1（基准不显示）');
  const sampleOffset = readOffset('pd0');
  assert(
    readOffset('pd0') === '…/group_a/…/sub/sub_main.c:1',
    `LIB+1 应当只显示偏移出来的那一段（…/group_a/…），实际「${readOffset('pd0')}」`
  );
  assert(
    readOffset('pd1') === '…/group_b/…/sub/sub_main.c:2',
    `另一条应当是 group_b，实际「${readOffset('pd1')}」`
  );

  // ⑥ 多层组合：基准与偏移各单列一条 → 两者都显示，且相邻段连在一起（中间不加省略号）
  const combined = { ...tailTwo, anchors: ['LIB', 'LIB+1'] };
  const readCombined = assertCrossSide(combined, '锚点 LIB + LIB+1');
  const sampleCombined = readCombined('pd0');
  assert(
    readCombined('pd0') === '…/LIB/group_a/…/sub/sub_main.c:1',
    `组合锚点应当显示成「…/LIB/group_a/…/sub/sub_main.c:1」，实际「${readCombined('pd0')}」`
  );

  // ⑦ 从文件名往上数：`-1` = 文件所在目录
  const byTail = { ...tailTwo, anchors: ['-1'] };
  const readTailAnchor = assertCrossSide(byTail, '锚点 -1');
  assert(
    readTailAnchor('pd0') === '…/sub/sub_main.c:1',
    `-1 应当取到文件所在目录，实际「${readTailAnchor('pd0')}」`
  );

  // ⑧ 目录名本身带 `-` 时不能被当成偏移（解析顺序：整串名字优先）
  const hyphen = { ...defaultOptions, tailLevels: 1, anchors: ['lib-2'] };
  const readHyphen = assertCrossSide(hyphen, '锚点 lib-2（含连字符的目录名）');
  const sampleHyphen = readHyphen('pd6');
  assert(
    readHyphen('pd6') === '…/lib-2/main.c:7',
    `含连字符的目录名应当被整串匹配，实际「${readHyphen('pd6')}」`
  );

  // ⑨ 完整显示：放得下就给整条路径（两条 group 路径自然也能区分）
  const fullMode = { ...defaultOptions, mode: 'full' };
  const readFull = assertCrossSide(fullMode, '完整显示');
  const sampleFull = readFull('pd4');
  assert(
    readFull('pd4') === `${GROUP_A_SHORT}:5`,
    `放得下的路径应当整条显示，实际「${readFull('pd4')}」`
  );
  assert(
    readFull('pd4') !== readFull('pd5'),
    `完整显示下两条短 group 路径必须不同，实际「${readFull('pd4')}」「${readFull('pd5')}」`
  );
  // 放不下的长路径：保留首尾（含文件名）且不超长 —— 完整路径的承诺由**悬停提示**兜底
  assert(
    readFull('pd2').length <= 45 && readFull('pd2').includes('sub_main.c'),
    `放不下的长路径应当保留首尾（含文件名）且不超长，实际「${readFull('pd2')}」`
  );
  {
    const group = nodesGroup.children.find((child) => child.getAttribute('data-node') === 'pd0');
    const tip = group?.children.find((child) => child.tagName === 'title');
    assert(
      String(tip?.textContent ?? '').includes(GROUP_A),
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

// ------------------------------------------------ 不截断 + 省略标记（0.22 需求）
//
// 需求原话：① 超长函数名/变量名不得从中间省略，路径要显示全部时也要完整显示，
// 方框要动态加宽容纳；② 因 maxChildrenPerNode 被省略的条数不能只在悬停里说，
// 要在方框上给个醒目的标记（小圆点 + +N）。
{
  const LONG_NAME = 'veryLongFunctionNameThatWouldHaveBeenMiddleTruncatedBefore_1234567890';
  const SHORT_NAME = 'f';
  const FULL_PATH = 'components/LIB/group_a/src/modules/display/sub/deep/deeper/sub_main.c';
  const nodes = {
    ln: {
      id: 'ln',
      name: LONG_NAME,
      file: FULL_PATH,
      line: 7,
      direction: 'callers',
      depth: 1,
      isCycle: false,
      children: [],
      parent: 'nr',
      loaded: true,
      kind: 'function',
      omitted: 7,
      // 其中 4 条是「节点总数上限」造成的：悬停必须把两种原因分开写，
      // 只说「另有 7 条未显示」用户不知道该调 maxChildrenPerNode 还是 maxLayoutNodes。
      omittedByNodeCap: 4,
    },
    sn: {
      id: 'sn',
      name: SHORT_NAME,
      file: FULL_PATH,
      line: 8,
      direction: 'callers',
      depth: 1,
      isCycle: false,
      children: [],
      parent: 'nr',
      loaded: true,
      kind: 'function',
    },
    nr: {
      id: 'nr',
      name: 'root',
      file: 'r.c',
      line: 1,
      direction: 'callers',
      depth: 0,
      isCycle: false,
      children: ['ln', 'sn'],
      loaded: true,
      kind: 'function',
    },
  };
  const groupOf = (id) =>
    nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  const textOf = (id, cls) => {
    const node = groupOf(id)?.children.find((child) => child.getAttribute('class') === cls);
    return String(node?.textContent ?? '');
  };
  /** 省略标记的元素嵌在 <g class="omitted-mark"> 里，所以要往下找一层。 */
  const findIn = (id, cls) => {
    const group = groupOf(id);
    if (!group) {
      return undefined;
    }
    for (const child of group.children) {
      if (child.getAttribute('class') === cls) {
        return child;
      }
      for (const grand of child.children ?? []) {
        if (grand.getAttribute('class') === cls) {
          return grand;
        }
      }
    }
    return undefined;
  };
  const boxWidthOf = (id) => {
    const rect = groupOf(id)?.children.find((child) => child.getAttribute('class') === 'box');
    return Number(rect?.getAttribute('width') ?? 0);
  };
  const renderNoTruncate = (settings) => {
    sendToWebview({ type: 'settings', settings: { showLocation: true, ...settings } });
    const boxes = createLayout(nodes, 'nr').boxes;
    sendToWebview({
      type: 'sessionUpdate',
      session: {
        id: 'no-truncate',
        title: '不截断',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'nr',
        nodes,
        edges: [],
        boxes,
        collapsedCount: 0,
      },
    });
  };

  renderNoTruncate({ pathDisplay: 'full', pathTailLevels: 0, pathAnchors: '' });
  const longName = textOf('ln', 'name');
  assert(
    longName === LONG_NAME,
    `超长名称必须完整显示，实际「${longName}」（长度 ${longName.length}）`
  );
  assert(!longName.includes('…'), '名称里出现了省略号 —— 中间截断是不允许的');
  const longLoc = textOf('ln', 'loc');
  assert(
    longLoc === `${FULL_PATH}:7`,
    `full 模式必须显示整条路径，实际「${longLoc}」`
  );
  const wideBox = boxWidthOf('ln');
  const narrowBox = boxWidthOf('sn');
  assert(
    wideBox > narrowBox,
    `长名称的方框应当更宽：长名 ${wideBox}px vs 短名 ${narrowBox}px —— 说明宽度没跟着文字长`
  );

  // 关掉文件名：那行只显示目录部分，行号仍在、文件名不再出现
  renderNoTruncate({
    pathDisplay: 'full',
    pathTailLevels: 0,
    pathShowFileName: false,
    pathAnchors: '',
  });
  const noNameLoc = textOf('ln', 'loc');
  assert(
    !noNameLoc.includes('sub_main.c'),
    `关掉文件名后不该再出现文件名，实际「${noNameLoc}」`
  );
  assert(noNameLoc.endsWith(':7'), `关掉文件名后行号必须仍在，实际「${noNameLoc}」`);
  renderNoTruncate({ pathDisplay: 'full', pathTailLevels: 0, pathAnchors: '' });

  // 省略标记：有 omitted 的方框要有小圆点 + +N，没有的不能有
  // 用户 2026-10-14 明确要求：**去掉**「小圆点 + 数字」那套省略标记，只保留到上限时的警示环。
  // 所以这里反向断言：任何方框上都不该再出现 omitted-count / omitted-dot。
  assert(
    findIn('ln', 'omitted-count') === undefined && findIn('ln', 'omitted-dot') === undefined,
    '数字 + 小圆点的省略标记已被要求删除，方框上不该再出现'
  );
  assert(
    findIn('sn', 'omitted-count') === undefined && findIn('sn', 'omitted-dot') === undefined,
    '任何方框都不该出现 +N 标记（该标记已删除）'
  );
  // 悬停里两种省略原因必须分开写（合并成一个数字等于没告诉用户该调哪个设置）
  const tipText = String(
    groupOf('ln')?.children.find((child) => child.tagName === 'title')?.textContent ?? ''
  );
  assert(
    tipText.includes('受 maxChildrenPerNode 限制'),
    `悬停里应当写明 maxChildrenPerNode 造成的条数，实际「${tipText}」`
  );
  assert(
    tipText.includes('maxLayoutNodes'),
    `悬停里应当写明节点总数上限造成的条数，实际「${tipText}」`
  );
  assert(
    tipText.includes('3 条') && tipText.includes('4 条'),
    `两种原因各自的条数应当是 3 与 4，实际「${tipText}」`
  );
  log(
    `诊断: 不截断与省略标记 —— 长名 ${longName.length} 字完整显示（方框 ${wideBox}px vs 短名 ${narrowBox}px），` +
      `数字标记已按用户要求删除（方框上只剩到上限时的警示环），悬停仍分列两种原因`
  );
  console.log('OK: 名称/路径不截断（方框按文字加宽），数字省略标记已删除、悬停仍区分原因');
}

// ------------------------------------------------ 相机：展开/收起后的滚动（0.22 需求 2/3/4）
//
// ① 收起某级后把它滚到视口垂直中央；② 右边缘再展开时内容整体左移、完整露出新一级；
// ③ 新一级比视口还宽（极端长）时以「被展开的那一级」为最左基准；
// ④ 收起时横向回到展开前的位置（展开的逆过程）。
//
// 走**真实交互路径**：点加减号（mousedown + window mouseup）→ 宿主回一帧新坐标 →
// 相机动作正是在那一帧执行。断言值全部按 `createLayout` 算出的真实坐标推导，不写死像素。
{
  // ⚠️ children / loaded 必须给默认值：少传一个参数会让 createLayout 拿到 undefined 去迭代
  const node = (id, depth, parent, children = [], loaded = false, name) => ({
    id,
    name: name ?? id,
    file: `${id}.c`,
    line: depth + 1,
    direction: 'callers',
    depth,
    isCycle: false,
    children,
    parent,
    loaded,
    // ⚠️ webview 靠 `canExpand` 决定加减号模式，夹具漏了它就会渲染成叶子（点了什么都不发）
    canExpand: loaded ? children.length > 0 : true,
    kind: 'function',
  });
  const base = {
    r: node('r', 0, undefined, ['a', 'b', 'c'], true),
    a: node('a', 1, 'r', [], false),
    b: node('b', 1, 'r', [], false),
    c: node('c', 1, 'r', [], false),
  };
  // ① a 展开后的那一帧（b、c 仍未加载，供后面两次点击使用）
  const levelA = {
    ...base,
    a: node('a', 1, 'r', ['a1', 'a2', 'a3'], true),
    a1: node('a1', 2, 'a'),
    a2: node('a2', 2, 'a'),
    a3: node('a3', 2, 'a'),
  };
  // ② c 的新一级里放一个**极端长**的名字：新一级整体宽过视口，走「以最左为基准」那条分支
  const levelC = {
    ...levelA,
    c: node('c', 1, 'r', ['c1'], true),
    c1: node('c1', 2, 'c', [], true, 'b'.repeat(120)),
  };
  // ③ c 收起后的那一帧（c 仍在图上，只是没有子框）
  const collapsedC = {
    ...levelC,
    c: node('c', 1, 'r', [], true),
  };
  const sessionOf = (nodes) => {
    const boxes = createLayout(nodes, 'r').boxes;
    return {
      boxes,
      message: {
        type: 'sessionUpdate',
        session: {
          id: 'camera',
          title: '相机',
          description: '',
          direction: 'callers',
          engineLabel: 'clangd',
          rootId: 'r',
          nodes,
          edges: [],
          boxes,
          collapsedCount: 0,
        },
      },
    };
  };
  const groupOfId = (id) =>
    nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  /** 把 `atCapacity` 状态发下去并读回两个展开按钮与提示行的状态。 */
  const capacityStateOf = (atCapacity, limit) => {
    const built = sessionOf(base);
    built.message.session.atCapacity = atCapacity;
    built.message.session.maxLayoutNodes = limit;
    sendToWebview(built.message);
    const buttonOf = (id) => byId.get(id);
    return {
      allDisabled: buttonOf('btn-expand-all').disabled === true,
      fullDisabled: buttonOf('btn-expand-full').disabled === true,
      allTitle: String(buttonOf('btn-expand-all').title ?? ''),
      fullTitle: String(buttonOf('btn-expand-full').title ?? ''),
      hintText: String(byId.get('capacity-hint').textContent ?? ''),
      hintHidden: byId.get('capacity-hint').hidden === true,
    };
  };
  const clickExpanderOf = (id, mode) => {
    const expander = groupOfId(id)?.children.find((child) =>
      String(child.getAttribute('class') || '').startsWith('expander')
    );
    assert(expander !== undefined, `${id} 应当有加减号`);
    const classes = String(expander.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean);
    // ⚠️ 必须按**词**比对：类名里含 `expander`，用 includes('expand') 会被前缀骗过
    assert(
      classes.includes(mode),
      `${id} 的加减号应为 ${mode}，实际 ${classes.join(' ')}`
    );
    expander.dispatch('mousedown', { stopPropagation() {}, preventDefault() {} });
    for (const handler of windowListeners.mouseup ?? []) {
      handler({});
    }
  };

  sendToWebview({ type: 'settings', settings: { stickyParent: false, showLocation: true } });
  const VIEW_H = 200;
  canvasEl.clientHeight = VIEW_H;
  canvasEl.clientWidth = 99999; // 先给个大视口，第一帧不做任何横向调整
  canvasEl.scrollTop = 0;
  canvasEl.scrollLeft = 0;
  sendToWebview(sessionOf(base).message);

  // ② 右边缘：视口刚好容得下新一级（宽 + 24），但它在视口右侧
  clickExpanderOf('a', 'expand');
  assert(
    posted.some((message) => message.type === 'expand' && message.nodeId === 'a'),
    `点开 a 应当向宿主请求展开 a，实际发了 ${JSON.stringify(posted.map((m) => m.type))}`
  );
  const aLayout = sessionOf(levelA);
  const level = levelA.a.children.map((id) => aLayout.boxes[id]);
  const levelLeft = Math.min(...level.map((box) => box.x));
  const levelRight = Math.max(...level.map((box) => box.x + box.width));
  const levelWidth = levelRight - levelLeft;
  canvasEl.clientWidth = Math.ceil(levelWidth + 24);
  sendToWebview(aLayout.message);
  const expectedRight = Math.max(0, levelRight + 12 - canvasEl.clientWidth);
  assert(
    canvasEl.scrollLeft === expectedRight,
    `右边缘展开后应当左移到 ${expectedRight}，实际 ${canvasEl.scrollLeft}` +
      `（新一级 ${levelLeft}~${levelRight}，视口宽 ${canvasEl.clientWidth}）`
  );

  // ③ 极端宽：视口比新一级还窄 → 以被展开的那一级为最左基准
  canvasEl.scrollLeft = 0;
  clickExpanderOf('c', 'expand');
  canvasEl.clientWidth = 50;
  const cLayout = sessionOf(levelC);
  const cBox = cLayout.boxes.c;
  sendToWebview(cLayout.message);
  const expectedExtreme = Math.max(0, cBox.x - 12);
  assert(
    canvasEl.scrollLeft === expectedExtreme,
    `新一级比视口宽时应以被展开的方框为最左基准 ${expectedExtreme}，实际 ${canvasEl.scrollLeft}`
  );

  // ④ 收起：被收起的那一级在屏幕上**原地不动**（内容消失但视线不丢），位移用平滑滚动
  const beforeLeft = canvasEl.scrollLeft;
  const beforeTop = canvasEl.scrollTop;
  clickExpanderOf('c', 'collapse');
  const collapsedLayout = sessionOf(collapsedC);
  canvasEl.clientHeight = VIEW_H;
  sendToWebview(collapsedLayout.message);
  const collapsedBox = collapsedLayout.boxes.c;
  const screenBefore = { x: cBox.x - beforeLeft, y: cBox.y - beforeTop };
  const screenAfter = { x: collapsedBox.x - canvasEl.scrollLeft, y: collapsedBox.y - canvasEl.scrollTop };
  assert(
    Math.abs(screenBefore.x - screenAfter.x) < 0.5,
    `收起后该方框的屏幕横向位置变了：${screenBefore.x.toFixed(1)} → ${screenAfter.x.toFixed(1)}`
  );
  // 纵向按用户要求**居中**（只锁位置时，同级还有别的方框就会停在半空、看着像偏移）
  // ⚠️ 行为变更（2026-10-14 用户反馈「折叠的时候本标签还会弹一下」）：折叠**不再移动视口**，
  // 与 0.21.0 一致 —— 位置交给粘性逻辑，折叠本身不滚动。所以这里断言「视口未被改动」，
  // 而不是断言「垂直居中」（那是被否掉的旧行为）。
  assert(
    canvasEl.scrollTop === beforeTop,
    `折叠不该改动视口滚动位置（折叠前 ${beforeTop}，折叠后 ${canvasEl.scrollTop}）` +
      `—— 收敛时的瞬时跳动即由该改动引起`
  );
  log(
    `诊断: 相机 —— 右边缘展开左移到 ${expectedRight}、极端宽按最左 ${expectedExtreme}、` +
      `收起不改动视口（scrollTop 保持 ${beforeTop}）`
  );
  console.log('OK: 展开/收起的滚动行为（最小位移显露、极端宽锚父框、收起不动视口）');
}

// ------------------------------------------------ 节点总数上限：按钮禁用 + 提示行（D）
// 用户反馈「到上限后再点展开、完全展开都没用」：那时两个按钮必然无效（画不下的节点没有方框），
// 却不给任何反馈。现在的约定是**禁用 + 写明原因与两条出路**，所以两侧都要断言。
{
  // ⚠️ 这里刻意自建最小夹具：相机的 `sessionOf` / `node` 是那一段的局部作用域，跨块取不到
  // （第一版就踩了这个，报 `sessionOf is not defined`）。这条用例只需要一个能通过渲染的最小会话。
  const nodes = {
    r: {
      id: 'r',
      name: 'r',
      file: 'a.c',
      line: 1,
      direction: 'callers',
      depth: 0,
      isCycle: false,
      children: [],
      loaded: false,
      kind: 'function',
      // 方案 A：到上限且仍有下一层可展开 → 方框上要有**不带数字**的警示环 + 悬停说明原因
      cappedExpandable: true,
    },
  };
  const boxes = { r: { x: 0, y: 0, width: 230, height: 43 } };
  const apply = (atCapacity, limit) => {
    sendToWebview({
      type: 'sessionUpdate',
      session: {
        id: 'capacity',
        title: '上限',
        description: '',
        direction: 'callers',
        engineLabel: 'clangd',
        rootId: 'r',
        nodes,
        edges: [],
        boxes,
        collapsedCount: 0,
        atCapacity,
        maxLayoutNodes: limit,
      },
    });
    return {
      button: (id) => byId.get(id),
      hint: byId.get('capacity-hint'),
    };
  };

  const capped = apply(true, 800);
  assert(
    capped.button('btn-expand-all').disabled === true,
    '到上限时「展开全部」应当置为禁用态'
  );
  assert(
    capped.button('btn-expand-full').disabled === true,
    '到上限时「完全展开」应当置为禁用态'
  );
  const cappedTitle = String(capped.button('btn-expand-all').title ?? '');
  assert(
    cappedTitle.includes('800') && cappedTitle.includes('maxLayoutNodes'),
    `禁用的按钮必须写明原因与具体上限，实际「${cappedTitle}」`
  );
  assert(
    cappedTitle.includes('收起'),
    `提示里应当给出另一条出路（先收起部分分支），实际「${cappedTitle}」`
  );
  const hintText = String(capped.hint.textContent ?? '');
  assert(
    hintText.includes('800') && hintText.includes('maxLayoutNodes'),
    `面板内提示行应当写明上限与设置名，实际「${hintText}」`
  );
  assert(capped.hint.hidden !== true, '到上限时提示行必须显示');

  const normal = apply(false, 800);
  assert(
    normal.button('btn-expand-all').disabled !== true &&
      normal.button('btn-expand-full').disabled !== true,
    '未到上限时两个展开按钮必须可用'
  );
  assert(
    String(normal.button('btn-expand-all').title ?? '').includes('maxExpandRounds'),
    '未到上限时按钮说明应当恢复为默认文案'
  );
  assert(normal.hint.hidden === true, '未到上限时提示行必须隐藏');
  // 方案 A（用户 2026-10-14 选定）：每个「仍有下一层可展开」的方框自己在**到上限时**要有标记，
  // 而且**不写数字**（那些子节点从未取过，条数未知，编一个数字就是撒谎）。
  {
    const cappedNode = nodesGroup.children.find(
      (child) => child.getAttribute('data-node') === 'r'
    );
    assert(cappedNode !== undefined, '上限用例里找不到方框 r');
    const hasRing = cappedNode.children.some((child) =>
      (child.children ?? []).some((grand) => grand.getAttribute('class') === 'capped-ring')
    );
    assert(hasRing, '到上限且仍有下一层可展开时，方框上应当有不带数字的警示环（capped-ring）');
    const capTip = String(
      cappedNode.children.find((child) => child.tagName === 'title')?.textContent ?? ''
    );
    assert(
      capTip.includes('节点总数上限'),
      `这类方框的悬停必须说明原因（节点总数上限），实际「${capTip}」`
    );
    assert(
      !capTip.includes('条未显示'),
      `数量未知时不得编造条数，实际「${capTip}」`
    );
  }
  console.log(
    `诊断: 上限反馈 —— 到上限时两按钮禁用且 title 含「800 / maxLayoutNodes / 收起」，` +
      `提示行显示；未到上限时按钮可用、提示行隐藏`
  );
  console.log('OK: 节点总数上限有明确反馈（按钮禁用 + 原因 + 两条出路 + 面板内提示行）');
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

  // 反向守卫：relayout（把非活动会话重新下发一次）绝不能把活动标签抢走 ——
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

// ------------------------------------------------ 没有活动标签时导出必须出声（不许静默）
//
// 历史缺陷：导出菜单的处理在 `activeSession()` 为 undefined 时直接 `return` ——
// 点了菜单项什么都不发生、也不报告，用户会以为扩展坏了。
// 这里放一个**没有活动标签**的帧，真的点一次菜单项，断言发出的是 error 消息。
//
// ⚠️ 必须放在最后：这条用例会把标签全部关掉（`update` 空列表），之后画布就是空状态。
// 1300ms 覆盖掉前面所有异步小节（最晚的是 900ms 那条）。
{
  setTimeout(() => {
    // 先确认这一刻**确实**没有活动标签：清空标签表后 activeSession() 应当为 undefined。
    sendToWebview({ type: 'update', sessions: [], activeId: '' });
    assert(
      nodesGroup.children.length === 0,
      `清空标签后画布应当是空状态，实际仍有 ${nodesGroup.children.length} 个方框`
    );

    const exportMenu = byId.get('export-menu');
    const menuHandlers = exportMenu.listeners.get('click') ?? [];
    assert(menuHandlers.length >= 1, '导出菜单上没有注册 click 处理函数');
    const pngItem = exportMenu.children.find(
      (child) => child.getAttribute?.('data-format') === 'png'
    );
    assert(pngItem !== undefined, '桩里的导出菜单缺少 png 项');

    const before = posted.length;
    for (const handler of menuHandlers) {
      handler({ type: 'click', target: pngItem, preventDefault() {}, stopPropagation() {} });
    }
    const fresh = posted.slice(before);
    const failure = fresh.find((message) => message.type === 'error');
    assert(
      failure !== undefined,
      `没有活动标签时点导出菜单项必须发出 error（不许静默什么都不做），实际发了 ${
        fresh.map((message) => message.type).join(',') || '（无）'
      }`
    );
    assert(
      String(failure.message).includes('当前没有活动标签，无法导出'),
      `这条 error 应当说明「当前没有活动标签，无法导出」，实际「${failure.message}」`
    );
    assert(
      String(failure.message).includes('导出 png 失败'),
      `这条 error 应当与其它导出失败同一套文案（导出 <格式> 失败：…），实际「${failure.message}」`
    );
    log(`OK: 没有活动标签时点导出不静默 —— ${failure.message}`);
  }, 1300);
}

// ------------------------------------------------ 名称行路径标签（设置 nameFolderTag*）
//
// 三件事都要钉住：① 有标签时名称行由 tspan 组成（前/后各一段，文字逐字相等）；
// ② 没有标签时**不引入 tspan**（保持单个 textContent，DOM 与改动前一致）；
// ③ 标签在名称前面时搜索底纹必须右移标签那么宽（否则底纹会盖住标签、只压住名字的后半截）。
//
// 放在文件末尾：这一块会下发自己的会话（新会话会被认领为活动标签），
// 放中间会把后面那些有状态依赖的用例全部带偏。
{
  const mkNode = (id, name, depth, tag) => ({
    id,
    name,
    file: 'components/LIB/core/lib_core.c',
    line: 12,
    direction: 'callers',
    depth,
    isCycle: false,
    canExpand: false,
    children: [],
    loaded: true,
    kind: 'function',
    ...tag,
  });
  const tagNodes = {
    // ⚠️ 子节点必须挂在根的 `children` 里，否则 webview 认为它们不可见、根本不会渲染
    tagBefore: mkNode('tagBefore', 'fn_a', 0, {
      nameTagPrefix: '[LIB] → ',
      children: ['tagAfter', 'tagNone'],
    }),
    tagAfter: mkNode('tagAfter', 'fn_b', 1, { nameTagSuffix: ' (core)' }),
    tagNone: mkNode('tagNone', 'fn_c', 1, {}),
  };
  const tagBoxes = {
    tagBefore: { x: 0, y: 0, width: 320, height: NODE_HEIGHT },
    tagAfter: { x: 420, y: 0, width: 320, height: NODE_HEIGHT },
    tagNone: { x: 420, y: 90, width: 320, height: NODE_HEIGHT },
  };
  sendToWebview({ type: 'settings', settings: { stickyParent: false, showLocation: false } });
  sendToWebview({
    type: 'sessionUpdate',
    session: {
      id: 'name-tag-check',
      title: '名称行标签检查',
      description: '',
      direction: 'callers',
      engineLabel: 'clangd',
      rootId: 'tagBefore',
      nodes: tagNodes,
      edges: [],
      boxes: tagBoxes,
      collapsedCount: 0,
    },
  });
  flushFrames();

  const groupOf = (id) => nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  const childOf = (element, className) =>
    element === undefined
      ? undefined
      : element.children.find((child) => child.getAttribute('class') === className);
  const nameElOf = (id) => childOf(groupOf(id), 'name');

  const before = nameElOf('tagBefore');
  assert(before !== undefined, '名称行标签用例：找不到 tagBefore 的名称元素');
  const beforeTag = childOf(before, 'name-tag-before');
  const beforeName = childOf(before, 'name-text');
  assert(
    beforeTag !== undefined && beforeTag.textContent === '[LIB] → ',
    `前置标签必须逐字等于宿主给的文字，实际「${beforeTag?.textContent}」`
  );
  assert(
    beforeName !== undefined && beforeName.textContent === 'fn_a',
    `前置摆法下元素名仍要单独成段，实际「${beforeName?.textContent}」`
  );

  const after = nameElOf('tagAfter');
  const afterTag = childOf(after, 'name-tag-after');
  assert(
    afterTag !== undefined && afterTag.textContent === ' (core)',
    `后置标签必须逐字等于宿主给的文字，实际「${afterTag?.textContent}」`
  );
  assert(
    childOf(after, 'name-tag-before') === undefined,
    '后置摆法不得再出现前置标签（两段不可能同时有文字）'
  );

  const none = nameElOf('tagNone');
  assert(
    none !== undefined && none.textContent === 'fn_c',
    `没有标签时名称行必须保持单个 textContent，实际「${none?.textContent}」`
  );
  assert(
    (none?.children ?? []).length === 0,
    '没有标签时不得引入 tspan（DOM 结构与改动前保持一致）'
  );

  // 搜索底纹的横向偏移：查询词 `fn` 让三个方框都命中
  const searchInput = byId.get('search-input') ?? byId.get('searchInput');
  if (searchInput === undefined) {
    log('诊断: 名称行标签 —— 前置/后置/无标签三种情形通过；底纹偏移**未验证**（桩里找不到搜索输入框）');
  } else {
    searchInput.value = 'fn';
    searchInput.dispatch('input', {});
    flushFrames();
    const hitBefore = childOf(groupOf('tagBefore'), 'name-hit');
    const hitNone = childOf(groupOf('tagNone'), 'name-hit');
    assert(hitBefore !== undefined && hitNone !== undefined, '命中后应当出现 name-hit 底纹');
    assert(
      Number(hitBefore.getAttribute('x')) > Number(hitNone.getAttribute('x')),
      `标签在前时底纹必须右移标签那么宽：带标签 x=${hitBefore.getAttribute('x')} vs 不带 x=${hitNone.getAttribute('x')}`
    );
    log(
      `诊断: 名称行标签 —— 前置「[LIB] → 」/ 后置「 (core)」/ 无标签不引 tspan；` +
        `底纹 x ${hitNone.getAttribute('x')} → ${hitBefore.getAttribute('x')}`
    );
  }

  // 设置 → payload 这一段只有**源码级**依据：冒烟夹具的路径是单段（`demo.cpp`），
  // 任何锚点模式都不可能命中，所以「打开开关 → payload 真的带上标签」在现有夹具里
  // 构造不出端到端用例。如实记在这里，不要当成已覆盖（见开发记录 8.10）。
  const hostSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'views', 'graphView.ts'),
    'utf8'
  );
  assert(
    /nameFolderTag: config\.get<boolean>\('nameFolderTag', false\)/.test(hostSource) &&
      /nameFolderTagStyle/.test(hostSource) &&
      /nameFolderTagPick/.test(hostSource),
    '宿主必须真的读这三项设置（否则设置里点了没反应）'
  );
  assert(
    /nameTagPartsFor\(node\.file, pathOptions\)/.test(hostSource),
    'payload 里的标签文字必须用与布局同一份 pathOptions 生成（两处各读一次设置会让列宽与文字分叉）'
  );
  assert(
    /nameFolderTagStyle:\s*\n?\s*rawStyle === 'parenAfter'/.test(hostSource) &&
      /nameFolderTagPick: rawPick === 'deepest'/.test(hostSource),
    '非法取值必须退回默认（手改 settings.json 写错字不该让整行标签渲染成 undefined）'
  );
}

// ------------------------------------------------ 「收起全部 → 点第一级展开」必须一次生效
//
// 回归（用户 2026-10-15 实测「折叠按钮点击后，再点第一级展开要点两遍」）：
// 收起全部会把根标成「已收起」，而复位之后根是**未加载**的。旧的展开处理只在「数据已加载」
// 那条分支里清收起标记 —— 第一次点击发出请求、数据也回来了，但节点仍被当成收起，
// 新一级不显示，用户必须再点一次。这里的判据是：**一次点击**之后，宿主把数据送回来就要可见。
{
  const makeNode = (id, name, depth, children, loaded) => ({
    id,
    name,
    file: `${name}.c`,
    line: 1,
    direction: 'callers',
    depth,
    isCycle: false,
    canExpand: !loaded,
    children,
    loaded,
    kind: 'function',
  });
  const foldRoot = 'foldRoot';
  const foldChild = 'foldChild';
  const foldSession = (withChild) => ({
    id: 'fold-check',
    title: '折叠回归',
    description: '',
    direction: 'callers',
    engineLabel: 'clangd',
    rootId: foldRoot,
    nodes: withChild
      ? {
          [foldRoot]: makeNode(foldRoot, 'root', 0, [foldChild], true),
          [foldChild]: makeNode(foldChild, 'child', 1, [], true),
        }
      : { [foldRoot]: makeNode(foldRoot, 'root', 0, [], false) },
    edges: withChild ? [{ id: 'fold-edge', from: foldRoot, to: foldChild }] : [],
    boxes: withChild
      ? {
          [foldRoot]: { x: 0, y: 0, width: 300, height: NODE_HEIGHT },
          [foldChild]: { x: 420, y: 0, width: 300, height: NODE_HEIGHT },
        }
      : { [foldRoot]: { x: 0, y: 0, width: 300, height: NODE_HEIGHT } },
    collapsedCount: withChild ? 1 : 0,
  });
  const groupOfFold = (id) =>
    nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  const expanderOfFold = (id) =>
    groupOfFold(id)?.children.find((child) =>
      String(child.getAttribute('class') || '').startsWith('expander')
    );
  const clickExpander = (id, mode) => {
    const expander = expanderOfFold(id);
    assert(expander !== undefined, `${id} 应当有加减号`);
    assert(
      String(expander.getAttribute('class')).includes(mode),
      `${id} 的加减号应当是 ${mode}，实际 ${expander.getAttribute('class')}`
    );
    expander.dispatch('mousedown', { stopPropagation() {}, preventDefault() {} });
    for (const handler of windowListeners.mouseup ?? []) {
      handler({});
    }
  };

  sendToWebview({ type: 'settings', settings: { stickyParent: false, showLocation: false } });
  // ① 先给一帧「已展开」的图，让「收起全部」有东西可收
  sendToWebview({ type: 'sessionUpdate', session: foldSession(true) });
  flushFrames();
  // ② 点收起全部（前端会下发 collapse([根]) 与 resetExpansion）
  byId.get('btn-collapse-all').dispatch('click', {});
  flushFrames();
  // ③ 宿主复位后回一帧「只有根、未加载」的会话 —— 这正是复位后的真实状态
  sendToWebview({ type: 'sessionUpdate', session: foldSession(false) });
  flushFrames();

  posted.length = 0;
  clickExpander(foldRoot, 'expand');
  flushFrames();
  const afterClick = posted.filter((message) => message.type !== 'reportWidths');
  assert(
    afterClick.some((message) => message.type === 'expand' && message.nodeId === foldRoot),
    `第一次点第一级 + 必须发出 expand，实际 ${afterClick.map((m) => m.type).join(',') || '（无）'}`
  );
  const cleared = afterClick.find((message) => message.type === 'collapse');
  assert(
    cleared !== undefined && Array.isArray(cleared.collapsed) && cleared.collapsed.length === 0,
    `点 + 时必须把「已收起」标记清掉并同步宿主，实际 ${JSON.stringify(cleared && cleared.collapsed)}`
  );
  // ④ 宿主把第一级数据送回来：必须**立刻可见**（这才是「一次点击」的判据）
  sendToWebview({ type: 'sessionUpdate', session: foldSession(true) });
  flushFrames();
  assert(
    groupOfFold(foldChild) !== undefined,
    '数据回来后第一级必须立刻显示（不许要再点一次）—— 标记没清就会出现这个现象'
  );
  log('OK: 收起全部 → 点第一级 + 一次生效（收起标记随展开请求一起清除，数据回来立刻可见）');
}

// ------------------------------------------------ 搜索范围：显示的路径 / 完整路径（用户 2026-10-15）
//
// 两个开关分别把「方框里那行路径的**显示文本**」与「**完整路径**」纳入搜索：
//   - 「显示的路径」跟着 `pathDisplay` / `pathTailLevels` 走 —— 被省略掉的目录名**搜不到**；
//   - 「完整路径」不看显示设置，路径里任何一段都能搜到；
//   - 两个都关 = 只搜元素名（0.22 之前的行为，这里也作为回归基准）。
// 夹具刻意让两条口径分叉：`lib/deepdir/nested/target.c` 在「保留末尾 1 层」下显示成 `…/target.c`。
{
  const mkNode = (id, name, file, line, depth, children) => ({
    id,
    name,
    file,
    line,
    direction: 'callers',
    depth,
    isCycle: false,
    canExpand: false,
    children,
    loaded: true,
    kind: 'function',
  });
  const scopeNodes = {
    scopeRoot: mkNode('scopeRoot', 'root_fn', 'src/main.c', 1, 0, ['scopeDeep', 'scopeTop']),
    // 末段之前还有一个目录段在显示里被省略 —— 这正是「显示的路径」与「完整路径」的分界
    scopeDeep: mkNode('scopeDeep', 'deep_fn', 'lib/deepdir/nested/target.c', 7, 1, []),
    scopeTop: mkNode('scopeTop', 'shallow_fn', 'lib/top.c', 3, 1, []),
  };
  const scopeSession = {
    id: 'scope-check',
    title: '搜索范围检查',
    description: '',
    direction: 'callers',
    engineLabel: 'clangd',
    rootId: 'scopeRoot',
    nodes: scopeNodes,
    edges: [],
    boxes: {
      scopeRoot: { x: 0, y: 0, width: 260, height: NODE_HEIGHT },
      scopeDeep: { x: 340, y: 0, width: 260, height: NODE_HEIGHT },
      scopeTop: { x: 340, y: 70, width: 260, height: NODE_HEIGHT },
    },
    collapsedCount: 0,
  };

  sendToWebview({
    type: 'settings',
    settings: {
      stickyParent: false,
      showLocation: true,
      pathDisplay: 'tail',
      // 只保留末尾 1 层：显示成 `…/target.c`
      pathTailLevels: 1,
      pathShowFileName: true,
      pathAnchors: [],
    },
  });
  sendToWebview({ type: 'sessionUpdate', session: scopeSession });
  flushFrames();

  const classListOf = (el) => String(el.className).split(/\s+/).filter(Boolean);
  const matchedIds = () =>
    nodesGroup.children
      .filter((child) => classListOf(child).includes('match'))
      .map((child) => child.getAttribute('data-node'))
      .sort();
  const groupOfScope = (id) =>
    nodesGroup.children.find((child) => child.getAttribute('data-node') === id);
  const locTextOf = (id) =>
    groupOfScope(id)?.flatten().find((el) => classListOf(el).includes('loc'))?.textContent;

  // 前提：那一行**确实**没有目录名（否则下面的三条断言全都在验一件不存在的事）
  const deepLoc = locTextOf('scopeDeep');
  assert(
    typeof deepLoc === 'string' && deepLoc === '…/target.c:7',
    `夹具前提不成立：保留末尾 1 层时 scopeDeep 那行应当是「…/target.c:7」，实际「${deepLoc}」`
  );

  const scopeSearch = byId.get('search-input');
  const typeScope = (value) => {
    scopeSearch.value = value;
    scopeSearch.dispatch('input', {});
    flushFrames();
  };

  // ① 两个开关都关（回归基准）：只搜元素名，路径里的目录名搜不到
  typeScope('deepdir');
  assert(
    matchedIds().length === 0,
    `两个路径开关都关时不应命中（只搜元素名），实际 ${matchedIds().join(',') || '（无）'}`
  );

  // ② 只开「显示的路径」：显示的 `…/target.c` 里没有目录名 → 仍然搜不到
  byId.get('btn-search-path').dispatch('click', {});
  typeScope('deepdir');
  assert(
    matchedIds().length === 0,
    `「显示的路径」只覆盖那行**显示出来的**文字：被省略掉的 deepdir 不该命中，实际 ${matchedIds().join(',')}`
  );
  // 同一开关下，显示出来的文件名要能搜到（证明这个开关真的生效，而不是死的）
  typeScope('target');
  assert(
    matchedIds().join(',') === 'scopeDeep',
    `「显示的路径」应当能搜到显示出来的 target.c，实际 ${matchedIds().join(',') || '（无）'}`
  );
  // 未显示的目录段 `lib`（两个节点的完整路径都有）同样搜不到
  typeScope('lib');
  assert(
    matchedIds().length === 0,
    `「显示的路径」不该命中被省略的 lib 段，实际 ${matchedIds().join(',')}`
  );

  // ③ 换开「完整路径」：同一个 deepdir 现在搜得到，且只有那一个节点
  byId.get('btn-search-path').dispatch('click', {});
  byId.get('btn-search-full').dispatch('click', {});
  typeScope('deepdir');
  assert(
    matchedIds().join(',') === 'scopeDeep',
    `「完整路径」应当能搜到完整路径里的目录名，实际 ${matchedIds().join(',') || '（无）'}`
  );
  typeScope('lib');
  assert(
    matchedIds().join(',') === 'scopeDeep,scopeTop',
    `「完整路径」下 lib 段应当命中两个节点，实际 ${matchedIds().join(',')}`
  );
  // 元素名仍然按老规矩能搜到（开关只**扩大**范围，不缩小）
  typeScope('root_fn');
  assert(
    matchedIds().join(',') === 'scopeRoot',
    `开了路径开关后元素名仍要能搜到，实际 ${matchedIds().join(',') || '（无）'}`
  );

  // ④ 恢复两个开关都关：与 ① 逐字一致（回归）
  byId.get('btn-search-full').dispatch('click', {});
  typeScope('deepdir');
  assert(
    matchedIds().length === 0,
    `关掉两个路径开关后应当回到只搜元素名，实际 ${matchedIds().join(',')}`
  );
  typeScope('');
  log(
    'OK: 搜索范围 —— 「显示的路径」只覆盖那行显示出来的文字（被省略的目录名搜不到），' +
      '「完整路径」覆盖全部路径段；两个都关 = 只搜元素名（与改动前一致）'
  );
}

// ------------------------------------------------ 临时路径过滤的界面接线（用户 2026-10-15）
//
// 面板这一侧的职责只有三件：① 把输入框的文字发给宿主（空查询立即发、非空查询防抖后发）；
// ② 用宿主回传的 `filteredCount` 显示「已隐藏 N 个」——**不是**面板自己数的
// （命中与否要拿完整会话数据判，而面板手上的 payload 已经被裁掉了那些节点）；
// ③ 面板重建时把宿主那一份查询还原回输入框，否则界面与图分叉。
//
// 「过滤真的把这些方框藏起来」那一半在宿主侧，由 smoke 的端到端用例覆盖。
{
  const filterInput = byId.get('path-filter-input');
  const filterCount = byId.get('path-filter-count');
  assert(
    filterInput !== undefined && filterCount !== undefined,
    '桩里缺少临时过滤的输入框或计数（#path-filter-input / #path-filter-count）'
  );

  const mkNode = (id, name, file, line, depth, children) => ({
    id,
    name,
    file,
    line,
    direction: 'callers',
    depth,
    isCycle: false,
    canExpand: false,
    children,
    loaded: true,
    kind: 'function',
  });
  const filterSession = (filteredCount) => ({
    id: 'filter-check',
    title: '临时过滤检查',
    description: '',
    direction: 'callers',
    engineLabel: 'clangd',
    rootId: 'fltRoot',
    nodes: {
      fltRoot: mkNode('fltRoot', 'root_fn', 'src/main.c', 1, 0, ['fltHidden']),
      fltHidden: mkNode('fltHidden', 'hidden_fn', 'lib/deepdir/target.c', 7, 1, []),
    },
    edges: [],
    boxes: {
      fltRoot: { x: 0, y: 0, width: 260, height: NODE_HEIGHT },
      fltHidden: { x: 340, y: 0, width: 260, height: NODE_HEIGHT },
    },
    collapsedCount: 0,
    ...(filteredCount > 0 ? { filteredCount } : {}),
  });

  sendToWebview({ type: 'sessionUpdate', session: filterSession(0) });
  flushFrames();

  // ① 还在打字（宿主没回）时不给一个已经不对的旧数字
  filterInput.value = 'deepdir';
  filterInput.dispatch('input', {});
  assert(
    filterCount.textContent === '过滤中…',
    `刚输入、宿主还没回时计数应当写「过滤中…」（不能显示旧数字），实际「${filterCount.textContent}」`
  );

  // ② 宿主回一帧带 filteredCount 的会话：计数按它显示
  sendToWebview({ type: 'sessionUpdate', session: filterSession(2) });
  flushFrames();
  assert(
    filterCount.textContent === '已隐藏 2 个',
    `计数应当用宿主回传的 filteredCount，实际「${filterCount.textContent}」`
  );

  // ③ 清空：**立刻**发空查询（恢复不该等防抖），计数清空
  posted.length = 0;
  filterInput.value = '';
  filterInput.dispatch('input', {});
  const clearedMessage = posted.find((message) => message.type === 'pathFilter');
  assert(
    clearedMessage !== undefined && clearedMessage.query === '',
    `清空输入框应当立刻发出空查询（不等防抖），实际 ${JSON.stringify(
      posted.filter((message) => message.type === 'pathFilter')
    )}`
  );
  assert(filterCount.textContent === '', `清空后不该还留着「已隐藏 N 个」，实际「${filterCount.textContent}」`);

  // ④ Esc 清空并立刻发空查询（与搜索框同一套手感）
  filterInput.value = 'something';
  filterInput.dispatch('input', {});
  posted.length = 0;
  filterInput.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert(filterInput.value === '', `Esc 应当清空临时过滤输入框，实际「${filterInput.value}」`);
  assert(
    posted.some((message) => message.type === 'pathFilter' && message.query === ''),
    'Esc 清空后应当立刻把空查询发给宿主'
  );

  // ⑤ 面板重建（init 带回宿主那一份查询）：输入框必须还原，计数按当前标签显示
  posted.length = 0;
  sendToWebview({
    type: 'init',
    sessions: [filterSession(2)],
    summaries: [{ id: 'filter-check', title: '临时过滤检查', description: '', direction: 'callers' }],
    activeId: 'filter-check',
    pathFilterQuery: 'deepdir',
  });
  flushFrames();
  assert(
    filterInput.value === 'deepdir',
    `面板重建时输入框应当还原宿主那一份查询，实际「${filterInput.value}」`
  );
  assert(
    filterCount.textContent === '已隐藏 2 个',
    `还原后计数应当按当前标签的 filteredCount 显示，实际「${filterCount.textContent}」`
  );
  assert(
    posted.every((message) => message.type !== 'pathFilter'),
    'init 还原输入框**不得**顺带把查询再发回去（那会在宿主与面板之间形成回环）'
  );
  log(
    'OK: 临时路径过滤的界面接线 —— 输入清空/ Esc 立刻发空查询、计数用宿主回传的 filteredCount、' +
      'init 还原输入框且不回发查询'
  );
}

// 非空查询要**防抖**后才发（打字是高频操作，宿主每个查询都要重算所有标签的布局）。
// 这一条必须真等一个防抖周期，所以放在文件最后的定时器里；此时其它小节都已跑完。
{
  const filterInput = byId.get('path-filter-input');
  setTimeout(() => {
    // 定时器醒来时活动会话可能已被别的小节换掉，先把自己的夹具摆回去
    const session = {
      id: 'filter-debounce',
      title: '防抖检查',
      description: '',
      direction: 'callers',
      engineLabel: 'clangd',
      rootId: 'dbRoot',
      nodes: {
        dbRoot: {
          id: 'dbRoot',
          name: 'root_fn',
          file: 'src/main.c',
          line: 1,
          direction: 'callers',
          depth: 0,
          isCycle: false,
          canExpand: false,
          children: [],
          loaded: true,
          kind: 'function',
        },
      },
      edges: [],
      boxes: { dbRoot: { x: 0, y: 0, width: 200, height: NODE_HEIGHT } },
      collapsedCount: 0,
    };
    sendToWebview({ type: 'sessionUpdate', session });
    flushFrames();

    posted.length = 0;
    filterInput.value = 'debounce-probe';
    filterInput.dispatch('input', {});
    assert(
      posted.every((message) => message.type !== 'pathFilter'),
      '非空查询不该**立即**发出（打字期间要防抖，否则宿主会被逐字符重排拖垮）'
    );
    setTimeout(() => {
      const sent = posted.filter((message) => message.type === 'pathFilter');
      assert(
        sent.length === 1 && sent[0].query === 'debounce-probe',
        `防抖结束后应当恰好发出一条 pathFilter，实际 ${JSON.stringify(sent)}`
      );
      // 收尾：清空，避免这条查询影响后续任何观察
      filterInput.value = '';
      filterInput.dispatch('input', {});
      log(`OK: 临时路径过滤的防抖 —— 停止输入后恰好发出 1 条 pathFilter（查询「${sent[0].query}」）`);
    }, 300);
  }, 1500);
}

// ------------------------------------------------ init 必须带回宿主的收起状态（用户 2026-10-16 检视发现）
//
// 面板收到 init 会清空本地收起表，而宿主仍在按它算坐标（收起的子树没有坐标、不占高度）——
// 不还原就会出现「父框画着 − 号、子框一个都不画」，用户要点两下才恢复（界面与宿主分叉）。
// 放在最后：这一块会换掉画布上的会话，而前面那些「冲帧后就地读几何」的用例依赖自己的图。
{
  setTimeout(() => {
    const mkNode = (id, name, depth, children) => ({
      id,
      name,
      file: `${name}.c`,
      line: 1,
      direction: 'callers',
      depth,
      isCycle: false,
      canExpand: false,
      children,
      loaded: true,
      kind: 'function',
    });
    const session = {
      id: 'collapsed-check',
      title: '收起状态还原',
      description: '',
      direction: 'callers',
      engineLabel: 'clangd',
      rootId: 'colRoot',
      nodes: {
        colRoot: mkNode('colRoot', 'root', 0, ['colChild']),
        colChild: mkNode('colChild', 'child', 1, []),
      },
      edges: [{ id: 'colEdge', from: 'colRoot', to: 'colChild', depth: 1 }],
      boxes: {
        colRoot: { x: 0, y: 0, width: 240, height: NODE_HEIGHT },
        colChild: { x: 320, y: 0, width: 240, height: NODE_HEIGHT },
      },
      collapsedCount: 1,
    };
    const groupOf = (id) =>
      nodesGroup.children.find((child) => child.getAttribute('data-node') === id);

    // ① 先给一帧「没收起」的：子方框在
    sendToWebview({ type: 'init', sessions: [session], summaries: [], activeId: session.id });
    flushFrames();
    assert(groupOf('colChild') !== undefined, '前提：未收起时子方框应当被画出来');

    // ② 宿主说「根是收起的」：面板必须照它的状态画（子方框不画、根显示 +）
    sendToWebview({
      type: 'init',
      sessions: [session],
      summaries: [],
      activeId: session.id,
      collapsed: [{ sessionId: session.id, ids: ['colRoot'] }],
    });
    flushFrames();
    assert(
      groupOf('colChild') === undefined,
      'init 带回来的收起状态必须生效：被收起的根之下不该渲染子方框（否则父框显示 − 却一个子框都没有）'
    );
    const expander = groupOf('colRoot')?.children.find((child) =>
      String(child.getAttribute('class') || '').startsWith('expander')
    );
    assert(
      String(expander?.getAttribute('class') || '').includes('expand'),
      `被收起的节点应当显示「+」（与宿主一致），实际 ${expander?.getAttribute('class')}`
    );

    // ③ 反向：不带 collapsed 的 init 要把本地收起表清空（不能被上一帧粘住）
    sendToWebview({ type: 'init', sessions: [session], summaries: [], activeId: session.id });
    flushFrames();
    assert(
      groupOf('colChild') !== undefined,
      '不带收起状态的 init 应当把本地收起表清空（不能被上一帧粘住）'
    );
    log('OK: init 下发收起状态 —— 面板按宿主的状态画（子方框不画、根显示 +），且不会粘住上一帧');
  }, 2000);
}
