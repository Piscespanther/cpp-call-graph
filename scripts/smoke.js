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
  /** 剪贴板写入内容（复制命令的断言用）。 */
  clipboard: [],
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
    uri: vscodeStub.Uri.file(`G:\\proj\\demo.cpp`),
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

/** 每个函数「调用了谁」（用于「显示调用关系」方向）。 */
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
  SymbolKind: { Method: 5, Function: 11, Constructor: 8 },
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
        return [items[currentRootName]];
      }
      if (id === 'vscode.provideIncomingCalls') {
        captured.incomingCalls += 1;
        const name = args[0]?.name;
        const calls = callersOf[name] ?? [];
        return calls.map((call) => ({
          from: items[call.from],
          fromRanges: [ranges.make(call.line, 2, call.line, 12)],
        }));
      }
      if (id === 'vscode.executeReferenceProvider') {
        captured.referenceCalls += 1;
        return [
          // 宏在 demo.cpp 里的三处使用点
          { uri: vscodeStub.Uri.file('G:\\proj\\demo.cpp'), range: ranges.make(19, 4, 19, 20) },
          { uri: vscodeStub.Uri.file('G:\\proj\\demo.cpp'), range: ranges.make(21, 4, 21, 20) },
          { uri: vscodeStub.Uri.file('G:\\proj\\other.cpp'), range: ranges.make(7, 2, 7, 18) },
        ];
      }
      if (id === 'vscode.executeDefinitionProvider') {
        captured.definitionCalls += 1;
        return [
          { uri: vscodeStub.Uri.file('G:\\proj\\demo.cpp'), range: ranges.make(5, 0, 5, 30) },
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
      return { info() {}, warn() {}, error() {}, show() {}, dispose() {} };
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
      return Promise.resolve({
        uri: arg,
        lineCount: 100,
        lineAt: (line) => ({
          text: `    // 第 ${line + 1} 行的调用`,
          lineNumber: line,
        }),
      });
    },
    fs: {
      createDirectory: () => Promise.resolve(),
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile: () => Promise.resolve(),
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
  extension.activate(fakeContext);
  await new Promise((resolve) => setTimeout(resolve, 300));

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
  console.log(
    `诊断: 视图已解析，HTML 长度 ${html.length}，脚本 src=${scriptMatch[1]}，localResourceRoots=${roots
      .map((root) => root.fsPath)
      .join(',')}`
  );

  // 3) 触发一次查询
  const editor = {
    document: {
      languageId: 'cpp',
      uri: vscodeStub.Uri.file('G:\\proj\\demo.cpp'),
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
  assert(Object.keys(payload.nodes).length >= 3, '根节点 + 两个调用者应有至少 3 个节点');
  const firstSessionId = payload.id;

  // 4) 调用点信息（谁在第几行调用了谁）
  const withCallSite = Object.values(payload.nodes).filter((node) => node.callSite);
  assert(withCallSite.length >= 1, '节点缺少调用点信息');
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
  console.log(`诊断: 复制整个标签 → ${captured.clipboard[0].split('\n').length} 行`);

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

  // 同一个标签上连点两次也必须有效果（第一次已展开完，第二次至少不能报错）
  fake.send({ type: 'expandAll', sessionId: afterSecond.id });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterThird = lastSessionPayload();
  assert(
    Object.keys(afterThird.nodes).length >= secondCount,
    '同一标签上再点一次「展开全部」不应让节点变少'
  );
  console.log(
    `诊断: 同一标签连点第二次 → 节点 ${Object.keys(afterThird.nodes).length}（不减少即正确）`
  );

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
