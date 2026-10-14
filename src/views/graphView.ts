/**
 * 方案 B 的宿主侧：底部面板里的 WebviewView 承载所有调用关系标签页。
 *
 * - 每次「被调用关系图 / 调用关系图」产生一个 CallSession，对应 webview 里的一个标签页；
 * - 标签可以逐个关闭；全部关闭后把整个面板视图一起收起来；
 * - 布局在宿主侧算（graphLayout），webview 只负责画与交互。
 *
 * 两个必须注意的陷阱（均曾出现，注释里写明原因）：
 *   1. webview 的 localResourceRoots 必须包含扩展目录，否则 webview.js 被静默拦掉，
 *      页面永远空白，而宿主收不到任何错误。
 *   2. HTML 模板里的 {{nonce}} 出现多次（CSP / <style> / <script>），必须 replaceAll，
 *      否则 <script> 的 nonce 与 CSP 不一致，脚本被 CSP 拒绝执行。
 */
import * as vscode from 'vscode';
import {
  Direction,
  EngineLabel,
  badgeFor,
  describeEngine,
  describeRelationError,
} from '../hierarchy/callHierarchy';
import { CallSession, SerializedSession, maxChildrenPerNodeLimit } from '../hierarchy/session';
import {
  GraphNode,
  PathDisplayOptions,
  createLayout,
  nameTagPartsFor,
  pathOnlyAnchorPatterns,
  splitQuoted,
  unmatchedAnchorPatterns,
} from '../hierarchy/graphLayout';
import { DIRECTION_LABEL, DIRECTION_SHORT } from '../hierarchy/graphTypes';
import { logError, logInfo, logWarn } from '../util/log';
import { copyNodeLocation, copyNodeName } from '../commands/copyTree';
import {
  ExportFormat,
  ExportSession,
  buildExportFileName,
  buildJsonText,
  buildMarkdownTable,
  buildMarkdownTree,
} from '../commands/exportGraph';
import {
  applyFolderFilter,
  createFolderFilter,
} from '../hierarchy/folderFilter';
import { applyPathQueryFilter } from '../hierarchy/pathQuery';
import { webviewResourceRoots } from '../webview/webviewHtml';

export const VIEW_ID = 'cppCallGraph.graphView';
const CONTEXT_KEY = 'cppCallGraph.hasSessions';
const STORAGE_KEY = 'cppCallGraph.sessions';
/**
 * 已经提示过「这条锚点在整个标签里一处都没命中」的模式。
 *
 * 只为了不刷屏：同一模式只提示一次（用户改设置后如果还是同样写法，也不会重复刷）。
 */
const warnedUnmatchedAnchors = new Set<string>();
/** 跳转后高亮停留时长（毫秒）。够看清位置，又不至于挡视线。 */
const FLASH_MS = 1200;
/** 持久化合流窗口（毫秒）：连续展开时只在停下来之后写一次快照。 */
const PERSIST_DELAY_MS = 400;
/** 「展开全部」的层数上限默认值（设置项 `cppCallGraph.maxExpandRounds` 可改）；
 *  节点总量上限固定为 800，与布局上限一致 —— 超过布局上限的节点没有方框，不会上图。 */const DEFAULT_MAX_EXPAND_ROUNDS = 5;
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
 * 设置项是**逗号分隔的字符串**（手写最省事，不必写数组与引号），例如 `mods,mods+1`。
 * 但两种写法都容错接受：
 *   - 数组：每项再按逗号切一次（`["mods,mods+1"]` 这种"数组里塞一条逗号串"的写法很常见）；
 *   - 字符串：直接按逗号切。
 * 早期版本把整条 `"mods,mods+1"` 当成一个模式，解析不出任何段就静默忽略 ——
 * 表现是"设置没反应"，所以这里必须切开，并在写法偏离时提示一次。
 */
function readAnchors(value: unknown): string[] {
  // 逗号拆分必须**引号感知**：目录名真的带逗号时写作 `"a,b"`，直接 split(',') 会把它切成
  // 两个都匹配不上的模式（表现为「设置没反应」）。见 graphLayout.splitQuoted。
  const split = (text: string): string[] =>
    splitQuoted(text, ',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  if (Array.isArray(value)) {
    const patterns = value.flatMap((item) => split(String(item)));
    if (value.some((item) => String(item).includes(',')) && !warnedAnchorsShape) {
      warnedAnchorsShape = true;
      logWarn(
        'cppCallGraph.pathAnchors 建议直接写成逗号分隔的字符串，例如 "src,src+1"；' +
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
  /**
   * 本会话被**临时路径过滤**隐藏的节点数（含子树），供面板显示「已隐藏 N 个」。
   *
   * 由宿主算：临时过滤的匹配在宿主侧做（见 `pathFilter` 消息），面板手上的 payload
   * 已经被裁掉了那些节点，自己数不出来。0 或缺省表示没有隐藏。
   */
  filteredCount?: number;
}

interface SessionSummary {
  id: string;
  title: string;
  description: string;
  direction: Direction;
  badge?: string;
}

/**
 * 导出格式 → 保存对话框与落盘的参数表。
 *
 * 为什么放在宿主侧：**只有宿主能调 vscode API**，保存位置、文件类型过滤器、
 * 文本还是二进制都由这里决定。`extension` 同时用于默认文件名与 `filters`，
 * 两处因此不可能各写一份而错位。
 */
interface ExportFormatInfo {
  /** 扩展名：既给保存对话框的过滤器，也用作默认文件名的后缀。 */
  extension: string;
  /** 保存对话框里的类型显示名。 */
  filterLabel: string;
  /** 日志与对话框标题里用的格式名。 */
  label: string;
  /** 是否为二进制内容（PNG 由 webview 给 base64，其余由宿主生成文本）。 */
  binary: boolean;
  /**
   * 由宿主生成正文的格式；省略表示正文由 webview 提供（png / svg）。
   *
   * ⚠️ 入参是**所见视图**（`ExportSessionView`，只含当前画面上真正画出来的节点），
   * 不是会话全量：否则过滤掉的节点会出现在导出结果里（与 PNG/SVG 两种口径）。
   */
  build?: (session: ExportSessionView) => string;
}

/** 导出 / 复制用的会话视图：字段与 `commands/exportGraph.ts` 的 `ExportSession` 相同。 */
export type ExportSessionView = ExportSession;

const EXPORT_FORMATS: Record<ExportFormat, ExportFormatInfo> = {
  'png': {
    extension: '.png',
    filterLabel: 'PNG 图片',
    label: '图片（PNG，2×）',
    binary: true,
  },
  'svg': {
    extension: '.svg',
    filterLabel: 'SVG 矢量图',
    label: '矢量图（SVG）',
    binary: false,
  },
  'md-tree': {
    extension: '.md',
    filterLabel: 'Markdown',
    label: 'Markdown（结构树）',
    binary: false,
    build: buildMarkdownTree,
  },
  'md-table': {
    extension: '.md',
    filterLabel: 'Markdown',
    label: 'Markdown（表格）',
    binary: false,
    build: buildMarkdownTable,
  },
  'json': {
    extension: '.json',
    filterLabel: 'JSON',
    label: 'JSON（数据）',
    binary: false,
    build: buildJsonText,
  },
};

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

  /**
   * 临时路径过滤的查询（面板搜索栏右侧输入框的内容，用户 2026-10-15 要求）。
   *
   * ⚠️ **窗口级、不按标签分**：用户口径是「所有打开的标签通用」，因此这里只有一份字符串，
   * 每个标签的 payload 都用它裁剪。也正因为如此它是**临时**状态：
   * 既不写设置（没有对应的 `configuration` 项），也不进 `persist()` 的快照 ——
   * 重载窗口后必须回到「没有过滤」。
   *
   * 为什么匹配放在宿主侧而不是面板侧：面板手上的会话数据是**已经裁掉命中节点**的 payload
   * （命中节点连子树都不在 `nodes` 里），它再想按新查询重算就缺了那些节点 ——
   * 「把查询从 `lib` 改成 `sub`」会把上一轮隐藏的节点永久丢掉。宿主始终持有完整会话数据，
   * 因此由宿主匹配、并把隐藏数量随 payload 回给面板显示。
   */
  private pathFilterQuery = '';

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

  /**
   * 导出当前标签（工具栏「导出」菜单）。
   *
   * 分工：
   *   - `png` / `svg`：正文由 webview 抓取（只有它能拿到真实画布与计算样式），
   *     经 `exportGraph` 消息的 `data` 送过来；
   *   - `md-tree` / `md-table` / `json`：宿主用 `commands/exportGraph.ts` 的纯函数生成。
   *
   * 结果一律写输出通道（不弹右下角提示）；只有**写盘失败**才用 `showErrorMessage`。
   * 用户取消保存对话框时什么都不做，也不报错。
   */
  async exportGraph(sessionId: string, format: ExportFormat, data?: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      logWarn(`导出失败：找不到会话 ${sessionId}`);
      return;
    }
    const info = EXPORT_FORMATS[format];
    if (!info) {
      logWarn(`导出失败：不认识的导出格式 ${String(format)}`);
      return;
    }
    // 宿主生成的三种正文与「复制标签为文本」共用这一份**所见视图**：
    // 与 PNG/SVG（从画布 DOM 抓）口径一致 —— 图里看不到的节点不出现在导出结果里。
    const view = this.exportView(session);
    // 正文先备齐再问保存位置：否则用户选完路径才发现没有内容，无效地走一次保存对话框。
    const body = info.build ? info.build(view) : (data ?? '');
    if (!body) {
      logWarn(
        info.build
          ? `导出失败：当前标签没有可导出的内容（${info.label}）。`
          : `导出失败：webview 没有提供${info.label}的内容（会话 ${sessionId}）。`
      );
      return;
    }
    // 默认文件名：`<根节点名>-<方向标签>-<yyyyMMdd-HHmmss>`，已过滤 Windows 非法字符并限长。
    const rootName = view.node(view.rootId)?.name ?? session.node(session.rootId)?.name ?? '';
    const fileName = buildExportFileName(rootName, session.direction, new Date(), info.extension);
    const folder = vscode.workspace.workspaceFolders?.[0];
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, fileName) : undefined,
      filters: { [info.filterLabel]: [info.extension] },
      title: `导出${DIRECTION_LABEL[session.direction]}（${info.label}）`,
    });
    if (!target) {
      // 用户取消：不写文件、不报错，只留一条诊断记录（输出通道，不打扰）。
      logInfo(`已取消导出（${info.label}）。`);
      return;
    }
    try {
      // 二进制（PNG）由 webview 给 base64；文本一律按 UTF-8 写，路径含中文/全角字符也能落盘。
      const bytes = info.binary ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
      await vscode.workspace.fs.writeFile(target, bytes);
      logInfo(`已导出${info.label}：${target.fsPath}（${bytes.length} 字节）`);
    } catch (error) {
      logError(`导出失败：${target.fsPath}`, error);
      void vscode.window.showErrorMessage(
        `导出失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
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
        // ⚠️ 这里**不能**再拼「视图内报错：」：onError 的实参是由 extension.ts 统一加前缀的
        // （见那里注册 GraphViewProvider 的回调），两处都拼会写成
        // 「视图内报错：视图内报错：…」（真机日志里出现过）。onError 的约定是收**裸消息**，
        // 与本文件另外三处调用一致。
        this.onError(message.message);
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
        // 而 forgetSession 已经清理过一次、此后再无人清理（会话 id 是随机串，不会复用）。
        const session = this.sessions.find((item) => item.id === message.sessionId);
        if (!session) {
          break;
        }
        this.collapsedNodes.set(message.sessionId, next);
        this.postSession(session);
        break;
      }
      case 'pathFilter': {
        // 临时路径过滤（面板搜索栏右侧的输入框）：整窗一份查询，所有标签一起重排。
        //
        // ⚠️ 查询没变就直接跳过：输入框的 `input` 事件比语义变化密得多（面板侧已做防抖，
        // 这里再挡一道），而每一次都要重算所有标签的布局并整份下发。
        const query = String(message.query ?? '');
        if (query === this.pathFilterQuery) {
          break;
        }
        this.pathFilterQuery = query;
        // 每个标签都要重发：过滤是窗口级的，非活动标签的图也得跟着变。
        for (const item of this.sessions) {
          this.postSession(item);
        }
        break;
      }
      case 'resetExpansion': {
        // 「收起全部」的另一半语义：把**已加载的展开状态**彻底丢掉（只留根，根标回未加载）。
        //
        // 只改收起标记是不够的：取回来的节点一直留在会话里，之后点「展开全部」只是把旧形状
        // 搬回来（层数由历史点击决定，与 maxExpandRounds 无关）。用户口径要的是「完全复位」。
        const session = this.getSession(message.sessionId);
        if (!session) {
          break;
        }
        const dropped = session.resetExpansion();
        // 按节点索引的表全部要清：里面存的是已删除节点的 id / 宽度 / 选中项，
        // 留着会让下一次重排按旧值排版（坐标幽灵）。
        this.collapsedNodes.delete(message.sessionId);
        this.measuredWidths.delete(message.sessionId);
        this.selectedIds.delete(message.sessionId);
        logInfo(
          `已复位「${session.title}」的展开状态：丢弃 ${dropped} 个已展开节点，` +
            `下次展开将重新读取语言服务。`
        );
        this.postSession(session);
        await this.persist();
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
      case 'exportGraph': {
        // 工具栏「导出」菜单：PNG / SVG 的正文由 webview 给出，Markdown 与 JSON 由宿主生成
        await this.exportGraph(message.sessionId, message.format, message.data);
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
      this.onError(`展开调用关系失败：${describeRelationError(error)}`);
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
    // ⚠️ 预算与目标一律按**可见节点**算（与 payload / 到顶提示同一份口径）：
    // 被目录过滤或临时路径查询隐藏的节点不该吃预算，更不该被当成展开目标去请求语言服务
    //（早期按会话全量算：过滤掉一大批后按钮仍可点，展开却会因为预算被隐藏节点占用而提前停，
    // 用户看到的是「点了没反应」，而面板上什么也不显示）。
    const visibleCount = (): number => Object.keys(this.visibleNodeRecord(session).nodes).length;
    // ⚠️ 已达上限时**提前给出交代**，不要跑进循环再逐层空转（用户反馈「到上限后两个展开按钮
    // 点了没用」）：那时循环会在第一个目标上算出 remaining ≤ 0 直接返回，面板上什么都不会变，
    // 唯一的痕迹是一行输出通道日志 —— 等于没有反馈。
    const currentCount = visibleCount();
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
          const visible = this.visibleNodeRecord(session).nodes;
          const targets = Object.values(visible)
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
            const before = visibleCount();
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
      // 跳转目标：**父级中引用它的位置**（调用处 / 引用处）—— 对函数、变量、枚举、宏一律相同
      // （用户 2026-10-14 要求）。此前打开的是该符号**自身的定义处**，于是双击总是跳到子级自己的
      // 函数名处，与「我在看这条调用关系」的语义不符。
      const node = session?.nodeRecord()[nodeId];
      const parentId = node?.parent;
      const parentItem = parentId ? session?.item(parentId) : undefined;
      const callSite = node?.callSite;
      if (callSite) {
        // ⚠️ 调用处**未必与父节点同文件**：文本搜索兜底的命中可以落在任何 .c/.h 上，而节点里
        // `callSite.file` 记的是**相对路径**。曾直接沿用父级 URI，结果跨文件时「停在本文件、
        // 行号还对不上」（用户 2026-10-14 反馈）。所以这里按 `callSite.file` 逐个候选解析，
        // 全部失败才退回父级文件。
        const candidates: vscode.Uri[] = [];
        if (/^[A-Za-z]:[\\/]/.test(callSite.file) || callSite.file.startsWith('/')) {
          candidates.push(vscode.Uri.file(callSite.file));
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          candidates.push(vscode.Uri.joinPath(folder.uri, callSite.file));
        }
        if (parentItem) {
          candidates.push(parentItem.uri);
        }
        let target: vscode.TextDocument | undefined;
        for (const uri of candidates) {
          try {
            target = await vscode.workspace.openTextDocument(uri);
            break;
          } catch {
            // 试下一个候选：跨文件时第一个可能不存在（多根工作区 / 路径写法差异）
          }
        }
        if (target) {
          const editor = await vscode.window.showTextDocument(target, {
            preview: false,
            preserveFocus: true,
          });
          // `callSite.line` 记录时已转成 1 基（session.ts），这里换算回 0 基；列不记录，取行首。
          const line = Math.max(0, Math.min(target.lineCount - 1, callSite.line - 1));
          const position = new vscode.Position(line, 0);
          // 高亮优先用「被引用符号出现的位置」：在那一行里找它的名字，找不到就整行。
          const lineText = target.lineAt(line).text;
          const column = node?.name ? lineText.indexOf(node.name) : -1;
          const range =
            column >= 0 && node?.name
              ? new vscode.Range(line, column, line, column + node.name.length)
              : target.lineAt(line).range;
          editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          editor.selection = new vscode.Selection(position, position);
          this.flashHighlight(editor, range);
          return;
        }
      }
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
   * 在编辑器里短暂高亮某个范围，便于立即看出跳转位置。
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
      // ⚠️ 下发的必须**只是路径那行用的**条目（方括号项去掉、圆括号剥壳）：括号语义属于「标签」，
      // 面板渲染路径那行时不需要、也不应该懂它。两侧因此逐字同规则（早期版本漏了这一步，
      // 于是 `pathAnchors: "(LIB)"` 在面板上那一行根本不保留 LIB —— renderCheck 的跨侧断言抓到过）。
      pathAnchors: pathOnlyAnchorPatterns(readAnchors(config.get<unknown>('pathAnchors', []))),
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
   *   方框不会变矮。所以要把每个会话都按新设置重排一次再下发。
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
        // 临时路径过滤的查询：**必须随 init 一起下发**。面板被隐藏后重新显示时 webview 会重建
        // （输入框回到空），而宿主这份查询还活着 —— 不下发的话，界面看起来「没有过滤」、
        // 图却是过滤后的，用户也没有办法清掉它（除非先随便打一个字再删掉）。
        pathFilterQuery: this.pathFilterQuery,
        // 收起状态同理：面板收到 init 会把本地的收起表清空，而宿主仍在按它算坐标 ——
        // 不下发就会出现「父框画着 − 号，子框一个都不画」（要点两下才恢复）。
        collapsed: this.sessions.map((session) => ({
          sessionId: session.id,
          ids: [...(this.collapsedNodes.get(session.id) ?? [])],
        })),
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

  /**
   * 按当前过滤算出**这个标签里真正会被画出来的**节点表，并把锚点诊断顺带做了。
   *
   * 三处必须共用这一份口径，否则会出现「图里看不到、导出里却有」这类自相矛盾：
   *   ① `buildPayload()`：画什么（布局与渲染的输入）；
   *   ② `expandBatched()`：「展开全部 / 完全展开」的**目标与预算** —— 早期版本按会话全量算，
   *      于是过滤掉一大批节点后，它会去展开用户根本看不到的分支、还会因为预算被隐藏节点占用
   *      而提前停下（面板上按钮却仍显示可点）；
   *   ③ `exportView()`：导出与「复制标签为文本」导出什么（PNG/SVG 从画布抓，天然只有可见节点）。
   *
   * 过滤都放在这一层（而不是会话层）：会话仍保留取回来的数据，改设置后节点立刻回来，
   * 不需要重新请求语言服务。根节点永不参与过滤。
   */
  private visibleNodeRecord(session: CallSession): {
    nodes: Record<string, GraphNode>;
    /** 因目录过滤隐藏的节点数（含子树）。 */
    folderHidden: number;
    /** 因临时路径查询隐藏的节点数（含子树）。 */
    queryHidden: number;
    /** 目录过滤生效的条目数（日志用）。 */
    folderEntryCount: number;
  } {
    const config = vscode.workspace.getConfiguration('cppCallGraph');
    const folderFilter = createFolderFilter(
      config.get<string[]>('excludeFolders', []),
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
    );
    for (const problem of folderFilter.problems) {
      logWarn(`目录过滤条目被忽略：${problem}`);
    }
    const { nodes: folderKept, hidden: folderHidden } = applyFolderFilter(
      session.nodeRecord(),
      session.rootId,
      folderFilter
    );
    const { nodes, hidden: queryHidden } = applyPathQueryFilter(
      folderKept,
      session.rootId,
      this.pathFilterQuery
    );
    return {
      nodes,
      folderHidden,
      queryHidden,
      folderEntryCount: folderFilter.activeCount,
    };
  }

  /**
   * 导出 / 「复制标签为文本」用的**所见**会话视图：只含当前画面上真正画出来的节点。
   *
   * 为什么需要它：PNG 与 SVG 是从画布 DOM 抓的，天然只有可见节点；而 Markdown / JSON /
   * 复制文本是宿主按会话生成的 —— 早期直接把**全量**会话交出去，于是被目录过滤或临时路径
   * 过滤隐藏的节点照样出现在导出结果里（同一个「导出」菜单下两种口径）。
   */
  exportView(session: CallSession): ExportSessionView {
    const { nodes } = this.visibleNodeRecord(session);
    return {
      rootId: session.rootId,
      direction: session.direction,
      node: (id: string) => nodes[id],
    };
  }

  buildPayload(session: CallSession): SessionPayload {
    // 边按**全量**算（`graph()` 会一并刷新会话的边表），下面再按可见节点过滤：
    // 节点表用 `visibleNodeRecord()`（它会套上目录过滤与临时路径过滤）。
    const { edges } = session.graph();
    // 用 webview 上一帧回传的实测宽度排布列位置；没有时 createLayout 自己估宽。
    const measured = this.measuredWidths.get(session.id);
    // ⚠️ 路径显示方式必须与 webview 渲染用同一份设置：估宽与实际文字不一致时，
    // 列宽会按错误的宽度排，文字要么顶到加减号、要么右边空一大截。
    const settings = this.settingsPayload();
    // 名称行标签（设置 `cppCallGraph.nameFolderTag` / `…Style` / `…Pick`）：估宽与 payload 里的
    // 渲染文字都从这一份口径来 —— 两处各读一次设置，列宽与实际文字就会对不上。
    const config = vscode.workspace.getConfiguration('cppCallGraph');
    const rawStyle = config.get<string>('nameFolderTagStyle', 'arrow');
    const rawPick = config.get<string>('nameFolderTagPick', 'first');
    // 锚点条目在这里取**原文**（含括号）：路径那行与名称行标签都从这一份算，
    // 括号语义（`(x)` = 两处都要、`[x]` = 只要标签）只此一处解释。
    // ⚠️ 下发给面板的那一份是**剥过括号**的（见 settingsPayload），两者结果必须一致。
    const rawAnchors = readAnchors(config.get<unknown>('pathAnchors', []));
    const pathOptions: PathDisplayOptions = {
      mode: settings.pathDisplay,
      tailLevels: settings.pathTailLevels,
      showFileName: settings.pathShowFileName,
      anchors: rawAnchors,
      nameFolderTag: config.get<boolean>('nameFolderTag', false),
      // 非法取值一律退回默认：手改 settings.json 写错字时，不该让整行标签消失或渲染成 "undefined"
      nameFolderTagStyle:
        rawStyle === 'parenAfter' || rawStyle === 'bracketAfter' || rawStyle === 'dotAfter'
          ? rawStyle
          : 'arrow',
      nameFolderTagPick: rawPick === 'deepest' ? 'deepest' : 'first',
    };
    // 目录过滤 + 临时路径过滤 + 锚点诊断：三处口径都在 `visibleNodeRecord()` 里
    // （payload 画什么、批量展开能碰什么、导出什么，必须完全一致）。
    const {
      nodes: visibleNodes,
      folderHidden,
      queryHidden: filteredCount,
      folderEntryCount,
    } = this.visibleNodeRecord(session);
    if (folderHidden > 0) {
      logInfo(`目录过滤：隐藏 ${folderHidden} 个节点（生效条目 ${folderEntryCount} 条）。`);
    }
    if (filteredCount > 0) {
      logInfo(
        `临时路径过滤：隐藏 ${filteredCount} 个节点（查询「${this.pathFilterQuery.trim()}」）。`
      );
    }
    const visibleIds = new Set(Object.keys(visibleNodes));
    const visibleEdges = edges.filter(
      (edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)
    );
    // 「锚点写了但一处都没命中」的诊断（会话级，一次）：命中是逐路径判的，
    // 在 displayPathText 里报会冤枉「只在别的文件里有的段」（见 unmatchedAnchorPatterns）。
    // 同一模式只提示一次，且只在真有锚点时才做这份检查。
    if (pathOptions.anchors.some((entry) => entry.trim().length > 0)) {
      const files = [...new Set(Object.values(visibleNodes).map((node) => node.file))];
      for (const pattern of unmatchedAnchorPatterns(files, pathOptions)) {
        if (!warnedUnmatchedAnchors.has(pattern)) {
          warnedUnmatchedAnchors.add(pattern);
          logWarn(
            `路径锚点「${pattern}」在当前标签的所有路径上均未命中，该条目不产生任何效果。` +
              `请核对目录名写法，或移除该条目。`
          );
        }
      }
    }
    const layout = createLayout(
      visibleNodes,
      session.rootId,
      measured,
      this.collapsedNodes.get(session.id),
      settings.showLocation,
      pathOptions,
      maxLayoutNodesLimit()
    );
    const payloadNodes: SessionPayload['nodes'] = {};
    // 布局是否吃满节点总数上限（两种口径见下面的 atCapacity）：先算好，因为下面的循环要用它
    // 给「仍有下一层可展开」的方框打**不带数字**的警示标记（方案 A，用户 2026-10-14 选定）。
    const atCapacity =
      Object.keys(layout.boxes).length >= maxLayoutNodesLimit() ||
      Object.keys(layout.omittedByCap).length > 0;
    for (const [id, node] of Object.entries(visibleNodes)) {
      // 两种省略来源合并成一个总数给标记用，同时保留下因上限被截断的那部分供悬停区分原因
      // （0.22 首版只算了 maxChildrenPerNode，上限截断的方框上什么都没有，用户反馈「到上限后
      // 再展开没反应、也没有省略标记」）。
      const omittedByNodeCap = layout.omittedByCap[id] ?? 0;
      const canExpand = !node.loaded && !node.isCycle;
      const hasBox = layout.boxes[id] !== undefined;
      // 名称行标签的两段文字（开关关闭或未命中锚点时为 undefined，payload 里就不写这两个键）。
      // 用与上面布局**同一份** pathOptions，估宽与实际渲染因此不可能分叉。
      const nameTag = nameTagPartsFor(node.file, pathOptions);
      payloadNodes[id] = {
        ...node,
        ...(nameTag?.prefix ? { nameTagPrefix: nameTag.prefix } : {}),
        ...(nameTag?.suffix ? { nameTagSuffix: nameTag.suffix } : {}),
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
      edges: visibleEdges,
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
      // 临时路径过滤隐藏了几个（面板据此显示「已隐藏 N 个」）。为 0 时省略，
      // 面板按「没有隐藏」处理。
      ...(filteredCount > 0 ? { filteredCount } : {}),
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
    /** 临时路径过滤的查询（用于断言「它只活在内存里、不进快照」）。 */
    pathFilterQuery: string;
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
      pathFilterQuery: this.pathFilterQuery,
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
  /**
   * 临时路径过滤的查询（面板搜索栏右侧输入框；空串 = 不过滤）。
   *
   * **不按标签分**：整窗一份查询，所有打开的标签一起重排 —— 用户口径是「所有标签通用」。
   * 宿主每次也会把它**遗弃在内存里**：既不写设置，也不进 `persist()` 的快照。
   */
  | { type: 'pathFilter'; query: string }
  | { type: 'resetExpansion'; sessionId: string }
  | { type: 'openLocation'; sessionId: string; nodeId: string }
  | { type: 'selectNode'; sessionId: string; nodeId: string }
  | { type: 'openSettings' }
  | { type: 'cancelResolve' }
  | { type: 'copyTabText'; sessionId: string }
  | { type: 'reportWidths'; sessionId: string; widths: Array<{ id: string; width: number }> }
  | { type: 'copyNodeName'; sessionId: string; nodeId: string }
  /**
   * 导出当前标签（工具栏「导出」菜单）。
   *
   * `png` / `svg` 的正文由 webview 抓取后放进 `data`（png 是 base64，svg 是序列化文本）；
   * `md-tree` / `md-table` / `json` **不带 data**，由宿主用纯函数生成。
   */
  | { type: 'exportGraph'; sessionId: string; format: ExportFormat; data?: string }
  | { type: 'copyNodeLocation'; sessionId: string; nodeId: string };
