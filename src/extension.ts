/**
 * 扩展入口（方案 B：Webview 图形化关系视图 + 多标签）。
 *
 * 用户流程：
 *   1. 在 C/C++ 文件里把光标放在函数 / 宏 / 变量上，右键
 *   2. 选择「显示被调用关系 / 显示调用关系 / 显示被引用关系 / 显示引用关系」
 *   3. 底部面板出现一个标签页，根在最左列；每个方框右下角的 + 可以一层层往下展开
 *
 * 四类关系：
 *   - 被调用关系 / 调用关系：走 LSP 调用层级，适用于函数、方法
 *   - 被引用关系 / 引用关系：走引用查找，适用于函数、宏、宏函数、变量、类型等
 *     （C/C++ 里宏没有调用层级，只能靠引用关系看「谁用了它」）
 *
 * 关于语言服务冲突（clangd vs C/C++ 扩展）：
 *   两者都注册在 c / cpp 上，VS Code 会把请求交给所有 provider。
 *   本扩展不去修改 clangd / cpptools 的任何配置，只在检测到两者同时可用时给出提示，
 *   并且只注册带 cppCallGraph. 前缀的命令、只创建自己的视图，避免与其它插件争用。
 */
import * as vscode from 'vscode';
import {
  EngineChoice,
  EngineLabel,
  clangdExecutable,
  describeEngine,
  explainUnavailable,
  hasCompileDatabase,
  invalidateClangdCache,
  isSupportedLanguage,
  lastPrepareDiagnostic,
  listAvailableEngines,
  pickByChoice,
  preferredEngine,
  probeCalls,
  probeEngines,
  probePosition,
  resolveAt,
  resolveEngineChoice,
} from './hierarchy/callHierarchy';
import { CallSession } from './hierarchy/session';
import { Direction, DIRECTION_LABEL } from './hierarchy/graphTypes';
import {
  NODE_HEIGHT as layoutNodeHeight,
  NODE_WIDTH as layoutNodeWidth,
  MARGIN_LEFT as layoutMarginLeft,
  MARGIN_TOP as layoutMarginTop,
  createLayout as layoutCreateLayout,
} from './hierarchy/graphLayout';
import { GraphViewProvider } from './views/graphView';
import { renderGraphHtml } from './webview/webviewHtml';
import { buildSessionText, copyNodeLocation, copyNodeName } from './commands/copyTree';
import { disposeLog, logError, logInfo, logWarn, showLog } from './util/log';

export function activate(context: vscode.ExtensionContext): void {
  logInfo('扩展已激活（底部面板 WebviewView）');

  // 状态栏提示已按需求完全去掉：所有信息只写输出通道（命令「显示日志」或「诊断」查看）。
  const graphPanel = new GraphViewProvider(context, renderGraphHtml, (message) =>
    logWarn(`视图内报错：${message}`)
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cppCallGraph.graphView', graphPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const readChoice = (): EngineChoice =>
    vscode.workspace
      .getConfiguration('cppCallGraph')
      .get<EngineChoice>('languageService', 'auto');

  // -------------------------------------------------------- 语言服务

  const detectEngine = async (): Promise<EngineLabel> => {
    invalidateClangdCache();
    const choice = readChoice();
    const installed = listAvailableEngines();

    if (choice !== 'auto') {
      const chosen = resolveEngineChoice(choice);
      if (chosen !== 'unknown') {
        return chosen;
      }
      const reason = explainUnavailable(choice) ?? '该语言服务当前不可用';
      logWarn(`设置里选择了 ${choice}，但不可用：${reason}；已回退为自动。`);
      return installed[0] ?? 'unknown';
    }

    if (installed.length === 0) {
      return 'unknown';
    }
    // 刻意不在激活阶段打开夹具文件去探测引擎：那会让没装 clangd 可执行文件的
    // clangd 收到请求并报错，反而干扰真正的查询。需要精确判断时用「诊断」命令。
    return installed[0];
  };

  const applyEngine = (label: EngineLabel): void => {
    graphPanel.setEngineLabel(label);
  };

  /** 两个引擎同时可用时的提示（只提示，不改任何设置）。 */
  const maybeWarnEngineConflict = async (): Promise<void> => {
    const enabled = vscode.workspace
      .getConfiguration('cppCallGraph')
      .get<boolean>('showEngineWarning', true);
    if (!enabled) {
      return;
    }
    const installed = listAvailableEngines();
    if (installed.length < 2) {
      return;
    }
    const active = preferredEngine();
    const message =
      installed.join(' 与 ') +
      ' 都会提供调用层级，两者注册在同一个语言 ID 上，结果可能混用。' +
      (active === 'unknown' ? '' : `当前按 ${active} 的结果展示。`);
    const choice = await vscode.window.showInformationMessage(
      message,
      '查看处理建议',
      '不再提示'
    );
    if (choice === '查看处理建议') {
      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: engineAdviceMarkdown(),
      });
      await vscode.window.showTextDocument(document, { preview: false });
    } else if (choice === '不再提示') {
      await vscode.workspace
        .getConfiguration('cppCallGraph')
        .update('showEngineWarning', false, vscode.ConfigurationTarget.Global);
    }
  };

  // -------------------------------------------------------- 命令

  /** 新增一个标签页：每次右键查询都独立成页。 */
  const run = async (direction: Direction): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage(
        '请先打开一个 C/C++ 文件并把光标放在函数上。'
      );
      return;
    }
    const document = editor.document;
    if (!isSupportedLanguage(document.languageId)) {
      void vscode.window.showWarningMessage('当前文件不是 C/C++ 源文件，暂时只支持 C/C++。');
      return;
    }

    const label = DIRECTION_LABEL[direction];
    const cursor = editor.selection.active;
    logInfo(
      `收到命令「${label}」：${document.uri.fsPath} 光标 ${cursor.line + 1}:${cursor.character + 1}（languageId=${document.languageId}）`
    );

    const choice = readChoice();
    const expected = resolveEngineChoice(choice);
    const resolved = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `正在解析${label}…` },
      () => resolveAt(document, cursor, choice, expected)
    );

    // 解析不出函数属于正常的“没找到”，不弹右下角 Toast，只在状态栏和日志里说明。
    if (!resolved) {
      const position = `${cursor.line + 1}:${cursor.character + 1}`;
      const reason = hasCompileDatabase()
        ? '当前光标位置没有解析出函数（请把光标放在函数名上，或等索引完成）'
        : '工作区缺少 compile_commands.json / compile_flags.txt，clangd 拿不到编译参数';
      logWarn(`解析${label}失败：${document.uri.fsPath} @ ${position} —— ${reason}`);
      return;
    }

    const { item, engine, allNames } = resolved;
    if (allNames.length > 1) {
      logInfo(
        `同一位置有 ${allNames.length} 个引擎给出结果：${allNames.join(', ')}；当前使用「${item.name}」。`
      );
    }

    const session = new CallSession(
      `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      direction,
      item,
      describeEngine(engine)
    );
    try {
      await session.expand(session.rootId);
    } catch (error) {
      logError('首次加载关系失败', error);
      return;
    }

    // 该方向确实没有关系时不建标签页（也就不会多出一堆空标签）。
    if (!session.hasContent) {
      const empty = explainEmpty(direction, item.name);
      logInfo(`未新建标签页：${empty}`);
      return;
    }

    await graphPanel.addSession(session);
    logInfo(
      `新建标签页：${session.title}（${label}，引擎 ${describeEngine(engine)}）`
    );
  };

  const copyActive = async (): Promise<void> => {
    const session = graphPanel.activeSession;
    if (!session) {
      logWarn('复制失败：当前没有打开的调用关系标签。');
      return;
    }
    const text = await buildSessionText(session);
    if (!text) {
      logWarn('复制失败：当前标签没有可导出的内容。');
      return;
    }
    await vscode.env.clipboard.writeText(text);
    logInfo(`已复制整个标签（${text.split('\n').length} 行）到剪贴板。`);
  };

  /** 复制「元素」：当前选中方框的符号名（没选过则用根节点）。 */
  const copyElement = async (): Promise<void> => {
    const session = graphPanel.activeSession;
    if (!session) {
      logWarn('复制失败：当前没有打开的调用关系标签。');
      return;
    }
    const result = await copyNodeName(session, graphPanel.activeNodeId);
    if (!result.ok) {
      logWarn(`复制元素失败：${result.text}`);
      return;
    }
    logInfo(`已复制元素名到剪贴板：${result.text}`);
  };

  /** 复制「地址」：当前选中方框的 文件:行号（没选过则用根节点）。 */
  const copyLocation = async (): Promise<void> => {
    const session = graphPanel.activeSession;
    if (!session) {
      logWarn('复制失败：当前没有打开的调用关系标签。');
      return;
    }
    const result = await copyNodeLocation(session, graphPanel.activeNodeId);
    if (!result.ok) {
      logWarn(`复制地址失败：${result.text}`);
      return;
    }
    logInfo(`已复制地址到剪贴板：${result.text}`);
  };

  /**
   * 自检：把所有关键状态与一次真实的语言服务探测结果写进输出通道。
   * 出问题时执行这个命令，输出通道里就能看到「哪一步断了」。
   */
  const diagnose = async (): Promise<void> => {
    const lines: string[] = [];
    const add = (text: string): void => {
      lines.push(text);
    };

    add(`扩展版本: ${context.extension.packageJSON.version ?? '(未知)'}`);
    add(`VS Code: ${vscode.version}`);
    add(`平台: ${process.platform} ${process.arch}`);
    add(
      `活动编辑器: ${
        vscode.window.activeTextEditor
          ? `${vscode.window.activeTextEditor.document.uri.fsPath} (languageId=${vscode.window.activeTextEditor.document.languageId})`
          : '(无)'
      }`
    );
    add(`语言服务设置: ${readChoice()}`);
    add(
      `clangd 扩展: ${vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd') ? '已安装' : '未安装'}`
    );
    add(
      `cpptools 扩展: ${vscode.extensions.getExtension('ms-vscode.cpptools') ? '已安装' : '未安装'}`
    );
    add(`clangd 可执行文件: ${clangdExecutable() ?? '(未找到)'}`);
    add(
      `编译数据库: ${hasCompileDatabase() ? '有 compile_commands.json / compile_flags.txt' : '没有（clangd 会拿不到编译参数）'}`
    );
    add(`可用引擎: ${listAvailableEngines().join(', ') || '(无)'}`);
    add(`最近一次 prepare 结果: ${lastPrepareDiagnostic()}`);
    add(`面板标签数: ${graphPanel.sessionCount}`);

    const editor = vscode.window.activeTextEditor;
    if (editor && isSupportedLanguage(editor.document.languageId)) {
      const cursor = editor.selection.active;
      add('');
      add(`--- 真实探测 @ ${cursor.line + 1}:${cursor.character + 1} ---`);
      add(
        `光标行: ${editor.document.lineAt(cursor.line).text.trim().slice(0, 120) || '(空行)'}`
      );
      const result = await probePosition(editor.document, cursor);
      add(`prepareCallHierarchy: 结果数=${result.count}${result.error ? ` 错误=${result.error}` : ''}`);
      for (const name of result.names) {
        add(`  · ${name}`);
      }
      if (result.count > 0) {
        const resolved = await resolveAt(editor.document, cursor, readChoice(), 'unknown');
        if (resolved) {
          const calls = await probeCalls(resolved.item);
          add(
            `provideIncomingCalls/OutgoingCalls(${resolved.item.name}): incoming=${calls.incoming} outgoing=${calls.outgoing}${calls.error ? ` 错误=${calls.error}` : ''}`
          );
        }
      } else {
        add('  （没有结果：光标要放在函数名上；若用 clangd，确认有 compile_commands.json）');
        for (const delta of [1, -1, 2, -2, 3, -3]) {
          if (cursor.character + delta < 0) {
            continue;
          }
          const nearby = await probePosition(
            editor.document,
            new vscode.Position(cursor.line, cursor.character + delta)
          );
          if (nearby.count > 0) {
            add(
              `  光标右/左移 ${delta} 列后有结果：${nearby.names.join(', ')}（说明光标稍微偏了一点）`
            );
            break;
          }
        }
      }

      add('');
      add('--- 夹具探测（判断谁在真正出力）---');
      const probed = await probeEngines(context);
      add(
        probed
          ? `夹具结果: engines=[${probed.engines.join(', ')}] detail=${probed.detail}`
          : '夹具结果: 没有返回（语言服务可能未就绪或未注册调用层级）'
      );
    } else {
      add('');
      add('--- 未做真实探测：请先在 C/C++ 文件里把光标放在函数名上 ---');
    }

    for (const line of lines) {
      logInfo(line);
    }
    showLog();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('cppCallGraph.showCallers', () => run('callers')),
    vscode.commands.registerCommand('cppCallGraph.showCallees', () => run('callees')),
    vscode.commands.registerCommand('cppCallGraph.closeAllTabs', () =>
      graphPanel.closeAll()
    ),
    vscode.commands.registerCommand('cppCallGraph.focusGraph', () => graphPanel.focus()),
    vscode.commands.registerCommand('cppCallGraph.copyActive', copyActive),
    vscode.commands.registerCommand('cppCallGraph.copyElement', copyElement),
    vscode.commands.registerCommand('cppCallGraph.copyLocation', copyLocation),
    vscode.commands.registerCommand('cppCallGraph.showLog', showLog),
    vscode.commands.registerCommand('cppCallGraph.diagnose', diagnose),
    // 跳转高亮用的装饰与定时器要随扩展一起释放
    { dispose: () => graphPanel.dispose() },

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('cppCallGraph.languageService')) {
        void detectEngine().then(applyEngine);
        return;
      }
      if (event.affectsConfiguration('clangd.path')) {
        invalidateClangdCache();
        void detectEngine().then(applyEngine);
      }
    })
  );

  void detectEngine().then((engine) => {
    applyEngine(engine);
    logInfo(`当前语言服务：${describeEngine(engine)}`);
  });
  void maybeWarnEngineConflict();
}

export function deactivate(): void {
  disposeLog();
}

/**
 * 仅用于测试：把布局引擎和方框尺寸暴露出来，
 * 让 scripts/renderCheck.js 能用**真实布局**生成夹具（而不是手写死坐标）。
 */
export const __layout = {
  createLayout: layoutCreateLayout,
  NODE_WIDTH: layoutNodeWidth,
  NODE_HEIGHT: layoutNodeHeight,
  MARGIN_LEFT: layoutMarginLeft,
  MARGIN_TOP: layoutMarginTop,
};

/**
 * 仅用于测试：暴露候选挑选逻辑，供 scripts/pickCheck.js 覆盖
 * 「光标落在符号名中间 / 旁边还有其他符号」这类容易取错的场景。
 */
export const __hierarchy = {
  pickByChoice,
  resolveAt,
};

function explainEmpty(direction: Direction, name: string): string {
  switch (direction) {
    case 'callers':
      return `${name} 没有被其他函数调用（可能是入口函数，或索引尚未完成）`;
    case 'callees':
      return `${name} 没有调用其他函数（可能是叶子函数，或索引尚未完成）`;
  }
}

function engineAdviceMarkdown(): string {
  return [
    '# 调用关系图：如何避免 clangd 与 cpptools 冲突',
    '',
    'C/C++ 的「调用层级」由 VS Code 的 CallHierarchyProvider 提供，',
    'clangd 与 C/C++ 扩展注册在同一个语言 ID（`c` / `cpp`）上，',
    '扩展无法指定“只问 clangd”，因此推荐只启用其中一个。',
    '',
    '## 方案一：用 clangd（推荐给 CMake 项目）',
    '',
    '1. 确认装了 clangd 可执行文件（clangd 扩展只是客户端）：`clangd --version` 能跑即可，',
    '   或设置 `clangd.path` 指向它。',
    '2. 确认有 `compile_commands.json`：',
    '   `cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`',
    '3. 关闭 C/C++ 扩展的 IntelliSense 引擎（设置里搜 `C_Cpp.intelliSenseEngine`，选 `disabled`），',
    '   或直接禁用 C/C++ 扩展（工作区级别禁用即可）。',
    '4. 本扩展设置 `cppCallGraph.languageService` 选 `clangd`。',
    '',
    '## 方案二：只用 C/C++ 扩展',
    '',
    '1. 禁用 clangd 扩展（工作区级别）。',
    '2. 本扩展设置 `cppCallGraph.languageService` 选 `cpptools`。',
    '',
    '## 方案三：保持现状',
    '',
    '`cppCallGraph.languageService` 留 `auto`。扩展会按可用引擎优先使用，',
    '并在视图标题与每个标签上标明使用的语言服务。',
    '',
    '> 注意：以上设置本扩展都不会替你修改，只会提示。',
  ].join('\n');
}
