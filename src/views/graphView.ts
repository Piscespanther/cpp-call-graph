/**
 * 方案 B 的宿主侧：底部面板里的 WebviewView 承载所有调用关系标签页。
 *
 * - 每次「被调用关系图 / 调用关系图」产生一个 CallSession，对应 webview 里的一个标签页；
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
import { Direction, EngineLabel, badgeFor, describeEngine } from '../hierarchy/callHierarchy';
import { CallSession, SerializedSession, maxChildrenPerNodeLimit } from '../hierarchy/session';
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
/** 持久化合流窗口（毫秒）：连续展开时只在停下来之后写一次快照。 */
const PERSIST_DELAY_MS = 400;
/** 「展开全部」的层数上限默认值（设置项 `cppCallGraph.maxExpandRounds` 可改）；
 *  节点总量上限固定为 800，与布局上限一致 —— 超过布局上限的节点没有方框，不会上图。 */
const DEFAULT_MAX_EXPAND_ROUNDS = 5;
/** 节点总数上限的默认值（设置项 `cppCallGraph.maxLayoutNodes` 可改）。 */
const MAX_EXPAND_NODES = 800;

/**
 * 节点总数上限（设置项 `cppCallGraph.maxLayoutNodes`）。
 *
 * 与布局上限是**同一个值**：超过它的节点没有方框、不会上图，所以「展开全部 / 完全展开」的
 * 预算也必须用它，否则会出现「预算里算进去了、画面上却没有」的节点。
 * 夹到 [100, 5000]：下限防止手滑填 1 变成空图，上限防止一次整帧重绘把界面拖死
 * （实测 400 节点约 8ms、1200 节点约 30ms）。
 */
function maxLayoutNodesLimit(): number {
  const value = vscode.workspace
    .getConfiguration('cppCallGraph')
    .get<number>('maxLayoutNodes', MAX_EXPAND_NODES);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MAX_EXPAND_NODES;
  }
  return Math.min(5000, Math.max(100, Math.floor(value)));
}

/**
 * 「展开全部」的层数上限（设置项 `cppCallGraph.maxExpandRounds`）。
 *
 * ⚠️ 与 `maxChildrenPerNodeLimit()` 同一口径：0 / 负数 / NaN / 小数一律夹到合法范围，
 * 否则手改 settings.json 会算出 0 轮或负数预算，「展开全部」变成点了没反应。
 */
function maxExpandRoundsLimit(): number {
  const value = vscode.workspace
    .getConfiguration('cppCallGraph')
    .get<number>('maxExpandRounds', DEFAULT_MAX_EXPAND_ROUNDS);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : DEFAULT_MAX_EXPAND_ROUNDS;
}

/**
 * 读一个「层数 / 计数」类设置：0 / 负数 / NaN / 小数一律归一（0 表示「该项不用」）。
 *
 * 与 `maxChildrenPerNodeLimit()`、`maxExpandRoundsLimit()` 同一口径 —— 手改 settings.json
 * 写进小数或负数时，不能让下游算出负数或 0.5 层这种无意义的窗口。
 */
function readCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 已经就 `pathAnchors` 的写法提示过一次（每次重排都会读设置，不能反复刷日志）。 */
let warnedAnchorsShape = false;
/**
 * 读路径锚点设置。
 *
 * 设置项是**逗号分隔的字符串**（手写最省事，不必写数组与引号），例如 `chip,chip+1`。
 * 但两种写法都容错接受：
 *   - 数组：每项再按逗号切一次（`["chip,chip+1"]` 这种"数组里塞一条逗号串"的写法很常见）；
 *   - 字符串：直接按逗号切。
 * 早期版本把整条 `"chip,chip+1"` 当成一个模式，解析不出任何段就静默忽略 ——
 * 表现是"设置没反应"，所以这里必须切开，并在写法偏离时提示一次。
 */
function readAnchors(value: unknown): string[] {
  const split = (text: string): string[] =>
    text
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  if (Array.isArray(value)) {
    const patterns = value.flatMap((item) => split(String(item)));
    if (value.some((item) => String(item).includes(',')) && !warnedAnchorsShape) {
      warnedAnchorsShape = true;
      logWarn(
        'cppCallGraph.pathAnchors 建议直接写成逗号分隔的字符串，例如 "chip,chip+1"；' +
          '写在数组项里的逗号串已按同样规则拆开。'
      );
    }
    return patterns;
  }
  return typeof value === 'string' ? split(value) : [];
}

export interface SessionPayload {
  id: string;
  title: string;
  description: string;
  direction: Direction;
  engineLabel: string;
  /** 标签角标 id（由引擎配置档决定；webview 用它选图标，读不到设置也不猜名字）。 */
  badge?: string;
  rootId: string;
  nodes: Record<string, GraphNode & { canExpand: boolean }>;
  edges: Array<{ id: string; from: string; to: string; depth: number }>;
  boxes: Record<string, { x: number; y: number; width: number; height: number }>;
  collapsedCount: number;
  /** 布局是否已吃满节点总数上限（面板据此禁用两个展开按钮并显示原因）。 */
  atCapacity: boolean;
  /** 生效的节点总数上限，用于把原因写清楚（「已达 800」这类具体数字）。 */
  maxLayoutNodes: number;
}

interface SessionSummary {
  id: string;
  title: string;
  description: string;
  direction: Direction;
  badge?: string;
}

export class GraphViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly sessions: CallSession[] = [];
  private activeId?: string;
  private engineLabel = '';
  /**
   * 当前正在进行的「可能较慢」的解析（`beginResolve()` 建立，`endResolve()` 清除）。
   * token 用来让过期的取消请求失效，cancelled 由 webview 的「取消」按钮置位。
   */
  private busy: { token: number; cancelled: boolean } | undefined;
  /** 跳转后短暂高亮用的装饰与定时器（同一时刻只保留一个）。 */
  private flashDecoration?: vscode.TextEditorDecorationType;
  private flashTimer?: ReturnType<typeof setTimeout>;
  /** 待写的持久化快照（合并连续展开，见 schedulePersist）。 */
  private persistTimer?: ReturnType<typeof setTimeout>;
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

  /**
   * 每个标签里**被收起**的节点（webview 每次改变收起状态都会整份下发）。
   *
   * 为什么宿主必须知道：坐标是宿主算的。收起的子树如果照样占高度，同级的兄弟之间
   * 就会一直留着一段空荡荡的「空挡」——用户 2026-10-10 实测反馈：
   * 把第三级折叠之后，第二级的空挡还在。
   */
  private readonly collapsedNodes = new Map<string, Set<string>>();

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
    // 还有没写盘的快照：停用前补写一次，否则最后几次展开会丢
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      void this.persist();
    }
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

  /** 忘掉某个会话的所有按 id 索引的缓存（关闭标签时统一走这里）。 */
  private forgetSession(id: string): void {
    this.measuredWidths.delete(id);
    this.collapsedNodes.delete(id);
    this.selectedIds.delete(id);
  }

  closeSession(id: string): void {
    const index = this.sessions.findIndex((session) => session.id === id);
    if (index < 0) {
      return;
    }
    this.sessions.splice(index, 1);
    // 一并清掉该会话的缓存，避免长期占用（也免得恢复同名会话时套用旧状态）
    this.forgetSession(id);
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
    // 三份按会话 id 索引的表都要清（曾经只清了实测宽度）
    this.measuredWidths.clear();
    this.collapsedNodes.clear();
    this.selectedIds.clear();
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
    // ⚠️ 只更新**视图**上的引擎名，不要回写各会话的 `engineLabel` ——
    // 会话里存的是**引擎 id**（角标 `badgeFor()` 与会话来源标注都按 id 查表），
    // 而这里是展示名（含版本与可执行文件路径）。回写会把自定义引擎的角标、
    // 以及引用兜底会话的「文本搜索」来源标注一并冲掉（重载窗口后必然发生）。
    this.engineLabel = describeEngine(label);
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
      case 'ready': {
        this.postInit();
        break;
      }
      case 'selectTab': {
        const session = this.getSession(message.id);
        if (session) {
          this.activeId = message.id;
          // 切换标签必须把该标签的图补发给前端，否则前端只有摘要、没有内容。
          this.postSession(session);
          // ⚠️ 还必须显式告知「现在活动的是这个标签」。webview 只在**新会话**的
          // sessionUpdate 里认领活动标签（否则 relayout 逐个重发时标签会自己跳到最后），
          // 所以补发内容本身并不切换标签 —— 缺了这条消息，点标签就没有任何反应，
          // 只有最新建出的那个标签点得动。
          void this.view?.webview.postMessage({ type: 'selectTab', id: message.id });
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
      case 'expandFull': {
        await this.expandFull(message.sessionId);
        break;
      }
      case 'collapse': {
        // 收起状态变了：记下来并重新布局（收起的子树不占高度，兄弟之间的空挡随之收掉）
        //
        // ⚠️ 集合没变就直接跳过：postSession 会重算整张图 + 重排版 + 全量克隆，
        // 而 webview 每次改收起状态都整份重发，无变化时的重排纯属浪费。
        const next = new Set(message.collapsed);
        const previous = this.collapsedNodes.get(message.sessionId);
        if (previous && previous.size === next.size && [...next].every((id) => previous.has(id))) {
          break;
        }
        // ⚠️ 先确认会话还在，再写缓存：标签关闭后仍在路上的 collapse 会把条目写回已关闭会话的 id，
        // 而 forgetSession 已经清过一遍、此后再无人清理（会话 id 是随机串，不会复用）。
        const session = this.sessions.find((item) => item.id === message.sessionId);
        if (!session) {
          break;
        }
        this.collapsedNodes.set(message.sessionId, next);
        this.postSession(session);
        break;
      }
      case 'cancelResolve': {
        // 用户在加载遮罩上点了「取消」：让正在进行的多步解析尽快收尾
        if (this.busy) {
          this.busy.cancelled = true;
          logInfo('收到「取消」：停止当前解析。');
        }
        break;
      }
      case 'openLocation': {
        await this.openLocation(message.sessionId, message.nodeId);
        break;
      }
      case 'selectNode': {
        // 用户点了某个方框：记下来，供「复制元素 / 复制地址」使用
        //
        // ⚠️ 与 collapse / reportWidths 同一口径：先确认会话还在，再写缓存。
        // 标签关闭后仍在路上的 selectNode 会给已关闭会话留一条永不清理的条目
        // （forgetSession 已经清过一次，此后无人再清；会话 id 是随机串、不会复用）。
        if (this.getSession(message.sessionId)) {
          this.selectedIds.set(message.sessionId, message.nodeId);
        }
        break;
      }
      case 'openSettings': {
        // 工具栏的齿轮按钮：打开 VS Code 设置并预过滤到本扩展。
        // 命令 ID 取自 VS Code 自己的 workbench 包（workbench.action.openSettings），
        // 传扩展 id 作为查询串，设置页会直接筛出本插件的设置（0.21 起共 9 项）。
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
        // 先确认会话还在，再落缓存 —— 否则已关闭的会话 id 也会留下一条永不清理的条目
        const session = this.getSession(message.sessionId);
        if (!session) {
          break;
        }
        this.measuredWidths.set(message.sessionId, next);
        this.postSession(session);
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
      // `expand` 返回 0 有两种情况：① 这一层确实没有调用关系；② 等待超时或该节点正在展开中
      // —— 后两种都没有把节点标记为已加载。日志必须分开写，否则「没响应」会被读成「本来就没有」。
      const loaded = session.node(nodeId)?.loaded === true;
      logInfo(
        added > 0
          ? `展开「${node?.name ?? nodeId}」：新增 ${added} 个节点（当前共 ${Object.keys(session.nodeRecord()).length} 个）`
          : loaded
            ? `展开「${node?.name ?? nodeId}」：没有下一层调用关系`
            : `展开「${node?.name ?? nodeId}」：未取到结果（等待超时或正在展开中），可再点一次重试`
      );
    } catch (error) {
      logError(`展开「${node?.name ?? nodeId}」失败`, error);
      this.onError(`展开调用关系失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.postSession(session);
    // 每次展开都全量序列化所有会话是明显的开销，这里合并成一次写（停下 400ms 后落盘）
    this.schedulePersist();
  }

  /**
   * 工具栏的「展开全部」：按设置项 `cppCallGraph.maxExpandRounds` 的层数上限逐层展开。
   * 节点预算按「每层上限 × 层数」折算（与设置里的两个上限相称），再夹到布局上限以内。
   */
  private async expandAll(sessionId: string): Promise<void> {
    const rounds = maxExpandRoundsLimit();
    await this.expandBatched(sessionId, {
      rounds,
      nodeBudget: Math.min(maxLayoutNodesLimit(), maxChildrenPerNodeLimit() * rounds),
      title: '正在展开全部调用关系…',
      label: '展开全部',
    });
  }

  /**
   * 工具栏的「完全展开」：递归展开直到没有可展开的节点，**不受层数上限约束**。
   *
   * 与「展开全部」的差别只有这一点：层数不设限。节点总数仍夹在布局上限以内
   * （超过上限的节点没有方框、不会上图，日志里会说明有多少个未显示）。
   */
  private async expandFull(sessionId: string): Promise<void> {
    await this.expandBatched(sessionId, {
      rounds: Number.POSITIVE_INFINITY,
      nodeBudget: maxLayoutNodesLimit(),
      title: '正在完全展开调用关系…',
      label: '完全展开',
    });
  }

  /**
   * 「展开全部」与「完全展开」共用的逐层展开。
   *
   * 逐层请求语言服务，所以要有限度，避免在巨大工程上把语言服务拖死：
   *   - `rounds`：最多展开几层（`Infinity` 表示递归到底）
   *   - `nodeBudget`：节点总数上限，且**每次 expand 都夹剩余额度**（见下）
   * 走 withProgress 显示进度（面板在底部，用户能看见；不是弹窗 Toast）。
   */
  private async expandBatched(
    sessionId: string,
    options: { rounds: number; nodeBudget: number; title: string; label: string }
  ): Promise<void> {
    const { rounds, nodeBudget, title, label } = options;
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }
    // ⚠️ 已达上限时**提前给出交代**，不要跑进循环再逐层空转（用户反馈「到上限后两个展开按钮
    // 点了没用」）：那时循环会在第一个目标上算出 remaining ≤ 0 直接返回，面板上什么都不会变，
    // 唯一的痕迹是一行输出通道日志 —— 等于没有反馈。
    const currentCount = Object.keys(session.nodeRecord()).length;
    if (currentCount >= nodeBudget) {
      logWarn(
        `${label}：已达节点总数上限 ${nodeBudget}（当前 ${currentCount} 个），未再展开。` +
          `可在设置中调大 cppCallGraph.maxLayoutNodes，或先收起部分分支后重试。`
      );
      // 重发一次会话：面板据此把「展开全部 / 完全展开」置为禁用态并显示原因
      this.postSession(session);
      return;
    }
    // 已经尝试过的节点：失败的展开不会把 `loaded` 置位，若只按 `!loaded` 挑目标，
    // 「完全展开」会在同一个失败节点上无限重试（层数不设限，没有别的机制来打断它）。
    const attempted = new Set<string>();

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title },
      async (progress) => {
        let total = 0;
        for (let round = 0; round < rounds; round += 1) {
          const targets = Object.values(session.nodeRecord())
            .filter((node) => !node.loaded && !node.isCycle && !attempted.has(node.id))
            .map((node) => node.id);
          if (targets.length === 0) {
            break;
          }
          for (const id of targets) {
            attempted.add(id);
            // ⚠️ 每轮都要复查会话还在不在：循环里每个节点都要 await 一次语言服务，
            // 大图上这可能是几秒到几十秒；期间用户很可能已经关掉这个标签（或点了「关闭全部」）。
            // 不复查的话请求会继续跑满预算，而用户唯一的「停止」手段就是关标签 —— 那等于无效。
            if (!this.getSession(sessionId)) {
              logInfo(`「${label}」中止：该标签已被关闭。`);
              return;
            }
            const before = Object.keys(session.nodeRecord()).length;
            // 剩余预算必须夹进这一次 expand：预算是在展开**之前**查的，而单次 expand 最多
            // 能新增 maxChildrenPerNode 个节点，只查预算会让总数冲过布局上限
            // （默认档位下最多 799 + 200 = 999 > 800），超出的节点没有方框也没有连线。
            const remaining = nodeBudget - before;
            if (remaining <= 0) {
              logWarn(
                `${label}：已达节点总数上限 ${nodeBudget}（当前 ${before} 个），停止继续展开。` +
                  `可在设置中调大 cppCallGraph.maxLayoutNodes，或先收起部分分支后重试。`
              );
              this.postSession(session);
              await this.persist();
              return;
            }
            try {
              await session.expand(id, remaining);
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
          `${label}完成：处理 ${total} 个节点，当前共 ${Object.keys(session.nodeRecord()).length} 个。`
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
      // 静默返回会让「双击没反应」变成无迹可查：恢复出来的旧快照可能缺 item
      logWarn(`跳转失败：找不到节点 ${nodeId} 的语言服务项（会话 ${sessionId}）。`);
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
      // ⚠️ 必须 dispose 而不是只对当前 editor 清空：setDecorations 只作用于传入的 editor，
      // 上一次跳到别的文件时留下的装饰挂在那个 editor 上，只清当前这个会让它永久留在
      // 先前文件里；而且旧 type 的引用被覆盖后再也没人 dispose 它（每次跳转泄漏一个）。
      this.flashDecoration.dispose();
      this.flashDecoration = undefined;
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

  /**
   * 下发给 webview 的设置项。
   *
   * webview 读不到 VS Code 的设置，只能由宿主读好再随消息送过去。
   * ⚠️ 新增设置项时，**三处要一起改**：`package.json` 的 `configuration`、
   * 这里的方法、以及 `README.md` 的设置表（工作区规则里明写了这条）。
   */
  private settingsPayload(): {
    stickyParent: boolean;
    showLocation: boolean;
    pathDisplay: 'tail' | 'full';
    pathTailLevels: number;
    pathShowFileName: boolean;
    pathAnchors: string[];
  } {
    const config = vscode.workspace.getConfiguration('cppCallGraph');
    return {
      stickyParent: config.get<boolean>('stickyParent', true),
      showLocation: config.get<boolean>('showLocation', true),
      // 路径在一行里怎么省略。锚点模式在这里就整理成数组：webview 只认数组，不该自己解析字符串。
      pathDisplay: config.get<string>('pathDisplay', 'tail') === 'full' ? 'full' : 'tail',
      pathTailLevels: readCount(config.get<number>('pathTailLevels', 0)),
      pathShowFileName: config.get<boolean>('pathShowFileName', true),
      pathAnchors: readAnchors(config.get<unknown>('pathAnchors', [])),
    };
  }

  /**
   * 开始一次「可能较慢」的解析：让 webview 在延迟一小会儿后显示加载遮罩
   * （转圈 + 取消 + 背景模糊）。
   *
   * 返回的句柄用来查询是否已被用户取消 —— 引用查找是一串语言服务请求，
   * 每个请求之间都可以检查一次，于是「取消」是真的能停下，而不是只把遮罩藏起来。
   * ⚠️ 必须把句柄里的 `token` 原样交给 `endResolve(token)`（放在 finally 里），
   * 否则遮罩会一直挂着、而且关错别人的窗口。
   */
  beginResolve(label: string): { token: number; isCancelled: () => boolean } {
    const token = (this.busy?.token ?? 0) + 1;
    this.busy = { token, cancelled: false };
    void this.view?.webview.postMessage({ type: 'busy', busy: true, label });
    return {
      token,
      // ⚠️ 两种「已结束」要区分开：
      //   · 被别人顶掉（`this.busy.token !== token`）→ 视为已取消，让旧的那次尽快收尾；
      //   · 自己的窗口已经正常结束（`this.busy === undefined`）→ **不算取消**，
      //     否则 `endResolve()` 之后随手再判一次就会误判成「用户点了取消」而中止流程。
      isCancelled: () =>
        this.busy !== undefined && (this.busy.token !== token || this.busy.cancelled),
    };
  }

  /**
   * 结束一次解析。
   *
   * ⚠️ 必须校验 token：命令是可以重入的（用户连点两次右键菜单），先开始的那一次结束时
   * 不能把后开始的那一次的 busy 一起清掉 —— 否则后一次会被判成「已取消」而静默不出图，
   * 遮罩也会提前消失、取消按钮随之失效。
   */
  endResolve(token: number): void {
    if (this.busy?.token !== token) {
      return;
    }
    this.busy = undefined;
    void this.view?.webview.postMessage({ type: 'busy', busy: false });
  }

  /** 换一句遮罩文案（解析进入下一阶段时用，例如从「解析」变成「查找引用」）。 */
  setResolveLabel(label: string): void {
    if (!this.busy) {
      return;
    }
    void this.view?.webview.postMessage({ type: 'busy', busy: true, label });
  }

  /**
   * 设置变了：把 webview 需要的那几项重新下发一次。
   *
   * @param relayout 这个设置是否影响**布局几何**（`showLocation` 会影响方框高度）。
   *   影响的话只下发设置是不够的 —— 坐标是宿主算的，webview 手里还是旧盒子（高度 43），
   *   方框不会变矮。所以要把每个会话都按新设置重排一遍再发过去。
   */
  postSettings(relayout = false): void {
    if (!this.view) {
      return;
    }
    const settings = this.settingsPayload();
    void this.view.webview.postMessage({ type: 'settings', settings }).then(
      (ok) => logInfo(`设置已下发：${JSON.stringify(settings)}，postMessage=${ok}`),
      (error) => logError('设置下发失败', error)
    );
    if (relayout) {
      for (const session of this.sessions) {
        this.postSession(session);
      }
    }
  }

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
      // ⚠️ 必须和 postSummaries 一致地带上角标：init 只给活动会话带完整 payload，
      // 其余标签只靠这份摘要占位；漏掉 badge 的表现是「重载窗口后只有活动标签有引擎角标」。
      badge: badgeFor(session.engineLabel),
    }));
    const payloads = active ? [this.buildPayload(active)] : [];
    void this.view.webview
      .postMessage({
        type: 'init',
        sessions: payloads,
        summaries,
        activeId: active ? active.id : '',
        settings: this.settingsPayload(),
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
    // ⚠️ 必须校验归属：展开/展开全部都是 await 之后才回到这里，期间用户可能已经关掉该标签。
    // 不校验的话会下发一个摘要里已不存在的会话，前端会把它当成新会话重新插回标签栏
    // （表现是「关不掉的标签」）。
    if (!this.sessions.includes(session)) {
      logInfo(`postSession：会话「${session.title}」已被关闭，丢弃这次下发。`);
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
        // 角标由宿主按配置档算好传给 webview（它读不到设置，也不该猜引擎名）
        badge: badgeFor(session.engineLabel),
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
    // ⚠️ 路径显示方式必须与 webview 渲染用同一份设置：估宽与实际文字不一致时，
    // 列宽会按错误的宽度排，文字要么顶到加减号、要么右边空一大截。
    const settings = this.settingsPayload();
    const layout = createLayout(
      nodes,
      session.rootId,
      measured,
      this.collapsedNodes.get(session.id),
      settings.showLocation,
      {
        mode: settings.pathDisplay,
        tailLevels: settings.pathTailLevels,
        showFileName: settings.pathShowFileName,
        anchors: settings.pathAnchors,
      },
      maxLayoutNodesLimit()
    );
    const payloadNodes: SessionPayload['nodes'] = {};
    // 布局是否吃满节点总数上限（两种口径见下面的 atCapacity）：先算好，因为下面的循环要用它
    // 给「仍有下一层可展开」的方框打**不带数字**的警示标记（方案 A，用户 2026-10-14 选定）。
    const atCapacity =
      Object.keys(layout.boxes).length >= maxLayoutNodesLimit() ||
      Object.keys(layout.omittedByCap).length > 0;
    for (const [id, node] of Object.entries(nodes)) {
      // 两种省略来源合并成一个总数给标记用，同时保留下因上限被截断的那部分供悬停区分原因
      // （0.22 首版只算了 maxChildrenPerNode，上限截断的方框上什么都没有，用户反馈「到上限后
      // 再展开没反应、也没有省略标记」）。
      const omittedByNodeCap = layout.omittedByCap[id] ?? 0;
      const canExpand = !node.loaded && !node.isCycle;
      const hasBox = layout.boxes[id] !== undefined;
      payloadNodes[id] = {
        ...node,
        omitted: (node.omitted ?? 0) + omittedByNodeCap,
        ...(omittedByNodeCap > 0 ? { omittedByNodeCap } : {}),
        canExpand,
        // 方案 A：到上限时，**有方框且仍有下一层可展开**的格子打一个不带数字的警示标记。
        // 手动点它展开仍然可用 —— 上限只约束「展开全部 / 完全展开」的预算，不拦单点展开。
        ...(atCapacity && canExpand && hasBox ? { cappedExpandable: true } : {}),
      };
    }
    return {
      id: session.id,
      title: session.title,
      description: session.description,
      direction: session.direction,
      engineLabel: session.engineLabel,
      badge: badgeFor(session.engineLabel),
      rootId: session.rootId,
      nodes: payloadNodes,
      edges,
      boxes: layout.boxes,
      /**
       * 布局是否已经吃满节点总数上限：面板据此禁用两个展开按钮并给出原因。
       *
       * 两种情形都算「到顶」：方框数已经等于上限，或者有节点因上限被丢弃（`omittedByCap` 非空）。
       * 只看前者会漏掉「刚好排满但还有未展开节点」的情况，用户仍会觉得点了没用。
       */
      atCapacity,
      maxLayoutNodes: maxLayoutNodesLimit(),
      collapsedCount: session.collapsedCount,
    };
  }

  // ---------------------------------------------------------- 持久化

  /**
   * 写一次持久化快照。
   *
   * 每次展开都会调用它，而它要把**所有**会话全量序列化，多标签大图上是明显的同步开销。
   * 所以热路径走 `schedulePersist()`（合并成一次写），只有关闭标签/新增标签这类
   * 低频且不该丢的操作才直接 `persist()`。
   */
  private async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.context.workspaceState.update(
      STORAGE_KEY,
      this.sessions.map((session) => session.serialize())
    );
  }

  /** 合并式持久化：连续展开多个节点只在停下来之后写一次。 */
  private schedulePersist(): void {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, PERSIST_DELAY_MS);
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

  /**
   * 仅用于测试（`scripts/smoke.js`）：内部缓存的**只读快照**。
   *
   * 为什么需要它：`measuredWidths` / `collapsedNodes` / `selectedIds` 是按会话 id 索引的表，
   * 「消息晚到、会话已关闭」这类竞态只表现在这些表里 —— 界面看不出来，也没有别的观察点。
   * 刻意只返回 id 与计数、不交出内部表本身：测试拿不到引用就改不了状态，
   * 断言反映的仍是真实运行时行为。
   */
  __debugSnapshot(): {
    sessionIds: string[];
    activeId: string | undefined;
    busyToken: number | undefined;
    measuredWidths: Array<{ sessionId: string; count: number }>;
    collapsedNodes: Array<{ sessionId: string; count: number }>;
    selectedIds: Array<{ sessionId: string; nodeId: string }>;
  } {
    return {
      sessionIds: this.sessions.map((session) => session.id),
      activeId: this.activeId,
      busyToken: this.busy?.token,
      measuredWidths: [...this.measuredWidths].map(([sessionId, widths]) => ({
        sessionId,
        count: widths.size,
      })),
      collapsedNodes: [...this.collapsedNodes].map(([sessionId, ids]) => ({
        sessionId,
        count: ids.size,
      })),
      selectedIds: [...this.selectedIds].map(([sessionId, nodeId]) => ({ sessionId, nodeId })),
    };
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
  | { type: 'selectTab'; id: string }
  | { type: 'closeTab'; id: string }
  | { type: 'closeAllTabs' }
  | { type: 'expand'; sessionId: string; nodeId: string }
  | { type: 'expandAll'; sessionId: string }
  /** 「完全展开」：递归到底（不受层数上限约束），节点总数仍受布局上限约束。 */
  | { type: 'expandFull'; sessionId: string }
  | { type: 'collapse'; sessionId: string; collapsed: string[] }
  | { type: 'openLocation'; sessionId: string; nodeId: string }
  | { type: 'selectNode'; sessionId: string; nodeId: string }
  | { type: 'openSettings' }
  | { type: 'cancelResolve' }
  | { type: 'copyTabText'; sessionId: string }
  | { type: 'reportWidths'; sessionId: string; widths: Array<{ id: string; width: number }> }
  | { type: 'copyNodeName'; sessionId: string; nodeId: string }
  | { type: 'copyNodeLocation'; sessionId: string; nodeId: string };
