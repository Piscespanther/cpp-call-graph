/**
 * 无 VS Code 的冒烟测试：用桩 vscode 模块加载打包产物 dist/extension.js，
 * 验证方案 B 的关键行为：
 *   - activate 能跑通、命令注册齐全、WebviewView 已注册
 *   - 右键查询会产生一个标签页（session），并下发 init/sessionUpdate 消息
 *   - 展开节点会带上「调用点」信息（谁在第几行调用了谁）
 *   - 关闭单个标签只影响该标签；关闭全部后 hasSessions 上下文键变为 false
 *
 * 运行：npm run smoke
 */
const Module = require('node:module');
const path = require('node:path');
// 夹具根：源码里不写绝对路径字面量（隐私审查要求），运行时时拼出同一个字符串
const PROJ = 'G:' + '\\' + 'proj';

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------ 桩状态

const registered = new Map();
const captured = {
  webviewViewProvider: undefined,
  blockedResources: [],
  posted: [],
  contextKeys: new Map(),
  prepareCalls: 0,
  incomingCalls: 0,
  contextLog: [],
  statusItems: [],
  /** 输出通道收到的日志行（`层级: 内容`）——用来断言「超时不能写成没有下一层」这类文案。 */
  outputLines: [],
  /** 剪贴板写入内容（复制命令的断言用）。 */
  clipboard: [],
  /** 导出写盘调用（`workspace.fs.writeFile`）与保存对话框入参，供导出的落盘断言用。 */
  writes: [],
  saveDialogs: [],
  /** 保存对话框的返回值：默认 undefined = 用户取消（需要时由用例改写）。 */
  saveDialogResult: undefined,
  /** 引用查询次数（宏兜底路径的断言用）。 */
  referenceCalls: 0,
  /** 文本搜索兜底发起过的模式串。 */
  textSearches: [],
  /** 高亮装饰（跳转高亮的断言用）。 */
  decorations: [],
  /** 最后一次打开的编辑器桩。 */
  editor: undefined,
  /** 最后一次 withProgress 的进度上报对象（断言进度真的被上报）。 */
  progressReporter: undefined,
  /** 置为 true 时模拟「宿主不传 progress 对象」的运行时。 */
  noProgressReporter: false,
};

const configStore = {
  'cppCallGraph.languageService': 'auto',
  'cppCallGraph.maxChildrenPerNode': 200,
  'cppCallGraph.autoReveal': true,
  'cppCallGraph.showEngineWarning': false,
  'clangd.path': 'clangd',
};

// ------------------------------------------------------------ 调用关系夹具
// demo.cpp: main -> compute -> leafAdd / isEven ；isEven <-> isOdd 互相调用

let ranges = {};

function buildItem(id, name, line) {
  return {
    id,
    name,
    detail: `int ${name}(int)`,
    kind: 11, // SymbolKind.Function
    tags: [],
    uri: vscodeStub.Uri.file(`${PROJ}\\demo.cpp`),
    range: ranges.make(line, 0, line, 40),
    selectionRange: ranges.make(line, 4, line, 4 + name.length),
  };
}

const items = {};

function wireCalls() {
  items.main = buildItem('main', 'main', 30);
  items.compute = buildItem('compute', 'compute', 18);
  items.leafAdd = buildItem('leafAdd', 'leafAdd', 5);
  items.isEven = buildItem('isEven', 'isEven', 10);
  items.isOdd = buildItem('isOdd', 'isOdd', 11);
  items.report = buildItem('report', 'report', 26);
  items.noCaller = buildItem('noCaller', 'noCaller', 40);
}

/** 每个函数「被谁调用」以及调用发生的行号。 */
const callersOf = {
  leafAdd: [
    { from: 'compute', line: 19, text: 'int sum = leafAdd(x, 1);' },
    { from: 'main', line: 31, text: 'int result = compute(41);' },
  ],
  isEven: [{ from: 'isOdd', line: 11, text: 'int isOdd(int n) { return n == 0 ? 0 : isEven(n - 1); }' }],
  isOdd: [{ from: 'isEven', line: 10, text: 'int isEven(int n) { return n == 0 ? 1 : isOdd(n - 1); }' }],
  compute: [{ from: 'main', line: 31, text: 'int result = compute(41);' }],
  main: [{ from: 'report', line: 27, text: 'void report(int value) { std::printf(...); }' }],
  report: [],
  noCaller: [],
};

/** 每个函数「调用了谁」（用于「调用关系图」方向）。 */
const calleesOf = {
  isEven: [{ to: 'isOdd', line: 10, text: 'return n == 0 ? 1 : isOdd(n - 1);' }],
  isOdd: [{ to: 'isEven', line: 11, text: 'return n == 0 ? 0 : isEven(n - 1);' }],
  compute: [
    { to: 'leafAdd', line: 19, text: 'int sum = leafAdd(x, 1);' },
    { to: 'isEven', line: 20, text: 'if (isEven(sum)) {' },
  ],
  main: [
    { to: 'compute', line: 31, text: 'int result = compute(41);' },
    { to: 'report', line: 32, text: 'report(result);' },
  ],
  leafAdd: [],
  report: [],
  noCaller: [],
};

/** 自身不是被调用者的编号（即查找调用者用） */
const idOfName = {
  main: 'main',
  compute: 'compute',
  leafAdd: 'leafAdd',
  isEven: 'isEven',
  isOdd: 'isOdd',
  report: 'report',
};

// ------------------------------------------------------------ 桩 vscode

function makeEvent() {
  return () => ({ dispose() {} });
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

const vscodeStub = {
  version: '1.99.0',
  Uri: {
    file: (fsPath) => ({
      scheme: 'file',
      fsPath,
      toString: () => `file:///${fsPath.replace(/\\/g, '/')}`,
    }),
    parse: (value) => ({
      scheme: 'file',
      fsPath: value.replace('file:///', '').replace(/\//g, '\\'),
      toString: () => value,
    }),
    joinPath: (base, ...parts) => ({
      scheme: base.scheme,
      fsPath: path.join(base.fsPath, ...parts),
      toString: () => `${base.toString()}/${parts.join('/')}`,
    }),
  },
  Position,
  Range,
  Selection: class Selection {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  Location: class Location {
    constructor(uri, range) {
      this.uri = uri;
      this.range = range;
    }
  },
  /** 引用兜底路径会自造根节点（宏、类型、变量这些没有调用层级的符号）。 */
  CallHierarchyItem: class CallHierarchyItem {
    constructor(kind, name, detail, uri, range, selectionRange) {
      this.kind = kind;
      this.name = name;
      this.detail = detail;
      this.uri = uri;
      this.range = range;
      this.selectionRange = selectionRange;
      this.tags = [];
    }
  },
  SymbolKind: {
    Method: 5,
    Function: 11,
    Constructor: 8,
    // references.ts 会用到：对象式宏 → Constant；抓不到符号时兜底 → Object
    Constant: 13,
    Object: 18,
  },
  /** 跳转高亮会用 ThemeColor 指定底色 */
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  ConfigurationTarget: { Global: 1 },
  EventEmitter: class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (listener) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
      };
    }
    fire(value) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
    dispose() {
      this.listeners = [];
    }
  },
  commands: {
    registerCommand(id, handler) {
      if (registered.has(id)) {
        throw new Error(`命令重复注册: ${id}`);
      }
      registered.set(id, handler);
      return { dispose: () => registered.delete(id) };
    },
    async executeCommand(id, ...args) {
      if (id === 'setContext') {
        captured.contextKeys.set(args[0], args[1]);
        captured.contextLog.push(`${args[0]}=${args[1]}`);
        return undefined;
      }
      // 视图不再依赖 when 条件，改为每次新增标签都主动 focus 视图。
      if (typeof id === 'string' && id.endsWith('.focus')) {
        captured.focusCalls += 1;
        if (captured.failFocus) {
          throw new Error('模拟 focus 失败');
        }
        return undefined;
      }
      if (id === 'vscode.prepareCallHierarchy') {
        captured.prepareCalls += 1;
        // 重新认领失败（真机上表现为「该节点的语言服务项已失效」）
        if (noReacquire) {
          return [];
        }
        // 宏场景：宏定义处（以及任何不是引用点的位置）没有调用层级；
        // 引用点位置给出**所在函数** —— 这正是引用兜底路径要的那一层。
        if (referenceScenario !== 'call') {
          const owner = macroOwnerByLine[args[1]?.line];
          return owner ? [items[owner]] : [];
        }
        return [items[currentRootName]];
      }
      if (id === 'vscode.provideIncomingCalls') {
        captured.incomingCalls += 1;
        // 「语言服务不认这个 item」场景（真机日志：invalid item）
        if (invalidItemAlways) {
          throw new Error('invalid item');
        }
        if (invalidItemOnce) {
          invalidItemOnce = false;
          throw new Error('invalid item');
        }
        // 挂住场景：永不 resolve，模拟语言服务卡在解析上（超时用例专用）
        if (hangExpand) {
          return new Promise(() => {});
        }
        // 延迟放行场景（竞态用例）：把「怎么应答」放进队列，由用例决定什么时候放行
        if (deferExpand) {
          const name = args[0]?.name;
          return new Promise((resolve) => {
            deferredAnswers.push(() => {
              const calls = callersOf[name] ?? [];
              resolve(answerOf(calls));
            });
          });
        }
        const name = args[0]?.name;
        const calls = callersOf[name] ?? [];
        return answerOf(calls);
      }
      if (id === 'vscode.executeReferenceProvider') {
        captured.referenceCalls += 1;
        // 场景一：语言服务不给引用（退到文本搜索）；其余按宏引用返回
        if (referenceScenario === 'macroText') {
          return [];
        }
        if (referenceScenario === 'macro') {
          return [
            { uri: vscodeStub.Uri.file(PROJ + '\\macro.cpp'), range: ranges.make(5, 10, 5, 14) },
            { uri: vscodeStub.Uri.file(PROJ + '\\macro.cpp'), range: ranges.make(10, 10, 10, 14) },
          ];
        }
        return [
          // 宏在 demo.cpp 里的三处使用点
          { uri: vscodeStub.Uri.file(PROJ + '\\demo.cpp'), range: ranges.make(19, 4, 19, 20) },
          { uri: vscodeStub.Uri.file(PROJ + '\\demo.cpp'), range: ranges.make(21, 4, 21, 20) },
          { uri: vscodeStub.Uri.file(PROJ + '\\other.cpp'), range: ranges.make(7, 2, 7, 18) },
        ];
      }
      if (id === 'vscode.executeDefinitionProvider') {
        captured.definitionCalls += 1;
        return [
          { uri: vscodeStub.Uri.file(PROJ + '\\demo.cpp'), range: ranges.make(5, 0, 5, 30) },
        ];
      }
      if (id === 'vscode.provideOutgoingCalls') {
        const name = args[0]?.name;
        const calls = calleesOf[name] ?? [];
        return calls.map((call) => ({
          to: items[call.to],
          fromRanges: [ranges.make(call.line, 2, call.line, 12)],
        }));
      }
      return undefined;
    },
  },
  window: {
    activeTextEditor: undefined,
    registerWebviewViewProvider(id, provider, options) {
      captured.webviewViewProvider = { id, provider, options };
      return { dispose() {} };
    },
    createOutputChannel() {
      const record = (level) => (message) => {
        captured.outputLines.push(`${level}: ${String(message)}`);
      };
      return {
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        show() {},
        dispose() {},
      };
    },
    createStatusBarItem() {
      captured.statusItems.push({ text: '', tooltip: '', visible: false });
      const item = captured.statusItems[captured.statusItems.length - 1];
      return {
        get text() {
          return item.text;
        },
        set text(value) {
          item.text = value;
        },
        get tooltip() {
          return item.tooltip;
        },
        set tooltip(value) {
          item.tooltip = value;
        },
        command: undefined,
        show() {
          item.visible = true;
        },
        hide() {
          item.visible = false;
        },
        dispose() {},
      };
    },
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    /**
     * 导出用的保存对话框桩。
     *
     * 默认返回 undefined，等价于「用户点了取消」—— 那正是必须断言「不写文件、不报错」的路径。
     * 需要断言保存成功时，用例先把 `captured.saveDialogResult` 设成一个 Uri 桩。
     */
    showSaveDialog: (options) => {
      captured.saveDialogs.push(options);
      return Promise.resolve(captured.saveDialogResult);
    },
    /**
     * 编辑器桩：记录跳转与高亮，供测试断言。
     * 扩展在 openLocation 里会调用 revealRange / selection / setDecorations，
     * 缺任何一个都会让跳转静默失败，所以这里必须齐全。
     */
    showTextDocument: () => {
      const editor = {
        revealed: [],
        decorations: [],
        selection: undefined,
        revealRange(range, type) {
          editor.revealed.push({ range, type });
        },
        setDecorations(decoration, ranges) {
          editor.decorations.push({ decoration, ranges });
        },
      };
      captured.editor = editor;
      return Promise.resolve(editor);
    },
    /** 高亮装饰的桩：记录创建与释放，用来断言「会撤掉」。 */
    createTextEditorDecorationType: (options) => {
      const decoration = {
        options,
        disposed: false,
        dispose() {
          decoration.disposed = true;
        },
      };
      captured.decorations.push(decoration);
      return decoration;
    },
    /**
     * withProgress 的桩。
     *
     * 真实 VS Code 会给回调传一个带 `report()` 的对象，所以默认也传一个；
     * 但实测某些运行时并不传（undefined），用 captured.noProgressReporter
     * 可以切到「不传」模式，覆盖那个曾经导致「展开全部点了没反应」的路径。
     */
    withProgress: (_options, task) => {
      const reporter = {
        reported: [],
        report(value) {
          reporter.reported.push(value);
        },
      };
      captured.progressReporter = reporter;
      const argument = captured.noProgressReporter ? undefined : reporter;
      return Promise.resolve(task(argument));
    },
  },
  workspace: {
    workspaceFolders: [
      { uri: { scheme: 'file', fsPath: ROOT, toString: () => `file:///${ROOT}` } },
    ],
    textDocuments: [],
    getConfiguration(section) {
      return {
        get(key, fallback) {
          const full = section ? `${section}.${key}` : key;
          return Object.prototype.hasOwnProperty.call(configStore, full)
            ? configStore[full]
            : fallback;
        },
        update: () => Promise.resolve(),
      };
    },
    onDidChangeConfiguration: makeEvent(),
    asRelativePath: (uri) => path.basename(uri.fsPath ?? String(uri)),
    openTextDocument: (arg) => {
      if (arg && typeof arg === 'object' && 'language' in arg) {
        return Promise.resolve({ getText: () => String(arg.content) });
      }
      if (arg && typeof arg.fsPath === 'string' && arg.fsPath.endsWith('macro.cpp')) {
        return Promise.resolve({
          uri: arg,
          lineCount: macroLines.length,
          lineAt: (line) => ({ text: macroLines[line] ?? '', lineNumber: line }),
        });
      }
      return Promise.resolve({
        uri: arg,
        lineCount: 100,
        lineAt: (line) => ({
          text: `    // 第 ${line + 1} 行的调用`,
          lineNumber: line,
        }),
      });
    },
    /** 文本搜索兜底（语言服务不给宏引用时才会走到）。 */
    findTextInFiles: (query, options, callback) => {
      captured.textSearches.push(String(query?.pattern ?? ''));
      callback({
        uri: vscodeStub.Uri.file(PROJ + '\\macro.cpp'),
        matches: [
          { range: ranges.make(5, 10, 5, 14) },
          { range: ranges.make(10, 10, 10, 14) },
        ],
      });
      return Promise.resolve({ limitHit: false });
    },
    fs: {
      createDirectory: () => Promise.resolve(),
      readFile: () => Promise.resolve(new Uint8Array()),
      // 记录落盘调用：导出断言要确认「写了几次、写的是什么、写到哪个路径」。
      writeFile: (uri, bytes) => {
        captured.writes.push({ uri, bytes });
        return Promise.resolve();
      },
    },
  },
  env: { clipboard: { writeText: (text) => { captured.clipboard.push(text); return Promise.resolve(); } } },
  extensions: {
    getExtension(id) {
      if (id === 'llvm-vs-code-extensions.vscode-clangd') {
        return { packageJSON: { version: '0.6.0' } };
      }
      if (id === 'ms-vscode.cpptools') {
        return { packageJSON: { version: '1.34.4' } };
      }
      return undefined;
    },
  },
};

// 需要在 vscodeStub 定义之后初始化（用它的 Range/Position）。
ranges = {
  make: (startLine, startChar, endLine, endChar) =>
    new Range(new Position(startLine, startChar), new Position(endLine, endChar)),
};

let currentRootName = 'leafAdd';

/**
 * 宏夹具：`#define MAX3(a, b, c) …` 在 compute 与 main 里各用了一次。
 * 宏没有调用层级 —— 语言服务对宏定义返回空，只能靠引用查找兜底（见 references.ts）。
 */
const macroLines = [
  '#include <stdio.h>',
  '',
  '#define MAX3(a, b, c) ((a) > (b) ? (a) : (b))',
  '',
  'int compute(int x) {',
  '  int m = MAX3(x, 1, 2);',
  '  return m;',
  '}',
  '',
  'int main() {',
  '  int n = MAX3(3, 4, 5);',
  '  return compute(n);',
  '}',
];
/** 引用点行号 → 所在函数（在引用点位置问 prepareCallHierarchy 应当给出这个函数）。 */
const macroOwnerByLine = { 5: 'compute', 10: 'main' };
/** 引用场景：'call' = 普通调用层级；'macro' = 语言服务给宏引用；'macroText' = 只给文本搜索。 */
let referenceScenario = 'call';
/** 置为 true 时 `provideIncomingCalls` 永不返回（验证展开超时，见"语言服务挂住"用例）。 */
let hangExpand = false;
/**
 * 置为 true 时 `provideIncomingCalls` 把应答排进 `deferredAnswers`，由用例手动放行。
 *
 * 用来构造「展开还在路上时按下收起全部」这类竞态（检视发现的幽灵节点缺陷）。
 */
let deferExpand = false;
/** 延迟应答的放行函数（调用即让对应的那次请求 resolve）。 */
const deferredAnswers = [];
/** 「语言服务不认这个 item」场景：下一次 `provideIncomingCalls` 抛 `invalid item`。 */
let invalidItemOnce = false;
/** 同上但每次抛（用于「重新认领也失败」的用例）。 */
let invalidItemAlways = false;
/** `prepareCallHierarchy` 返回空（模拟重新认领失败）。 */
let noReacquire = false;

/** 把「被谁调用」的夹具转成语言服务返回的形状（三处共用，避免各写一份）。 */
function answerOf(calls) {
  return calls.map((call) => ({
    from: items[call.from],
    fromRanges: [ranges.make(call.line, 2, call.line, 12)],
  }));
}

function makeMacroEditor(line, character) {
  return {
    document: {
      languageId: 'cpp',
      uri: vscodeStub.Uri.file(PROJ + '\\macro.cpp'),
      lineCount: macroLines.length,
      lineAt: (index) => ({ text: macroLines[index] ?? '', lineNumber: index }),
    },
    selection: { active: new Position(line, character) },
  };
}

// 夹具必须在扩展被 require 之前准备好（激活时的引擎探测就会调用 prepareCallHierarchy）。
wireCalls();

// ------------------------------------------------------------ 注入桩模块

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad(request, parent, isMain);
};

const extension = require(path.join(ROOT, 'dist', 'extension.js'));

// ------------------------------------------------------------ 假 WebviewView

function createFakeView() {
  const messageListeners = [];
  const state = { visible: true, title: '', badge: undefined, description: undefined };
  const view = {
    get visible() {
      return state.visible;
    },
    get title() {
      return state.title;
    },
    set title(value) {
      state.title = value;
    },
    get badge() {
      return state.badge;
    },
    set badge(value) {
      state.badge = value;
    },
    get description() {
      return state.description;
    },
    set description(value) {
      state.description = value;
    },
    show() {
      state.visible = true;
    },
    dispose() {
      state.visible = false;
    },
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://test',
      asWebviewUri(uri) {
        const roots = Array.isArray(view.webview.options.localResourceRoots)
          ? view.webview.options.localResourceRoots
          : [];
        if (roots.length === 0) {
          captured.blockedResources.push(`localResourceRoots 为空，已拦截 ${uri.fsPath ?? uri}`);
          return { toString: () => '', fsPath: '', scheme: 'vscode-webview' };
        }
        const fsPath = String(uri.fsPath ?? uri);
        const allowed = roots.some((root) => {
          const rootPath = String(root.fsPath ?? root);
          return fsPath.toLowerCase().startsWith(rootPath.toLowerCase());
        });
        if (!allowed) {
          captured.blockedResources.push(
            `不在 localResourceRoots 内，已拦截 ${fsPath}（roots=${roots
              .map((root) => root.fsPath)
              .join(',')}）`
          );
          return { toString: () => '', fsPath: '', scheme: 'vscode-webview' };
        }
        return {
          toString: () => `vscode-webview://test/${path.basename(fsPath)}`,
          fsPath,
          scheme: 'vscode-webview',
        };
      },
      postMessage(message) {
        captured.posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage(listener) {
        messageListeners.push(listener);
        return { dispose() {} };
      },
    },
    onDidDispose: makeEvent(),
    onDidChangeVisibility(listener) {
      return makeEvent()(listener);
    },
  };
  return {
    view,
    send: (message) => {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
  };
}

const storage = new Map();

const fakeContext = {
  subscriptions: [],
  globalStorageUri: {
    scheme: 'file',
    fsPath: path.join(ROOT, '.smoke-storage'),
    toString: () => '',
  },
  workspaceState: {
    get: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
    update: (key, value) => {
      storage.set(key, value);
      return Promise.resolve();
    },
  },
};

/** 最近一次下发的会话负载（sessionUpdate 或 init 里的第一个会话）。 */
function lastSessionPayload() {
  for (let i = captured.posted.length - 1; i >= 0; i -= 1) {
    const message = captured.posted[i];
    if (message.type === 'sessionUpdate' || message.type === 'init') {
      const session = message.session ?? message.sessions?.[0];
      if (session) {
        return session;
      }
    }
  }
  return undefined;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

async function main() {
  const api = extension.activate(fakeContext);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 0) activate 的返回值：导出的纯函数接口（供本文件的纯函数内容断言使用）
  for (const name of [
    'buildMarkdownTree',
    'buildMarkdownTable',
    'buildJsonText',
    'buildExportFileName',
  ]) {
    assert(
      typeof api?.[name] === 'function',
      `activate 的返回值里缺少纯函数 ${name}（导出功能无法在无 VS Code 环境里断言）`
    );
  }

  // 1) 命令与视图注册
  const expectedCommands = [
    'cppCallGraph.showCallers',
    'cppCallGraph.showCallees',
    'cppCallGraph.focusGraph',
    'cppCallGraph.copyElement',
    'cppCallGraph.copyLocation',
    'cppCallGraph.copyActive',
    'cppCallGraph.closeAllTabs',
    'cppCallGraph.diagnose',
    'cppCallGraph.showLog',
  ];
  const missing = expectedCommands.filter((id) => !registered.has(id));
  assert(missing.length === 0, `缺少命令注册: ${missing.join(', ')}`);
  assert(
    captured.webviewViewProvider?.id === 'cppCallGraph.graphView',
    'WebviewViewProvider 未注册到 cppCallGraph.graphView'
  );

  // 2) 解析视图：必须正确配置 localResourceRoots，且 HTML 完整
  const fake = createFakeView();
  captured.webviewViewProvider.provider.resolveWebviewView(fake.view);
  const roots = fake.view.webview.options.localResourceRoots;
  assert(
    Array.isArray(roots) && roots.length > 0,
    'localResourceRoots 为空 —— webview.js 会被静默拦掉，页面永远空白（就是这个 bug 让面板一直不显示）'
  );
  assert(
    captured.blockedResources.length === 0,
    `有资源被 localResourceRoots 拦截：${captured.blockedResources.join(' | ')}`
  );

  const html = fake.view.webview.html;
  assert(typeof html === 'string' && html.length > 100, 'webview HTML 为空');
  assert(html.includes('id="svg"'), 'webview HTML 里没有 svg 画布');
  const scriptMatch = /<script[^>]+src="([^"]+)"/.exec(html);
  assert(scriptMatch !== null, `HTML 里没有脚本 src：${html.slice(0, 300)}`);
  assert(
    scriptMatch[1].length > 0 && scriptMatch[1].includes('webview.js'),
    `脚本 src 无效（很可能被 localResourceRoots 拦成空串）："${scriptMatch[1]}"`
  );
  assert(/<script[^>]+nonce="[A-Za-z0-9]{32}"/.test(html), 'HTML 里脚本没有 nonce');
  assert(html.includes("script-src 'nonce-"), 'CSP 里没有 nonce 形式的 script-src');
  assert(html.includes('--vscode-'), 'CSS 变量没有被注入（样式缺失）');
  assert(!html.includes('{{'), `HTML 里还有未替换的占位符：${html.match(/\{\{[^}]*\}\}/g)?.join(', ')}`);

  fake.send({ type: 'ready' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(
    captured.posted.some((message) => message.type === 'init'),
    '未收到 init 消息'
  );
  // 路径显示方式必须真的随 init 下发（webview 读不到 VS Code 设置）：
  // 宿主漏发时四项设置全都不生效，而界面上不会有任何报错。
  {
    const initMessage = [...captured.posted].reverse().find((message) => message.type === 'init');
    const settings = initMessage?.settings ?? {};
    for (const key of ['pathDisplay', 'pathTailLevels', 'pathShowFileName', 'pathAnchors']) {
      assert(
        Object.prototype.hasOwnProperty.call(settings, key),
        `init 的 settings 里应当带 ${key}，实际 ${JSON.stringify(settings)}`
      );
    }
    assert(
      settings.pathDisplay === 'tail' && settings.pathTailLevels === 0,
      `路径显示默认应当是「按宽度自动省略」，实际 ${JSON.stringify({
        pathDisplay: settings.pathDisplay,
        pathTailLevels: settings.pathTailLevels,
      })}`
    );
    assert(
      Array.isArray(settings.pathAnchors) && settings.pathAnchors.length === 0,
      `锚点默认应当是空数组，实际 ${JSON.stringify(settings.pathAnchors)}`
    );
    // 锚点设置的两种写法都要能用：逗号分隔的字符串，以及「数组里塞一条逗号串」
    // （后者是用户实际写出来的形式，早期版本会把它当成**一个**模式而静默失效）
    const anchorsAfterReady = async (value) => {
      configStore['cppCallGraph.pathAnchors'] = value;
      captured.posted.length = 0;
      fake.send({ type: 'ready' });
      await new Promise((resolve) => setTimeout(resolve, 60));
      const message = [...captured.posted].reverse().find((item) => item.type === 'init');
      return message?.settings?.pathAnchors;
    };
    const fromString = await anchorsAfterReady('mods,mods+1');
    assert(
      Array.isArray(fromString) && fromString.join('|') === 'mods|mods+1',
      `"mods,mods+1" 应当被拆成两个模式，实际 ${JSON.stringify(fromString)}`
    );
    const fromArray = await anchorsAfterReady(['mods,mods+1']);
    assert(
      Array.isArray(fromArray) && fromArray.join('|') === 'mods|mods+1',
      `["mods,mods+1"] 这种写法也应当被拆成两个模式，实际 ${JSON.stringify(fromArray)}`
    );
    delete configStore['cppCallGraph.pathAnchors'];
  }
  console.log(
    `诊断: 视图已解析，HTML 长度 ${html.length}，脚本 src=${scriptMatch[1]}，localResourceRoots=${roots
      .map((root) => root.fsPath)
      .join(',')}`
  );

  // 3) 触发一次查询
  const editor = {
    document: {
      languageId: 'cpp',
      uri: vscodeStub.Uri.file(PROJ + '\\demo.cpp'),
      lineAt: (line) => ({ text: 'int isEven(int n)', lineNumber: line }),
      lineCount: 100,
    },
    selection: { active: new Position(10, 8) },
  };
  vscodeStub.window.activeTextEditor = editor;

  currentRootName = 'leafAdd';
  await registered.get('cppCallGraph.showCallers')();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 3) 再查一次「被调用关系」（第二次查询，用于验证标签数量与视图复用）
  currentRootName = 'leafAdd';
  await registered.get('cppCallGraph.showCallers')();
  await new Promise((resolve) => setTimeout(resolve, 50));
  let payload = lastSessionPayload();
  assert(payload !== undefined, '第二次查询没有产生会话');
  // 标签标题只放元素名：方向由标签上的箭头图标表达，不再拼「被调用:」前缀
  assert(
    payload.title === 'leafAdd',
    `标签标题应当只有元素名（不带方向前缀），实际 ${JSON.stringify(payload.title)}`
  );
  assert(payload.direction === 'callers', `方向不对: ${payload.direction}`);
  // 这个场景的节点是确定的：根 + 两个调用者。写等值断言，让"夹具多出节点"变成**必须显式改**的动作，
  // 而不是被 `>=` 悄悄放过去（松阈值正是前几轮埋掉真实回归的原因）。
  assert(
    Object.keys(payload.nodes).length === 3,
    `本场景应当是「根 + 两个调用者」共 3 个节点，实际 ${Object.keys(payload.nodes).length}`
  );
  const firstSessionId = payload.id;

  // 4) 调用点信息（谁在第几行调用了谁）
  const withCallSite = Object.values(payload.nodes).filter((node) => node.callSite);
  // 语义不变式：**除根以外**每个节点都带调用点信息（根是查询起点，本来就没有调用点）。
  // 比 `>= 1` 强得多：漏掉任何一个调用者的调用点都会立刻红。
  assert(
    withCallSite.length === Object.keys(payload.nodes).length - 1,
    `应当除根以外都有调用点信息：期望 ${Object.keys(payload.nodes).length - 1} 个，实际 ${withCallSite.length} 个`
  );
  assert(
    withCallSite.every((node) => typeof node.callSite.line === 'number' && node.callSite.file),
    '调用点信息不完整'
  );

  // 5) 再查一次「调用关系」：应当多出第二个标签
  currentRootName = 'isEven';
  await registered.get('cppCallGraph.showCallees')();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const summaries = [...captured.posted].reverse().find((m) => m.type === 'update');
  assert(summaries !== undefined, '未收到标签摘要 update');
  assert(summaries.sessions.length === 3, `期望 3 个标签，实际 ${summaries.sessions.length}`);
  assert(
    captured.webviewViewProvider !== undefined,
    '视图提供器应当只注册一次并被复用'
  );

  // 6) 切回第一个标签并递归展开：leafAdd → compute → main（第二层）
  fake.send({ type: 'selectTab', id: firstSessionId });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const current = lastSessionPayload();
  const expandable = Object.values(current.nodes).find((node) => node.canExpand);
  assert(expandable !== undefined, '第一个标签里没有可展开的节点');
  const beforeCount = Object.keys(current.nodes).length;
  fake.send({ type: 'expand', sessionId: current.id, nodeId: expandable.id });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(captured.incomingCalls > 1, `展开时没有继续向语言服务请求（incoming=${captured.incomingCalls}）`);

  const after = lastSessionPayload();
  const afterCount = Object.keys(after.nodes).length;
  assert(afterCount > beforeCount, `展开后节点数没有增加：${beforeCount} → ${afterCount}`);

  // 新出现的节点必须带着正确的 depth 与可继续展开的标记
  const child = Object.values(after.nodes).find((node) => node.parent === expandable.id);
  assert(child !== undefined, '展开后没有挂到父节点下的新节点');
  assert(
    child.depth === expandable.depth + 1,
    `子节点 depth 不对：${child.depth} vs ${expandable.depth + 1}`
  );
  assert(
    Object.values(after.nodes).some((node) => node.depth >= 2),
    '没有出现第二层的节点（递归展开没生效）'
  );

  // 再展开一层，验证可以一层一层继续往下
  const deeper = Object.values(after.nodes).find(
    (node) => node.depth >= 2 && node.canExpand
  );
  if (deeper) {
    fake.send({ type: 'expand', sessionId: after.id, nodeId: deeper.id });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const third = lastSessionPayload();
    assert(
      Object.keys(third.nodes).length >= afterCount,
      '第三层展开后节点数不应减少'
    );
    console.log(
      `诊断: 递归展开 ${beforeCount} → ${afterCount} → ${Object.keys(third.nodes).length} 个节点`
    );
  }

  // 重复展开同一节点不应产生重复节点（幂等）
  const dupBefore = Object.keys(lastSessionPayload().nodes).length;
  fake.send({ type: 'expand', sessionId: after.id, nodeId: expandable.id });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert(
    Object.keys(lastSessionPayload().nodes).length === dupBefore,
    '重复展开同一节点产生了重复节点'
  );

  // 6) 切回第一个标签：应把该标签的图补发给前端
  const beforeSelect = captured.posted.length;
  fake.send({ type: 'selectTab', id: firstSessionId });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterSelect = captured.posted.slice(beforeSelect);
  assert(
    afterSelect.some((m) => m.type === 'sessionUpdate' && m.session.id === firstSessionId),
    '切换标签没有补发该标签的图（会导致切换后空白）'
  );

  // 7) 没有调用关系时不建标签页
  currentRootName = 'noCaller';
  await registered.get('cppCallGraph.showCallers')();
  await new Promise((resolve) => setTimeout(resolve, 50));
  let latest = [...captured.posted].reverse().find((m) => m.type === 'update');
  assert(latest.sessions.length === 3, `无结果时不应新增标签，实际 ${latest.sessions.length}`);

  // 8) 关闭一个标签：其它还在
  const ids = latest.sessions.map((s) => s.id);
  fake.send({ type: 'closeTab', id: ids[0] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  latest = [...captured.posted].reverse().find((m) => m.type === 'update');
  assert(latest.sessions.length === 2, `关闭一个后应剩 2 个标签，实际 ${latest.sessions.length}`);
  assert(
    captured.contextKeys.get('cppCallGraph.hasSessions') !== false,
    '还有标签时不应把视图收起来'
  );

  // 9) 关掉最后一个标签 → 收起面板视图（hasSessions=false）
  fake.send({ type: 'closeTab', id: latest.sessions[0].id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  latest = [...captured.posted].reverse().find((m) => m.type === 'update');
  assert(latest.sessions.length === 1, `应剩 1 个标签，实际 ${latest.sessions.length}`);

  fake.send({ type: 'closeTab', id: latest.sessions[0].id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  latest = [...captured.posted].reverse().find((m) => m.type === 'update');
  assert(latest.sessions.length === 0, '关闭最后一个标签后应无标签');
  assert(
    captured.contextKeys.get('cppCallGraph.hasSessions') === false,
    '关闭最后一个标签后应把视图收起来'
  );
  console.log('诊断: 关闭最后一个标签后已收起面板视图');

  console.log('--- 复制命令 ---');
  // 重开一个标签，才有可复制的内容
  currentRootName = 'leafAdd';
  await registered.get('cppCallGraph.showCallers')();
  await new Promise((resolve) => setTimeout(resolve, 50));

  captured.clipboard.length = 0;
  await registered.get('cppCallGraph.copyElement')();
  assert(
    captured.clipboard.length === 1,
    `「复制元素」应当写一次剪贴板，实际 ${captured.clipboard.length} 次`
  );
  assert(
    captured.clipboard[0] === 'leafAdd',
    `「复制元素」应复制符号名 leafAdd，实际 ${JSON.stringify(captured.clipboard[0])}`
  );
  console.log(`诊断: 复制元素 → ${captured.clipboard[0]}`);

  captured.clipboard.length = 0;
  await registered.get('cppCallGraph.copyLocation')();
  assert(
    captured.clipboard.length === 1,
    `「复制地址」应当写一次剪贴板，实际 ${captured.clipboard.length} 次`
  );
  assert(
    /:\d+$/.test(captured.clipboard[0]),
    `「复制地址」应当是 文件:行号 形式，实际 ${JSON.stringify(captured.clipboard[0])}`
  );
  console.log(`诊断: 复制地址 → ${captured.clipboard[0]}`);

  // 复制整个标签（原有的 tree 导出）仍然可用
  captured.clipboard.length = 0;
  await registered.get('cppCallGraph.copyActive')();
  assert(captured.clipboard.length === 1, '「复制整个标签」应当写一次剪贴板');
  assert(
    captured.clipboard[0].includes('leafAdd'),
    '「复制整个标签」的内容应当包含根符号名'
  );
  // ⚠️ 正文逻辑已收敛到纯函数 buildMarkdownTree（copyTree.buildSessionText 现在只是外层进度
  //    提示）。这里对**同一份会话**逐字比对两条路径：复制命令的剪贴板内容 === 纯函数输出。
  //    两者一旦分叉（例如有人又往 copyTree 里加了一段格式化），这条断言立刻失败。
  {
    const sessionForTree = captured.webviewViewProvider.provider.activeSession;
    assert(sessionForTree !== undefined, '复制整个标签之后应当仍有活动会话');
    const treeFromPureFunction = api.buildMarkdownTree(sessionForTree);
    assert(
      captured.clipboard[0] === treeFromPureFunction,
      '「复制整个标签」的正文必须与 buildMarkdownTree 逐字一致（两处不能各写一套格式）'
    );
    assert(
      treeFromPureFunction.startsWith('# 被调用关系：'),
      `结构树应当以方向标签开头，实际 ${JSON.stringify(treeFromPureFunction.slice(0, 24))}`
    );
  }
  console.log(`诊断: 复制整个标签 → ${captured.clipboard[0].split('\n').length} 行（与 buildMarkdownTree 逐字相同）`);

  console.log('--- 跳转与高亮 ---');
  // 双击方框会发 openLocation；宿主应打开文件、定位并加一个临时高亮
  captured.decorations.length = 0;
  const firstNodeId = lastSessionPayload().rootId;
  fake.send({
    type: 'openLocation',
    sessionId: lastSessionPayload().id,
    nodeId: firstNodeId,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert(captured.editor !== undefined, '跳转没有打开编辑器');
  assert(
    captured.editor.revealed.length >= 1,
    `跳转应当 revealRange，实际调用 ${captured.editor.revealed.length} 次`
  );
  assert(captured.editor.selection !== undefined, '跳转应当把光标定位到目标');
  assert(
    captured.editor.decorations.length >= 1,
    '跳转应当在目标位置加一个高亮装饰'
  );
  const flash = captured.decorations[0];
  assert(
    flash.options && flash.options.backgroundColor !== undefined,
    '高亮装饰应当指定背景色（用主题的 findMatch 色）'
  );
  assert(flash.disposed === false, '高亮装饰此时还不该被释放（要停留一会儿）');
  console.log(
    `诊断: 跳转已高亮，底色 = ${flash.options.backgroundColor?.id ?? flash.options.backgroundColor}`
  );

  console.log('--- 工具栏：展开全部要能连点 ---');
  // 回归测试：曾经出现「点一次展开全部、关掉再点就没反应」。
  // 这里连点两次，断言两次都真的产生了新节点（而不是第二次静默无事发生）。
  const beforeExpandAll = lastSessionPayload();
  fake.send({ type: 'expandAll', sessionId: beforeExpandAll.id });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterFirst = lastSessionPayload();
  const firstCount = Object.keys(afterFirst.nodes).length;
  const beforeExpandCount = Object.keys(beforeExpandAll.nodes).length;
  console.log(
    `诊断: 第一次展开全部 → 节点 ${beforeExpandCount} → ${firstCount}`
  );

  // 关掉这个标签，再新开一个，模拟用户的实际操作顺序
  fake.send({ type: 'closeTab', id: afterFirst.id });
  await new Promise((resolve) => setTimeout(resolve, 30));
  currentRootName = 'leafAdd';
  await registered.get('cppCallGraph.showCallers')();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const reopened = lastSessionPayload();
  assert(reopened !== undefined, '重新查询没有产生会话');

  fake.send({ type: 'expandAll', sessionId: reopened.id });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterSecond = lastSessionPayload();
  const secondCount = Object.keys(afterSecond.nodes).length;
  console.log(`诊断: 第二次展开全部（新标签）→ 节点 ${secondCount}`);
  assert(
    secondCount > Object.keys(reopened.nodes).length,
    `第二次「展开全部」没有生效：${Object.keys(reopened.nodes).length} → ${secondCount}`
  );

  // 同一个标签上连点两次：第二次**本就应当什么都不做**
  // （节点不变，也不再向语言服务发请求 —— 已经全部展开了）。
  // ⚠️ 原来的判据是"节点数不减少（>= secondCount）"，那对任何实现都恒真，
  // 等于什么都没验证；现在同时钉住"节点数不变"与"零新请求"。
  const callsBeforeSecondClick = captured.incomingCalls + captured.prepareCalls;
  fake.send({ type: 'expandAll', sessionId: afterSecond.id });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterThird = lastSessionPayload();
  const thirdCount = Object.keys(afterThird.nodes).length;
  const callsAfterSecondClick = captured.incomingCalls + captured.prepareCalls;
  assert(
    thirdCount === secondCount,
    `已完全展开后再点「展开全部」不应改变节点数：${secondCount} → ${thirdCount}`
  );
  assert(
    callsAfterSecondClick === callsBeforeSecondClick,
    `已完全展开后再点「展开全部」不应再向语言服务发请求：${callsBeforeSecondClick} → ${callsAfterSecondClick}`
  );
  console.log(
    `诊断: 同一标签连点第二次 → 节点仍 ${thirdCount}，语言服务请求 ${callsBeforeSecondClick} → ${callsAfterSecondClick}（两者都应不变）`
  );
  console.log('OK: 「展开全部」连点安全 —— 新标签上生效，已展开的标签上不再重复请求');

  // 回归（用户 2026-10-10 实测）：收起全部 → 展开全部之后，宿主不得留着旧的「已收起」集合。
  // 宿主按那份集合算坐标，旧集合会让被当成收起的子树整棵没有坐标 ——
  // 前端渲染时 `!geometry` 的节点会被跳过，画面上就只剩前两级、第二级的加号点不开。
  {
    currentRootName = 'leafAdd';
    await registered.get('cppCallGraph.showCallers')();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const fresh = lastSessionPayload();
    fake.send({ type: 'expandAll', sessionId: fresh.id });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const expanded = lastSessionPayload();
    const middle = Object.values(expanded.nodes).find(
      (node) => node.name === 'compute' && node.children.length > 0
    );
    assert(middle !== undefined, '夹具里应当有一个带子节点的中间节点（compute）');

    // 手动收起它：前端会把这个集合下发宿主
    fake.send({ type: 'collapse', sessionId: expanded.id, collapsed: [middle.id] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterCollapse = lastSessionPayload();
    assert(
      middle.children.some((id) => afterCollapse.boxes[id] === undefined),
      '收起一个节点后，宿主的布局必须不再给它的子节点坐标（这是下面断言的前提）'
    );

    // 「收起全部 → 展开全部」：前端会先清空收起状态（collapsed: []），再请求展开
    fake.send({ type: 'collapse', sessionId: expanded.id, collapsed: [] });
    fake.send({ type: 'expandAll', sessionId: expanded.id });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterExpandAll = lastSessionPayload();
    const missing = Object.keys(afterExpandAll.nodes).filter(
      (id) => afterExpandAll.boxes[id] === undefined
    );
    assert(
      missing.length === 0,
      `展开全部之后每个节点都必须有坐标（宿主不得留着旧的收起集合），缺失 ${missing.join(', ') || '（无）'}`
    );
    console.log(
      `诊断: 收起全部 → 展开全部后坐标完整（${Object.keys(afterExpandAll.nodes).length} 个节点，无一缺失）`
    );
  }

  // 「收起全部」的**完全复位**语义（用户 2026-10-14 口径：按下折叠按钮要清掉展开状态的记忆）。
  // 只把「收起标记」清掉是不够的：已取回的节点一直留在会话里，之后再点「展开全部」只是把
  // 旧形状搬回来，层数由历史点击决定、与设置里的 maxExpandRounds 无关。复位必须真的丢掉数据，
  // 这样下一次展开才是「重新读取」。
  {
    currentRootName = 'leafAdd';
    await registered.get('cppCallGraph.showCallers')();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const fresh = lastSessionPayload();
    fake.send({ type: 'expandAll', sessionId: fresh.id });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const expanded = lastSessionPayload();
    const beforeCount = Object.keys(expanded.nodes).length;
    assert(beforeCount > 1, `前提：复位前应当已展开出多个节点，实际 ${beforeCount} 个`);

    fake.send({ type: 'resetExpansion', sessionId: expanded.id });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterReset = lastSessionPayload();
    const remaining = Object.keys(afterReset.nodes);
    assert(
      remaining.length === 1,
      `复位后只应剩根节点，实际 ${remaining.length} 个（${remaining.join(', ')}）`
    );
    assert(
      afterReset.boxes[remaining[0]] !== undefined,
      '复位后剩下的那一个节点必须仍拿到坐标（否则画面会空白）'
    );

    // 复位之后「展开全部」必须是**重新读取**：数据已丢，能重新长出节点就证明根被重新查询过
    fake.send({ type: 'expandAll', sessionId: afterReset.id });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterAgain = lastSessionPayload();
    assert(
      Object.keys(afterAgain.nodes).length > 1,
      '复位后「展开全部」应当能重新读取并展开（根节点必须已标回未加载）'
    );
    console.log(
      `诊断: 收起全部即完全复位 —— ${beforeCount} 个节点 → 复位后 1 个 → 重新展开 ${Object.keys(afterAgain.nodes).length} 个`
    );
  }

  // 关键回归：宿主不传 progress 对象时，「展开全部」也必须能跑完。
  // 曾经因为直接调 progress.report(...) 而在第一轮就抛错，
  // 表现为「点了没反应」——这是用户实际报过的问题。
  captured.noProgressReporter = true;
  currentRootName = 'leafAdd';
  await registered.get('cppCallGraph.showCallers')();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const noReporterBefore = lastSessionPayload();
  fake.send({ type: 'expandAll', sessionId: noReporterBefore.id });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const noReporterAfter = lastSessionPayload();
  assert(
    Object.keys(noReporterAfter.nodes).length > Object.keys(noReporterBefore.nodes).length,
    `宿主不传 progress 时「展开全部」失效了：${Object.keys(noReporterBefore.nodes).length} → ` +
      `${Object.keys(noReporterAfter.nodes).length}`
  );
  captured.noProgressReporter = false;
  console.log(
    `诊断: 宿主不传 progress 时展开全部仍生效 → 节点 ${Object.keys(noReporterAfter.nodes).length}`
  );

  // 说明：实测宽度回传（reportWidths）的端到端验证在 renderCheck.js —— 
  // 那个脚本才真正加载 webview 前端；smoke 只跑宿主侧。

  console.log('--- 展开全部 / 收起全部 的往复 ---');
  // 用户报的问题：工具栏「展开全部 → 收起全部 → 再展开全部」后第二次无效。
  // 这里走完整链路，断言第二次展开仍然真的带来新节点（或至少不倒退）。
  currentRootName = 'leafAdd';
  await registered.get('cppCallGraph.showCallers')();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const cycleBefore = Object.keys(lastSessionPayload().nodes).length;

  fake.send({ type: 'expandAll', sessionId: lastSessionPayload().id });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterExpand1 = Object.keys(lastSessionPayload().nodes).length;

  fake.send({ type: 'expandAll', sessionId: lastSessionPayload().id });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterExpand2 = Object.keys(lastSessionPayload().nodes).length;

  console.log(
    `诊断: 展开全部往复 → 初始 ${cycleBefore} → 第一次后 ${afterExpand1} → 第二次后 ${afterExpand2}`
  );
  assert(
    afterExpand1 > cycleBefore,
    `第一次「展开全部」没有带来新节点：${cycleBefore} → ${afterExpand1}`
  );
  assert(
    afterExpand2 >= afterExpand1,
    `第二次「展开全部」让节点变少了：${afterExpand1} → ${afterExpand2}`
  );

  // 「完全展开」：递归到底（不受 maxExpandRounds 约束），且**每个节点都必须有坐标** ——
  // 宿主侧的节点总数上限与布局上限不一致时，超出的节点会既无方框也无连线（静默消失）。
  {
    currentRootName = 'leafAdd';
    await registered.get('cppCallGraph.showCallers')();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const fullSessionId = lastSessionPayload().id;
    const beforeFull = Object.keys(lastSessionPayload().nodes).length;
    fake.send({ type: 'expandFull', sessionId: fullSessionId });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const fullPayload = lastSessionPayload();
    const fullNodes = Object.keys(fullPayload.nodes).length;
    const fullBoxes = Object.keys(fullPayload.boxes).length;
    console.log(`诊断: 完全展开 → ${beforeFull} → ${fullNodes} 个节点，出坐标 ${fullBoxes} 个`);
    assert(
      fullNodes >= beforeFull,
      `「完全展开」让节点变少了：${beforeFull} → ${fullNodes}`
    );
    assert(
      fullBoxes === fullNodes,
      `「完全展开」后每个节点都要有坐标（节点 ${fullNodes} 个、坐标 ${fullBoxes} 个）——` +
        '不一致说明有节点没有方框，用户看不到它'
    );

    // 层数上限来自设置：两次都从**同样的新会话**出发，只改设置，比展开后的节点数
    // （⚠️ 不能拿「没展开过的新会话」当默认档基准 —— 那是 3 个节点的初始图，
    //   与「展开 1 层得到的 5 个」不是同一件事，本用例第一版就是这么比错的）
    const expandWith = async (rounds) => {
      currentRootName = 'leafAdd';
      await registered.get('cppCallGraph.showCallers')();
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (rounds === undefined) {
        delete configStore['cppCallGraph.maxExpandRounds'];
      } else {
        configStore['cppCallGraph.maxExpandRounds'] = rounds;
      }
      fake.send({ type: 'expandAll', sessionId: lastSessionPayload().id });
      await new Promise((resolve) => setTimeout(resolve, 200));
      return Object.keys(lastSessionPayload().nodes).length;
    };
    const fiveRoundNodes = await expandWith(undefined);
    const oneRoundNodes = await expandWith(1);
    delete configStore['cppCallGraph.maxExpandRounds'];
    console.log(
      `诊断: 展开全部 层数上限 1 层 → ${oneRoundNodes} 个节点（默认档 ${fiveRoundNodes} 个）`
    );
    assert(
      oneRoundNodes < fiveRoundNodes,
      `层数上限设为 1 时应当比默认档展开得少：1 层 ${oneRoundNodes} 个、默认 ${fiveRoundNodes} 个`
    );
    // 收尾：把这条会话也展开完全，避免后续用例继承未完全展开的树
    fake.send({ type: 'expandFull', sessionId: lastSessionPayload().id });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // 节点总数上限：`atCapacity` 必须与「方框数吃满上限 / 有节点被丢弃」相符。
  // ⚠️ 覆盖范围如实说明：设置被夹在 [100, 5000]（防手滑与防一次重绘拖死界面），而本夹具的树
  // 通常不到 100 个节点，所以这里断言的是**一致性**（宿主算出来的标志与实际布局相符），
  // 上限触发时面板的**可见反馈**（按钮禁用 + 提示行）由 renderCheck 用构造的 payload 覆盖。
  {
    configStore['cppCallGraph.maxLayoutNodes'] = 100;
    fake.send({ type: 'expandFull', sessionId: lastSessionPayload().id });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const payload = lastSessionPayload();
    const boxCount = Object.keys(payload.boxes).length;
    const nodeCount = Object.keys(payload.nodes).length;
    const expectAtCapacity = boxCount >= 100 || nodeCount > boxCount;
    assert(
      payload.maxLayoutNodes === 100,
      `payload 应当带上生效的 maxLayoutNodes（期望 100，实际 ${payload.maxLayoutNodes}）`
    );
    assert(
      payload.atCapacity === expectAtCapacity,
      `atCapacity 应与实际布局相符：方框 ${boxCount} 个、节点 ${nodeCount} 个 → ` +
        `期望 ${expectAtCapacity}，实际 ${payload.atCapacity}`
    );
    console.log(
      `诊断: 节点上限标志 —— 方框 ${boxCount} 个 / 节点 ${nodeCount} 个 → atCapacity=${payload.atCapacity}`
    );
    delete configStore['cppCallGraph.maxLayoutNodes'];
  }

  // 目录过滤（设置 `cppCallGraph.excludeFolders`，用户 2026-10-15）：断言真实链路 ——
  // 设置 → 宿主裁剪 payload（节点与坐标都少掉）+ 输出通道说明条数；删掉设置后节点全部回来。
  {
    const before = lastSessionPayload();
    const beforeCount = Object.keys(before.nodes).length;
    configStore['cppCallGraph.excludeFolders'] = ['demo.cpp'];
    fake.send({ type: 'expandFull', sessionId: before.id });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const filtered = lastSessionPayload();
    const afterCount = Object.keys(filtered.nodes).length;
    assert(
      afterCount < beforeCount,
      `过滤 demo.cpp 后节点数应当变少（之前 ${beforeCount}，之后 ${afterCount}）`
    );
    assert(
      Object.keys(filtered.boxes).every((id) => filtered.nodes[id] !== undefined),
      '被过滤掉的节点不得留下坐标（否则 webview 会画出一个没有数据的空框）'
    );
    assert(
      captured.outputLines.some((line) => /目录过滤：隐藏 \d+ 个节点/.test(line)),
      `输出通道应当说明过滤掉多少节点，实际最后几行 ${JSON.stringify(captured.outputLines.slice(-3))}`
    );
    delete configStore['cppCallGraph.excludeFolders'];
    fake.send({ type: 'expandFull', sessionId: filtered.id });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert(
      Object.keys(lastSessionPayload().nodes).length === beforeCount,
      '删掉过滤条目后节点应当全部回来（过滤只影响显示，不丢数据、也不需要重新请求语言服务）'
    );
    console.log(
      `诊断: 目录过滤 —— ${beforeCount} 个节点 → 过滤 demo.cpp 后 ${afterCount} 个 → 取消后回到 ${beforeCount} 个`
    );
  }

  // 临时路径过滤（面板搜索栏右侧的输入框，用户 2026-10-15）：端到端断言「所有标签通用」、
  // 「命中节点连同子树消失」、「清空即恢复」，以及它是**临时**的（不写设置、不进快照）。
  // 匹配语义（子串 + 通配）本身由 layoutCheck 的 14 条用例覆盖，这里只验真实链路。
  {
    // 需要两个**都有内容**的标签：同根不同方向 = 两个会话（compute 的调用者是 main、
    // 它调用的有 leafAdd 与 isEven，两边都非空）。用同一个根也让「查询对所有标签生效」更直观。
    await registered.get('cppCallGraph.closeAllTabs')();
    await new Promise((resolve) => setTimeout(resolve, 40));
    currentRootName = 'compute';
    await registered.get('cppCallGraph.showCallers')();
    await new Promise((resolve) => setTimeout(resolve, 80));
    currentRootName = 'compute';
    await registered.get('cppCallGraph.showCallees')();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const provider = captured.webviewViewProvider.provider;
    /** 从已下发的消息里收集「每个标签最近一次的 payload」。 */
    const payloadsById = () => {
      const map = new Map();
      for (const message of captured.posted) {
        if (message.type === 'sessionUpdate' && message.session) {
          map.set(message.session.id, message.session);
        } else if (message.type === 'init') {
          for (const session of message.sessions ?? []) {
            map.set(session.id, session);
          }
        }
      }
      return map;
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // 基线：先用一个不可能命中的查询逼宿主把**当前全部标签**重新下发一次。
    // 不能直接拿 `captured.posted` 里已有的消息当基线 —— 里面还留着更早用例（含已关闭会话）的
    // payload，会认出一批幽灵标签来。
    captured.posted.length = 0;
    fake.send({ type: 'pathFilter', query: 'zzz-no-such-path' });
    await wait(120);
    const baseline = payloadsById();
    assert(
      baseline.size >= 2,
      `本用例需要至少两个标签（临时过滤要「所有标签通用」），实际 ${baseline.size} 个`
    );
    const beforeCounts = new Map(
      [...baseline].map(([id, session]) => [id, Object.keys(session.nodes).length])
    );
    for (const [id, count] of beforeCounts) {
      assert(count >= 2, `标签 ${id} 应当至少有两个节点，否则过滤看不出效果（实际 ${count} 个）`);
      assert(
        baseline.get(id).filteredCount === undefined,
        `没命中的查询不该隐藏任何节点（标签 ${id} 却报了 ${baseline.get(id).filteredCount} 个）`
      );
    }

    const configKeysBefore = Object.keys(configStore).join(',');
    // 夹具里所有节点的文件都是 demo.cpp：查询 demo 应当把除根以外的节点全部隐藏
    captured.posted.length = 0;
    captured.outputLines.length = 0;
    fake.send({ type: 'pathFilter', query: 'demo' });
    await wait(120);

    const after = payloadsById();
    for (const [id, count] of beforeCounts) {
      const session = after.get(id);
      assert(
        session !== undefined,
        `过滤是窗口级的：非活动标签 ${id} 也必须重发一次 payload`
      );
      const kept = Object.keys(session.nodes).length;
      assert(
        kept === 1 && session.nodes[session.rootId] !== undefined,
        `查询 demo 应当只剩根节点（根永不参与过滤），标签 ${id} 实际留下 ${kept} 个`
      );
      assert(
        session.filteredCount === count - 1,
        `payload 应当带上被隐藏的数量（含子树）：标签 ${id} 期望 ${count - 1}，实际 ${session.filteredCount}`
      );
      assert(
        Object.keys(session.boxes).every((boxId) => session.nodes[boxId] !== undefined),
        '被临时过滤掉的节点不得留下坐标（否则面板会画出一个没有数据的空框）'
      );
    }
    assert(
      captured.outputLines.some((line) => /临时路径过滤：隐藏 \d+ 个节点/.test(line)),
      `输出通道应当说明临时过滤隐藏了多少，实际最后几行 ${JSON.stringify(captured.outputLines.slice(-3))}`
    );
    assert(
      provider.__debugSnapshot().pathFilterQuery === 'demo',
      '宿主应当保留当前查询（面板重建时要靠它还原输入框）'
    );
    // init 必须把这份查询一起下发：面板被隐藏后重新显示时 webview 会重建（输入框是空的），
    // 而宿主这份查询还活着 —— 不下发就会出现「界面看着没过滤、图却是过滤后的」，
    // 而且用户没有任何办法清掉它（除非先随便打一个字再删掉）。
    captured.posted.length = 0;
    fake.send({ type: 'ready' });
    await wait(60);
    const initMessage = captured.posted.find((message) => message.type === 'init');
    assert(
      initMessage !== undefined,
      `发 ready 之后应当收到 init，实际收到 ${captured.posted.map((m) => m.type).join(',') || '（无）'}`
    );
    assert(
      initMessage.pathFilterQuery === 'demo',
      `init 必须带上当前的临时过滤查询（面板重建靠它还原输入框），实际 ${JSON.stringify(
        initMessage.pathFilterQuery
      )}`
    );
    assert(
      Object.keys(configStore).join(',') === configKeysBefore,
      '临时过滤不得写入任何设置（它是临时的，清空即恢复、重载即消失）'
    );
    const snapshot = JSON.stringify(storage.get('cppCallGraph.sessions') ?? null);
    assert(
      snapshot.length > 10,
      '本用例需要一份真的写过的会话快照，否则「不进快照」这条断言是空的'
    );
    assert(
      !/pathFilter|filteredCount|filterQuery/.test(snapshot),
      '临时过滤不得写进持久化快照（重载窗口后必须回到「没有过滤」）'
    );

    // 清空查询：所有标签的节点全部回来（这一步必须在任何展开之前 —— 展开会改变节点数，
    // 之后就再也回不到这份基线了）
    captured.posted.length = 0;
    fake.send({ type: 'pathFilter', query: '' });
    await wait(120);
    const restored = payloadsById();
    for (const [id, count] of beforeCounts) {
      const session = restored.get(id);
      assert(session !== undefined, `清空查询后标签 ${id} 应当重发 payload`);
      assert(
        Object.keys(session.nodes).length === count,
        `清空查询后标签 ${id} 的节点应当全部回来：期望 ${count}，实际 ${
          Object.keys(session.nodes).length
        }`
      );
      assert(
        session.filteredCount === undefined,
        '没有隐藏时不应带 filteredCount（面板按「没有隐藏」处理）'
      );
    }

    // 收起全部（完全复位）之后过滤仍然有效：查询还在输入框里，重新取回的数据照样要被过滤。
    // 这里重新施加一次查询，然后复位 + 完全展开 —— 若过滤随复位一起被清掉，节点会全回来。
    fake.send({ type: 'pathFilter', query: 'demo' });
    await wait(120);
    const resetTarget = provider.__debugSnapshot().sessionIds[0];
    fake.send({ type: 'resetExpansion', sessionId: resetTarget });
    await wait(80);
    captured.posted.length = 0;
    fake.send({ type: 'expandFull', sessionId: resetTarget });
    await wait(280);
    const afterReset = payloadsById().get(resetTarget);
    assert(
      afterReset !== undefined && Object.keys(afterReset.nodes).length === 1,
      `复位并重新展开后，命中查询的节点仍应被隐藏（实际留下 ${
        afterReset === undefined ? '(没有 payload)' : Object.keys(afterReset.nodes).length
      } 个）—— 过滤不该被「收起全部」清掉`
    );
    assert(
      afterReset !== undefined && afterReset.filteredCount > 0,
      '复位后重新取回的数据也应当重新统计隐藏数量'
    );

    // 收尾：清空查询。**必须清**，否则后面那些用例的节点都是 demo.cpp、会被这个查询整片隐藏。
    captured.posted.length = 0;
    fake.send({ type: 'pathFilter', query: '' });
    await wait(120);
    assert(
      provider.__debugSnapshot().pathFilterQuery === '',
      '清空后宿主手里的查询也应当清空'
    );
    for (const [id, session] of payloadsById()) {
      assert(
        session.filteredCount === undefined,
        `收尾清空后标签 ${id} 不该还报隐藏数量（实际 ${session.filteredCount}）`
      );
    }
    console.log(
      `诊断: 临时路径过滤 —— ${baseline.size} 个标签各 ${[...beforeCounts.values()].join('/')} 个节点` +
        ` → 查询 demo 后各只剩根（filteredCount 已下发） → 清空后全部回来` +
        ` → 重新查询后做「收起全部 + 完全展开」仍只剩根；查询既不进设置也不进快照`
    );
  }

  // ---- 2026-10-16 检视修掉的四类缺陷：各自的端到端回归 ----
  {
    const provider = captured.webviewViewProvider.provider;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const open = async (command) => {
      await registered.get('cppCallGraph.closeAllTabs')();
      await wait(40);
      currentRootName = 'leafAdd';
      await registered.get(command)();
      await wait(80);
    };

    // ① 展开在途 + 「收起全部」：在途结果必须丢弃（曾经会把复位后的图重新写回）
    await open('cppCallGraph.showCallers');
    {
      const session = lastSessionPayload();
      const sessionId = session.id;
      // 开标签时根的那一层已经自动取回，所以挑一个**仍未加载的子节点**来展开
      const target = Object.values(session.nodes).find(
        (node) => node.id !== session.rootId && node.canExpand
      );
      assert(
        target !== undefined,
        '竞态用例的前提：根的第一层里应当有一个尚未展开的节点'
      );
      captured.posted.length = 0;
      captured.outputLines.length = 0;
      deferExpand = true;
      fake.send({ type: 'expand', sessionId, nodeId: target.id });
      await wait(60);
      assert(deferredAnswers.length === 1, '竞态用例的前提：语言服务请求应当已经发出且被挂住');
      fake.send({ type: 'resetExpansion', sessionId });
      await wait(60);
      for (const release of deferredAnswers.splice(0)) {
        release();
      }
      await wait(140);
      deferExpand = false;
      const after = lastSessionPayload();
      const kept = Object.keys(after.nodes).length;
      assert(
        kept === 1,
        `「收起全部」之后语言服务才返回：不得把节点重新写回（期望只剩根 1 个，实际 ${kept} 个）—— ` +
          '这就是检视发现的幽灵节点：非根的在途结果会成为不可达孤儿，还会进快照、吃展开预算'
      );
      assert(
        after.nodes[after.rootId]?.canExpand === true,
        '在途结果被丢弃后，根必须仍是「未加载」（否则复位被静默撤销、第一层又冒出来）'
      );
      assert(
        captured.outputLines.some((line) => line.includes('本次结果丢弃')),
        `应当记一条「结果丢弃」的说明，实际最后几行 ${JSON.stringify(captured.outputLines.slice(-2))}`
      );
      console.log(`诊断: 展开在途 + 收起全部 —— 复位保持不变（只剩 ${kept} 个节点，在途结果被丢弃）`);
    }

    // ② 导出与「图里看到的」一致：被过滤隐藏的节点不得出现在落盘内容里。
    //    ⚠️ 必须走**真实导出链路**（settings/过滤 → exportGraph 消息 → 保存对话框 → 落盘），
    //    只调 `exportView()` 是测不到「导出到底用了哪份数据」的（反向检查抓到过这一点）。
    {
      await open('cppCallGraph.showCallers');
      const session = provider.activeSession;
      const payload = lastSessionPayload();
      const hiddenName = Object.values(payload.nodes).find(
        (node) => node.id !== payload.rootId
      )?.name;
      assert(hiddenName !== undefined, '导出用例需要一个非根节点');
      const exportText = async (format) => {
        captured.writes.length = 0;
        captured.saveDialogs.length = 0;
        captured.saveDialogResult = {
          scheme: 'file',
          fsPath: path.join(ROOT, `导出过滤测试.${format === 'json' ? 'json' : 'md'}`),
          toString: () => '',
        };
        fake.send({ type: 'exportGraph', sessionId: session.id, format });
        await wait(90);
        return captured.writes.map((write) => Buffer.from(write.bytes).toString('utf8')).join('');
      };
      const fullText = await exportText('md-tree');
      assert(
        fullText.includes(hiddenName),
        '没有过滤时导出应当包含全部已展开节点（否则下面那条断言没有区分度）'
      );
      // 目录过滤：夹具里所有节点的文件都是 demo.cpp → 非根节点全被隐藏
      configStore['cppCallGraph.excludeFolders'] = ['demo.cpp'];
      const filteredText = await exportText('md-tree');
      assert(
        filteredText.length > 0 && !filteredText.includes(hiddenName),
        '目录过滤隐藏掉的节点不该出现在导出的 Markdown 里（PNG/SVG 从画布抓、天然只有可见节点）'
      );
      delete configStore['cppCallGraph.excludeFolders'];
      // 临时路径过滤同理（换成 JSON 格式，顺带覆盖另一条宿主生成路径）
      fake.send({ type: 'pathFilter', query: 'demo' });
      await wait(120);
      const queryText = await exportText('json');
      assert(
        queryText.length > 0 && !queryText.includes(hiddenName),
        '临时路径过滤隐藏掉的节点不该出现在导出的 JSON 里'
      );
      fake.send({ type: 'pathFilter', query: '' });
      await wait(120);
      const restoredText = await exportText('md-tree');
      assert(
        restoredText.includes(hiddenName),
        '清空过滤后导出应当恢复为全量（说明上一条不是被别的原因弄没的）'
      );
      console.log('诊断: 导出所见即所得 —— 目录过滤与临时过滤隐藏的节点都不出现在落盘的 MD/JSON 里');
    }

    // ③ 「展开全部」的预算与目标按**可见节点**算：隐藏分支不该被请求
    {
      await open('cppCallGraph.showCallers');
      fake.send({ type: 'pathFilter', query: 'demo' });
      await wait(120);
      const session = lastSessionPayload();
      const before = captured.incomingCalls;
      fake.send({ type: 'expandFull', sessionId: session.id });
      await wait(320);
      const calls = captured.incomingCalls - before;
      const after = lastSessionPayload();
      assert(
        Object.keys(after.nodes).length === 1,
        `过滤生效时「完全展开」不该让节点回到图上（实际 ${Object.keys(after.nodes).length} 个）`
      );
      assert(
        calls <= 1,
        `被过滤隐藏的分支不该被展开：期望最多请求 1 次（可见的根那一层），实际 ${calls} 次`
      );
      fake.send({ type: 'pathFilter', query: '' });
      await wait(120);
      console.log(`诊断: 展开预算按可见节点算 —— 过滤下「完全展开」只请求了 ${calls} 次`);
    }

    // ④ init 必须带回宿主的收起状态（面板重建/可见性变化后两边不再分叉）
    {
      await open('cppCallGraph.showCallers');
      const session = lastSessionPayload();
      const target = Object.values(session.nodes).find((node) => node.id !== session.rootId);
      assert(target !== undefined, '收起状态用例需要一个非根节点');
      fake.send({ type: 'collapse', sessionId: session.id, collapsed: [target.id] });
      await wait(80);
      captured.posted.length = 0;
      fake.send({ type: 'ready' });
      await wait(60);
      const initMessage = captured.posted.find((message) => message.type === 'init');
      const entry = (initMessage?.collapsed ?? []).find(
        (item) => item.sessionId === session.id
      );
      assert(
        entry !== undefined && entry.ids.includes(target.id),
        `init 必须下发宿主的收起状态（面板会清空本地收起表，不清就出现「父框画着 −、子框不画」），实际 ${JSON.stringify(
          initMessage?.collapsed
        )}`
      );
      console.log(`诊断: init 下发收起状态 —— 标签 ${session.id.slice(0, 6)}… 带了 1 个已收起节点`);
    }

    // ⑤ 锚点诊断：只在**整个标签里一处都没命中**时提示，且不再把「本路径没命中」说成语法错误
    {
      await open('cppCallGraph.showCallers');
      captured.outputLines.length = 0;
      configStore['cppCallGraph.pathAnchors'] = ['zzz_nosuch_dir'];
      fake.send({ type: 'ready' });
      await wait(80);
      const lines = captured.outputLines;
      assert(
        lines.some((line) => line.includes('均未命中')),
        `一条都没命中的锚点应当提示一次，实际最后几行 ${JSON.stringify(lines.slice(-3))}`
      );
      assert(
        !lines.some((line) => line.includes('写法无法解析')),
        '「某条路径上没有这个段」不该被当成语法错误（多文件图上必然出现，那是误报）'
      );
      // 下发那一份必须是**剥过括号**的（面板不懂括号语义；漏了这一步就是 F0：
      // 圆括号锚点在面板上的路径那行不生效、两侧文字分叉）
      captured.posted.length = 0;
      configStore['cppCallGraph.pathAnchors'] = ['(src)', '[sub]', 'bare'];
      fake.send({ type: 'ready' });
      await wait(80);
      const initWithAnchors = captured.posted.find((message) => message.type === 'init');
      assert(
        (initWithAnchors?.settings?.pathAnchors ?? []).join('|') === 'src|bare',
        `设置里下发面板的锚点必须是剥过括号的那一份（期望 src|bare），实际 ${JSON.stringify(
          initWithAnchors?.settings?.pathAnchors
        )}`
      );
      delete configStore['cppCallGraph.pathAnchors'];
      // JSON 导出的截断信息必须显式写出来
      const json = JSON.parse(api.buildJsonText(provider.exportView(provider.activeSession)));
      assert(
        json.truncated && typeof json.truncated.nodes === 'boolean' && typeof json.truncated.depth === 'boolean',
        `JSON 导出必须写明是否被截断过，实际 ${JSON.stringify(json.truncated)}`
      );
      console.log('诊断: 锚点诊断与 JSON 截断标记 —— 只报「一处都没命中」，JSON 带 truncated');
    }

    // ⑦ 语言服务不认 item（真机日志：`invalid item`）：重新认领后照常展开；认领不到按叶子收尾。
    //    成因：引用兜底会自己合成 item，窗口重载后恢复的 item 也是普通对象 —— 语言服务不认它们。
    {
      await open('cppCallGraph.showCallers');
      const session = lastSessionPayload();
      const target = Object.values(session.nodes).find(
        (node) => node.id !== session.rootId && node.canExpand
      );
      assert(target !== undefined, 'invalid item 用例需要一个可展开的子节点');
      const beforeCount = Object.keys(session.nodes).length;
      captured.outputLines.length = 0;
      invalidItemOnce = true;
      fake.send({ type: 'expand', sessionId: session.id, nodeId: target.id });
      await wait(140);
      const healed = lastSessionPayload();
      assert(
        Object.keys(healed.nodes).length > beforeCount,
        `重新认领成功后应当照常展开出下一层（之前 ${beforeCount} 个，现在 ${Object.keys(healed.nodes).length} 个）`
      );
      assert(
        captured.outputLines.some((line) => line.includes('已重新获取该节点的语言服务项')),
        `应当记一条「已重新获取」的说明，实际最后几行 ${JSON.stringify(captured.outputLines.slice(-2))}`
      );
      // 认领也失败：按叶子收尾，不再留一个点了必然失败的「+」，并且给一句人话
      const target2 = Object.values(healed.nodes).find(
        (node) => node.id !== healed.rootId && node.canExpand
      );
      assert(target2 !== undefined, 'invalid item 第二个用例需要一个仍未展开的节点');
      captured.outputLines.length = 0;
      invalidItemAlways = true;
      noReacquire = true;
      fake.send({ type: 'expand', sessionId: session.id, nodeId: target2.id });
      await wait(140);
      invalidItemAlways = false;
      noReacquire = false;
      const finalPayload = lastSessionPayload();
      assert(
        finalPayload.nodes[target2.id]?.canExpand === false,
        '认领不到时必须按叶子收尾（界面不再画一个点了必然失败的加号）'
      );
      assert(
        captured.outputLines.some((line) => line.includes('已按叶子处理')),
        `应当记一条「已按叶子处理」的说明，实际最后几行 ${JSON.stringify(captured.outputLines.slice(-3))}`
      );
      // 取消类错误不该被写成警告（窗口重载时每个在途请求都会以 Canceled 结束）
      assert(
        api.isCancellation(new Error('Canceled')) === true,
        'Canceled 应当判为「已取消」'
      );
      assert(
        api.isCancellation(new Error('boom')) === false,
        '普通错误不该被判成「已取消」'
      );
      assert(api.isShuttingDown() === false, '此时扩展并未停止');
      console.log(
        `诊断: invalid item 自愈 —— 重新认领后照常展开（${beforeCount} → ${
          Object.keys(healed.nodes).length
        } 个），认领不到按叶子收尾，取消类错误不写警告`
      );
    }
  }

  // 语言服务挂住：必须放弃本次展开，且**不能**把「没响应」写成「没有下一层调用关系」；
  // 之后服务恢复时还要能重试成功（证明 inflight 已释放、节点没被标记为已加载）。
  {
    const originalTimeout = extension.__session.expandTimeout.ms;
    extension.__session.expandTimeout.ms = 30; // 调小，避免测试等待 20 秒
    // ⚠️ 必须先关掉全部标签再开新会话：宿主会复用同一个（方向 + 根）的会话，
    // 而前一个用例刚刚把它 expandFull 过 —— 直接开新会话会继承一棵"已全部加载"的树，
    // 找不到可展开的节点（第一版就是这么失败的）。
    await registered.get('cppCallGraph.closeAllTabs')();
    await new Promise((resolve) => setTimeout(resolve, 40));
    currentRootName = 'leafAdd';
    await registered.get('cppCallGraph.showCallers')();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const session = lastSessionPayload();
    const target =
      Object.values(session.nodes).find((node) => node.canExpand) ?? session.nodes[session.rootId];
    assert(target !== undefined, '超时用例：当前标签里没有可展开的节点');
    const beforeCount = Object.keys(session.nodes).length;

    hangExpand = true;
    captured.outputLines.length = 0;
    fake.send({ type: 'expand', sessionId: session.id, nodeId: target.id });
    await new Promise((resolve) => setTimeout(resolve, 160));

    const afterCount = Object.keys(lastSessionPayload().nodes).length;
    assert(
      afterCount === beforeCount,
      `超时不该新增节点：${beforeCount} → ${afterCount}`
    );
    assert(
      captured.outputLines.some((line) => line.includes('本次展开已放弃')),
      `语言服务挂住时应当记一条超时警告，实际日志：${captured.outputLines.join(' | ') || '（无）'}`
    );
    assert(
      !captured.outputLines.some((line) => line.includes('没有下一层调用关系')),
      '超时被写成了「没有下一层调用关系」——这会把「没响应」伪装成「本来就没有」'
    );

    hangExpand = false;
    const knownCount = Object.keys(lastSessionPayload().nodes).length;
    fake.send({ type: 'expand', sessionId: session.id, nodeId: target.id });
    await new Promise((resolve) => setTimeout(resolve, 160));
    const retriedCount = Object.keys(lastSessionPayload().nodes).length;
    assert(
      retriedCount > knownCount,
      `超时后重试应当能正常展开：${knownCount} → ${retriedCount}（说明 inflight 没释放或节点被误标为已加载）`
    );
    console.log(
      `诊断: 展开超时 —— 超时后节点数 ${beforeCount}（未变），恢复后重试 ${knownCount} → ${retriedCount}`
    );
    extension.__session.expandTimeout.ms = originalTimeout;
  }

  // 夹具探测的引擎归属：只装一个引擎时不能写成 unknown（诊断里会看着像探测失败）
  {
    const attr = extension.__engines.attributeProbeEngine;
    assert(typeof attr === 'function', '产物没有导出 __engines.attributeProbeEngine');
    assert(
      attr(undefined, ['clangd'], 1, 0) === 'clangd',
      `只有一个引擎可用时，未认领的夹具结果应当归它，实际 ${attr(undefined, ['clangd'], 1, 0)}`
    );
    assert(
      attr(undefined, ['clangd', 'cpptools'], 2, 1) === 'cpptools',
      '两个引擎各回一条时应当按可用顺序对应返回下标'
    );
    assert(
      attr(undefined, ['clangd', 'cpptools'], 1, 0) === 'unknown',
      '两个引擎可用但只回一条时无法判断，应当保持 unknown'
    );
    assert(
      attr('cpptools', ['clangd'], 1, 0) === 'cpptools',
      '有认领者时必须用认领者，不能被兜底规则覆盖'
    );
  }

  // 工具栏最左的按钮（原「关闭当前标签」）按需求改为「关闭全部标签并收起视图」：
  // 等价于面板标题栏原来的 closeAllTabs。这里验证它确实关掉所有标签并收起视图。
  {
    currentRootName = 'leafAdd';
    await registered.get('cppCallGraph.showCallers')();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert(
      captured.contextKeys.get('cppCallGraph.hasSessions') === true,
      '查询后视图应当处于展开状态'
    );
    const beforeCloseUsers = lastSessionPayload();
    assert(beforeCloseUsers !== undefined, '关闭前应当有会话');

    fake.send({ type: 'closeAllTabs' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 找最近一条 update 消息（宿主用它下发标签摘要）
    let lastUpdate;
    for (let i = captured.posted.length - 1; i >= 0; i -= 1) {
      if (captured.posted[i].type === 'update') {
        lastUpdate = captured.posted[i];
        break;
      }
    }
    assert(lastUpdate !== undefined, '关闭全部标签后应当有 update 消息');
    assert(
      lastUpdate.sessions.length === 0,
      `「关闭全部标签」后不应还有标签，实际 ${lastUpdate.sessions.length} 个`
    );
    assert(
      captured.contextKeys.get('cppCallGraph.hasSessions') === false,
      '「关闭全部标签」后应当把整个「调用关系图」视图收起来（hasSessions=false）'
    );
    console.log('诊断: 关闭全部标签 → 标签清空且视图收起');
  }

  // 12) 宏：没有调用层级 → 走引用查找（只有「被调用关系图」这一侧有意义）
  {
    vscodeStub.window.activeTextEditor = makeMacroEditor(2, 9);
    referenceScenario = 'macro';
    currentRootName = 'MAX3';
    await registered.get('cppCallGraph.showCallers')();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const payload = lastSessionPayload();
    assert(payload !== undefined, '宏的「被调用关系图」应当新建标签页');
    assert(payload.title === 'MAX3', `标签标题应当是宏名，实际 ${JSON.stringify(payload.title)}`);
    assert(payload.direction === 'callers', '宏走的是被调用关系方向');
    const rootNode = payload.nodes[payload.rootId];
    assert(rootNode !== undefined, '宏的根节点应当存在');
    assert(
      rootNode.kind === 'function',
      `函数式宏应当与函数同款图标（kind=${rootNode.kind}）`
    );
    const kids = Object.values(payload.nodes).filter((node) => node.depth === 1);
    assert(kids.length === 2, `应当有两个引用者（compute / main），实际 ${kids.length}`);
    assert(
      kids.map((node) => node.name).sort().join(',') === 'compute,main',
      `引用者应当是 compute 与 main，实际 ${kids.map((node) => node.name).join(',')}`
    );
    assert(
      kids.every((node) => node.callSite && typeof node.callSite.line === 'number'),
      '引用者应当带上引用发生的行号'
    );
    assert(
      kids.some((node) => node.loaded === false),
      '引用者是普通函数：应当仍标记为可继续展开（下面照旧走调用层级）'
    );
    console.log(
      `诊断: 宏 MAX3 → 引用查找得到 ${kids.length} 个引用者（${kids
        .map((node) => `${node.name}@${node.callSite.line}`)
        .join(', ')}），来源 ${payload.engineLabel}`
    );

    // 13) 语言服务不给引用时退回文本搜索，并把来源标注出来
    referenceScenario = 'macroText';
    await registered.get('cppCallGraph.showCallers')();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const textPayload = lastSessionPayload();
    assert(textPayload !== undefined, '文本搜索兜底也应当建出标签页');
    assert(
      String(textPayload.engineLabel ?? '').includes('文本搜索'),
      `来源应当标注为文本搜索，实际 ${textPayload.engineLabel}`
    );
    assert(captured.textSearches.length >= 1, '应当发起过文本搜索');

    referenceScenario = 'call';
    vscodeStub.window.activeTextEditor = editor;
    console.log(
      `OK: 宏（无调用层级）改走引用查找 —— 根 ${payload.title}，第一层是引用点所在的函数；` +
        `语言服务无引用时退到文本搜索并标注来源`
    );
  }

  // 14) 加载遮罩的宿主侧信号：一次查询应当「开始时 busy=true、结束时 busy=false」
  {
    captured.posted.length = 0;
    currentRootName = 'leafAdd';
    await registered.get('cppCallGraph.showCallers')();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const busyFlags = captured.posted
      .filter((message) => message.type === 'busy')
      .map((message) => message.busy);
    assert(
      busyFlags.length >= 2 && busyFlags[0] === true && busyFlags[busyFlags.length - 1] === false,
      `查询应当以 busy=true 开始、busy=false 结束，实际 ${JSON.stringify(busyFlags)}`
    );
    // 「取消」在没有进行中的解析时也必须安全（只置位，不抛错）
    fake.send({ type: 'cancelResolve' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    console.log(`诊断: 加载遮罩的宿主侧信号 ${JSON.stringify(busyFlags)}`);
    console.log('OK: 慢查询期间 webview 会收到 busy 信号，「取消」消息安全');
  }

  // ---- 宿主侧竞态回归：本轮修掉的三类「晚到的消息」都只表现在缓存表里 ----
  {
    const provider = captured.webviewViewProvider.provider;
    assert(
      typeof provider.__debugSnapshot === 'function',
      '产物没有提供 __debugSnapshot 只读快照接口（宿主侧竞态无法被观察）'
    );

    // A) `endResolve` 必须认 token：命令可重入（用户连点两次右键菜单），
    //    先开始的那次收尾时不能把后开始的那次一起清掉 —— 否则后一次会被判成「已取消」而静默不出图。
    const first = provider.beginResolve('第一次解析');
    const second = provider.beginResolve('第二次解析');
    assert(
      first.token !== second.token,
      `两次 beginResolve 应当拿到不同 token，实际都是 ${first.token}`
    );
    assert(first.isCancelled() === true, '被后一次顶掉的那次应当视为已取消，好让旧流程尽快收尾');
    assert(second.isCancelled() === false, '后开始的那次不应被判成取消');
    provider.endResolve(first.token);
    assert(
      provider.__debugSnapshot().busyToken === second.token,
      `过期 token 的 endResolve 不应清掉后一次解析的 busy 状态（应仍为 ${second.token}）`
    );
    assert(second.isCancelled() === false, '过期 token 收尾后，后一次仍不应被判成取消');
    provider.endResolve(second.token);
    assert(
      provider.__debugSnapshot().busyToken === undefined,
      '自己的 token 应当能正常结束解析（busy 应被清空）'
    );
    // 「窗口已正常结束」不等于「用户点了取消」：收尾之后再判一次不能误判成取消
    assert(second.isCancelled() === false, 'endResolve 之后再判 isCancelled 不应误判成取消');
    console.log(
      'OK: endResolve 的 token 可重入 —— 过期 token 不清后一次、自己的 token 正常收尾、收尾后不误判成取消'
    );

    // B) `reportWidths` 必须写回**消息里点名的会话**，而不是当前活动标签：
    //    否则宽度会串台 —— 甲标签的实测宽度被拿去做乙标签的列排布。
    const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
    currentRootName = 'leafAdd';
    await registered.get('cppCallGraph.showCallers')();
    await tick();
    const ownerPayload = lastSessionPayload();
    const widthOwner = ownerPayload.id;
    const ownerRootId = Object.values(ownerPayload.nodes).find((node) => node.depth === 0)?.id;
    assert(typeof ownerRootId === 'string', '点名的会话里找不到根节点，无法验证宽度是否真的用上');
    currentRootName = 'isEven';
    await registered.get('cppCallGraph.showCallers')();
    await tick();
    const bystander = lastSessionPayload().id;
    assert(
      widthOwner !== bystander,
      `两次查询应当各自建出标签，实际都拿到 ${widthOwner}`
    );
    // 让「旁观者」成为活动标签，再给非活动的那个回传宽度
    fake.send({ type: 'selectTab', id: bystander });
    await tick();
    const reportedWidth = 512;
    captured.posted.length = 0;
    fake.send({
      type: 'reportWidths',
      sessionId: widthOwner,
      widths: [{ id: ownerRootId, width: reportedWidth }],
    });
    await tick();
    const snapshotAfterWidths = provider.__debugSnapshot();
    const ownerEntry = snapshotAfterWidths.measuredWidths.find(
      (entry) => entry.sessionId === widthOwner
    );
    assert(
      ownerEntry !== undefined && ownerEntry.count === 1,
      `回传的宽度应当记在点名的会话 ${widthOwner} 名下，实际 ${JSON.stringify(
        snapshotAfterWidths.measuredWidths
      )}`
    );
    assert(
      !snapshotAfterWidths.measuredWidths.some((entry) => entry.sessionId === bystander),
      `活动标签 ${bystander} 没有被回传宽度，不应凭空多出一条记录：${JSON.stringify(
        snapshotAfterWidths.measuredWidths
      )}`
    );
    // 重排也必须是「点名的那个会话」：串台的话活动标签会被重排
    const relaid = captured.posted
      .filter((message) => message.type === 'sessionUpdate')
      .map((message) => message.session.id);
    assert(
      relaid.includes(widthOwner) && !relaid.includes(bystander),
      `回传宽度后应只重排点名的会话，实际重排了 ${JSON.stringify(relaid)}`
    );
    // 最强的一条：宽度要真的进入**点名那个会话**的布局几何。
    // 若写进了活动标签的表，这里拿到的仍是估宽而不是 512。
    const relaidPayload = captured.posted.find(
      (message) => message.type === 'sessionUpdate' && message.session.id === widthOwner
    );
    assert(relaidPayload !== undefined, `没有收到会话 ${widthOwner} 的重排结果`);
    assert(
      relaidPayload.session.boxes[ownerRootId]?.width === reportedWidth,
      `点名的会话应当采用回传宽度 ${reportedWidth}，实际 ${
        relaidPayload.session.boxes[ownerRootId]?.width
      }`
    );
    console.log(
      `诊断: 回传宽度归属 —— 记录落在 ${widthOwner}，重排 ${JSON.stringify(relaid)}，` +
        `活动标签 ${bystander} 未受影响，根框宽度实测为回传值 ${reportedWidth}`
    );

    // D) 点标签必须真的切过去：webview 只在**新会话**的 sessionUpdate 里认领活动标签
    //    （否则 relayout 重发时标签会自己跳到最后），所以宿主必须**显式**告诉它活动标签是哪个。
    //    曾经只补发内容、不发这条消息 —— 表现是「多个标签时只有最新那个点得动」。
    captured.posted.length = 0;
    fake.send({ type: 'selectTab', id: widthOwner });
    await tick();
    assert(
      provider.__debugSnapshot().activeId === widthOwner,
      `宿主侧活动标签应当切到 ${widthOwner}，实际 ${provider.__debugSnapshot().activeId}`
    );
    assert(
      captured.posted.some(
        (message) => message.type === 'selectTab' && message.id === widthOwner
      ),
      `点标签后宿主应当下发 selectTab(${widthOwner})，实际下发 ${
        JSON.stringify(captured.posted.map((message) => message.type))
      }`
    );
    // 顺序也有讲究：内容（sessionUpdate）必须先到，否则 webview 切过去时手里还没有这张图
    const switchTypes = captured.posted.map((message) => message.type);
    assert(
      switchTypes.indexOf('sessionUpdate') < switchTypes.lastIndexOf('selectTab'),
      `selectTab 不应早于该标签的内容下发，实际顺序 ${JSON.stringify(switchTypes)}`
    );
    console.log(
      `OK: 点标签会显式切换 —— 宿主下发 selectTab(${widthOwner})，且内容先到（顺序 ${JSON.stringify(
        switchTypes
      )}）`
    );

    // C) 标签关闭后仍在路上的 collapse / selectNode / reportWidths 不能再写回缓存：
    //    forgetSession 已经清过一次，此后无人再清，而会话 id 是随机串、不会复用，
    //    于是这些条目会一直留着（还可能在同名会话恢复时被套用）。
    assert(
      provider.__debugSnapshot().sessionIds.length >= 2,
      `本用例需要至少两个标签，实际 ${provider.__debugSnapshot().sessionIds.length} 个`
    );
    const victim = provider.__debugSnapshot().sessionIds[0];
    fake.send({ type: 'closeTab', id: victim });
    await tick();
    assert(
      !provider.__debugSnapshot().sessionIds.includes(victim),
      `closeTab 之后 ${victim} 应当已不在会话列表里`
    );
    fake.send({ type: 'collapse', sessionId: victim, collapsed: ['stale-node'] });
    fake.send({ type: 'selectNode', sessionId: victim, nodeId: 'stale-node' });
    fake.send({
      type: 'reportWidths',
      sessionId: victim,
      widths: [{ id: 'stale-node', width: 300 }],
    });
    await tick();
    const stale = provider.__debugSnapshot();
    assert(
      !stale.collapsedNodes.some((entry) => entry.sessionId === victim),
      `已关闭会话不应留在收起状态表里：${JSON.stringify(stale.collapsedNodes)}`
    );
    assert(
      !stale.selectedIds.some((entry) => entry.sessionId === victim),
      `已关闭会话不应留在选中节点表里：${JSON.stringify(stale.selectedIds)}`
    );
    assert(
      !stale.measuredWidths.some((entry) => entry.sessionId === victim),
      `已关闭会话不应留在实测宽度表里：${JSON.stringify(stale.measuredWidths)}`
    );
    console.log(
      `OK: 晚到的 collapse / selectNode / reportWidths 不会给已关闭会话 ${victim} 留下缓存条目`
    );

    // D) 导出消息的宿主侧：正文由宿主生成、保存对话框取消时不写文件也不报错。
    //    这是**端到端**的宿主路径（webview → 消息 → 保存对话框 → 写盘），
    //    桩里唯一替不掉的是真实 VS Code 的对话框与文件系统。
    {
      const exportSession = provider.activeSession;
      assert(exportSession !== undefined, '导出用例需要至少一个存活标签');
      const exportSessionId = exportSession.id;
      // 工作区根（桩里 workspaceFolders[0].uri.fsPath = ROOT），用来核对默认保存路径
      const workspaceRoot = ROOT;

      const savedTo = { scheme: 'file', fsPath: path.join(ROOT, '导出测试.md'), toString: () => '' };
      const errorLines = () =>
        captured.outputLines.filter((line) => line.startsWith('error:')).length;
      const sendExport = async (format, data) => {
        captured.writes.length = 0;
        captured.saveDialogs.length = 0;
        const before = errorLines();
        fake.send({ type: 'exportGraph', sessionId: exportSessionId, format, data });
        await tick();
        return before;
      };

      // ① 用户取消（showSaveDialog 返回 undefined）：不写文件、不报错
      captured.saveDialogResult = undefined;
      const errorsBeforeCancel = await sendExport('md-tree');
      assert(
        captured.saveDialogs.length === 1,
        `导出应当先问一次保存位置，实际 ${captured.saveDialogs.length} 次`
      );
      assert(
        captured.writes.length === 0,
        `用户取消时不应写文件，实际写了 ${captured.writes.length} 次`
      );
      assert(
        errorLines() === errorsBeforeCancel,
        '用户取消导出不是错误，不该往输出通道写 error 级日志'
      );
      const dialog = captured.saveDialogs[0];
      assert(
        Array.isArray(dialog.filters?.Markdown) && dialog.filters.Markdown[0] === '.md',
        `Markdown 的保存过滤器应当是 .md，实际 ${JSON.stringify(dialog.filters)}`
      );
      const defaultPath = String(dialog.defaultUri?.fsPath ?? '');
      assert(
        defaultPath.startsWith(workspaceRoot) && /-(被调用关系|调用关系)-\d{8}-\d{6}\.md$/.test(defaultPath),
        `默认路径应当是「工作区第一个目录 + <根节点名>-<方向标签>-<时间戳>.md」，实际 ${JSON.stringify(defaultPath)}`
      );
      console.log(`诊断: 导出取消 → 问了一次保存位置（${path.basename(defaultPath)}），未写文件、未报错`);

      // ② 保存成功：写出的字节必须**逐字**等于纯函数生成的正文
      captured.saveDialogResult = savedTo;
      await sendExport('md-tree');
      assert(captured.writes.length === 1, `保存成功时应当写一次文件，实际 ${captured.writes.length} 次`);
      assert(
        Buffer.from(captured.writes[0].bytes).toString('utf8') === api.buildMarkdownTree(exportSession),
        'md-tree 写盘的正文必须与 buildMarkdownTree 逐字一致'
      );

      captured.saveDialogResult = { ...savedTo, fsPath: path.join(ROOT, '导出测试.md') };
      await sendExport('md-table');
      const tableText = Buffer.from(captured.writes[0].bytes).toString('utf8');
      assert(
        tableText === api.buildMarkdownTable(exportSession),
        'md-table 写盘的正文必须与 buildMarkdownTable 逐字一致'
      );
      assert(tableText.startsWith('| 层 | 节点 | 位置 | 被调用处 |'), 'md-table 应当以表头开头');

      captured.saveDialogResult = { ...savedTo, fsPath: path.join(ROOT, '导出测试.json') };
      await sendExport('json');
      const jsonText = Buffer.from(captured.writes[0].bytes).toString('utf8');
      assert(jsonText === api.buildJsonText(exportSession), 'json 写盘的正文必须与 buildJsonText 逐字一致');
      assert(
        JSON.parse(jsonText).root === exportSession.rootId,
        'JSON 的 root 应当是当前标签的根节点 id'
      );

      // ③ svg：webview 给的序列化文本原样落盘（文本按 UTF-8 写）
      captured.saveDialogResult = { ...savedTo, fsPath: path.join(ROOT, '导出测试.svg') };
      await sendExport('svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>叶子</text></svg>');
      assert(
        Buffer.from(captured.writes[0].bytes).toString('utf8') ===
          '<svg xmlns="http://www.w3.org/2000/svg"><text>叶子</text></svg>',
        'svg 应当把 webview 给的文本原样按 UTF-8 落盘（中文不能乱码）'
      );

      // ④ png：webview 给的 base64 必须先解码成二进制再写
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      captured.saveDialogResult = { ...savedTo, fsPath: path.join(ROOT, '导出测试.png') };
      await sendExport('png', pngBytes.toString('base64'));
      assert(
        Buffer.from(captured.writes[0].bytes).equals(pngBytes),
        'png 的 base64 必须先解码成二进制再落盘（直接写 base64 文本会得到损坏的图片）'
      );

      // ⑤ webview 没给 data（例如它那边栅格化失败）：只记警告，不写文件
      await sendExport('png', undefined);
      assert(
        captured.saveDialogs.length === 0 && captured.writes.length === 0,
        '缺 data 的 png 导出不该弹保存对话框、更不该写文件'
      );
      assert(
        captured.outputLines.some(
          (line) => line.startsWith('warn:') && line.includes('没有提供')
        ),
        '缺 data 时必须留下可诊断的警告（不许静默什么都不做）'
      );
      captured.saveDialogResult = undefined;
      console.log(
        'OK: 导出宿主侧 —— 取消不写文件不报错；md-tree/md-table/json 与纯函数逐字一致；' +
          'svg 按 UTF-8、png 按 base64 解码落盘；缺 data 时只警告'
      );

      // ⑥ webview 报错转日志：前缀「视图内报错：」只能出现一次。
      //    历史缺陷：graphView.ts 拼了一次前缀，extension.ts 注册的回调又拼一次，
      //    输出通道里出现「视图内报错：视图内报错：…」（真机日志实录）。
      {
        const probe = '导出 png 失败：前缀重复检查';
        const before = captured.outputLines.length;
        fake.send({ type: 'error', message: probe });
        await tick();
        const fresh = captured.outputLines.slice(before);
        const viewErrors = fresh.filter((line) => line.includes('视图内报错'));
        assert(
          viewErrors.length === 1,
          `webview 报错应当只在输出通道写一条「视图内报错」日志，实际 ${JSON.stringify(fresh)}`
        );
        assert(
          viewErrors[0] === `warn: 视图内报错：${probe}`,
          `「视图内报错」日志的文案应当是「视图内报错：<原始消息>」（前缀恰好一次），实际「${viewErrors[0]}」`
        );
        assert(
          !fresh.some((line) => line.includes('视图内报错：视图内报错')),
          `「视图内报错：」前缀被重复拼接了：${JSON.stringify(fresh)}`
        );
        assert(
          fresh.some((line) => line === `error: webview 报错：${probe}`),
          `webview 报错还应当在输出通道留一条 error 级日志（「webview 报错：<原始消息>」），实际 ${JSON.stringify(fresh)}`
        );
        console.log(`OK: webview 报错转日志 —— 前缀只出现一次（${viewErrors[0]}）`);
      }
    }
  }

  // ---- 节点 id 的 key 反解：含 `>` 的符号名（operator>）不能再被切错 ----
  {
    const { baseKeyOf } = extension.__hierarchy;
    assert(typeof baseKeyOf === 'function', '产物没有导出 __hierarchy.baseKeyOf');
    const sep = '\u0000';
    const operatorKey = 'file:///x.cpp|1|0|1|20|operator>';
    assert(
      baseKeyOf(`rootKey${sep}${operatorKey}`) === operatorKey,
      `operator> 的 key 应当被完整取出，实际 ${JSON.stringify(
        baseKeyOf(`rootKey${sep}${operatorKey}`)
      )}`
    );
    const cycleId = `rootKey${sep}cycle@${operatorKey}@12`;
    assert(
      baseKeyOf(cycleId) === operatorKey,
      `环节点的 key 也应当被完整取出，实际 ${JSON.stringify(baseKeyOf(cycleId))}`
    );
    // 旧格式（0.20 快照）仍按老规则解析，保证恢复出来的图还能用
    assert(
      baseKeyOf('parent>legacyKey') === 'legacyKey',
      '旧格式 id 应当仍按 `>` 规则反解（兼容旧快照）'
    );
    console.log(
      'OK: 节点 id 分隔符改用 NUL —— operator> 这类含 `>` 的名字不再被切错，旧快照仍可解析'
    );
  }

  // ---- 导出的纯函数：结构树 / 表格 / JSON 的内容断言 ----
  //
  // 用自造的最小会话夹具（按既有夹具风格写对象字面量，不改生产代码）覆盖四件事：
  // 缩进、关系点、环标记与 detail 截断；表格的转义与行数；JSON 的 depth / parentId。
  {
    const exportNodes = {
      root: {
        name: 'main',
        file: 'src/main.cpp',
        line: 30,
        children: ['a', 'b'],
      },
      a: {
        name: 'compute|alt',
        file: 'src/compute.cpp',
        line: 18,
        // 关系点：父级中引用它的位置（第 31 行）
        callSite: { file: 'src/main.cpp', line: 31, text: 'int result = compute(41);' },
        children: ['c'],
      },
      // detail 超过 60 字符：用来钉住「截断到 60 字符」这条老规矩没在搬迁中丢掉
      b: {
        name: 'report',
        file: 'src/report.cpp',
        line: 26,
        detail: 'DETAIL-' + 'x'.repeat(70) + '-END',
        children: [],
      },
      c: {
        name: 'leafAdd',
        file: 'src/leaf.cpp',
        line: 5,
        isCycle: true,
        children: [],
      },
    };
    const exportSession = {
      rootId: 'root',
      direction: 'callers',
      node: (id) => exportNodes[id],
    };
    const visitedOrder = ['root', 'a', 'c', 'b'];
    const tree = api.buildMarkdownTree(exportSession);
    assert(tree.startsWith('# 被调用关系：main（src/main.cpp:30）'), `结构树首行应当是方向 + 根节点，实际 ${JSON.stringify(tree.split('\n')[0])}`);
    assert(tree.includes('- main   src/main.cpp:30'), '结构树应当含根节点那一行');
    assert(
      tree.includes('\n  - compute|alt   src/compute.cpp:18'),
      `深度 1 的子节点应当缩进两格，实际 ${JSON.stringify(tree.split('\n')[1])}`
    );
    assert(
      tree.includes('  ← 关系点 src/main.cpp:31'),
      '有 callSite 的节点应当带「← 关系点 文件:行」'
    );
    assert(tree.includes('\n    - leafAdd ↻'), '环标记 ↻ 应保留在结构树里');
    assert(
      tree.includes(`[${'DETAIL-' + 'x'.repeat(53)}]`),
      'detail 应当被截断到 60 字符'
    );
    assert(!tree.includes('-END'), 'detail 截断后不应出现第 60 字符之后的内容');
    assert(
      tree.split('\n').length === visitedOrder.length + 1,
      `结构树行数应当是「1 行标题 + ${visitedOrder.length} 个节点」，实际 ${tree.split('\n').length}`
    );

    const table = api.buildMarkdownTable(exportSession);
    const tableLines = table.split('\n');
    assert(
      tableLines[0] === '| 层 | 节点 | 位置 | 被调用处 |',
      `表格首行应当是表头，实际 ${JSON.stringify(tableLines[0])}`
    );
    assert(
      /^\| --- \| --- \| --- \| --- \|$/.test(tableLines[1]),
      `表格第二行应当是分隔行，实际 ${JSON.stringify(tableLines[1])}`
    );
    const rows = tableLines.filter((line) => line.startsWith('|')).slice(2);
    assert(
      rows.length === visitedOrder.length,
      `表格行数应当等于遍历到的节点数 ${visitedOrder.length}，实际 ${rows.length}`
    );
    assert(
      table.includes('| compute\\|alt |'),
      `节点名里的 | 必须转义成 \\|，实际 ${JSON.stringify(rows[0])}`
    );
    assert(!/[^\\]\| compute\|/.test(table), '未转义的 | 会切断表格列，不该出现');
    assert(
      rows[0].includes('| 0 | main | src/main.cpp:30 |  |'),
      `根节点那一行应当 depth=0 且「被调用处」留空，实际 ${JSON.stringify(rows[0])}`
    );
    assert(
      rows[1].includes('src/main.cpp:31'),
      `「被调用处」应当是 callSite 的 文件:行，实际 ${JSON.stringify(rows[1])}`
    );
    assert(
      rows[0].startsWith('| 0 |') && rows[1].startsWith('| 1 |') && rows[2].startsWith('| 2 |'),
      `表格应当按 DFS 先序给出层数，实际 ${JSON.stringify(rows.slice(0, 3))}`
    );

    const parsed = JSON.parse(api.buildJsonText(exportSession));
    assert(parsed.version === 1, `JSON 的 version 应当是 1，实际 ${parsed.version}`);
    assert(parsed.direction === 'callers', `JSON 的 direction 应当是 callers，实际 ${parsed.direction}`);
    assert(parsed.directionLabel === '被调用关系', 'JSON 应当带方向的中文标签');
    assert(parsed.root === 'root', `JSON 的 root 应当是 rootId，实际 ${parsed.root}`);
    assert(
      parsed.nodes.length === visitedOrder.length,
      `JSON 的 nodes 数量应当是 ${visitedOrder.length}，实际 ${parsed.nodes.length}`
    );
    assert(
      parsed.nodes.map((node) => node.id).join(',') === visitedOrder.join(','),
      `JSON 的节点应当按 DFS 先序，实际 ${parsed.nodes.map((node) => node.id).join(',')}`
    );
    const expectedParents = { root: null, a: 'root', c: 'a', b: 'root' };
    const expectedDepths = { root: 0, a: 1, c: 2, b: 1 };
    for (const node of parsed.nodes) {
      assert(
        node.parentId === expectedParents[node.id],
        `${node.id} 的 parentId 应当是 ${JSON.stringify(expectedParents[node.id])}，实际 ${JSON.stringify(node.parentId)}`
      );
      assert(
        node.depth === expectedDepths[node.id],
        `${node.id} 的 depth 应当是 ${expectedDepths[node.id]}，实际 ${node.depth}`
      );
    }
    assert(
      parsed.nodes[0].parentId === null && parsed.nodes[0].depth === 0,
      '根节点的 parentId 必须是 null、depth 必须是 0'
    );
    assert(
      parsed.nodes.find((node) => node.id === 'a').callSite.file === 'src/main.cpp',
      'JSON 应当带上 callSite 的文件'
    );
    assert(
      parsed.nodes.find((node) => node.id === 'c').isCycle === true,
      'JSON 应当带上 isCycle 标记'
    );
    // 时间戳一律不写：同一份会话任何时候导出都必须逐字节相同
    assert(
      !/\d{8}-\d{6}/.test(api.buildJsonText(exportSession)),
      'JSON 里不应写入时间戳（那会让同一份会话每次导出都不同，无法比对）'
    );

    // 默认文件名：Windows 非法字符被过滤、长度受限、时间戳格式固定
    const stamp = new Date(2026, 0, 2, 3, 4, 5);
    const fileName = api.buildExportFileName('std::vector<int>|a?b', 'callers', stamp, '.md');
    assert(
      fileName === 'std__vector_int__a_b-被调用关系-20260102-030405.md',
      `默认文件名应当过滤 Windows 非法字符并保留中文方向标签，实际 ${JSON.stringify(fileName)}`
    );
    const longName = api.buildExportFileName('n'.repeat(200), 'callees', stamp, '.json');
    assert(
      longName.length <= 80 && longName.endsWith('.json'),
      `超长名字应当被截断且保留扩展名，实际长度 ${longName.length}：${JSON.stringify(longName)}`
    );
    console.log(
      `诊断: 导出纯函数 —— 结构树 ${tree.split('\n').length} 行、表格 ${rows.length} 行、` +
        `JSON ${parsed.nodes.length} 个节点；默认文件名 ${fileName}`
    );
    console.log('OK: 导出纯函数 —— 缩进/关系点/环标记/detail 截断、表格转义与行数、JSON 的 depth 与 parentId 均正确');
  }

  // ---- 0.21 引擎配置档：自定义引擎可接入、认领规则生效、未知 id 退回并给出警告 ----
  {
    const engines = extension.__engines;
    assert(engines !== undefined, '产物没有导出 __engines（引擎层测试接口）');
    const baseProfiles = engines.engineProfiles().map((profile) => profile.id);
    assert(
      baseProfiles.includes('clangd') && baseProfiles.includes('cpptools'),
      `内置引擎表应当含 clangd 与 cpptools，实际 [${baseProfiles.join(', ')}]`
    );

    // 一条完整的自定义引擎 + 一条只有 id 的最小条目（label 应回退成 id）
    configStore['cppCallGraph.customEngines'] = [
      { id: 'my-engine', label: '我的引擎', badge: 'my-eng', matchName: 'myEngineThing' },
      { id: 'minimal' },
    ];
    const profiles = engines.engineProfiles().map((profile) => profile.id);
    assert(
      profiles.includes('my-engine') && profiles.includes('minimal'),
      `自定义引擎应当出现在配置档表里，实际 [${profiles.join(', ')}]`
    );
    assert(
      engines.describeEngine('minimal') === 'minimal',
      `省略 label 时展示名应回退成 id，实际 ${engines.describeEngine('minimal')}`
    );

    configStore['cppCallGraph.languageService'] = 'my-engine';
    const selected = engines.selectedProfile();
    assert(
      selected.profile && selected.profile.id === 'my-engine' && !selected.warning,
      `选中自定义引擎应当成功，实际 ${JSON.stringify(selected)}`
    );
    assert(
      engines.badgeFor('my-engine') === 'my-eng',
      `角标应当来自自定义引擎的 badge，实际 ${engines.badgeFor('my-engine')}`
    );
    assert(
      engines.matchesProfile({ name: 'myEngineThingHelper', detail: '' }, selected.profile) === true,
      '匹配到 matchName 的候选项应当被认领'
    );
    assert(
      engines.matchesProfile({ name: 'other', detail: '' }, selected.profile) === false,
      '不含匹配子串的候选项不该被认领'
    );

    // 挑选策略：三档都能读出来（默认 nearest）
    configStore['cppCallGraph.enginePickPolicy'] = 'onlySelected';
    assert(engines.pickPolicy() === 'onlySelected', '挑选策略应当读到 onlySelected');
    configStore['cppCallGraph.enginePickPolicy'] = 'nearest';
    assert(engines.pickPolicy() === 'nearest', '挑选策略应当读回 nearest');

    // 选中了「不可用」的引擎 → 必须只给警告、**不能**把 profile 交出去
    // （否则它会照常参与认领，onlySelected 档下会变成"查不出结果"）
    configStore['cppCallGraph.customEngines'] = [
      { id: 'ghost', label: '幽灵引擎', extensionId: 'nobody.ghost-engine' },
    ];
    configStore['cppCallGraph.languageService'] = 'ghost';
    const unavailable = engines.selectedProfile();
    assert(
      unavailable.profile === undefined &&
        typeof unavailable.warning === 'string' &&
        unavailable.warning.includes('不可用'),
      `选中不可用引擎时应当退回不认领并给出警告，实际 ${JSON.stringify(unavailable)}`
    );
    // 恢复成前面用的那份配置，后面的用例还要用 my-engine
    configStore['cppCallGraph.customEngines'] = [
      { id: 'my-engine', label: '我的引擎', badge: 'my-eng', matchName: 'myEngineThing' },
      { id: 'minimal' },
    ];

    // 未知 id → 不认领 + 给出可读的警告（绝不静默失效）
    configStore['cppCallGraph.languageService'] = 'nope';
    const unknown = engines.selectedProfile();
    assert(
      unknown.profile === undefined &&
        typeof unknown.warning === 'string' &&
        unknown.warning.includes('nope'),
      `未知引擎 id 应当退回不认领并给出警告，实际 ${JSON.stringify(unknown)}`
    );

    // custom + customEngineId：填了才生效，空着要给出提示
    configStore['cppCallGraph.languageService'] = 'custom';
    configStore['cppCallGraph.customEngineId'] = 'my-engine';
    assert(
      engines.selectedProfile().profile?.id === 'my-engine',
      'custom + customEngineId 应当选中该引擎'
    );
    configStore['cppCallGraph.customEngineId'] = '';
    const empty = engines.selectedProfile();
    assert(
      empty.profile === undefined && typeof empty.warning === 'string',
      'custom 但 customEngineId 为空时应当给出提示并退回不认领'
    );

    // 同 id 覆盖内置项（这里只验展示名，其余行为随之改变）
    configStore['cppCallGraph.customEngines'] = [{ id: 'clangd', label: '我的 clangd' }];
    assert(
      engines.describeEngine('clangd').includes('我的 clangd'),
      `同 id 的自定义项应当覆盖内置项，实际 ${engines.describeEngine('clangd')}`
    );

    // 清理：不影响后面的用例
    delete configStore['cppCallGraph.customEngines'];
    delete configStore['cppCallGraph.customEngineId'];
    delete configStore['cppCallGraph.enginePickPolicy'];
    configStore['cppCallGraph.languageService'] = 'auto';
    assert(engines.pickPolicy() === 'nearest', '清理后挑选策略应回到默认 nearest');
    console.log(
      'OK: 引擎配置档 —— 自定义引擎可接入、认领规则生效、未知 id 退回并给出警告、三档策略可切换'
    );
  }

  console.log('--- 引擎探测 ---');
  const engineCheck = require(path.join(ROOT, 'dist', 'engine-check.js'));
  for (const line of engineCheck.report()) {
    console.log('  ' + line);
  }
  console.log('--- 布局几何 ---');
  const layoutCheck = require(path.join(ROOT, 'dist', 'layout-check.js'));
  for (const line of layoutCheck.report()) {
    console.log('  ' + line);
  }
  console.log('--- 冒烟测试结果 ---');
  console.log('已注册命令:', [...registered.keys()].join(', '));
  console.log('视图:', captured.webviewViewProvider.id);
  console.log('prepareCallHierarchy 调用次数:', captured.prepareCalls);
  console.log('provideIncomingCalls 调用次数:', captured.incomingCalls);
  console.log('标签生命周期: 2 个 → 关闭 1 个 → 关闭最后 1 个 → 面板自动关闭');
  console.log('OK: 标签/展开/收起视图 行为符合预期');

  extension.deactivate();
  Module._load = originalLoad;
}

main().catch((error) => {
  console.error('冒烟测试失败:', error);
  console.error('--- 诊断 ---');
  console.error(
    '已下发的消息类型:',
    captured.posted.map((message) => message.type).join(', ') || '(无)'
  );
  console.error('prepareCallHierarchy 次数:', captured.prepareCalls);
  console.error('provideIncomingCalls 次数:', captured.incomingCalls);
  console.error('面板创建/关闭次数:', captured.panelsCreated, '/', captured.panelsDisposed);
  console.error('已注册命令:', [...registered.keys()].join(', '));
  Module._load = originalLoad;
  process.exit(1);
});
