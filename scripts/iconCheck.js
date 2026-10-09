/**
 * 符号角标测试：确认每个 NodeKind 都拿到**正确的、来自真实 codicon 的**图标轮廓。
 *
 * 做法：不另写一套 stub，而是用 `vm` 在受控全局环境里直接运行真实产物
 * dist/webview.js（它本身是 IIFE），注入最小 DOM 与 acquireVsCodeApi，
 * 喂一条含全部 NodeKind 的 init 消息，然后检查渲染出的角标。
 *
 * 断言：
 *   1. 每个节点都有角标，且带 data-codicon
 *   2. 每个 kind 的 codicon 与 symbolIcons.ts 里的映射一致
 *   3. 共用的图标必须是**有意共用**（同一 codicon 服务多个 kind 是正常的，与 VS Code 一致）
 *   4. 每个角标只有一条 path，且带 fill-rule
 *
 * 运行：node scripts/iconCheck.js
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

// 从源码读取权威映射（KIND_TO_ICON）与图标表（ICON_BY_CODICON）
const iconSource = fs.readFileSync(
  path.join(ROOT, 'src', 'webview', 'symbolIcons.ts'),
  'utf8'
);
const kindToIcon = {};
{
  const block = /KIND_TO_ICON[^{]*\{([\s\S]*?)\n\};/.exec(iconSource);
  assert(block !== null, 'symbolIcons.ts 里找不到 KIND_TO_ICON');
  for (const line of block[1].split('\n')) {
    const match = /^\s*(\w+):\s*'([^']+)',/.exec(line);
    if (match) {
      kindToIcon[match[1]] = match[2];
    }
  }
}
const iconPaths = {};
{
  const block = /ICON_BY_CODICON[^{]*\{([\s\S]*?)\n\};/.exec(iconSource);
  assert(block !== null, 'symbolIcons.ts 里找不到 ICON_BY_CODICON');
  const re = /'([^']+)':\s*\{\s*path:\s*'([^']+)'/g;
  let match;
  while ((match = re.exec(block[1])) !== null) {
    iconPaths[match[1]] = match[2];
  }
}

const KINDS = Object.keys(kindToIcon);
assert(KINDS.length >= 20, `KIND_TO_ICON 覆盖的类型太少：${KINDS.length}`);

// ------------------------------------------------------------ 最小 DOM

function createElement(tagName) {
  return {
    tagName,
    attributes: new Map(),
    children: [],
    listeners: new Map(),
    style: {},
    _textContent: '',
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
      toggle(name, force) {
        const should = force === undefined ? !this._set.has(name) : Boolean(force);
        if (should) {
          this._set.add(name);
        } else {
          this._set.delete(name);
        }
      },
    },
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
    getBBox() {
      return { x: 0, y: 0, width: 16, height: 16 };
    },
    getCTM() {
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
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
for (const id of ['tabs', 'toolbar', 'box-menu', 'summary', 'empty', 'canvas', 'svg', 'viewport', 'edges', 'nodes']) {
  byId.set(id, createElement(id === 'svg' ? 'svg' : 'div'));
}
byId.get('canvas').clientWidth = 800;
byId.get('canvas').clientHeight = 400;

const windowListeners = [];
const sandbox = {
  document: {
    createElementNS: (_ns, tag) => createElement(tag),
    createElement: (tag) => createElement(tag),
    getElementById: (id) => byId.get(id) ?? null,
    addEventListener() {},
  },
  window: {
    addEventListener(type, handler) {
      if (type === 'message') {
        windowListeners.push(handler);
      }
    },
    requestAnimationFrame: (callback) => callback(),
  },
  acquireVsCodeApi: () => ({ postMessage() {}, getState: () => undefined, setState() {} }),
  setTimeout: (callback) => {
    callback();
    return 0;
  },
  clearTimeout() {},
  requestAnimationFrame: (callback) => {
    callback();
    return 0;
  },
  console,
  Map,
  Set,
  Object,
  Array,
  Number,
  String,
  Math,
  JSON,
  Error,
  RegExp,
  Boolean,
  Date,
  parseInt,
  parseFloat,
  isNaN,
};
sandbox.globalThis = sandbox;

// ------------------------------------------------------------ 跑真实产物

const bundle = fs.readFileSync(path.join(ROOT, 'dist', 'webview.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: 'dist/webview.js' });

assert(windowListeners.length > 0, '产物没有注册 message 监听器');

const nodes = {};
const boxes = {};
KINDS.forEach((kind, index) => {
  const id = `n${index}`;
  nodes[id] = {
    id,
    name: `symbol_${kind}`,
    file: 'sample/types.h',
    line: index + 1,
    direction: 'callees',
    depth: index,
    isCycle: false,
    children: index < KINDS.length - 1 ? [`n${index + 1}`] : [],
    parent: index === 0 ? undefined : `n${index - 1}`,
    loaded: true,
    canExpand: false,
    kind,
  };
  boxes[id] = { x: index * 240, y: 0, width: 230, height: 50 };
});

for (const handler of windowListeners) {
  handler({
    data: {
      type: 'init',
      sessions: [
        {
          id: 's-kinds',
          title: '调用:symbols',
          description: 'types.h:1',
          direction: 'callees',
          engineLabel: 'cpptools',
          rootId: 'n0',
          nodes,
          edges: [],
          boxes,
          collapsedCount: 0,
        },
      ],
      summaries: [],
      activeId: 's-kinds',
    },
  });
}

// ------------------------------------------------------------ 检查

const nodeGroups = byId.get('nodes').children;
assert(
  nodeGroups.length === KINDS.length,
  `渲染出的节点数不对：期望 ${KINDS.length}，实际 ${nodeGroups.length}`
);

const seen = new Map();
for (const group of nodeGroups) {
  const nodeId = String(group.getAttribute('data-node'));
  const kind = nodes[nodeId].kind;
  const icon = group.children.find((child) => child.className.startsWith('kind-icon'));
  assert(icon !== undefined, `节点 ${nodeId}（${kind}）没有符号角标`);

  const codicon = String(icon.getAttribute('data-codicon') ?? '');
  assert(codicon !== '', `节点 ${nodeId}（${kind}）的角标缺少 data-codicon`);
  assert(
    codicon === kindToIcon[kind],
    `${kind} 的图标不对：期望 ${kindToIcon[kind]}，实际 ${codicon}`
  );

  const shape = icon.children.find((child) => child.className.includes('icon-shape'));
  assert(shape !== undefined, `${kind} 的角标里没有图形`);
  assert(shape.tagName === 'path', `${kind} 的角标应是单条 <path>，实际 <${shape.tagName}>`);
  assert(
    String(shape.getAttribute('d') ?? '').length > 40,
    `${kind} 的角标路径太短，可能是空轮廓`
  );
  assert(
    String(shape.getAttribute('fill-rule') ?? '') === 'nonzero',
    `${kind} 的角标缺少 fill-rule="nonzero"`
  );
  // 路径应来自真实字体轮廓（含 Q 二次贝塞尔），而不是手画的直线方块
  assert(
    String(shape.getAttribute('d')).includes('Q'),
    `${kind} 的角标不像字体轮廓（缺少二次贝塞尔指令）`
  );

  seen.set(codicon, (seen.get(codicon) ?? 0) + 1);
}

console.log(`诊断: ${KINDS.length} 种类型 → ${seen.size} 种 codicon 图标`);
console.log(
  `诊断: ${[...seen.entries()].map(([name, count]) => `${name}×${count}`).join(', ')}`
);

// 共用的图标必须是「有意共用」：同一个 codicon 只能服务在 KIND_TO_ICON 里显式写明的那些类型
const expectedSharing = new Map();
for (const [kind, codicon] of Object.entries(kindToIcon)) {
  expectedSharing.set(codicon, (expectedSharing.get(codicon) ?? 0) + 1);
}
for (const [codicon, count] of seen) {
  assert(
    count === expectedSharing.get(codicon),
    `${codicon} 的使用次数与映射表不一致：实际 ${count}，映射表 ${expectedSharing.get(codicon)}`
  );
}

// 图标表里必须每个都有非空路径
for (const [name, d] of Object.entries(iconPaths)) {
  assert(d.length > 40, `${name} 的路径太短`);
}
console.log(`诊断: ICON_BY_CODICON 共 ${Object.keys(iconPaths).length} 个图标，路径均非空`);

console.log('OK: 全部 NodeKind 都拿到与 VS Code 一致的 codicon 轮廓图标');
