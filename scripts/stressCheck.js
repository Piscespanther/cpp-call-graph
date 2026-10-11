/**
 * 压测：宿主侧热路径的真实耗时（只出数字，不做断言）。
 *
 * 用法：`npm run stress`（会先构建，再跑本脚本）
 *
 * 为什么单独一个脚本：`npm run smoke` 里的断言回答的是"对不对"，不回答"多大图、多快"。
 * 这里用**真实产物**（`dist/extension.js` 的 `__layout` / `__hierarchy`）在大图上量时间，
 * 目的是暴露 O(n²)、静默截断这类只有"放大规模"才看得见的问题 —— 布局上限那次就是
 * 靠它发现的（既是 off-by-one，又是静默丢方框，还顺带找出每轮 `Object.keys().length`
 * 的 O(n²) 计数；改成计数器后 6001 节点的排布从 52.9 ms 降到 3.8 ms）。
 */
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------ 最小 vscode 桩
const configStore = {};
const vscodeStub = {
  Uri: {
    file: (fsPath) => ({ scheme: 'file', fsPath, toString: () => `file:///${fsPath}` }),
    joinPath: (uri, ...parts) => vscodeStub.Uri.file(path.join(uri.fsPath, ...parts)),
  },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Range: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  SymbolKind: { Object: 19, Function: 11, Constant: 14 },
  CallHierarchyItem: class {},
  ProgressLocation: { Notification: 15, Window: 10 },
  ViewColumn: { One: 1 },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
  ThemeColor: class {},
  MarkdownString: class {},
  extensions: { getExtension: () => undefined, all: [] },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  window: {
    activeTextEditor: undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_options, task) => task({ report() {} }),
    // 日志接口要齐全（info/warn/error）：生产代码用 logWarn 报「图太大、有节点没排布」，
    // 桩里缺 warn 会让那句日志抛 TypeError，整个压测直接崩掉（本轮踩过）。
    createOutputChannel: () => ({
      appendLine() {},
      append() {},
      info() {},
      warn() {},
      error() {},
      show() {},
      dispose() {},
      clear() {},
    }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    visibleTextEditors: [],
  },
  workspace: {
    workspaceFolders: [],
    textDocuments: [],
    getConfiguration: (section) => ({
      get: (key, fallback) =>
        Object.prototype.hasOwnProperty.call(configStore, `${section}.${key}`)
          ? configStore[`${section}.${key}`]
          : fallback,
      update: async () => undefined,
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    fs: {
      readFile: async () => new Uint8Array(),
      createDirectory: async () => undefined,
      writeFile: async () => undefined,
    },
    openTextDocument: async () => undefined,
    asRelativePath: (uri) => String(uri.fsPath ?? uri),
  },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};

const extension = require(path.join(ROOT, 'dist', 'extension.js'));
const { createLayout } = extension.__layout;
const { baseKeyOf, pickByChoice } = extension.__hierarchy;

// ------------------------------------------------------------ 夹具
function makeNode(id, depth, parent, children) {
  return {
    id,
    name: `func_${id}`,
    file: `src/module_${depth}/file_${id}.cpp`,
    line: 10 + (Number(id.replace(/\D/g, '') || 0) % 900),
    direction: 'callees',
    depth,
    isCycle: false,
    children,
    parent,
    loaded: true,
    kind: 'function',
  };
}

function wideGraph(n, c) {
  const nodes = {};
  const rootChildren = [];
  for (let i = 0; i < n; i += 1) {
    const childId = `c${i}`;
    const leafIds = [];
    for (let j = 0; j < c; j += 1) {
      const leafId = `c${i}_l${j}`;
      leafIds.push(leafId);
      nodes[leafId] = makeNode(leafId, 2, childId, []);
    }
    nodes[childId] = makeNode(childId, 1, 'root', leafIds);
    rootChildren.push(childId);
  }
  nodes.root = makeNode('root', 0, undefined, rootChildren);
  return nodes;
}

function deepGraph(d) {
  const nodes = {};
  let parent;
  for (let i = 0; i < d; i += 1) {
    const id = `n${i}`;
    nodes[id] = makeNode(id, i, parent, []);
    if (parent) {
      nodes[parent].children.push(id);
    }
    parent = id;
  }
  return nodes;
}

/**
 * 计时：先预热一次（JIT 与 GC 会让第一轮明显偏慢 —— 上一版 800 节点竟比 1600 节点还慢，
 * 就是这个噪声造成的），再多轮取样**取中位数**，避免被单次尖峰带偏。
 */
function time(fn, repeat = 5) {
  let result = fn();
  const samples = [];
  for (let i = 0; i < repeat; i += 1) {
    const started = process.hrtime.bigint();
    result = fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { ms: median, min: sorted[0], max: sorted[sorted.length - 1], samples, result };
}

console.log('=== 宿主布局 createLayout（列 / 行 / 子树高度） ===');
for (const [n, c] of [
  [50, 3],
  [200, 3],
  [500, 3],
  [1000, 3],
  [2000, 2],
]) {
  const nodes = wideGraph(n, c);
  const total = Object.keys(nodes).length;
  const { ms, result } = time(() => createLayout(nodes, 'root'));
  console.log(
    `  宽树 ${String(total).padStart(6)} 节点：${ms.toFixed(1)} ms，出坐标 ${Object.keys(result.boxes).length} 个，${(
      (ms / total) *
      1000
    ).toFixed(2)} µs/节点`
  );
}
for (const depth of [100, 500, 1000, 2000]) {
  const nodes = deepGraph(depth);
  const { ms, result } = time(() => createLayout(nodes, 'n0'));
  console.log(
    `  深链 ${String(depth).padStart(6)} 层：${ms.toFixed(1)} ms，出坐标 ${Object.keys(result.boxes).length} 个`
  );
}

console.log('=== 其他热路径 ===');
{
  const nodes = wideGraph(2000, 2);
  const ids = Object.keys(nodes);
  const measured = new Map(ids.map((id) => [id, 120 + (id.length % 7) * 20]));
  console.log(`  带实测宽度重排（${ids.length} 节点）：${time(() => createLayout(nodes, 'root', measured)).ms.toFixed(1)} ms`);

  const keyStart = process.hrtime.bigint();
  for (let i = 0; i < 5; i += 1) {
    for (const id of ids) {
      baseKeyOf(`${id}\u0000file:///x.cpp|1|0|1|20|fn`);
    }
  }
  console.log(`  baseKeyOf × ${ids.length * 5}：${(Number(process.hrtime.bigint() - keyStart) / 1e6).toFixed(2)} ms`);

  const items = ids.map((id, index) => ({
    name: id,
    kind: 11,
    uri: { toString: () => `file:///${id}.cpp` },
    range: { start: { line: index }, end: { line: index } },
    selectionRange: {
      start: { line: index, character: index % 40 },
      end: { line: index, character: (index % 40) + 5 },
    },
  }));
  console.log(
    `  pickByChoice（${items.length} 候选）× 20：${time(() => pickByChoice(items, { line: 100, character: 12 }), 20).ms.toFixed(2)} ms`
  );
}

const used = process.memoryUsage();
console.log(
  `=== 内存 === heapUsed ${(used.heapUsed / 1024 / 1024).toFixed(1)} MB，rss ${(used.rss / 1024 / 1024).toFixed(1)} MB`
);
Module._load = originalLoad;
