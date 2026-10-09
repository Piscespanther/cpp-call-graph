/**
 * 方案 B 的宿主侧：底部面板里的 WebviewView 承载所有调用关系标签页。
 *
 * - 每次「显示被调用关系 / 显示调用关系」产生一个 CallSession，对应 webview 里的一个标签页；
 * - 标签可以逐个关闭；全部关闭后把整个面板视图一起收起来；
 * - 布局在宿主侧算（graphLayout），webview 只负责画与交互。
 *
 * 两个必须注意的坑（都踩过，注释里写明原因）：
 *   1. webview 的 localResourceRoots 必须包含扩展目录，否则 webview.js 被静默拦掉，
 *      页面永远空白，而宿主收不到任何错误。
 *   2. HTML 模板里的 {{nonce}} 出现多次（CSP / <style> / <script>），必须 replaceAll，
 *      否则 <script> 的 nonce 与 CSP 不一致，脚本被 CSP 拒绝执行。
 */
import * as vscode from 'vscode';
import { Direction, EngineLabel, describeEngine } from '../hierarchy/callHierarchy';
import { CallSession, SerializedSession } from '../hierarchy/session';
import { GraphNode, createLayout } from '../hierarchy/graphLayout';
import { DIRECTION_SHORT } from '../hierarchy/graphTypes';
import { logError, logInfo, logWarn } from '../util/log';
import { copyNodeLocation, copyNodeName } from '../commands/copyTree';
import { webviewResourceRoots } from '../webview/webviewHtml';

export const VIEW_ID = 'cppCallGraph.graphView';
const CONTEXT_KEY = 'cppCallGraph.hasSessions';
const STORAGE_KEY = 'cppCallGraph.sessions';
/** 跳转后高亮停留时长（毫秒）。够看清位置，又不至于挡视线。 */
const FLASH_MS = 1200;
/** 「展开全部」的层数上限与节点总量上限（防止在巨大工程上拖死语言服务）。 */
const MAX_EXPAND_ROUNDS = 5;
const MAX_EXPAND_NODES = 800;

export interface SessionPayload {
  id: string;
  title: string;
  description: string;
  direction: Direction;
  engineLabel: string;
  rootId: string;
  nodes: Record<string, GraphNode & { canExpand: boolean }>;
  edges: Array<{ id: string; from: string; to: string; depth: number }>;
  boxes: Record<string, { x: number; y: number; width: number; height: number }>;
  collapsedCount: number;
}

interface SessionSummary {
  id: string;
  title: string;
  description: string;
  direction: Direction;
}

export class GraphViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly sessions: CallSession[] = [];
  private activeId?: string;
  private engineLabel = '';
  /** 跳转后短暂高亮用的装饰与定时器（同一时刻只保留一个）。 */
  private flashDecoration?: vscode.TextEditorDecorationType;
  private flashTimer?: ReturnType<typeof setTimeout>;
  /** 每个会话里用户最后选中的节点（供复制命令使用）。 */
  private readonly selectedIds = new Map<string, string>();
  /**
   * webview 回传的**实测方框宽度**（会话 id → 节点 id → 宽度）。
   *
   * 宿主没有排版引擎、量不了文字，只能按字符数估宽；估宽一旦偏大，
   * 列就被推远、箭头被拉长。所以由 webview 量准后回传，宿主用它排列位置，
   * 列间距才严格等于 COLUMN_GAP。
   */
  private readonly measuredWidths = new Map<string, Map<string, number>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly renderHtml: (webview: vscode.Webview) => string,
    /** 出错时的轻量提示（由扩展入口接到状态栏，不弹 Toast）。 */
    private readonly onError: (message: string) => void = () => {}
  ) {
    this.restore();
  }

  /** 清理跳转高亮的资源（扩展停用时调用）。 */
  dispose(): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
    }
    this.flashDecoration?.dispose();
    this.flashDecoration = undefined;
  }

  // ---------------------------------------------------------- 会话管理

  get sessionCount(): number {
    return this.sessions.length;
  }

  listSessions(): CallSession[] {
    return [...this.sessions];
  }

  getSession(id: string): CallSession | undefined {
    return this.sessions.find((session) => session.id === id);
  }

  get activeSession(): CallSession | undefined {
    return this.activeId
      ? this.getSession(this.activeId)
      : this.sessions[this.sessions.length - 1];
  }

  /**
   * 「当前元素」的节点 id：优先用户最后点过的方框，没有则用根节点。
   * 复制命令靠它决定复制谁。
   */
  get activeNodeId(): string | undefined {
    const session = this.activeSession;
    if (!session) {
      return undefined;
    }
    const selected = this.selectedIds.get(session.id);
    if (selected && session.node(selected)) {
      return selected;
    }
    return session.rootId;
  }

  /** 复制某个节点的符号名（方框右键菜单）。 */
  async copyNodeName(sessionId: string, nodeId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      logWarn(`复制元素失败：找不到会话 ${sessionId}`);
      return;
    }
    const result = await copyNodeName(session, nodeId);
    if (!result.ok) {
      logWarn(`复制元素失败：${result.text}`);
      return;
    }
    logInfo(`已复制元素名到剪贴板：${result.text}`);
  }

  /** 复制某个节点的 文件:行号（方框右键菜单）。 */
  async copyNodeLocation(sessionId: string, nodeId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      logWarn(`复制地址失败：找不到会话 ${sessionId}`);
      return;
    }
    const result = await copyNodeLocation(session, nodeId);
    if (!result.ok) {
      logWarn(`复制地址失败：${result.text}`);
      return;
    }
    logInfo(`已复制地址到剪贴板：${result.text}`);
  }

  /** 新增一个会话：把视图显示出来，并下发标签与图。 */
  async addSession(session: CallSession): Promise<void> {
    this.sessions.push(session);
    this.activeId = session.id;
    await this.setViewVisible(true);
    await this.showView();
    logInfo(
      `已加入标签「${session.title}」，当前共 ${this.sessions.length} 个；视图${
        this.view ? `已创建（visible=${this.view.visible}）` : '尚未创建'
      }`
    );
    this.postSummaries();
    this.postSession(session);
    await this.persist();
  }

  closeSession(id: string): void {
    const index = this.sessions.findIndex((session) => session.id === id);
    if (index < 0) {
      return;
    }
    this.sessions.splice(index, 1);
    // 一并清掉该会话的实测宽度缓存，避免长期占用
    this.measuredWidths.delete(id);
    if (this.activeId === id) {
      const next = this.sessions[Math.min(index, this.sessions.length - 1)];
      this.activeId = next?.id;
      if (next) {
        this.postSession(next);
      }
    }
    this.postSummaries();
    if (this.sessions.length === 0) {
      this.activeId = undefined;
      // 全部关闭：把整个面板视图一起收起来。
      void this.setViewVisible(false);
      logInfo('已关闭最后一个标签，收起面板视图');
    }
    void this.persist();
  }

  closeAll(): void {
    this.sessions.length = 0;
    this.activeId = undefined;
    this.measuredWidths.clear();
    this.postSummaries();
    void this.setViewVisible(false);
    logInfo('已关闭全部标签，收起面板视图');
    void this.persist();
  }

  /**
   * 控制面板视图的显示/隐藏。
   * VS Code 只在面板已打开时重新求值 when，所以这里同时配合 showView() 主动显示。
   */
  private async setViewVisible(visible: boolean): Promise<void> {
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, visible);
  }

  setEngineLabel(label: EngineLabel): void {
    this.engineLabel = describeEngine(label);
    for (const session of this.sessions) {
      session.engineLabel = this.engineLabel;
    }
    this.postSummaries();
  }

  private updateBadge(): void {
    if (!this.view) {
      return;
    }
    this.view.badge =
      this.sessions.length > 0
        ? { value: this.sessions.length, tooltip: `${this.sessions.length} 个调用关系标签` }
        : undefined;
    this.view.description =
      this.sessions.length > 0
        ? `${this.sessions.length} 个标签${this.engineLabel ? ` · ${this.engineLabel}` : ''}`
        : undefined;
  }

  // ---------------------------------------------------------- WebviewView

  /** 把视图显示到最前。优先用 view.show()，它直接、不依赖 when 条件；focus 作为兜底。 */
  private async showView(): Promise<void> {
    if (this.view) {
      try {
        this.view.show(false);
        logInfo('已调用 view.show(false)');
      } catch (error) {
        logWarn(`view.show 失败：${String(error)}`);
      }
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        logInfo(`已执行 ${VIEW_ID}.focus（第 ${attempt} 次尝试成功）`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn(`聚焦视图失败（第 ${attempt} 次）：${message}`);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
    logWarn('三种方式都未能聚焦视图（面板可能被用户折叠了）');
  }

  /** 供命令使用：把视图显示出来。 */
  async focus(): Promise<void> {
    await this.showView();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    logInfo('WebviewView 已被 VS Code 解析，开始注入 HTML');
    try {
      view.webview.options = {
        enableScripts: true,
        // 关键：必须允许加载扩展目录里的 webview.js，否则脚本被静默拦掉。
        localResourceRoots: webviewResourceRoots(),
      };
      view.webview.html = this.renderHtml(view.webview);
      logInfo(`HTML 注入完成，长度 ${view.webview.html.length}`);
    } catch (error) {
      logError('注入 webview HTML 失败', error);
      view.webview.html = `<html><body style="font-family:sans-serif;padding:12px">注入 webview 失败：${String(
        error
      )}<br>详见「C/C++ 调用关系图」输出通道。</body></html>`;
    }
    view.onDidDispose(() => {
      logInfo('WebviewView 已被销毁');
      this.view = undefined;
    });
    view.onDidChangeVisibility(() => {
      logInfo(`WebviewView 可见性变化：visible=${view.visible}`);
      if (view.visible) {
        this.postInit();
      }
    });
    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === 'error') {
        logError(`webview 报错：${message.message}`);
        this.onError(`视图内报错：${message.message}`);
        return;
      }
      logInfo(`收到 webview 消息：${message.type}`);
      void this.handleMessage(message);
    });
    this.updateBadge();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'requestInit': {
        this.postInit();
        break;
      }
      case 'selectTab': {
        const session = this.getSession(message.id);
        if (session) {
          this.activeId = message.id;
          // 切换标签必须把该标签的图补发给前端，否则前端只有摘要、没有内容。
          this.postSession(session);
        }
        break;
      }
      case 'closeTab': {
        this.closeSession(message.id);
        break;
      }
      case 'closeAllTabs': {
        this.closeAll();
        break;
      }
      case 'expand': {
        await this.expandNode(message.sessionId, message.nodeId);
        break;
      }
      case 'expandAll': {
        await this.expandAll(message.sessionId);
        break;
      }
      case 'openLocation': {
        await this.openLocation(message.sessionId, message.nodeId);
        break;
      }
      case 'selectNode': {
        // 用户点了某个方框：记下来，供「复制元素 / 复制地址」使用
        this.selectedIds.set(message.sessionId, message.nodeId);
        break;
      }
      case 'openSettings': {
        // 工具栏的齿轮按钮：打开 VS Code 设置并预过滤到本扩展。
        // 命令 ID 取自 VS Code 自己的 workbench 包（workbench.action.openSettings），
        // 传扩展 id 作为查询串，设置页会直接筛出本插件的 4 项设置。
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          `@ext:${this.context.extension.id}`
        );
        break;
      }
      case 'reportWidths': {
        // webview 量好方框宽度后回传，用于下一次布局排列列位置。
        const next = new Map<string, number>();
        for (const item of message.widths) {
          if (Number.isFinite(item.width) && item.width > 0) {
            next.set(item.id, Math.round(item.width));
          }
        }
        const previous = this.measuredWidths.get(message.sessionId);
        // 只在**确实变了**的时候才重排，否则会「回传 → 重排 → 再回传」无限循环。
        if (previous && sameWidths(previous, next)) {
          break;
        }
        this.measuredWidths.set(message.sessionId, next);
        const session = this.getSession(message.sessionId);
        if (session) {
          this.postSession(session);
        }
        break;
      }
      case 'copyTabText': {
        // 工具栏的「复制当前标签为文本」：整棵已展开的关系树。
        // 直接调扩展注册的同名命令，避免把导出逻辑复制一份。
        await vscode.commands.executeCommand('cppCallGraph.copyActive');
        break;
      }
      case 'copyNodeName': {
        // 方框右键菜单：复制该方框的符号名
        await this.copyNodeName(message.sessionId, message.nodeId);
        break;
      }
      case 'copyNodeLocation': {
        // 方框右键菜单：复制该方框的 文件:行号
        await this.copyNodeLocation(message.sessionId, message.nodeId);
        break;
      }
      case 'saveOffsets': {
        // 拖动偏移由 webview 自己维护，宿主不需要参与。
        break;
      }
    }
  }

  private async expandNode(sessionId: string, nodeId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      logWarn(`展开请求找不到会话：${sessionId}`);
      return;
    }
    const node = session.node(nodeId);
    try {
      const added = await session.expand(nodeId);
      logInfo(
        added === 0
          ? `展开「${node?.name ?? nodeId}」：没有下一层调用关系`
          : `展开「${node?.name ?? nodeId}」：新增 ${added} 个节点（当前共 ${Object.keys(session.nodeRecord()).length} 个）`
      );
    } catch (error) {
      logError(`展开「${node?.name ?? nodeId}」失败`, error);
      this.onError(`展开调用关系失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.postSession(session);
    await this.persist();
  }

  /** 反复展开未展开的节点，最多两轮，避免在大工程上一次拉爆。 */
  /**
   * 工具栏的「展开全部」。
   *
   * 逐层请求语言服务，所以要有两个上限，避免在巨大工程上把语言服务拖死：
   *   - MAX_EXPAND_ROUNDS：层数上限
   *   - MAX_EXPAND_NODES：节点总数上限（与 maxChildrenPerNode 的默认档位相称）
   * 走 withProgress 显示进度（面板在底部，用户能看见；不是弹窗 Toast）。
   */
  private async expandAll(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }
    const maxChildren =
      vscode.workspace
        .getConfiguration('cppCallGraph')
        .get<number>('maxChildrenPerNode', 200) || 200;
    const nodeBudget = Math.min(MAX_EXPAND_NODES, maxChildren * MAX_EXPAND_ROUNDS);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: '正在展开全部调用关系…' },
      async (progress) => {
        let total = 0;
        for (let round = 0; round < MAX_EXPAND_ROUNDS; round += 1) {
          const targets = Object.values(session.nodeRecord())
            .filter((node) => !node.loaded && !node.isCycle)
            .map((node) => node.id);
          if (targets.length === 0) {
            break;
          }
          for (const id of targets) {
            if (Object.keys(session.nodeRecord()).length >= nodeBudget) {
              logWarn(`展开全部：已达节点上限 ${nodeBudget}，停止继续展开。`);
              this.postSession(session);
              await this.persist();
              return;
            }
            try {
              await session.expand(id);
              total += 1;
            } catch (error) {
              logError(`展开 ${id} 失败`, error);
              this.onError(
                `批量展开失败：${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
          // progress 可能不存在（宿主实现差异；类型上它是必需的，但实测会传 undefined）。
          // 这里必须用可选调用，否则整个「展开全部」会在第一轮就抛错、
          // 表现为「点了没反应」——曾经就是这样。
          progress?.report({
            message: `第 ${round + 1} 层，已处理 ${total} 个节点`,
          });
        }
        logInfo(
          `展开全部完成：处理 ${total} 个节点，当前共 ${Object.keys(session.nodeRecord()).length} 个。`
        );
        this.postSession(session);
        await this.persist();
      }
    );
  }

  private async openLocation(sessionId: string, nodeId: string): Promise<void> {
    const session = this.getSession(sessionId);
    const item = session?.item(nodeId);
    if (!item) {
      return;
    }
    // 记录「当前元素」，供「复制元素 / 复制地址」使用（无论 autoReveal 是否开启）
    this.selectedIds.set(sessionId, nodeId);
    if (!vscode.workspace.getConfiguration('cppCallGraph').get<boolean>('autoReveal', true)) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(item.uri);
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: true,
      });
      // 高亮范围优先用整个声明（range），它比 selectionRange（只有名字）更容易看见；
      // 若声明跨行过多，退回到名字范围，免得糊住整屏。
      const selection = item.selectionRange ?? item.range;
      const whole = item.range ?? selection;
      const spanLines = whole.end.line - whole.start.line;
      const range = spanLines <= 12 ? whole : selection;
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      editor.selection = new vscode.Selection(selection.start, selection.start);
      this.flashHighlight(editor, range);
    } catch (error) {
      logError('打开函数位置失败', error);
    }
  }

  /**
   * 在编辑器里短暂高亮某个范围，让人一眼看到「跳到哪了」。
   *
   * 做法：加一个装饰，`FLASH_MS` 后自动撤掉。
   * 注意两点：
   *   1. 定时器必须存起来，同一会话里连续跳转时先清掉上一个，否则旧定时器
   *      会把新加的高亮提前撤掉；
   *   2. 扩展停用时要把装饰与定时器一起清理（见 dispose）。
   */
  private flashHighlight(editor: vscode.TextEditor, range: vscode.Range): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
    }
    if (this.flashDecoration) {
      editor.setDecorations(this.flashDecoration, []);
    }

    const decoration = vscode.window.createTextEditorDecorationType({
      // 用 VS Code 自己的「查找匹配」底色，深浅主题下都适配
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      borderRadius: '3px',
      isWholeLine: false,
    });
    editor.setDecorations(decoration, [range]);
    this.flashDecoration = decoration;

    this.flashTimer = setTimeout(() => {
      this.flashTimer = undefined;
      decoration.dispose();
      if (this.flashDecoration === decoration) {
        this.flashDecoration = undefined;
      }
    }, FLASH_MS);
  }

  // ---------------------------------------------------------- 消息下发

  /** 全量同步：标签摘要 + 当前活动会话的图。 */
  private postInit(): void {
    if (!this.view) {
      logWarn('postInit：视图对象还不存在，跳过一次同步');
      return;
    }
    const active = this.activeSession;
    const summaries: SessionSummary[] = this.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      description: session.description,
      direction: session.direction,
    }));
    const payloads = active ? [this.buildPayload(active)] : [];
    void this.view.webview
      .postMessage({
        type: 'init',
        sessions: payloads,
        summaries,
        activeId: active ? active.id : '',
      })
      .then(
        (ok) => logInfo(`postInit 已下发：${summaries.length} 个标签，postMessage=${ok}`),
        (error) => logError('postInit 下发失败（消息可能无法结构化克隆）', error)
      );
  }

  private postSession(session: CallSession): void {
    if (!this.view) {
      logWarn('postSession：视图对象还不存在，跳过一次同步');
      return;
    }
    let payload: SessionPayload;
    try {
      payload = this.buildPayload(session);
    } catch (error) {
      logError('构建会话负载失败', error);
      this.onError(`构建视图数据失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const nodeCount = Object.keys(payload.nodes).length;
    void this.view.webview
      .postMessage({ type: 'sessionUpdate', session: payload })
      .then(
        (ok) =>
          logInfo(
            `postSession 已下发「${payload.title}」：${nodeCount} 个节点、${payload.edges.length} 条连线，postMessage=${ok}`
          ),
        (error) =>
          logError(
            `postSession 下发失败（节点 ${nodeCount} 个，消息可能无法结构化克隆）`,
            error
          )
      );
    this.updateTitle();
  }

  private postSummaries(): void {
    this.updateTitle();
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'update',
      sessions: this.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        description: session.description,
        direction: session.direction,
      })),
      activeId: this.activeSession?.id ?? '',
    });
  }

  private updateTitle(): void {
    if (!this.view) {
      return;
    }
    const active = this.activeSession;
    this.view.title = active
      ? `${DIRECTION_SHORT[active.direction]}:${active.rootItem.name}`
      : '调用关系图';
    this.updateBadge();
  }

  buildPayload(session: CallSession): SessionPayload {
    const { nodes, edges } = session.graph();
    // 用 webview 上一帧回传的实测宽度排布列位置；没有时 createLayout 自己估宽。
    const measured = this.measuredWidths.get(session.id);
    const layout = createLayout(nodes, session.rootId, measured);
    const payloadNodes: SessionPayload['nodes'] = {};
    for (const [id, node] of Object.entries(nodes)) {
      payloadNodes[id] = {
        ...node,
        canExpand: !node.loaded && !node.isCycle,
      };
    }
    return {
      id: session.id,
      title: session.title,
      description: session.description,
      direction: session.direction,
      engineLabel: session.engineLabel,
      rootId: session.rootId,
      nodes: payloadNodes,
      edges,
      boxes: layout.boxes,
      collapsedCount: session.collapsedCount,
    };
  }

  // ---------------------------------------------------------- 持久化

  private async persist(): Promise<void> {
    await this.context.workspaceState.update(
      STORAGE_KEY,
      this.sessions.map((session) => session.serialize())
    );
  }

  private restore(): void {
    const snapshots = this.context.workspaceState.get<SerializedSession[]>(STORAGE_KEY, []);
    for (const snapshot of snapshots) {
      try {
        this.sessions.push(CallSession.restore(snapshot));
      } catch (error) {
        logError('恢复会话失败', error);
      }
    }
    this.activeId = this.sessions[this.sessions.length - 1]?.id;
    if (this.sessions.length > 0) {
      logInfo(`从上次会话恢复了 ${this.sessions.length} 个调用关系标签。`);
      void this.setViewVisible(true);
    }
  }
}

// ---------------------------------------------------------------- 工具

/**
 * 比较两份实测宽度是否一致。
 *
 * 用途：webview 每次渲染都会回传实测宽度，宿主据此重排；若不做这层比较，
 * 就会「回传 → 重排 → 再回传」无限循环。宽度稳定后即停止重排。
 */
function sameWidths(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [id, width] of a) {
    if (b.get(id) !== width) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- 消息类型

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'requestInit' }
  | { type: 'selectTab'; id: string }
  | { type: 'closeTab'; id: string }
  | { type: 'closeAllTabs' }
  | { type: 'expand'; sessionId: string; nodeId: string }
  | { type: 'expandAll'; sessionId: string }
  | { type: 'openLocation'; sessionId: string; nodeId: string }
  | { type: 'selectNode'; sessionId: string; nodeId: string }
  | { type: 'openSettings' }
  | { type: 'copyTabText'; sessionId: string }
  | { type: 'reportWidths'; sessionId: string; widths: Array<{ id: string; width: number }> }
  | { type: 'copyNodeName'; sessionId: string; nodeId: string }
  | { type: 'copyNodeLocation'; sessionId: string; nodeId: string }
  | {
      type: 'saveOffsets';
      sessionId: string;
      offsets: Array<{ id: string; dx: number; dy: number }>;
    };
