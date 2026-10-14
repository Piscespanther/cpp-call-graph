/**
 * Webview 前端：把宿主算好的布局画成 SVG（框 + 折线箭头），
 * 并处理标签栏、滚动、展开、跳转。
 *
 * 重要：这里不做布局计算，布局由扩展侧的 graphLayout.ts 负责，
 * 前端只负责画与交互，避免两套布局逻辑不一致。
 */

import { ICON_BY_CODICON, KIND_TO_ICON } from './symbolIcons';
import { createDirectionIcon } from './callIcons';

type Direction = 'callers' | 'callees';

interface CallSite {
  file: string;
  line: number;
  text: string;
}

interface GraphNode {
  id: string;
  name: string;
  detail?: string;
  /** 展开时省略掉的条数合计（`maxChildrenPerNode` + 节点总数上限），>0 时方框上有标记。 */
  omitted?: number;
  /** `omitted` 中因节点总数上限（`maxLayoutNodes`）未显示的那部分，用于悬停里区分原因。 */
  omittedByNodeCap?: number;
  /**
   * 名称行标签的两段文字（设置 `cppCallGraph.nameFolderTag`），由**宿主**用
   * `nameTagPartsFor()` 算好随 payload 下发：`arrow` 摆法只有前缀（`[core] → `），
   * 三种后置摆法只有后缀（` (core)` 等）。webview 只渲染，不参与格式拼装。
   */
  nameTagPrefix?: string;
  nameTagSuffix?: string;
  /**
   * 已达节点总数上限、但这一格**仍有下一层可展开**（宿主在 atCapacity 时下发）。
   *
   * 方案 A：这种方框要有一个**不带数字**的标记（空心环）+ 悬停说明 —— 子节点从未取过，
   * 条数未知，写数字就是编造。手动点它展开仍然可用（上限只拦住批量展开的预算，不拦单点）。
   */
  cappedExpandable?: boolean;
  file: string;
  line: number;
  callSite?: CallSite;
  direction: Direction;
  depth: number;
  isCycle: boolean;
  children: string[];
  parent?: string;
  loaded: boolean;
  canExpand: boolean;
  kind: NodeKind;
}

/** 与宿主侧 graphTypes.ts 的 NodeKind 保持一致（前端独立打包，故此处重复定义）。 */
type NodeKind =
  | 'function'
  | 'method'
  | 'constructor'
  | 'operator'
  | 'enum'
  | 'enumMember'
  | 'class'
  | 'interface'
  | 'struct'
  | 'typeParameter'
  | 'variable'
  | 'field'
  | 'property'
  | 'constant'
  | 'namespace'
  | 'module'
  | 'package'
  | 'event'
  | 'key'
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'file'
  | 'other';

interface GraphEdge {
  id: string;
  from: string;
  to: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SessionPayload {
  id: string;
  title: string;
  description: string;
  direction: Direction;
  engineLabel: string;
  /** 角标 id（宿主按引擎配置档算好；缺省时回退到按 engineLabel 文本猜）。 */
  badge?: string;
  rootId: string;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  boxes: Record<string, Box>;
  collapsedCount: number;
  /** 布局是否已吃满节点总数上限：为真时两个展开按钮置为禁用态并给出原因。 */
  atCapacity?: boolean;
  /** 生效的节点总数上限（用于把原因写成具体数字；缺省时不写数字）。 */
  maxLayoutNodes?: number;
  /**
   * 本标签被**临时路径过滤**隐藏的节点数（含子树；缺省 = 没有隐藏）。
   *
   * 由宿主算并下发：命中与否是宿主按完整会话数据判的，面板手上的 `nodes` 已经被裁掉那些
   * 节点，自己数不出来。面板只用它显示「已隐藏 N 个」。
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

interface InitMessage {
  type: 'init';
  /** 当前活动会话的完整图（可能为空）。 */
  sessions: SessionPayload[];
  /** 所有标签的摘要，用于立即画出标签栏。 */
  summaries: SessionSummary[];
  activeId: string;
  /** 宿主读到的设置（webview 自己读不到 VS Code 设置）。 */
  settings?: WebviewSettings;
  /**
   * 临时路径过滤的查询（宿主侧那一份）。面板重建时输入框是空的，靠它把文字还原回来 ——
   * 否则会出现「界面看着没过滤、图却是过滤后的」这种没法解释、也没法清掉的状态。
   */
  pathFilterQuery?: string;
  /**
   * 宿主手里的**收起状态**（按标签）。面板重建或可见性变化时，本地的收起表会被清空，
   * 而宿主的仍在按它算坐标（收起的子树没有坐标、不占高度）—— 不下发就会出现
   * 「父框画着 − 号、子框一个都不画」，要点两下才恢复。据此还原即可两边一致。
   */
  collapsed?: Array<{ sessionId: string; ids: string[] }>;
}

/** 需要下发给 webview 的设置项（与宿主 settingsPayload() 一一对应）。 */
/** 路径在方框里的显示方式（与宿主 `graphLayout.ts` 的 PathDisplayOptions 同形）。 */
interface PathDisplayOptions {
  mode: 'tail' | 'full';
  /** 末尾保留几层（含文件名）；0 = 按字符预算自动（0.20 的行为）。 */
  tailLevels: number;
  /** 那行路径是否包含最后的文件名（关闭后只显示目录部分）。 */
  showFileName?: boolean;
  /**
   * 必须显示的目录段，可组合多层；每条模式只保留它自己解析出的那一段。
   * 写法见宿主 `graphLayout.ts` 的同名说明（两侧必须逐字同规则）。
   */
  anchors: string[];
}

interface WebviewSettings {
  /** 纵向滚动时把父方框钉在窗口垂直中央。 */
  stickyParent?: boolean;
  /** 方框里是否显示「文件路径:行号」那一行。 */
  showLocation?: boolean;
  /** 路径显示方式（见 PathDisplayOptions）。 */
  pathDisplay?: 'tail' | 'full';
  pathTailLevels?: number;
  /** 那行路径是否包含文件名（关闭后只显示目录部分）。 */
  pathShowFileName?: boolean;
  pathAnchors?: string[];
}

interface SessionUpdateMessage {
  type: 'sessionUpdate';
  session: SessionPayload;
}

interface SelectTabMessage {
  type: 'selectTab';
  id: string;
}

interface UpdateMessage {
  type: 'update';
  sessions: SessionSummary[];
  activeId: string;
}

/** 设置变了：宿主重新下发一次。 */
interface SettingsMessage {
  type: 'settings';
  settings: WebviewSettings;
}

/**
 * 宿主的解析进度：解析较慢的查询（宏、结构体、变量这些要走引用查找的符号）
 * 会在开始时下发 `busy: true`、结束时下发 `busy: false`，webview 据此显示加载遮罩。
 */
interface BusyMessage {
  type: 'busy';
  busy: boolean;
  /** 遮罩上的文案（可选）。 */
  label?: string;
}

type HostMessage =
  | InitMessage
  | SessionUpdateMessage
  | SelectTabMessage
  | UpdateMessage
  | SettingsMessage
  | BusyMessage;

interface VSCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeApi;

const vscode = acquireVsCodeApi();
const SVG_NS = 'http://www.w3.org/2000/svg';

const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;
const summaryEl = document.getElementById('summary') as HTMLSpanElement;
const emptyEl = document.getElementById('empty') as HTMLDivElement;
const canvasEl = document.getElementById('canvas') as HTMLDivElement;
const svgEl = document.getElementById('svg') as unknown as SVGSVGElement;
const viewportEl = document.getElementById('viewport') as unknown as SVGGElement;
const edgesEl = document.getElementById('edges') as unknown as SVGGElement;
const nodesEl = document.getElementById('nodes') as unknown as SVGGElement;
const busyEl = document.getElementById('busy') as HTMLDivElement | null;
const busyLabelEl = document.getElementById('busy-label') as HTMLParagraphElement | null;

/** 遮罩延迟：快查询不出现瞬时闪烁（毫秒）。 */
const BUSY_DELAY_MS = 240;

/**
 * 本地「正在展开」标记的超时时间。
 *
 * 正常情况下宿主回 `sessionUpdate` 就会清掉该标记；但宿主在「会话已关闭」等异常路径下
 * 直接 return、不发任何消息，标记会永久留着并把遮罩一直点亮。超时后自行清除。
 */
const LOADING_TIMEOUT_MS = 12000;
/** 遮罩默认文案（与 graph.html 里 #busy-label 的初始文本一致）。 */
const BUSY_DEFAULT_LABEL = '正在解析…';
/** 宿主是否正在解析（busy 消息维护）。 */
let hostBusy = false;
/** 已排队的遮罩显示定时器。 */
let busyTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 按当前状态决定遮罩的显隐。
 *
 * 两个来源都要算：宿主正在解析（`hostBusy`，宏/结构体/变量这类掉进引用查找的查询）
 * 与本地正在展开某个方框（`state.loading`）。延迟一小会儿才显示，避免快查询出现瞬时闪烁。
 */
function updateBusy(): void {
  if (!busyEl) {
    return;
  }
  const wanted = hostBusy || state.loading.size > 0;
  if (!wanted) {
    if (busyTimer !== undefined) {
      clearTimeout(busyTimer);
      busyTimer = undefined;
    }
    busyEl.hidden = true;
    return;
  }
  if (!busyEl.hidden || busyTimer !== undefined) {
    return;
  }
  busyTimer = setTimeout(() => {
    busyTimer = undefined;
    if (!busyEl) {
      return;
    }
    // 定时器排队期间可能已经解析完 / 取消，所以这里再确认一次
    busyEl.hidden = !(hostBusy || state.loading.size > 0);
  }, BUSY_DELAY_MS);
}

/** 立刻收起遮罩（例如点了「取消」）。 */
function hideBusy(): void {
  if (busyTimer !== undefined) {
    clearTimeout(busyTimer);
    busyTimer = undefined;
  }
  if (busyEl) {
    busyEl.hidden = true;
  }
  // 文案复位：否则下一次不带 label 的 busy 会继续显示上一阶段的文字
  if (busyLabelEl) {
    busyLabelEl.textContent = BUSY_DEFAULT_LABEL;
  }
}

const state = {
  sessions: new Map<string, SessionPayload>(),
  order: [] as string[],
  activeId: undefined as string | undefined,
  /** 每个会话的 viewBox 原点（内容坐标）。 */
  viewports: new Map<string, { x: number; y: number }>(),
  /**
   * 当前选中的方框。**必须带会话 id**：节点 id 由内容派生，同一个符号在
   * 「被调用关系图」与「调用关系图」两个标签里 id 完全相同，只存 id 会串标签。
   */
  selected: undefined as { sessionId: string; nodeId: string } | undefined,
  loading: new Set<string>(),
  /** 每个会话里被手动收起的节点（只影响显示，不丢数据）。 */
  collapsed: new Map<string, Set<string>>(),
  /** 待居中的会话：新查询时把根方框摆到视图中间。 */
  centerRequest: undefined as string | undefined,
  /** 由宿主下发的设置：纵向滚动时是否把父方框钉在窗口垂直中央。 */
  stickyParent: true,
  /** 由宿主下发的设置：方框里是否显示「文件路径:行号」那一行。 */
  showLocation: true,
  /** 由宿主下发的设置：路径怎么省略（默认与 0.20 一致：按字符预算保留末尾目录段）。 */
  pathOptions: {
    mode: 'tail',
    tailLevels: 0,
    showFileName: true,
    anchors: [],
  } as PathDisplayOptions,
};

/**
 * 用户坐标 = 屏幕像素。
 * 这样方框尺寸和字号就是 CSS 里写的值，不随窗口大小变化。
 */
const MARGIN_LEFT = 16;
const MARGIN_TOP = 10;
const MARGIN_RIGHT = 16;
const MARGIN_BOTTOM = 16;

/**
 * 每行开头的小图标（模仿 VS Code 符号图标）。
 * 图标内容画在 16×16 的坐标系里，整体按 ICON_BOX/16 缩放后贴到方框左上角。
 *
 * 垂直对齐：图标中心 y = ICON_Y + ICON_BOX/2 = 11.5，
 * 13px 字号的光学中心约在基线 -4.5 处，故名称基线取 16。
 */
const ICON_BOX = 13;
const ICON_GAP = 4;
const ICON_X = 5;
const ICON_Y = 5;
/** 第一行文字从图标右边开始。 */
const TEXT_X = ICON_X + ICON_BOX + ICON_GAP;
/**
 * 两行文字的基线。与 NODE_HEIGHT(43) 配合，数值按**真实字体墨迹**校准：
 *   13px 粗体名称的墨迹约在基线上方 9px、下方 3px
 *   12px 路径的墨迹约在基线上方 8px、下方 2px
 * 于是：
 *   名称基线 15 → 墨迹 6~18，距上边框 6px
 *   路径基线 32 → 墨迹 24~34，距下边框 9px
 * 两行墨迹之间留 6px。
 *
 * 取舍说明：这里**优先保证行间空隙**（行距 17），因此下留白比上留白大，
 * 不再追求上下相等。行距曾取 12 / 14 / 16，两行都还显得近。
 */
const NAME_BASELINE = 15;
const LOC_BASELINE = 32;
/**
 * 方框高度。**必须与宿主 `graphLayout.ts` 的 NODE_HEIGHT / NODE_HEIGHT_COMPACT 一致**：
 * 正常路径下方框几何由宿主算好下发，这两个值只用于「几何缺失」时兜底。
 *
 * 显示路径时两行（43），不显示时单行（26）—— 后者见 `nameBaselineFor()` 的居中口径。
 */
const NODE_HEIGHT = 43;
const NODE_HEIGHT_COMPACT = 26;

/** 几何缺失时的兜底框高：跟着「显示路径」开关走。 */
function defaultBoxHeight(): number {
  return state.showLocation ? NODE_HEIGHT : NODE_HEIGHT_COMPACT;
}

/**
 * 名称基线。显示路径时是两行布局的第一行（固定 15）。
 *
 * 不显示路径时整框只剩一行，于是按**墨迹上下留白相等**居中：
 * 13px 粗体名称的墨迹约在基线上方 9、下方 3，所以「墨迹中心 = 框中心」对应
 * 基线 = 框高/2 + 3（26 高的框 → 16，上下各留 7px）。
 */
function nameBaselineFor(height: number): number {
  return state.showLocation ? NAME_BASELINE : height / 2 + 3;
}

/** 图标左上角 y。显示路径时贴着名称行（ICON_Y）；单行时在框里垂直居中。 */
function iconYFor(height: number): number {
  return state.showLocation ? ICON_Y : (height - ICON_BOX) / 2;
}

/**
 * 搜索命中时元素名背后的底纹尺寸。
 *
 * 13px 粗体名称的墨迹约在基线上方 9px、下方 3px（见上面的校准说明），
 * 四周各留 2px：于是底纹从基线以上 11px 起、高 16px。
 * 宽度按**同一段文字**用 measureTextWidth 量（和算方框宽度用的是同一套），
 * 所以底纹永远贴合实际渲染出来的名字。
 */
const NAME_HIT_PAD_X = 2;
const NAME_HIT_ABOVE = 11;
const NAME_HIT_HEIGHT = 16;

/**
 * 「省略」模式（`pathTailLevels = 0`）下末尾目录段的字符预算。
 *
 * 不是截断上限：它只决定自动档保留几层。显式给了层数或锚点时不受它约束，
 * 方框宽度会照着完整文字长出来（0.22 起没有宽度上限，见下方说明）。
 */
const LOC_MAX_CHARS = 40;
/** 方框最小宽度：太窄会显得像个方块，且放不下加减号。 */
const MIN_BOX_WIDTH = 120;
/**
 * ⚠️ 0.22 起**没有方框宽度上限**。
 *
 * 需求原话：「如果碰到超长函数名或者变量名会直接省略中间的，这是不允许的；
 * 路径显示全部或层数超过当前宽度时，也要动态增宽保证完整显示」。
 * 所以这里不再有宽度上限常量，宽度一律按完整文字量出来（画布可横向滚动）。
 */
/** 几何缺失时的兜底宽度（正常路径下不会用到）。 */
const DEFAULT_BOX_WIDTH = 200;
/** 文字右端到加减号之间的最小间隙（保证加减号不压文字）。 */
const EXPANDER_GAP = 10;
/**
 * 量宽之外再留的余量。
 *
 * 原因：截断后末尾是「…」，它的实际宽度可能大于按平均字宽估算出来的值；
 * 只算平均字宽会让文字正好顶到加减号上（实测差 0.8px）。
 * 留一点余量既稳妥，视觉上也只是一点点空隙。
 */
const WIDTH_SAFETY = 6;
/** 加减号小方块的宽度（与 ICON_BOX 一致）。 */
const EXPANDER_BOX = ICON_BOX;
/** 「已达上限、仍有下一层」警示环的半径（数字那套已按用户要求删除，故不再需要字号常量）。 */
const OMITTED_MARK_RADIUS = 4;
/**
 * 内容尾部余量（右与下各留这么多）：VS Code 的滚动条是**覆盖式**的，浮在内容之上且不占布局空间，
 * 所以 `clientWidth` 把滚动条底下那一条也算进可视宽度。没有这段余量时，滚到最右/最下仍会被
 * 滚动条压住十几像素（用户 2026-10-14 的实测反馈：「没到右边底部」实为被上下滚动条遮挡）。
 */
const TRAILING_SCROLLBAR_SLACK = 16;

/** 两行文字的字号，与 graph.css 里的 .name / .loc 保持一致（量宽要用）。 */
const NAME_FONT_SIZE = 13;
const LOC_FONT_SIZE = 12;

/** 节点上显示的名称（与 renderNode 里的写法保持一致，含循环标记）。全名，不截断。 */
function nodeNameText(node: GraphNode): string {
  return `${node.isCycle ? '↻ ' : ''}${node.name}`;
}

/** 节点上显示的「路径:行号」（按设置的路径显示方式，与宿主估宽同一份逻辑）。 */
function nodeLocText(node: GraphNode): string {
  return `${displayPathText(node.file, state.pathOptions, LOC_MAX_CHARS)}:${node.line}`;
}

/**
 * 量一段文字的渲染宽度。
 *
 * **必须把探测节点插进文档**：对游离（未 attach）的 SVG 文字，浏览器里
 * `getBBox()` 返回全 0、`getComputedTextLength()` 也可能返回 0，
 * 于是量宽永远失败、只能吃估算兜底 —— 曾经就是这样，表现为「方框宽度不随内容变」。
 * 所以这里挂到真实的 <svg> 上量完立刻摘掉；全程同步，用户看不到这一帧。
 *
 * 顺序：`getComputedTextLength()`（最准）→ `getBBox().width` → 按字符数估算。
 * 估算刻意估宽，宁可留空隙也不要让文字顶住加减号。
 *
 * ⚠️ 性能：这里每帧要为「每个可见方框的名称 + 路径」各量一次（几百节点 = 上千次），
 * 而每次量宽都会触发一次**强制同步布局**。所以：
 *   ① 结果按「字体族 + 字号 + 粗细 + 文字」缓存（同名元素在后续帧里直接命中，开销归零）；
 *   ② 探测节点常驻复用，不再每次新建 / 挂载 / 摘除（少大量 DOM 变更）。
 * 只缓存**量成功**的结果：退到估算时不缓存，免得一帧的失败被永久记住。
 */
const MEASURE_CACHE_LIMIT = 4000;
const measureCache = new Map<string, number>();
let measureProbe: SVGTextElement | undefined;
/**
 * 当前字体族签名（缓存键的一部分）。
 *
 * 缓存键以前只有「字号 + 粗细 + 文字」，而字体族是从 `--vscode-font-family` 继承来的：
 * 用户换字体时字号没变，旧宽度会被继续命中 —— 方框宽度就与文字对不上了。
 * 每帧 `render()` 开始时清空一次，于是字体一变即失效（旧键不再命中，由 LRU 自然淘汰）。
 */
let measureFontSignature: string | undefined;

/** 取探测节点实际生效的字体族；取不到就返回空串（桩里没有 getComputedStyle 也安全）。 */
function fontSignature(probe: SVGTextElement | undefined): string {
  if (measureFontSignature !== undefined) {
    return measureFontSignature;
  }
  let family = '';
  try {
    const view = probe?.ownerDocument?.defaultView;
    if (probe && view && typeof view.getComputedStyle === 'function') {
      family = view.getComputedStyle(probe).fontFamily ?? '';
    }
  } catch {
    family = '';
  }
  measureFontSignature = family;
  return family;
}

/** 常驻探测节点（挂在 <svg> 下、visibility:hidden，不参与节点/连线的遍历）。 */
function probeElement(): SVGTextElement | undefined {
  if (!svgEl) {
    return undefined;
  }
  if (!measureProbe || measureProbe.parentNode !== svgEl) {
    const probe = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
    probe.setAttribute('visibility', 'hidden');
    probe.setAttribute('aria-hidden', 'true');
    probe.setAttribute('class', 'measure-probe');
    svgEl.appendChild(probe);
    measureProbe = probe;
  }
  return measureProbe;
}

function measureTextWidth(text: string, fontSize: number, bold: boolean): number {
  if (!text) {
    return 0;
  }
  const probe = probeElement();
  const key = `${fontSignature(probe)}|${fontSize}|${bold ? 'b' : 'n'}|${text}`;
  const cached = measureCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let measured = 0;
  if (probe) {
    probe.setAttribute('font-size', `${fontSize}px`);
    if (bold) {
      probe.setAttribute('font-weight', '600');
    } else {
      probe.removeAttribute('font-weight');
    }
    probe.textContent = text;
    try {
      const length = (probe as unknown as { getComputedTextLength?: () => number })
        .getComputedTextLength;
      if (typeof length === 'function') {
        const value = length.call(probe);
        if (Number.isFinite(value) && value > 0) {
          measured = value;
        }
      }
      if (measured === 0) {
        const width = probe.getBBox().width;
        if (Number.isFinite(width) && width > 0) {
          measured = width;
        }
      }
    } catch {
      // 忽略：退到估算
    }
  }
  if (measured > 0) {
    // 超限时**淘汰最旧的一条**（Map 保持插入顺序），而不是整表清空 ——
    // 整表清空会让接下来那一帧把上千段文字重新测量一次，等于把优化退回去。
    if (measureCache.size >= MEASURE_CACHE_LIMIT) {
      const oldest = measureCache.keys().next();
      if (!oldest.done) {
        measureCache.delete(oldest.value);
      }
    }
    measureCache.set(key, measured);
    return measured;
  }
  // 退到估算：ASCII 用实测系数（粗体 0.66 / 常规 0.6），
  // **非 ASCII（中文、全角标点）按 1 倍字号** —— 否则中文路径会被估窄、方框压住文字。
  let units = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) > 0x2e7f) {
      units += 1;
    } else {
      units += bold ? 0.66 : 0.6;
    }
  }
  return units * fontSize;
}

/**
 * 按内容算方框宽度：取「名称」与「路径:行号」两行里更宽的那个，
 * 右边给加减号留出固定位置（不让它压到文字上）。
 */
function measureBoxWidth(node: GraphNode): number {
  // 名称行可能带路径标签（设置 `cppCallGraph.nameFolderTag`）：实测宽必须与宿主估宽、与真实
  // 渲染三者同口径 —— 漏掉标签，方框就会窄到压住标签。
  const nameLine = `${node.nameTagPrefix ?? ''}${nodeNameText(node)}${node.nameTagSuffix ?? ''}`;
  const nameWidth = measureTextWidth(nameLine, NAME_FONT_SIZE, true);
  // 关掉「显示路径」时方框只按名称算宽 —— 否则右边会空出一整块（路径那一行的宽度）
  const locWidth = state.showLocation
    ? measureTextWidth(nodeLocText(node), LOC_FONT_SIZE, false)
    : 0;
  const content = Math.max(nameWidth, locWidth);
  const total = TEXT_X + content + EXPANDER_GAP + EXPANDER_BOX + ICON_X + WIDTH_SAFETY;
  // 不设上限：文字有多宽、方框就有多宽（0.22 起不许截断）
  return Math.max(MIN_BOX_WIDTH, Math.ceil(total));
}

/**
 * 给当前可见节点量宽，写回 boxes。
 *
 * 必须在算画布大小（contentBounds）与画边之前调用，否则 viewBox 和箭头锚点
 * 会按宿主给的固定宽度算，和新方框对不上。
 */
function measureSessionWidths(session: SessionPayload): void {
  for (const node of visibleNodes(session)) {
    const geometry = session.boxes[node.id];
    if (!geometry) {
      continue;
    }
    const measured = measureBoxWidth(node);
    if (geometry.width !== measured) {
      geometry.width = measured;
    }
  }
}

/**
 * 把量到的真实宽度回报给宿主。
 *
 * 为什么需要：宿主（扩展进程）没有排版引擎，排布列位置时只能按字符数估宽；
 * 估宽一旦偏大，列就被推远、箭头被拉得很长。这里回传实测值后，宿主用真实宽度
 * 排列各列，列间距才严格等于设计值。宿主会在宽度变化时才重排，所以不会死循环。
 */
/** 上一次回报给宿主的宽度（按会话）：一模一样就不再发，省掉每帧一次含 N 项的 IPC。 */
const lastReportedWidths = new Map<string, string>();

/**
 * 本地「正在展开」标记的键：**必须带会话 id**。
 *
 * 节点 id 由内容派生，同一个符号在「被调用关系图」与「调用关系图」两个标签里 id 完全相同；
 * 只按节点 id 记录时，标签 B 的一次 `sessionUpdate` 会把标签 A 正在展开的标记清掉，
 * 于是遮罩与「取消」会在解析还没结束时就失效。
 */
function loadingKey(sessionId: string, nodeId: string): string {
  return `${sessionId}\u0000${nodeId}`;
}

/** 清掉某个会话的全部「正在展开」标记（会话关闭或这一层数据已回来时用）。 */
function clearSessionLoading(sessionId: string): void {
  const prefix = `${sessionId}\u0000`;
  for (const key of [...state.loading]) {
    if (key.startsWith(prefix)) {
      state.loading.delete(key);
    }
  }
}

function reportMeasuredWidths(session: SessionPayload): void {
  const widths: Array<{ id: string; width: number }> = [];
  for (const node of visibleNodes(session)) {
    const geometry = session.boxes[node.id];
    if (geometry) {
      widths.push({ id: node.id, width: geometry.width });
    }
  }
  if (widths.length === 0) {
    return;
  }
  const signature = widths.map((item) => `${item.id}:${Math.round(item.width)}`).join('|');
  if (lastReportedWidths.get(session.id) === signature) {
    return;
  }
  lastReportedWidths.set(session.id, signature);
  post({ type: 'reportWidths', sessionId: session.id, widths });
}

// ------------------------------------------------------------ 工具

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

/**
 * 画一个符号角标——直接用 **VS Code 自带的 codicon 真实轮廓**
 * （路径由 scripts/genSymbolIcons.js 解析 codicon.ttf 的 glyf 表得到）。
 *
 * 这样形状与 VS Code 的大纲（Outline）、文件标签里显示的符号图标**完全一致**，
 * 不再是我手画的近似图形。颜色交给 CSS 里的 --vscode-symbolIcon-* 主题变量，
 * 所以函数的紫、变量的蓝、类的橙都会自动对上。
 *
 * codicon 的坐标系是 16×16，这里整体缩放到 ICON_BOX。
 */
function buildKindIcon(kind: NodeKind, iconY: number = ICON_Y): SVGGElement {
  const codicon = KIND_TO_ICON[kind] ?? KIND_TO_ICON.other;
  const icon = svg('g', {
    class: `kind-icon kind-${kind}`,
    transform: `translate(${ICON_X} ${iconY}) scale(${ICON_BOX / 16})`,
    'data-codicon': codicon,
  });
  const definition = ICON_BY_CODICON[codicon] ?? ICON_BY_CODICON['symbol-color'];
  const shape = svg('path', {
    class: 'icon-shape',
    d: definition.path,
    // 字形自带正确的绕向，nonzero 即可（空心部分靠反向子路径挖空）
    'fill-rule': 'nonzero',
  });
  icon.appendChild(shape);
  return icon;
}

/**
 * 说明：加减号曾经用 SVG <text> 渲染，再靠 getBBox() 事后校正位置。
 * 那条路试了三种办法（dominant-baseline / 固定 dy / 事后按包围盒校正）都会偏，
 * 因为文字渲染依赖字体度量。现在改用几何图形（见 buildSignShape），
 * 中心就是坐标原点，**不需要任何事后校正**，所以这里的 recenterSigns 已删除。
 */

/**
 * 标记「当前元素」：记在本地状态里（用于高亮样式），并告知宿主
 * （宿主侧的「复制元素 / 复制地址」需要知道用户选的是哪个节点）。
 */
/**
 * 只刷新「选中」与「当前命中」这两个**纯状态类**，不重建 DOM。
 *
 * 为什么需要：单击方框、以及上下键切换命中，过去都走 `render()` —— 它会把 `#nodes` 整个重建
 * （每个方框重新建元素、重新量宽）。压测数据：800 个方框时一次重建约 50 ms，
 * 而这两个状态变化只影响两三个 class 名。
 *
 * ⚠️ 「是不是命中」（`match` 类）**不在这里**维护：命中要在元素名底下垫一层底纹矩形，
 * 宽度得实测文字，属于结构性变化，仍由 `render()` 处理（改查询词时本来就要重建一帧）。
 */
function refreshStateClasses(session: SessionPayload): void {
  const currentId = currentMatchId();
  for (const group of nodesEl.children) {
    const id = group.getAttribute('data-node');
    if (!id) {
      continue;
    }
    const isSelected =
      state.selected?.sessionId === session.id && state.selected.nodeId === id;
    if (isSelected) {
      group.classList.add('selected');
    } else {
      group.classList.remove('selected');
    }
    group.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    if (currentId === id) {
      group.classList.add('match-current');
    } else {
      group.classList.remove('match-current');
    }
  }
  // 计数文案（「第 x/y 处」）与开关状态也在这里刷新 —— 以前是靠 `render()` 里的这一步，
  // 改成只改 class 之后必须显式调用，否则步进命中时计数不跟着动（测试会立刻发现）。
  updateSearchUi();
}

/**
 * 标记某个方框为选中（并通知宿主）。
 *
 * 只更新状态与相关 class，**不再重建整张图** —— 选中不改变任何几何，重建纯属浪费。
 * （宿主侧的「复制元素 / 复制地址」需要知道用户选的是哪个节点。）
 */
function markSelected(session: SessionPayload, node: GraphNode): void {
  if (state.selected?.sessionId === session.id && state.selected.nodeId === node.id) {
    return;
  }
  // 选中态**按会话隔离**：节点 id 由内容派生，同一个符号在「被调用关系图」与
  // 「调用关系图」两个标签里 id 完全相同；只存 id 会让另一个标签里的同名节点
  // 看起来也被选中，并让「复制当前标签为文本」从错误的起点导出。
  state.selected = { sessionId: session.id, nodeId: node.id };
  post({ type: 'selectNode', nodeId: node.id, sessionId: session.id });
  refreshStateClasses(session);
}

/** 内容包围盒（含留白）。 */
function contentBounds(session: SessionPayload): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of visibleNodes(session)) {
    const position = boxOf(session, node.id);
    const geometry = session.boxes[node.id];
    if (!position || !geometry) {
      continue;
    }
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + geometry.width);
    maxY = Math.max(maxY, position.y + geometry.height);
  }
  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, width: 600, height: 400 };
  }
  return {
    x: minX - MARGIN_LEFT,
    y: minY - MARGIN_TOP,
    width: maxX - minX + MARGIN_LEFT + MARGIN_RIGHT,
    height: maxY - minY + MARGIN_TOP + MARGIN_BOTTOM,
  };
}

/**
 * 视口模型（关键，改之前先读完）：
 *
 *   SVG 元素尺寸 = 内容尺寸
 *   viewBox 尺寸  = 内容尺寸
 *   ⇒ 1 内容单位恒等于 1 CSS 像素，字号不随窗口大小变化。
 *
 * **没有缩放功能**（按需求已移除 Ctrl+滚轮缩放）。视口只有一个状态：viewBox 原点。
 * 平移完全交给浏览器的滚动条，界面尺寸永远与实际像素 1:1。
 *
 * 历史教训（两处，都写在这里防止再犯）：
 *   ① `viewBox` 的 width/height 是**可视区域**尺寸，不是内容尺寸。写反会让可视窗口
 *      被压到不到 1 个单位宽，内容整个落在窗口外，屏幕一片空白。
 *   ② 一旦引入缩放，若把 SVG 元素的 width/height 也跟着缩小，元素就会比内容窄，
 *      而 `overflow:auto` 的容器只认元素尺寸 —— 右侧/下方内容被裁掉。
 *      现在不缩放了，这两类问题从设计上就不存在。
 */
interface Viewport {
  x: number;
  y: number;
}

function readView(session: SessionPayload): Viewport {
  let view = state.viewports.get(session.id);
  if (!view) {
    const bounds = contentBounds(session);
    view = { x: bounds.x, y: bounds.y };
    state.viewports.set(session.id, view);
  }
  return view;
}

/**
 * 图变了：把 viewBox 原点复位到内容左上角，并**补偿滚动**以免视口跳动。
 *
 * ⚠️ 宿主不只在「图真的变了」时发 `sessionUpdate`：改设置（`postSettings(true)`）与
 * 宽度重排（`reportWidths` 触发）都会把整张会话重新下发一次。此时内容并没有移动，
 * 但 `view.y` 被复位而 `scrollTop` 不变 → 用户会看到画面整体跳动一次（平滑滚动还会演成动画）。
 * 所以：锚点没变就什么都不做；变了就把滚动量同步补偿同样的位移。
 */
function reanchor(session: SessionPayload): void {
  const bounds = contentBounds(session);
  const previous = state.viewports.get(session.id);
  state.viewports.set(session.id, { x: bounds.x, y: bounds.y });
  if (!previous || session.id !== state.activeId) {
    return;
  }
  const dx = bounds.x - previous.x;
  const dy = bounds.y - previous.y;
  // 补偿方向：viewBox 原点增大 dx 时，同一个内容点在屏幕上的位置会**左移** dx
  // （屏幕位置 = 内容坐标 − 原点 − 滚动量），所以滚动量要**减去** dx 才能抵消。
  // ⚠️ 原实现写的是 `+= dx`，方向反了 —— 一旦原点真的会动，等于把位移加倍。
  //
  // ⚠️ 目前 `contentBounds()` 的原点恒为负的留白量：根固定在第 0 列、最上方那条子链的 y 恒为 0，
  // 与展开/收起哪些节点无关，因此 dx = dy = 0，这段补偿实际不会执行。
  // 保留它是为了原点将来会动时不至于跳动，方向按上面的推导已修正。
  if (dx !== 0) {
    canvasEl.scrollLeft -= dx;
  }
  if (dy !== 0) {
    canvasEl.scrollTop -= dy;
  }
}

function activeSession(): SessionPayload | undefined {
  return state.activeId ? state.sessions.get(state.activeId) : undefined;
}

// ------------------------------------------------------------ 相机：展开/收起后的滚动

/**
 * 点击 `+` / `−` 时记下的相机动作，等新一帧（本地重排或宿主 `sessionUpdate`）后执行。
 *
 * 用户需求（0.22）：
 *   ① 收起某一级后，把该方框滚到视口**垂直中央**；
 *   ② 在右边缘继续展开时，自动把内容整体左移，完整显示新一级；
 *   ③ 新一级比视口还宽（极端长方框）时，**以最左侧为基准**显示被展开的那一级；
 *   ④ 收起时横向滑回上一个展开前的位置（即展开的逆过程）。
 */
interface CameraIntent {
  kind: 'expand' | 'collapse';
  sessionId: string;
  nodeId: string;
  /** 点击时该方框的**屏幕**坐标：之后每帧按绝对目标还原它，保证幂等（不会重复补偿）。 */
  screenXBefore: number;
  screenYBefore: number;
  /** 记下的时刻：宿主迟迟不回消息时不至于在很久之后突然跳动一次。 */
  at: number;
}

/** 内容与视口边缘之间留的余量。 */
const CAMERA_PADDING = 12;
/** 相机动作的过期时间。 */
const CAMERA_STALE_MS = 2000;
/**
 * 相机动作的重放窗口。
 *
 * ⚠️ 一次展开会来**两帧**：第一帧的方框宽度是宿主**估算**的，webview 量准后回传
 * `reportWidths`，宿主再用实测宽度重排一次。只在第一帧调整滚动量，第二帧列位置一变
 * 右边就又被切掉一点（用户实测反馈「还得自己拖一下横条」）。所以在窗口内**每帧重放**；
 * 补偿与显露都是幂等的（同一布局重放不会叠加位移）。
 */
const CAMERA_REPLAY_MS = 800;
let cameraIntent: CameraIntent | undefined;
/** 已应用过的重放窗口截止时刻（0 表示没有活动动作）。 */
let cameraReplayUntil = 0;

/** 记一次相机动作（在点击处调用，读的是点击时的坐标）。 */
function startCameraIntent(
  kind: 'expand' | 'collapse',
  sessionId: string,
  nodeId: string
): void {
  const box = state.sessions.get(sessionId)?.boxes[nodeId];
  cameraIntent = {
    kind,
    sessionId,
    nodeId,
    // ⚠️ 记**屏幕**坐标而不是内容坐标：重放窗口里会按绝对目标反复应用，
    // 用内容位移做增量补偿会被叠加两次（表现是「收起时抖一下、然后位置偏了」）。
    screenXBefore: box ? box.x - canvasEl.scrollLeft : Number.NaN,
    screenYBefore: box ? box.y - canvasEl.scrollTop : Number.NaN,
    at: Date.now(),
  };
  cameraReplayUntil = Date.now() + CAMERA_REPLAY_MS;
  // 相机已整体停用（见 applyCameraIntent 的说明）：这里的动作只被记录，不会移动视口。
  void cameraReplayUntil;
  void revealNewLevel;
  void centerChainSpan;
}

/**
 * 平移视口。
 *
 * 有 `scrollTo` 就用**平滑滚动**：收起/展开会让内容整体位移，瞬时跳变时用户会找不到
 * 自己刚才在看的方框，平滑滚动让位移可被眼睛跟随。测试桩没有 `scrollTo`，走直接赋值
 * （所以用例断言的是**目标值**与「屏幕位置不变」这条性质，动画本身不断言）。
 */
function panTo(left: number, top: number): void {
  // ⚠️ 必须夹在**当前可滚动范围**内：平滑滚动的目标是按内容坐标算的，而重排可能让内容变窄
  // （实测宽度回传后的第二帧常比宿主估算的窄），此时视口会滑到内容之外 —— 那块没有绘制，
  // 深色主题下就是一块黑（用户实测反馈「右边有一块像没渲染出来」）。
  const clamp = (value: number, limit: number | undefined): number => {
    const rounded = Math.max(0, Math.round(value));
    return Number.isFinite(limit) && (limit as number) > 0
      ? Math.min(rounded, limit as number)
      : rounded;
  };
  const nextLeft = clamp(left, canvasEl.scrollWidth - canvasEl.clientWidth);
  const nextTop = clamp(top, canvasEl.scrollHeight - canvasEl.clientHeight);
  if (nextLeft === canvasEl.scrollLeft && nextTop === canvasEl.scrollTop) {
    return;
  }
  const scrollTo = (canvasEl as unknown as { scrollTo?: (options: ScrollToOptions) => void })
    .scrollTo;
  if (typeof scrollTo === 'function') {
    scrollTo.call(canvasEl, { left: nextLeft, top: nextTop, behavior: 'smooth' });
  } else {
    canvasEl.scrollLeft = nextLeft;
    canvasEl.scrollTop = nextTop;
  }
}

/*
 * 【已删除的「重排淡入」，留档以免重蹈覆辙】
 *
 * 曾经在点击展开/收起时把 `#nodes` / `#edges` 压到 0.3 不透明度，等相机动作那一帧再淡回，
 * 用来弱化「内容瞬移」的硬切感。2026-10-13 出事：**淡回只写在相机执行路径上**，那一帧没来
 * （会话 id 不匹配 / 动作过期 / 途中抛异常）时图层就永久停在暗态，用户看到整幅图发黑。
 * 因此整套删掉（连同 `graph.css` 里那条 `transition: opacity`）。
 *
 * 若将来要恢复这类「自愈式」的视觉过渡，必须满足：副作用的解除**不依赖另一段代码一定跑到**
 * —— 例如压暗时同时挂一个兜底定时器。C2 的位移动画就是按这个原则重做的（见「粘性位移的逐帧插值」）。
 */

/** 让被点的方框在屏幕上原地不动：按**绝对目标**算视口位置（幂等，重放不会叠加）。 */
function compensatedView(session: SessionPayload, intent: CameraIntent): { left: number; top: number } {
  const box = session.boxes[intent.nodeId];
  if (!box) {
    return { left: canvasEl.scrollLeft, top: canvasEl.scrollTop };
  }
  return {
    left: Number.isFinite(intent.screenXBefore) ? box.x - intent.screenXBefore : canvasEl.scrollLeft,
    top: Number.isFinite(intent.screenYBefore) ? box.y - intent.screenYBefore : canvasEl.scrollTop,
  };
}

/** 展开：先让被点的方框原地不动，再最小位移地让新一级露出来。 */
function revealNewLevel(session: SessionPayload, intent: CameraIntent): void {
  const parent = session.boxes[intent.nodeId];
  const children = (session.nodes[intent.nodeId]?.children ?? [])
    .map((id) => session.boxes[id])
    .filter((box): box is NonNullable<typeof box> => box !== undefined);
  const view = compensatedView(session, intent);
  // ⚠️ 横向只允许**右移**，且不做「把被点方框按回原位」的补偿：
  // 那个补偿会把视口往左推，与「把新一级露出来」的右移方向相反 —— 用户实测到的
  // 「第三级整体右移后回弹」与「最右侧展开却没有滚到最右边」都是这两股运动叠加的结果。
  // 横向的唯一动作者就是本函数下面的显露逻辑（用户 2026-10-14 确认的口径）。
  view.left = canvasEl.scrollLeft;
  // ⚠️ 粘性父框开着时，纵向**完全交给粘性**：它会把被展开的父框用 transform 拉到视口中央，
  // 而相机若再用滚动去锁它的屏幕位置，两次运动叠加 → 用户看到整行「大幅抖动」（视觉疲劳）。
  // 所以这里连同**位置补偿**一起撤掉，只保留横向的显露。
  if (state.stickyParent) {
    view.top = canvasEl.scrollTop;
  }
  if (!parent || children.length === 0) {
    panTo(view.left, view.top);
    return;
  }
  const levelLeft = Math.min(...children.map((box) => box.x));
  const levelRight = Math.max(...children.map((box) => box.x + box.width));
  const levelTop = Math.min(...children.map((box) => box.y));
  const viewportWidth = canvasEl.clientWidth;
  const viewportHeight = canvasEl.clientHeight;

  if (viewportWidth > 0 && levelRight + CAMERA_PADDING > view.left + viewportWidth) {
    // 最小必要量：让最右的新方框刚好进来
    const wanted = levelRight + CAMERA_PADDING - viewportWidth;
    // ⚠️ 「父框可见」只在**新一级放不下**时才是硬约束：那种情况下不再追求把整级露完，
    // 而是把父框贴到左边缘、从它右侧尽量多露出新一级，其余交给横向滚动条。
    // 放得下时若也套这条约束，正常情形反而看不全新一级。
    const tooWide = levelRight - levelLeft > viewportWidth - CAMERA_PADDING * 2;
    const limit = tooWide ? Math.max(0, parent.x - CAMERA_PADDING) : wanted;
    view.left = Math.max(view.left, Math.min(wanted, limit));
  }

  // ⚠️ 粘性父框开着时**不动纵向**：那条不变式是「被展开的父框钉在视口中央」，
  // 由 sticky 逻辑负责；这里再插一手会把它的位移算乱（renderCheck 里有用例钉住）。
  if (!state.stickyParent && viewportHeight > 0) {
    const viewTop = view.top;
    const viewBottom = viewTop + viewportHeight;
    // 父框优先保持可见；新一级只保证**起点**可见（同列纵向堆叠，滚动即可看全），
    // 否则子节点一多就会为了「全看到」而做一次很大的纵向位移。
    if (parent.y + parent.height + CAMERA_PADDING > viewBottom) {
      view.top = parent.y + parent.height + CAMERA_PADDING - viewportHeight;
    } else if (parent.y - CAMERA_PADDING < viewTop) {
      view.top = Math.max(0, parent.y - CAMERA_PADDING);
    } else if (levelTop - CAMERA_PADDING < viewTop) {
      view.top = Math.max(0, levelTop - CAMERA_PADDING);
    }
  }
  panTo(view.left, view.top);
}

/**
 * 收起：横向让该级在屏幕上原地不动，**纵向把它滚到视口中央**。
 *
 * 用户原始需求就是「某一级收起后垂直居中到这个级」，实测也印证：只锁位置时，
 * 若同级还有别的方框，收起后它停在半空，表现为「抖动后位置偏移」。
 * 纵向用**绝对目标**（居中），因此重放多少次结果都一样，不会叠加位移。
 */
/*
 * 【已删除的「折叠后把该格滚到视口中央」】留档：用户 2026-10-14 反馈「折叠的时候本标签还会弹一下」。
 * 那个做法与粘性位移叠加成两股反向运动，所以整套去掉 —— 折叠后的纵向定位改由
 * `centerChainSpan()` 统一负责（链跨度居中、单一权威）。
 */

/**
 * 执行待处理的相机动作。
 *
 * 口径（2026-10-14 用户确认）：
 *   - **展开**：调用 `revealNewLevel()` —— 用户早先明确要的「右侧新内容被切时自动带进视野」；
 *   - **折叠**：**不动视口**。曾试过「折叠后把该格滚到中央」，用户反馈「一收就弹一下」，
 *     已去掉；位置由粘性父框负责。
 *   - **链跨度居中那套不做**（用户 2026-10-14 明确：那一版不做）。
 * 粘性位移的逐帧插值（C2）保持开启，负责把布局重排造成的位移平滑过渡。
 */
function applyCameraIntent(session: SessionPayload): void {
  const intent = cameraIntent;
  if (!intent) {
    return;
  }
  if (intent.sessionId !== session.id || Date.now() - intent.at > CAMERA_STALE_MS) {
    cameraIntent = undefined;
    return;
  }
  cameraIntent = undefined;
  if (intent.kind === 'expand') {
    revealNewLevel(session, intent);
  }
  // 折叠：有意什么都不做（见上）。
}

/**
 * 把「根 → 被操作的那一格」这条**调用链的纵向跨度**居中到视口（用户 2026-10-14 选定的口径）。
 *
 * 为什么用滚动而不是粘性位移：
 *   - 链上各格分布在不同列、不同 y，粘性位移（只能在本子树空挡内滑动）**无法表达**这条链，
 *     所以靠近内容顶/底时用粘性永远居中不了；
 *   - 用滚动则是无条件可达的（受内容范围夹取），而且**一次操作只有一种运动** → 不会回弹。
 *
 * 实现约束：本函数在冻结粘性位移（`stickyFrozenUntil`）之后调用，且**不做插值动画**
 * （瞬时到位），保证「一个机制、一次到位」。
 */
function centerChainSpan(session: SessionPayload, nodeId: string): void {
  const chain: string[] = [];
  let cursor: string | undefined = nodeId;
  let guard = 0;
  while (cursor !== undefined && guard < 10000) {
    const box = session.boxes[cursor];
    if (box) {
      chain.push(cursor);
    }
    cursor = session.nodes[cursor]?.parent;
    guard += 1;
  }
  if (chain.length === 0) {
    return;
  }
  const tops = chain.map((id) => session.boxes[id].y);
  const bottoms = chain.map((id) => session.boxes[id].y + session.boxes[id].height);
  const spanTop = Math.min(...tops);
  const spanBottom = Math.max(...bottoms);
  const viewportHeight = Number(canvasEl.clientHeight) || 0;
  if (viewportHeight <= 0) {
    return;
  }
  // 冻结粘性并把显示位移清零：这一帧的方框按布局原样摆，纵向定位只由滚动负责
  stickyFrozenUntil = Date.now() + CAMERA_FREEZE_MS;
  stopStickyAnimation();
  displayedShifts = new Map();
  lastPaintedTotal = new Map();
  const wanted = (spanTop + spanBottom) / 2 - viewportHeight / 2;
  canvasEl.scrollTop = Math.max(0, wanted);
}
function collapsedSet(sessionId: string): Set<string> {
  let set = state.collapsed.get(sessionId);
  if (!set) {
    set = new Set<string>();
    state.collapsed.set(sessionId, set);
  }
  return set;
}

/**
 * 把「哪些节点被收起」整份下发给宿主。
 *
 * 坐标是宿主算的：收起的子树必须从布局里去掉 —— 否则它继续占着高度，
 * 同级的兄弟之间就留下一段空荡荡的「空挡」（用户 2026-10-10 实测反馈过：
 * 把第三级折叠后第二级的空挡还在）。所以每次改变收起状态都要发一次。
 */
function postCollapsed(sessionId: string): void {
  post({ type: 'collapse', sessionId, collapsed: [...collapsedSet(sessionId)] });
}

/** 从根开始收集当前可见的节点（跳过被收起的子树）。 */
function visibleNodes(session: SessionPayload): GraphNode[] {
  const collapsed = collapsedSet(session.id);
  const result: GraphNode[] = [];
  const stack = [session.rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const node = session.nodes[id];
    if (!node) {
      continue;
    }
    result.push(node);
    if (collapsed.has(id)) {
      continue;
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return result;
}

/**
 * 从根开始遍历**全部**已加载节点（不管有没有被收起），顺序为前序遍历、
 * 且兄弟节点按 `children` 的声明顺序 —— 与宿主排布兄弟节点的顺序一致，
 * 所以搜索的「下一个 / 上一个」就是用户从上往下看到的顺序。
 *
 * 注意不要写成 `visibleNodes` 那种直接 pop 的栈式遍历：那样兄弟节点是**倒序**的。
 *
 * 与 `visibleNodes` 的另一处区别：后者遇到被收起的节点就停止下探，这个不。
 * 搜索需要它来找「命中但当前被收起」的节点，好在计数里提示用户。
 */
function allNodes(session: SessionPayload): GraphNode[] {
  const result: GraphNode[] = [];
  const stack = [session.rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const node = session.nodes[id];
    if (!node) {
      continue;
    }
    result.push(node);
    // 逆序压栈：出栈顺序才与 children 的声明顺序一致
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
  return result;
}

function isVisible(session: SessionPayload, nodeId: string): boolean {
  const collapsed = collapsedSet(session.id);
  let current = session.nodes[nodeId];
  const guard = new Set<string>();
  while (current?.parent && !guard.has(current.id)) {
    guard.add(current.id);
    if (collapsed.has(current.parent)) {
      return false;
    }
    current = session.nodes[current.parent];
  }
  return true;
}

/** 方框左上角坐标（用户坐标 = 像素，不再有手动拖动偏移）。 */
function boxOf(session: SessionPayload, nodeId: string): { x: number; y: number } | undefined {
  const box = session.boxes[nodeId];
  if (!box) {
    return undefined;
  }
  return { x: box.x, y: box.y };
}

/**
 * 把某个方框摆到视图中间。
 *
 * 滚动容器认的是「SVG 元素尺寸」，而 SVG 始终等于内容尺寸，
 * 所以滚动偏移与内容坐标之间只差一个视口左上角 view.x（1 单位 = 1 像素）。
 */
function centerOn(session: SessionPayload, nodeId: string): void {
  const position = boxOf(session, nodeId);
  const geometry = session.boxes[nodeId];
  if (!position || !geometry) {
    return;
  }
  const view = readView(session);
  const clientWidth = canvasEl.clientWidth || 800;
  const clientHeight = canvasEl.clientHeight || 400;

  // 期望的视口左上角：让方框中心落在可视区中心
  const wantedX = position.x + geometry.width / 2 - clientWidth / 2;
  const wantedY = position.y + geometry.height / 2 - clientHeight / 2;

  // SVG 元素尺寸 = 内容尺寸，滚动偏移 = wanted - viewBox 原点（超出范围浏览器自己钳制）
  canvasEl.scrollLeft = Math.max(0, wantedX - view.x);
  canvasEl.scrollTop = Math.max(0, wantedY - view.y);
}

/**
 * 展开时以被点的方框为基准：先量出它当前的屏幕位置，
 * 等宿主把新布局发回来、重绘完成后再把滚动偏移补回去，视觉上这个方框原地不动。
 */
function anchorOn(session: SessionPayload, nodeId: string): void {
  const before = findNodeGroup(session.id, nodeId)?.getBoundingClientRect();
  if (!before) {
    return;
  }
  setTimeout(() => {
    const after = findNodeGroup(session.id, nodeId)?.getBoundingClientRect();
    if (!after) {
      return;
    }
    canvasEl.scrollLeft += after.left - before.left;
    canvasEl.scrollTop += after.top - before.top;
  }, 0);
}

/** 找到某个节点对应的 DOM 分组（group 上带 data-node 属性）。 */
function findNodeGroup(sessionId: string, nodeId: string): FakeSvgGroup | undefined {
  void sessionId;
  const stack: FakeSvgGroup[] = [nodesEl as unknown as FakeSvgGroup];
  while (stack.length > 0) {
    const element = stack.pop() as FakeSvgGroup;
    if (element.getAttribute?.('data-node') === nodeId) {
      return element;
    }
    for (const child of element.children ?? []) {
      stack.push(child as unknown as FakeSvgGroup);
    }
  }
  return undefined;
}

type FakeSvgGroup = {
  getAttribute(name: string): string | null;
  /** 粘性父框要改根分组的 transform（真实 DOM 的 SVGGElement 与测试桩都有这个方法）。 */
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): { left: number; top: number };
  children?: unknown[];
};

// ------------------------------------------------------------ 标签栏

function renderTabs(): void {
  tabsEl.textContent = '';
  for (const id of state.order) {
    const session = state.sessions.get(id);
    if (!session) {
      continue;
    }
    const tab = document.createElement('div');
    tab.className = id === state.activeId ? 'tab active' : 'tab';
    // 标签栏（#tabs 已是 role="tablist"）里的每一项都应当是 tab，并暴露选中状态；
    // 键盘用漫游 tabindex：只有活动标签在 Tab 序列里，其余靠方向键切换（见下）。
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', id === state.activeId ? 'true' : 'false');
    // 标签栏右键菜单按这个属性定位目标（早期按 DOM 下标对齐 `state.order`，两表一旦不同步
    // 就会关错标签 —— 见 `renderTabs` 里 `continue` 那条分支）。
    tab.setAttribute('data-tab-id', id);
    tab.tabIndex = id === state.activeId ? 0 : -1;
    tab.title = `${session.direction === 'callers' ? '被调用关系' : '调用关系'} · ${session.description}${session.engineLabel ? ` · ${session.engineLabel}` : ''}`;

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = session.title;
    tab.appendChild(label);

    // 元素名右侧放方向图标：进来 = 被调用关系，出去 = 调用关系。
    // 方向原先是用「被调用:名字」这种前缀表达的，既啰嗦又占地方，改成图标。
    tab.appendChild(createDirectionIcon(session.direction));

    // 引擎角标：多标签时才有意义（单标签可立即看出是哪个引擎）。
    const engineBadge = state.order.length > 1 ? badgeOf(session) : '';
    if (engineBadge) {
      const engine = document.createElement('span');
      engine.className = 'tab-engine';
      engine.textContent = engineBadge;
      tab.appendChild(engine);
    }

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.title = '关闭标签';
    close.textContent = '✕';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      post({ type: 'closeTab', id });
    });
    tab.appendChild(close);

    tab.addEventListener('click', () => {
      post({ type: 'selectTab', id });
    });
    // ⚠️ `div[role="tab"]` 不会因为回车/空格自动产生 click（只有原生 button 才会），
    // 而漫游 tabindex 又把非活动标签移出了 Tab 序列 —— 不接键盘的话，
    // 唯一能被 Tab 聚焦的那个标签反而按不动，「其余靠方向键切换（见下）」也没有下文。
    // 这里按 WAI-ARIA 的 tabs 模式补齐：方向键在标签间移动焦点并切换，Home/End 去首尾。
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        post({ type: 'selectTab', id });
        return;
      }
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const jump = event.key === 'Home' ? 0 : event.key === 'End' ? state.order.length - 1 : -1;
      if (step === 0 && jump < 0) {
        return;
      }
      event.preventDefault();
      const index = state.order.indexOf(id);
      const next =
        jump >= 0 ? state.order[jump] : state.order[(index + step + state.order.length) % state.order.length];
      if (next === undefined || next === id) {
        return;
      }
      post({ type: 'selectTab', id: next });
      // 焦点也要跟着走：标签是重建出来的，等宿主回执后那一帧再聚焦新标签。
      setTimeout(() => {
        for (const child of tabsEl.children) {
          if (child.getAttribute('aria-selected') === 'true') {
            (child as HTMLElement).focus?.();
            break;
          }
        }
      }, 0);
    });
    tabsEl.appendChild(tab);
  }
  tabsEl.style.display = state.order.length > 0 ? 'flex' : 'none';
  toolbarEl.classList.toggle('is-empty', state.order.length === 0);
}

/**
 * 标签上的引擎角标。
 *
 * 优先用宿主算好的 `badge`（引擎配置档决定，接了新引擎也只改设置）；
 * 缺省时退回按 `engineLabel` 文本猜 —— 兼容旧宿主/旧快照，认不出就不显示角标。
 */
function badgeOf(session: { badge?: string; engineLabel?: string }): string {
  const badge = (session.badge ?? '').trim();
  if (badge && badge !== 'unknown') {
    return badge;
  }
  return shortEngine(session.engineLabel ?? '');
}

function shortEngine(label: string): string {
  const text = label.toLowerCase();
  if (text.startsWith('clangd') || text.includes('clangd')) {
    return 'clangd';
  }
  if (text.includes('cpptools') || text.includes('c/c++')) {
    return 'cpptools';
  }
  return '';
}

// ------------------------------------------------------------ 画布

/**
 * 「展开全部」后要清掉的「已收起」标记。
 *
 * 工具栏的「展开全部」语义是**把图重新完整显示出来**，而不只是「加载数据」。
 * 用户点了「收起全部」（或逐个收起了方框）之后，数据仍然存在、仅被本地标记为
 * 收起状态；此时再点「展开全部」，若不清理这些标记，就会**什么都不发生**——
 * 这正是用户报的「展开折叠一遍后再展开又无效了」。
 */
let pendingExpandAll: string | undefined;

function render(): void {
  // 每帧重取一次字体签名：用户换了编辑器字体（--vscode-font-family）而字号未变时，
  // 量宽缓存必须失效，否则方框宽度会按旧字体算。
  measureFontSignature = undefined;
  const session = activeSession();
  renderTabs();

  if (!session) {
    nodesEl.textContent = '';
    edgesEl.textContent = '';
    emptyEl.style.display = 'flex';
    summaryEl.textContent = '';
    // 标签全关掉时把搜索也复位，免得下次打开还留着上一张图的命中计数
    refreshSearchMatches(undefined);
    updateSearchUi();
    // 临时过滤的计数同理：没有标签时不该留着上一张图的「已隐藏 N 个」
    updatePathFilterUi(undefined);
    // 没有会话了：任何「正在展开」的标记都失效。必须在这里清掉并刷新遮罩，
    // 否则已排队的定时器会把遮罩显示在空状态上，而且此后再也无人把它关掉。
    state.loading.clear();
    updateBusy();
    return;
  }
  emptyEl.style.display = 'none';
  // 汇总行已按需求去掉（不显示「显示几个/未展开几个」）。
  summaryEl.textContent = '';

  // 上一次「展开全部」的响应（宿主把数据补发）到了：清掉本地收起标记，让所有
  // 已加载的方框重新显示出来。
  if (pendingExpandAll === session.id) {
    pendingExpandAll = undefined;
    collapsedSet(session.id).clear();
  }

  // 搜索命中集合每帧重算：数据更新、切换标签、改查询走的都是这条路径，
  // 类名也在这一帧写进节点分组，所以状态只有一份。
  refreshSearchMatches(session);

  // 粘性父框：先定下这一帧钉住哪些方框、各自移多少，下面的连线与方框都按它画。
  refreshSticky(session);

  // 方框宽度按内容自适应：先量宽写回 boxes，再算画布与箭头锚点。
  measureSessionWidths(session);
  // 把实测宽度回报宿主，让它用真实宽度排列各列（否则估宽偏大 → 列远、箭头长）。
  // 宿主只在宽度变化时才重排，因此这里每帧回报也不会死循环。
  reportMeasuredWidths(session);

  // 位移插值只用于**几何真的变了**的帧（展开/收起、实测宽度回传后的重排）：
  // 改设置（例如重新打开粘性）不该有 180ms 的过渡，否则「打开设置后立刻居中」这条
  // 既有的不变式会被动画拖慢（renderCheck 里有断言钉住）。放在量宽之后，
  // 因为宽度也是几何的一部分 —— 第二帧（实测宽度）正需要动画。
  const signature = geometrySignature(session);
  if (signature !== lastGeometrySignature) {
    lastGeometrySignature = signature;
    beginLayoutStickyAnimation(session);
  } else if (animFrame === undefined && animFrom === undefined) {
    // ⚠️ 同一几何常常会连着渲染两帧（宿主回传宽度、相机执行都会再 render 一次）。
    // 那时**不能落位**：落位会把正在跑的插值当场结束（表现就是「还是瞬移」）。
    snapStickyShifts();
  }
  // 几何没变、但动画在自己的窗口内：不动它（由 tick 续帧）。
  // ⚠️ 动画过期后**必须落位而不是只停掉**：只 stop 会把 `displayedShifts` 留在插值中间值上，
  // 于是展开后的方框永远差一点没居中（2026-10-14 用户实测「展开某个节点时当前节点不居中了」）。
  // `snapStickyShifts()` 会同时停动画并把显示值落成目标值。
  else if (Date.now() - animStart >= ANIM_DURATION_MS + 100) {
    snapStickyShifts();
  }

  // 视口（见最上方「视口模型」的说明）：
  //   SVG 元素尺寸 = viewBox 尺寸 = 内容尺寸，1 内容单位恒等于 1 像素。
  //   没有缩放功能，平移交给滚动条；界面尺寸永远与实际像素 1:1。
  const view = readView(session);
  const contentSize = contentBounds(session);
  // 尾部余量：VS Code 的滚动条是**覆盖式**的（浮在内容上、不占布局空间），`clientWidth` 把
  // 滚动条底下那一条也算作可视宽度 —— 于是「对准右边缘」的内容会被滚动条压住十几像素，
  // 看起来就是「没滚到最右边」（用户 2026-10-14 实测反馈）。给内容加尾部余量，
  // 最右侧/最下方的方框就能滚到滚动条之外。
  const width = Math.max(1, contentSize.width + TRAILING_SCROLLBAR_SLACK);
  const height = Math.max(1, contentSize.height + TRAILING_SCROLLBAR_SLACK);
  svgEl.setAttribute('viewBox', `${view.x} ${view.y} ${width} ${height}`);
  svgEl.setAttribute('width', String(width));
  svgEl.setAttribute('height', String(height));
  viewportEl.removeAttribute('transform');

  edgesEl.textContent = '';
  nodesEl.textContent = '';

  stickyEdges = [];
  for (const edge of session.edges) {
    if (!isVisible(session, edge.from) || !isVisible(session, edge.to)) {
      continue;
    }
    // 折线几何统一走 edgeGeometry：边的 from/to 已带方向语义（callers 里 from 是调用者、
    // 指向左侧的被调用方），按实际左右位置取锚点，画成 90° 折线。
    // 注意宽度是逐节点自适应的，两个锚点各取自己那个方框的几何
    // （曾经两个锚点都用 from 的宽度，目标方框较宽/较窄时箭头就接不上边）。
    const geometry = edgeGeometry(session, edge);
    if (!geometry) {
      continue;
    }
    const path = svg('path', { d: geometry.d, class: 'edge' });
    const toNode = session.nodes[edge.to];
    if (toNode?.isCycle) {
      path.classList.add('cycle');
    }
    edgesEl.appendChild(path);
    // 只要有一端**被钉住**，这条线就会随滚动改变形状，记下来逐帧重画。
    // ⚠️ 判据必须是「被钉住」而不是「这一帧位移 ≠ 0」：位移的取值区间穿过 0
    // （父框正好在自己槽位中央时位移就是 0），用位移判会出现「这一帧恰好为 0 → 这条边
    // 永不登记 → 之后滚动时方框动了、箭头却没重画」的脱节。
    if (stickyShifts.has(edge.from) || stickyShifts.has(edge.to)) {
      stickyEdges.push({ path, from: edge.from, to: edge.to });
    }
  }

  for (const node of visibleNodes(session)) {
    const position = boxOf(session, node.id);
    const geometry = session.boxes[node.id];
    if (!position || !geometry) {
      continue;
    }
    nodesEl.appendChild(renderNode(session, node, position, geometry));
  }

  updateSearchUi();
  // 临时过滤的计数：按**当前标签**的 payload 显示（宿主每次构负载都会重新算）
  updatePathFilterUi(session);

  // 加载遮罩：本地的展开状态（state.loading）也在这一帧变化，一并刷新
  updateBusy();

  // 新查询：把根方框摆到视图中间（等这一帧画完再滚动）
  if (state.centerRequest === session.id) {
    state.centerRequest = undefined;
    setTimeout(() => centerOn(session, session.rootId), 0);
  }
}

function renderNode(
  session: SessionPayload,
  node: GraphNode,
  position: { x: number; y: number },
  geometry: Box
): SVGGElement {
  // 选中态同时用于 class 与 aria-pressed（屏幕阅读器读不出 class）
  const selected =
    state.selected?.sessionId === session.id && state.selected.nodeId === node.id;
  const group = svg('g', {
    class: [
      'node',
      node.depth === 0 ? 'root' : '',
      node.isCycle ? 'cycle' : '',
      selected ? 'selected' : '',
    // 最后点过加减号的格子带上粉框（持久）：折叠时可立即看出操作对象（用户 2026-10-14 要求）
    isExpanderTarget(session.id, node.id) ? 'expander-active' : '',
      searchState.hits.has(node.id) ? 'match' : '',
      currentMatchId() === node.id ? 'match-current' : '',
    ]
      .filter(Boolean)
      .join(' '),
    // 链上节点各自带上自己的粘性位移：纵向滚动时它们都停在视口垂直中央（见「粘性父框」一节）
    transform: `translate(${position.x} ${position.y + stickyShiftOf(node.id)})`,
    'data-node': node.id,    // 键盘可达：方框进 Tab 序列；回车跳转、空格选中（见下面的 keydown 处理）。
    tabindex: '0',
    role: 'button',
    'aria-label': `${node.name}，${node.file}:${node.line}，回车键跳转，空格键选中`,
    'aria-pressed': selected ? 'true' : 'false',
  });
  // 记下这一帧这一格画出来的**总绘制 y**：它是下一次布局插值的起点。
  // ⚠️ 少了这一步，布局帧上 `lastPaintedTotal` 是空的，插值起点只能回落到目标 → 永远不动
  // （C2 前一版就是这样：闸门开着、诊断却始终显示「send 后 = 终点」）。
  lastPaintedTotal.set(node.id, position.y + stickyShiftOf(node.id));

  // 键盘操作：与鼠标的单击（选中）与双击（跳转）等价。
  // ⚠️ 展开/收起目前仍只能用鼠标点加减号（那条路径要经 pointer.expandTarget + window 的
  // mouseup 才生效，合成事件容易在守卫处被丢掉），所以 aria-label 里不承诺空格能展开。
  group.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      post({ type: 'openLocation', sessionId: session.id, nodeId: node.id });
      return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      markSelected(session, node);
    }
  });

  // 框高由宿主布局给出（显示路径 43 / 不显示 26）；文字基线与图标位置都按框高算，
  // 所以关掉路径后方框不只是「少一行」，而是**整框变矮**、剩下那行在框里居中。
  const boxHeight = geometry.height || defaultBoxHeight();
  const nameBaseline = nameBaselineFor(boxHeight);
  group.appendChild(
    svg('rect', { class: 'box', width: geometry.width, height: boxHeight, rx: 0 })
  );

  // 第一行开头放符号角标（模仿 VS Code 的小图标），文字从图标右侧开始。
  group.appendChild(buildKindIcon(node.kind, iconYFor(boxHeight)));

  // 两行布局：第一行「图标 + 名称 + 加减号」，第二行「文件路径:行号」。
  // 方框宽度已按这两行的实际渲染宽度量好（measureSessionWidths），
  // 所以文字不会溢出，右边的加减号也不会压到文字上。
  // 搜索命中：只给**元素名**垫一层底纹，方框本身不动（按需求）。
  // 必须先 append 底纹、再 append 文字，底纹才画在文字下面。
  const displayName = nodeNameText(node);
  if (searchState.hits.has(node.id)) {
    // 标签在名称前面时（`arrow` 摆法），底纹要右移标签那么宽 ——
    // 否则底纹会盖住标签、只压住元素名的后半截。
    group.appendChild(hitRectFor(displayName, nameBaseline, node.nameTagPrefix));
  }

  // 名称行 = 标签（宿主算好的文字）+ 元素名。用独立 tspan 是为了给标签弱化颜色，
  // 同时让搜索底纹仍然只覆盖元素名本身。
  const nameText = svg('text', { x: TEXT_X, y: nameBaseline, class: 'name' });
  if (!node.nameTagPrefix && !node.nameTagSuffix) {
    // 没有标签时**保持原样**：单个 textContent，不引入 tspan ——
    // 既有断言与测试桩都按 textContent 读元素名，多包一层只是徒增差异。
    nameText.textContent = displayName;
  } else {
    if (node.nameTagPrefix) {
      const tag = svg('tspan', { class: 'name-tag-before' });
      tag.textContent = node.nameTagPrefix;
      nameText.appendChild(tag);
    }
    const nameSpan = svg('tspan', { class: 'name-text' });
    nameSpan.textContent = displayName;
    nameText.appendChild(nameSpan);
    if (node.nameTagSuffix) {
      const tag = svg('tspan', { class: 'name-tag-after' });
      tag.textContent = node.nameTagSuffix;
      nameText.appendChild(tag);
    }
  }
  group.appendChild(nameText);

  // 「文件路径:行号」那一行由设置控制：关掉后每个方框里只有元素名
  if (state.showLocation) {
    const locText = svg('text', { x: TEXT_X, y: LOC_BASELINE, class: 'loc' });
    locText.textContent = nodeLocText(node);
    group.appendChild(locText);
  }

  const title = svg('title', {});
  title.textContent = buildTooltip(node);
  group.appendChild(title);

  // 「还有多少同级节点没显示」的可见标记（小圆点 + +N）
  const omittedMark = buildOmittedMark(node, { width: geometry.width, height: boxHeight });
  if (omittedMark) {
    group.appendChild(omittedMark);
  }

  // 单击选中、双击跳转（按需求：单击不再打开文件）。
  //
  // ⚠️ 不要用 `dblclick` 事件：单击会走 markSelected → render()，把整个 #nodes 子树换成
  // 新元素；浏览器按「两次点击是否命中同一元素」配对双击，命中不同元素时 `dblclick`
  // 根本不会派发 —— 表现是「第一次双击只选中、要再双击一次才跳转」。
  // 改成在 click 里看 `event.detail`：detail ≥ 2 就是双击，与元素是否被替换无关。
  group.addEventListener('click', (event) => {
    event.stopPropagation();
    markSelected(session, node);
    if (event.detail >= 2) {
      // 双击会选中 SVG 文本留下蓝色选区，这里压掉（CSS 的 user-select: none 是兜底）
      event.preventDefault();
      post({ type: 'openLocation', nodeId: node.id, sessionId: session.id });
    }
  });

  // 右键：弹出该方框自己的菜单（复制元素 / 复制地址）
  group.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    markSelected(session, node);
    openBoxMenu(event.clientX, event.clientY, session.id, node.id);
  });

  // 加减号与函数名同一行，放在方框右侧。
  // 用 mousedown 记录、window mouseup 统一处理，避免点击被冒泡顺序拦截。
  //
  // 模式判定顺序很关键（曾经写错导致「减号永远不出现、折叠不了」）：
  //   node.canExpand 在**子节点已加载**后依然是 true，所以不能把它放在前面，
  //   否则「已展开、有子节点」的节点会拿到 expand 模式（显示加号），
  //   点下去走的是「展开」分支（对已加载节点是空操作），折叠分支成了死代码。
  //   正确顺序：先判「已展开且有子节点」→ collapse，再判「可展开或已被收起」→ expand。
  const isCollapsed = collapsedSet(session.id).has(node.id);
  const hasVisibleChildren = !isCollapsed && node.children.length > 0;
  if (state.loading.has(loadingKey(session.id, node.id))) {
    group.appendChild(buildExpander(session, node, geometry, 'loading'));
  } else if (hasVisibleChildren) {
    group.appendChild(buildExpander(session, node, geometry, 'collapse'));
  } else if (isCollapsed || node.canExpand) {
    group.appendChild(buildExpander(session, node, geometry, 'expand'));
  } else {
    group.appendChild(buildExpander(session, node, geometry, 'leaf'));
  }

  return group;
}

type ExpanderMode = 'expand' | 'collapse' | 'loading' | 'leaf';

function buildExpander(
  session: SessionPayload,
  node: GraphNode,
  geometry: Box,
  mode: ExpanderMode
): SVGGElement {
  // 与函数名同一行，紧贴方框右侧；宽度是自适应的，所以位置也按实际宽度算。
  // 中心留出 EXPANDER_BOX/2 + ICON_X，保证加减号与文字之间至少 EXPANDER_GAP。
  const expander = svg('g', {
    class: `expander ${mode}`,
    // 中心与图标在同一水平线上（单行布局时两者都在框里居中）
    transform: `translate(${geometry.width - ICON_X - EXPANDER_BOX / 2} ${
      iconYFor(geometry.height || defaultBoxHeight()) + ICON_BOX / 2
    })`,
  });
  // 命中区域比视觉方块大，方便点击
  expander.appendChild(svg('circle', { class: 'hit', r: 12, fill: 'transparent' }));
  // 视觉上是小正方形（直角），边长 ICON_BOX(13)，以原点为中心；
  // 中心放在 width - ICON_X - ICON_BOX/2，左右留白与图标侧对称
  const half = EXPANDER_BOX / 2;
  expander.appendChild(
    svg('rect', { class: 'ring', x: -half, y: -half, width: half * 2, height: half * 2, rx: 0 })
  );
  // 符号用**几何图形**画，不用文字：
  //   文字渲染的居中依赖字体度量（基线、字形高度），换字体就会偏，
  //   而这里对"正中"的要求很严，所以直接用矩形按坐标精确居中。
  expander.appendChild(buildSignShape(mode));

  const tip = svg('title', {});
  tip.textContent =
    mode === 'expand'
      ? node.direction === 'callers'
        ? `展开：显示 ${node.name} 的调用者`
        : `展开：显示 ${node.name} 调用的函数`
      : mode === 'collapse'
        ? `收起：${node.name} 的下一层`
        : mode === 'loading'
          ? '正在加载…'
          : '无下一层调用关系';
  expander.appendChild(tip);

  if (mode === 'leaf') {
    // 叶子：不可点，只是占位保持视觉一致
    return expander;
  }

  expander.addEventListener('mousedown', (event) => {
    // 只认左键：右键点加减号时 contextmenu 会弹菜单，若这里也记下目标，
    // 松开右键就会在 window 的 mouseup 里把它当成一次展开/收起。
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    if (mode === 'loading') {
      return;
    }
    pointer.expandTarget = { sessionId: session.id, nodeId: node.id, mode };
  });
  // 拦住 click，避免冒泡到方框触发「打开文件」
  expander.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
  });

  return expander;
}

/**
 * 加减号图形：以原点（小正方形中心）为中心、按坐标精确居中的几何图形。
 *
 * 为什么不用文字：`+` / `−` 作为文本渲染时，视觉中心取决于字体的基线位置与
 * 字形高度，`dominant-baseline` 在 webview 里又支持不一致——试过三种办法都会偏。
 * 用矩形拼就没有任何字体依赖：中心就是原点。
 *
 * 尺寸按 9px 臂长（正方形边长 13px，留 2px 边距）。
 */
function buildSignShape(mode: ExpanderMode): SVGGElement {
  const sign = svg('g', { class: `sign sign-${mode}` });
  const arm = 4.5; // 半臂长
  const thickness = 1.6;

  if (mode === 'leaf') {
    // 到底了：一个小圆点
    sign.appendChild(svg('circle', { class: 'sign-shape', cx: 0, cy: 0, r: 1.4 }));
    return sign;
  }

  if (mode === 'loading') {
    // 加载中：一个不闭合的圆环（CSS 里让它旋转）
    const r = 5;
    sign.appendChild(
      svg('path', {
        class: 'sign-shape sign-spin',
        d: `M ${r} 0 A ${r} ${r} 0 1 1 0 ${-r}`,
        fill: 'none',
      })
    );
    return sign;
  }

  // 横杠：加号与减号都有
  sign.appendChild(
    svg('rect', {
      class: 'sign-shape',
      x: -arm,
      y: -thickness / 2,
      width: arm * 2,
      height: thickness,
    })
  );
  if (mode === 'expand') {
    // 加号再多一竖，与横杠同中心
    sign.appendChild(
      svg('rect', {
        class: 'sign-shape',
        x: -thickness / 2,
        y: -arm,
        width: thickness,
        height: arm * 2,
      })
    );
  }
  return sign;
}

/** 悬停提示：只保留函数名、完整路径、位置行数。 */
function buildTooltip(node: GraphNode): string {
  const lines = [node.name, `${node.file}:${node.line}`];
  // 省略条数除了这里的文字，方框右下角还有个可见标记（见 buildOmittedMark）。
  // ⚠️ 两种原因必须分开写：合并成一个数字，用户不知道该调 maxChildrenPerNode 还是 maxLayoutNodes。
  const total = node.omitted ?? 0;
  if (total > 0) {
    const byNodeCap = Math.min(total, Math.max(0, node.omittedByNodeCap ?? 0));
    const byChildrenCap = total - byNodeCap;
    if (byChildrenCap > 0) {
      lines.push(`（另有 ${byChildrenCap} 条未显示，受 maxChildrenPerNode 限制）`);
    }
    if (byNodeCap > 0) {
      lines.push(
        `（另有 ${byNodeCap} 条未显示，因节点总数上限 maxLayoutNodes 未排布；可在设置中调大上限）`
      );
    }
  }
  // 方案 A：到上限且这一格仍有下一层可展开 —— 悬停里如实说明「数量未知、原因是什么」
  if (node.cappedExpandable === true && total === 0) {
    lines.push(
      '（仍有下一层未展开，但已达节点总数上限；可在设置中调大 maxLayoutNodes，' +
        '或先收起部分分支后重试）'
    );
  }
  return lines.join('\n');
}

/**
 * 方框右下角的「还有未显示的同级节点」标记：一个小圆点 + `+N`。
 *
 * 需求（0.22）原话：省略条数只在悬停提示里说不够，要在方框上给个更醒目的标记。
 * 位置选**右下角**：右侧那一条留白本来就是给加减号预留的，而加减号在第一行，
 * 第二行右边是空的，所以这里不会压到名称或路径。
 *
 * ⚠️ 不用 codicon：合规计数已用满（31 条），圆点与数字都是直接画的几何/文字。
 */
function buildOmittedMark(
  node: GraphNode,
  geometry: { width: number; height: number }
): SVGElement | undefined {
  // 方案 A（用户 2026-10-14 选定，并明确要求**去掉**原先的「小圆点 + 数字」那套）：
  // 只有一种标记 —— 到节点总数上限、且这一格**仍有下一层可展开**时，画一个不带数字的虚线环。
  // 不写数字的理由：那些子节点从未取过、条数未知，编一个数字就是撒谎。
  if (node.cappedExpandable !== true) {
    return undefined;
  }
  const mark = svg('g', { class: 'omitted-mark capped-mark' });
  const ringY = geometry.height - OMITTED_MARK_RADIUS - 5;
  const ringX = geometry.width - OMITTED_MARK_RADIUS - 22;
  mark.appendChild(
    svg('circle', {
      class: 'capped-ring',
      cx: ringX,
      cy: ringY,
      r: OMITTED_MARK_RADIUS,
    })
  );
  const tip = svg('title', {});
  tip.textContent =
    '仍有下一层未展开，但已达节点总数上限（可在设置中调大 cppCallGraph.maxLayoutNodes，' +
    '或先收起部分分支后重试）';
  mark.appendChild(tip);
  return mark;
}

/**
 * 按设置把一条路径变成方框里显示的文字。
 *
 * ⚠️ 与宿主 `graphLayout.ts` 的 `displayPathText` **必须逐字同步**：宿主用同一份逻辑估宽，
 * 两边算出的字符串一旦不同，列宽与实际文字就对不上（renderCheck 有跨侧等值断言）。
 *
 * - `full`：整条原样显示（不截断，方框按完整路径加宽）。
 * - `tail`：末尾窗口（固定层数，或 `tailLevels = 0` 时按字符预算，即 0.20 的行为）+ 锚点段；
 *   只有自动档会为了塞进预算而缩窗口，显式给了层数或锚点时一律完整显示。
 */
function displayPathText(file: string, options: PathDisplayOptions, max: number): string {
  const segments = file.split(/[\\/]/).filter((part) => part.length > 0);
  if (segments.length <= 1) {
    return file;
  }
  // 只有显式传 false 才去掉文件名（未设置时按显示处理）
  const keepFileName = options.showFileName !== false;
  if (options.mode === 'full') {
    // 完整显示就是要整条：不截断，方框按完整文字宽度长出来；
    // 关掉文件名时去掉最后一段（若因此为空则仍显示原名，避免那行只剩 `:12`）
    const kept = keepFileName ? segments : segments.slice(0, -1);
    return kept.length > 0 ? kept.join('/') : file;
  }
  // 省略模式只对目录段做省略：关掉文件名时先摘掉文件名那一段
  const dirs = keepFileName ? segments : segments.slice(0, -1);
  const parts = dirs.length > 0 ? dirs : segments;

  const anchors = resolveAnchorIndexes(parts, options.anchors);
  let tailCount =
    options.tailLevels > 0
      ? Math.min(options.tailLevels, parts.length)
      : budgetTailCount(parts, max);
  // 只在自动档缩窗口；显式给了层数或锚点时用户要的就是那些段，缩了等于不显示
  if (options.tailLevels <= 0) {
    while (tailCount > 1 && assemblePath(parts, anchors, tailCount).length > max) {
      tailCount -= 1;
    }
  }
  // 不截断：超出预算的长度由方框加宽容纳
  return assemblePath(parts, anchors, tailCount);
}

/** 编译好的段匹配正则缓存（同一批模式逐帧复用，避免每个节点都重新编译）。 */
const globRegexCache = new Map<string, RegExp>();

/**
 * 把通配形式的段匹配器编成正则：`*` = 任意长、`?` = 单字符，其余一律当字面量。
 *
 * 大小写不敏感（与既有锚点口径一致）。带缓存：同一批模式在 800 个节点上会被调用很多次。
 */
function globRegex(glob: string): RegExp {
  const cached = globRegexCache.get(glob);
  if (cached) {
    return cached;
  }
  let source = '';
  for (const character of glob) {
    if (character === '*') {
      source += '.*';
    } else if (character === '?') {
      source += '.';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const regex = new RegExp(`^${source}$`, 'i');
  // 简单上限：手写几百条模式时不至于无界增长（超出就整表清掉，代价只是重新编译）
  if (globRegexCache.size > 200) {
    globRegexCache.clear();
  }
  globRegexCache.set(glob, regex);
  return regex;
}

/**
 * 段匹配器的解析结果。支持的段写法（宿主 `cppCallGraph.pathAnchors` 的条目用这一套，
 * 面板只收到**已经剥过括号**的那份，两侧逐字同规则）：
 *
 *   `src`              字面量（大小写不敏感）
 *   `group_*` / `a?c`  通配：`*` 任意长、`?` 单字符
 *   `a|b`              多选（段内，不嵌套）
 *   `"a*b"`            引号 = **字面量**（不解释任何元字符；名字真的带 `*` `|` `(` 时用它）
 *   `re:^group_[ab]$`  正则（整段都是正则，不参与 `|` 拆分；`+` `-` `*` 在正则里原样有效）
 *   `**`               任意层（含 0 层）
 */
type SegmentSpec =
  | { kind: 'anyDepth' }
  | { kind: 'regex'; regex: RegExp }
  | { kind: 'literal'; value: string }
  | { kind: 'glob'; branches: string[] }
  | { kind: 'invalid' };

/** 解析一个段；正则写错时返回 `invalid`（调用方据此提示，而不是静默失效）。 */
function parseSegmentSpec(raw: string): SegmentSpec {
  const trimmed = raw.trim();
  if (trimmed === '**') {
    return { kind: 'anyDepth' };
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return { kind: 'literal', value: trimmed.slice(1, -1).toLowerCase() };
  }
  if (/^re:/i.test(trimmed)) {
    try {
      return { kind: 'regex', regex: new RegExp(trimmed.replace(/^re:/i, ''), 'i') };
    } catch {
      return { kind: 'invalid' };
    }
  }
  const branches = trimmed
    .split('|')
    .map((branch) => branch.trim())
    .filter((branch) => branch.length > 0);
  return branches.length === 0 ? { kind: 'invalid' } : { kind: 'glob', branches };
}

/** 该段匹配器是否命中某个段名（`**` 由 `matchSpans` 单独处理，不在这里比较）。 */
function specMatches(spec: SegmentSpec, segment: string): boolean {
  switch (spec.kind) {
    case 'anyDepth':
      return true;
    case 'literal':
      return segment.toLowerCase() === spec.value;
    case 'regex':
      return spec.regex.test(segment);
    case 'glob':
      return spec.branches.some((branch) => globRegex(branch).test(segment));
    default:
      return false;
  }
}

/** 一条模式解析后的计划。 */
interface PatternPlan {
  /** 原始写法（提示用）。 */
  raw: string;
  /** `!` 前缀：排除（任一排除模式命中该路径 → 整条路径不出锚点/标签）。 */
  exclude: boolean;
  /** `all:` 前缀：该模式的**所有**命中。 */
  all: boolean;
  /** `keep:` 前缀：命中区间整体保留（只作用于标签；路径那行会关掉它）。 */
  keep: boolean;
  /** 以分隔符开头：必须从工作区根开始。 */
  fromRoot: boolean;
  /** 末段 `+N` / `-N`；`all:` 时每个命中各偏移。 */
  offset: number;
  /** 单独写的 `+N` / `-N`（没有段）：按段数定位。 */
  pureOffset?: { sign: '+' | '-'; count: number };
  /**
   * 末段既能当**整段名字**、也能当「名字 ± N」时（例如 `lib-2`），这里放偏移那一种解释。
   *
   * ⚠️ 必须先按整段试、整段命中不了才用它 —— 这条「整段优先」是 0.22 的既有规则，
   * 丢掉的后果是真实目录名 `lib-2` 永远匹配不上（统一匹配器时曾出现一次）。
   */
  offsetCandidate?: { specs: SegmentSpec[]; offset: number };
  specs: SegmentSpec[];
}

/**
 * 解析一条模式。语法（三层，可任意组合）：
 *
 *   前缀：`!`（排除）/ `all:`（所有命中）/ `keep:`（整段保留）—— 顺序任意、可叠加
 *   段：见 `SegmentSpec`；`父/名字` 要求这些段**连续出现**，以 `/` 开头要求从工作区根开始
 *   偏移：末尾 `+N` / `-N`；单独写 `+N` / `-N` 表示「从根数第 N 段 / 从文件名往上第 N 段」
 *
 * ⚠️ 末段是正则（`re:`）或引号段时不解析偏移：`re:a+1`、`"a+1"` 里的 `+1` 是内容而不是偏移。
 */
function parsePattern(raw: string): PatternPlan | undefined {
  let text = String(raw ?? '').trim();
  if (text.length === 0) {
    return undefined;
  }
  let exclude = false;
  if (text.startsWith('!')) {
    exclude = true;
    text = text.slice(1).trim();
  }
  let all = false;
  let keep = false;
  for (;;) {
    if (/^all:/i.test(text)) {
      all = true;
      text = text.replace(/^all:/i, '').trim();
      continue;
    }
    if (/^keep:/i.test(text)) {
      keep = true;
      text = text.replace(/^keep:/i, '').trim();
      continue;
    }
    break;
  }
  if (text.length === 0) {
    return undefined;
  }
  // 整体加引号 = 一条**字面量路径**：各段按字面量匹配，并整段一起显示（等价 keep:）
  if (isWhollyQuoted(text)) {
    const specs = quoteEachSegment(text).split('/').map(parseSegmentSpec);
    return { raw, exclude, all, keep: true, fromRoot: false, offset: 0, specs };
  }
  // 单独写的偏移：没有段，按段数定位
  const plain = /^([+-])(\d+)$/.exec(text.replace(/^[\\/]+/, ''));
  if (plain) {
    return {
      raw,
      exclude,
      all,
      keep,
      fromRoot: false,
      offset: 0,
      pureOffset: { sign: plain[1] === '-' ? '-' : '+', count: Number.parseInt(plain[2], 10) },
      // ⚠️ 字面解释**也要留着**：真的存在名为 `+3` 的目录时必须先按整段命中
      //（与 `lib-2` 同一条「整段优先」规则，见 offsetCandidate）。
      specs: [parseSegmentSpec(text)],
    };
  }
  const fromRoot = /^[\\/]/.test(text);
  const body = text.replace(/^[\\/]+/, '');
  const segments = body.split(/[\\/]/);
  const lastIndex = segments.length - 1;
  const last = segments[lastIndex].trim();
  const canOffset = last !== '**' && !/^re:/i.test(last) && !isWhollyQuoted(last);
  const named = canOffset ? /^(.+?)([+-])(\d+)$/.exec(last) : null;
  // 先把**整段**当名字（`lib-2` 是真实目录名，不能一开始就当成「mods 减 1」）；
  // 整段命中不了时才退回「名字 + 偏移」这一种解释（见 PatternPlan.offsetCandidate）。
  const specs = segments.map(parseSegmentSpec);
  if (!named) {
    return { raw, exclude, all, keep, fromRoot, offset: 0, specs };
  }
  const offsetSegments = segments.slice();
  offsetSegments[lastIndex] = named[1];
  return {
    raw,
    exclude,
    all,
    keep,
    fromRoot,
    offset: 0,
    specs,
    offsetCandidate: {
      specs: offsetSegments.map(parseSegmentSpec),
      offset: Number.parseInt(named[3], 10) * (named[2] === '-' ? -1 : 1),
    },
  };
}

/**
 * 在一条路径的段表上匹配一条模式，返回命中**区间**。
 *
 * - 非 `keep:`：区间只有一个元素（锚点段）；
 * - `keep:`：区间 = 首个命中段…锚点段（含 `**` 跨过的中间段），用于整段保留显示；
 * - `all:`：收集**全部**命中；否则只取最左一个；
 * - `**`：匹配任意层（含 0 层）。写法上它自己占一段，例如「`**` 后接 `/se`」表示任意层里的 se，
 *   「`a` 后接 `/**`」表示 a 以下的任意层，中间夹一层也可以（`a` 后接 `/**` 再接 `/se`）。
 *   ⚠️ 文档里不能直接写连在一起的星号加斜杠：那会提前结束块注释（本项目曾出现过一次）。
 */
function matchSpansOnce(parts: string[], plan: PatternPlan): number[][] {
  // 纯偏移只在「没有段」时生效：带段的模式要走下面的匹配（`+3` 可能真的是目录名）
  if (plan.pureOffset && plan.specs.length === 0) {
    const { sign, count } = plan.pureOffset;
    // `+N` 从根数（1 = 最左一段）；`-N` 从文件名往上数（1 = 文件所在目录）
    const index = sign === '+' ? count - 1 : parts.length - 2 - (count - 1);
    return index >= 0 && index < parts.length ? [[index]] : [];
  }
  const specs = plan.specs;
  if (specs.length === 0 || parts.length === 0) {
    return [];
  }
  const spans: number[][] = [];
  const seen = new Set<string>();
  const record = (first: number, last: number): void => {
    if (last < 0) {
      return; // 整条模式只由 `**` 组成：没有可锚定的段
    }
    const anchor = last + plan.offset;
    if (anchor < 0 || anchor >= parts.length) {
      return;
    }
    const start = first + plan.offset;
    if (plan.keep && start < 0) {
      return;
    }
    const span: number[] = [];
    if (plan.keep) {
      for (let index = start; index <= anchor; index += 1) {
        span.push(index);
      }
    } else {
      span.push(anchor);
    }
    const key = span.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      spans.push(span);
    }
  };
  const walk = (specIndex: number, pathIndex: number, first: number, last: number): void => {
    if (!plan.all && spans.length > 0) {
      return; // 只要最左一个：第一个命中就收工
    }
    if (specIndex === specs.length) {
      record(first, last);
      return;
    }
    const spec = specs[specIndex];
    if (spec.kind === 'anyDepth') {
      // `**` 匹配 0..N 段：从当前位置起逐个试（含“一段都不吃”）
      for (let next = pathIndex; next <= parts.length; next += 1) {
        walk(specIndex + 1, next, first, last);
        if (!plan.all && spans.length > 0) {
          return;
        }
      }
      return;
    }
    if (pathIndex >= parts.length || !specMatches(spec, parts[pathIndex])) {
      return;
    }
    walk(specIndex + 1, pathIndex + 1, first < 0 ? pathIndex : first, pathIndex);
  };
  const starts = plan.fromRoot ? [0] : parts.map((_part, index) => index);
  for (const start of starts) {
    walk(0, start, -1, -1);
    if (!plan.all && spans.length > 0) {
      break;
    }
  }
  return spans;
}

/**
 * 匹配一条模式：**先按整段名字试**，整段命中不了才退回「名字 ± N」那一种解释。
 *
 * 这条顺序是 0.22 的既有规则（`lib-2` 这类真实目录名不能被当成「mods 减 1」），
 * 统一匹配器时必须显式保留 —— 解析阶段无法判断该用哪种解释，只有匹配结果能。
 */
function matchSpans(parts: string[], plan: PatternPlan): number[][] {
  const primary = matchSpansOnce(parts, plan);
  if (primary.length > 0) {
    return primary;
  }
  if (plan.offsetCandidate) {
    const retry = matchSpansOnce(parts, {
      ...plan,
      specs: plan.offsetCandidate.specs,
      offset: plan.offsetCandidate.offset,
      offsetCandidate: undefined,
    });
    if (retry.length > 0) {
      return retry;
    }
  }
  if (plan.pureOffset) {
    // 最后才把 `+N` / `-N` 当偏移：真的存在同名目录时上面已经命中了
    return matchSpansOnce(parts, { ...plan, specs: [], offset: 0, offsetCandidate: undefined });
  }
  return primary;
}

/** 该路径是否被**任一排除模式**（`!...`）命中；命中则整条路径不出任何锚点/标签。 */
function isPathExcluded(parts: string[], plans: readonly PatternPlan[]): boolean {
  return plans.some(
    (plan) => plan.exclude && matchSpans(parts, { ...plan, all: true, keep: false }).length > 0
  );
}

/**
 * 逐条模式给出命中区间（标签链路用：**一条模式可能出多个标签**，所以不能把各模式合并）。
 *
 * @param keepEnabled 路径那行传 `false`：`keep:` 在那里不生效（区间被拍平成单段），
 *   因为路径那行本来就靠列举相邻锚点显示多段（`LIB` + `LIB+1`），否则同一写法在两条链路里
 *   语义就不同了 —— 这条有断言钉住。
 */
function planAnchorPatterns(
  parts: string[],
  patterns: readonly string[],
  keepEnabled = true,
  collectAll = false
): { groups: Array<{ raw: string; all: boolean; spans: number[][] }>; invalid: string[]; excluded: boolean } {
  const invalid: string[] = [];
  const plans: PatternPlan[] = [];
  for (const pattern of patterns) {
    const text = String(pattern ?? '').trim();
    if (text.length === 0) {
      continue;
    }
    const plan = parsePattern(text);
    if (!plan || plan.specs.some((spec) => spec.kind === 'invalid')) {
      invalid.push(text);
      continue;
    }
    plans.push(plan);
  }
  // 排除优先：任一排除模式命中，这条路径就整体作废
  if (isPathExcluded(parts, plans)) {
    return { groups: [], invalid, excluded: true };
  }
  const groups: Array<{ raw: string; all: boolean; spans: number[][] }> = [];
  for (const plan of plans) {
    if (plan.exclude) {
      continue;
    }
    // 与宿主同规则：`collectAll` 只在标签链路用（路径那行不传，保持「只保留最左一个」）
    const spans = matchSpans(parts, {
      ...plan,
      // 与宿主同规则：`keepEnabled` 表示「尊重计划里的 keep」，不是强制 keep
      keep: keepEnabled ? plan.keep : false,
      all: collectAll ? true : plan.all,
    });
    if (spans.length === 0) {
      // 命中不了的模式要出声（`!` 排除型不算：排除本来就可能不命中）
      invalid.push(plan.raw);
      continue;
    }
    groups.push({ raw: plan.raw, all: plan.all, spans });
  }
  return { groups, invalid, excluded: false };
}

/** 整串是否被一对引号包住（引号内允许有分隔符，表示一条**字面量路径**）。 */
function isWhollyQuoted(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

/** 把 `"aa/se"` 展开成 `"aa"/"se"`：每一段各自按**字面量**匹配。 */
function quoteEachSegment(text: string): string {
  return text
    .trim()
    .slice(1, -1)
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0)
    .map((segment) => `"${segment}"`)
    .join('/');
}

/**
 * 把锚点模式解析成段下标（与宿主 `graphLayout.ts` 的 `resolveAnchorIndexes` **逐字同规则**）。
 *
 * 路径那行只认单段锚点，因此这里同样关掉 `keep:` 的整段保留；`!` 排除模式在这里也生效
 * （命中则整条路径不出锚点，与宿主一致）。
 */
function resolveAnchorIndexes(parts: string[], patterns: readonly string[]): Set<number> {
  const { groups } = planAnchorPatterns(parts, patterns, false);
  const indexes = new Set<number>();
  for (const group of groups) {
    for (const span of group.spans) {
      for (const index of span) {
        indexes.add(index);
      }
    }
  }
  return indexes;
}

/** 末尾窗口按**字符预算**能放下几段（`tailLevels = 0` 的口径，与宿主同规则）。 */
function budgetTailCount(parts: string[], max: number): number {
  const whole = parts.join('/');
  if (whole.length <= max) {
    return parts.length;
  }
  let count = 1;
  let result = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const candidate = `${parts[i]}/${result}`;
    if (candidate.length + 1 > max) {
      break;
    }
    result = candidate;
    count += 1;
  }
  return count;
}

/** 把「末尾窗口 + 锚点段」拼成显示串：被跳过的连续段压缩成一个 `…`（与宿主同规则）。 */
function assemblePath(parts: string[], anchors: Set<number>, tailCount: number): string {
  const keep = new Set<number>();
  for (let i = Math.max(0, parts.length - tailCount); i < parts.length; i += 1) {
    keep.add(i);
  }
  for (const index of anchors) {
    if (index >= 0 && index < parts.length) {
      keep.add(index);
    }
  }
  if (keep.size === parts.length) {
    return parts.join('/');
  }
  const out: string[] = [];
  let skipped = false;
  for (const [index, part] of parts.entries()) {
    if (keep.has(index)) {
      if (skipped) {
        out.push('…');
        skipped = false;
      }
      out.push(part);
    } else {
      skipped = true;
    }
  }
  if (skipped) {
    out.push('…');
  }
  return out.join('/');
}

// ------------------------------------------------------------ 滚动 / 拖框

const pointer = {
  /** 按在展开按钮上时记录目标，由 window mouseup 统一处理。 */
  expandTarget: undefined as
    | { sessionId: string; nodeId: string; mode: ExpanderMode }
    | undefined,
};

// 方框不再支持拖动：位置完全由宿主算好的布局决定，平移交给滚动条。

// 空白处不再做平移：平移交给浏览器的滚动条（滚轮上下滚、Shift+滚轮左右滚）。

// 面板尺寸变化（首次展开、拖动分隔条、切标签）时重算 viewBox，否则会用到旧的画布宽度渲染错位。
if (typeof ResizeObserver !== 'undefined') {
  const observer = new ResizeObserver(() => {
    if (canvasEl.clientWidth <= 8) {
      return;
    }
    if (activeSession()) {
      render();
    }
  });
  observer.observe(canvasEl);
}

window.addEventListener('mouseup', () => {
  if (pointer.expandTarget) {
    const { sessionId, nodeId, mode } = pointer.expandTarget;
    pointer.expandTarget = undefined;
    if (mode === 'collapse') {
      // 点加减号时把「亮粉色框」留在这一格（用户要求：折叠时能看清操作的是谁）。
      // 只记状态，不动选中（白框）与悬停语义。
      rememberExpanderTarget(sessionId, nodeId);
      collapsedSet(sessionId).add(nodeId);
      // 相机：让被收起的那一级在屏幕上**原地不动**（内容消失但视线不丢），
      // 位移用平滑滚动，眼睛能跟上；坐标要等宿主的重排结果，所以收到 sessionUpdate 再执行。
      startCameraIntent('collapse', sessionId, nodeId);
      // 收起状态变了：让宿主按「收起的子树不占高度」重算一次坐标
      postCollapsed(sessionId);
      render();
    } else {
      const session = state.sessions.get(sessionId);
      const node = session?.nodes[nodeId];
      if (session && node && !state.loading.has(loadingKey(sessionId, nodeId))) {
        // ⚠️ **先把「已收起」标记清掉**，无论这次是要直接展开还是要新建语言服务请求。
        // 曾经的写法只在「数据已加载」那条分支里清标记，于是：收起全部（会把根标成收起）→ 点第一级 `+`
        // 发出请求、拿到数据，但节点仍被当成收起 → 新一级不显示，用户必须再点一次才亮
        // （用户 2026-10-15 实测「折叠按钮点击后，再点第一级展开要点两遍」）。
        // 标记必须**随展开请求一起**同步给宿主：它按这个集合决定哪些子树不占高度，
        // 晚一步同步的话，新一级会拿不到坐标（就是历史上「只展开到第二级」那类现象）。
        if (collapsedSet(sessionId).delete(nodeId)) {
          postCollapsed(sessionId);
        }
        if (node.loaded) {
          // 数据已有，只是被收起过：直接展开，不需要再问语言服务
          startCameraIntent('expand', sessionId, nodeId);
          render();
          applyCameraIntent(session);
        } else {
          state.loading.add(loadingKey(sessionId, nodeId));
          // 超时兜底：宿主在「会话已关闭」等异常路径下**不会回任何消息**
          // （graphView.expandNode 找不到会话时直接 return），那样 loading 永远不会被清除，
          // 遮罩会一直亮着且此后无人关闭它。超时后自行清除并重绘。
          setTimeout(() => {
            if (state.loading.delete(loadingKey(sessionId, nodeId))) {
              render();
            }
          }, LOADING_TIMEOUT_MS);
          // 以被点的方框为基准，展开后它不要在屏幕上跳动。
          // （粘性父框开着时，紧接着这一帧会把它钉到视口中央 —— 以那条不变式为准；
          //   关掉设置或内容本来就不高时，才由这里保住它的屏幕位置。）
          // 新一级回来后由相机动作把它露出来（见 applyCameraIntent）。
          rememberExpanderTarget(sessionId, nodeId);
          startCameraIntent('expand', sessionId, nodeId);
          anchorOn(session, nodeId);
          post({ type: 'expand', sessionId, nodeId });
          render();
        }
      }
    }
  }
});

// 滚轮完全交给浏览器原生行为：上下平滑滚动；Shift+滚轮左右滚动。
// **缩放功能已按需求移除**（原来的 Ctrl+滚轮缩放），所以这里不再拦截 wheel 事件。
// 关闭标签用标签上的 ✕；展开用方框上的 + / −。

// ------------------------------------------------------------ 方框右键菜单

const boxMenuEl = document.getElementById('box-menu') as HTMLDivElement;

/** 菜单当前指向的节点（null 表示菜单已关闭）。 */
let boxMenuTarget: { sessionId: string; nodeId: string } | undefined;

/**
 * 在鼠标位置弹出方框菜单。
 *
 * 用 `position: fixed` + 视口坐标，所以直接吃 `clientX/clientY`；
 * 弹出后做一次边界收边，避免贴到右下角时被裁掉。
 */
function openBoxMenu(clientX: number, clientY: number, sessionId: string, nodeId: string): void {
  boxMenuTarget = { sessionId, nodeId };
  boxMenuEl.hidden = false;
  // 先显示再量尺寸，否则 offsetWidth 是 0
  const width = boxMenuEl.offsetWidth || 150;
  const height = boxMenuEl.offsetHeight || 70;
  const left = Math.min(clientX, Math.max(0, window.innerWidth - width - 4));
  const top = Math.min(clientY, Math.max(0, window.innerHeight - height - 4));
  boxMenuEl.style.left = `${Math.max(0, left)}px`;
  boxMenuEl.style.top = `${Math.max(0, top)}px`;
}

function closeBoxMenu(): void {
  if (boxMenuEl.hidden) {
    return;
  }
  boxMenuEl.hidden = true;
  boxMenuTarget = undefined;
}

/**
 * 从事件目标往上找带指定 `data-*` 属性的元素，返回它的值。
 *
 * 不用 `closest()`：它属于 Element 接口，测试桩与部分环境不一定提供，
 * 自己走 parentNode 更稳，逻辑也只有几行。
 */
function findMenuAttribute(target: EventTarget | null, name: string): string | undefined {
  let node = target as (HTMLElement & { parentNode?: Node | null }) | null;
  const guard = new Set<unknown>();
  while (node && !guard.has(node)) {
    guard.add(node);
    const value = (node as HTMLElement).getAttribute?.(name);
    if (value) {
      return value;
    }
    node = (node.parentNode as typeof node) ?? null;
  }
  return undefined;
}

/** 方框菜单项的动作（`data-action`）。 */
function findMenuAction(target: EventTarget | null): string | undefined {
  return findMenuAttribute(target, 'data-action');
}

boxMenuEl.addEventListener('click', (event) => {
  const action = findMenuAction(event.target);
  const target = boxMenuTarget;
  closeBoxMenu();
  if (!action || !target) {
    return;
  }
  post({
    type: action === 'copyElement' ? 'copyNodeName' : 'copyNodeLocation',
    sessionId: target.sessionId,
    nodeId: target.nodeId,
  });
});

// 点其它地方、滚动、按 Esc 都关掉菜单
window.addEventListener('mousedown', (event) => {
  if (!boxMenuEl.hidden && !boxMenuEl.contains(event.target as Node)) {
    closeBoxMenu();
  }
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeBoxMenu();
  }
});
canvasEl.addEventListener('scroll', closeBoxMenu, { passive: true });
// 纵向滚动时把「已展开下一层」的方框钉在视口垂直中央（只改位置与相关连线，见「粘性父框」一节）。
// 用 scheduleStickyFrame 合并：滚动事件密度远高于帧率，逐个处理等于重复计算数十次。
canvasEl.addEventListener('scroll', scheduleStickyFrame, { passive: true });

// ------------------------------------------------------------ 工具栏

/**
 * 收起全部：画面上只剩根方框。
 *
 * 关键点：**必须把根自身标记为收起**。
 * `visibleNodes()` 是从根往下遍历、遇到「已收起的节点」就停止下探的；
 * 若只把子节点标为收起，遍历仍会走到它们并把它们画出来（子节点是叶子，
 * 它们的收起状态不影响父级的遍历）。把**根**标为收起，遍历才会在根处停下，
 * 结果正好是「只剩根方框」。
 *
 * 同时清掉其它节点的收起标记：它们已经因为根被收起而不可见，
 * 留着标记会让下次展开时出现莫名其妙的缺口。
 */
function collapseAll(): void {
  const session = activeSession();
  if (!session) {
    return;
  }
  const collapsed = collapsedSet(session.id);
  collapsed.clear();
  collapsed.add(session.rootId);
  // ⚠️ 必须把新的收起状态告诉宿主：坐标是宿主算的（它按这个集合决定哪些子树不占高度）。
  //    漏掉这一步，宿主手里那份集合就一直是旧的 —— 之后任何一次重排（展开全部、
  //    改设置触发 relayout）都会继续把那些子树排除在布局之外，画面上表现为
  //    「只展开到第二级、第二级的加号点不开」（节点没有坐标 → 整棵被跳过）。
  postCollapsed(session.id);
  // 「收起全部」= 完全复位（用户 2026-10-14 口径）：请宿主把**已加载的展开状态**丢掉
  // （只留根，根标回未加载），这样之后点「展开全部」是重新读取，而不是把旧形状搬回来。
  // 本地也要清掉按会话记的「正在展开」标记：那些节点马上就不存在了。
  clearSessionLoading(session.id);
  post({ type: 'resetExpansion', sessionId: session.id });
  render();
}

// ------------------------------------------------------------ 粘性父框（可设置）

/**
 * 纵向滚动时把**所有「已经展开了下一层」的方框**都钉在视口垂直中央当参照：
 * 画面中间因此是一条「父框带」，各层的子方框从它旁边滑过；与被钉住的方框相连的箭头
 * 每帧重画，保证箭头不脱节。
 *
 * 为什么是「所有展开了下一层的」而不是「最后展开的那一个」：同一层里可以展开好几个
 * （隔几个同级标签各展开一个），它们都该留在中间当参照 —— 只钉最后那个，
 * 先展开的就会跟着内容滚走。
 *
 * 三条必须的约束（都有断言兜着，**别删**）：
 *   ① **不能压到同列的邻居** —— 每个方框只能在它自己的「空挡」里上下滑（见 `stickySubtreeSlot()`），
 *      空挡边缘离相邻方框正好是正常行距 ROW_GAP；这一条也顺带把方框留在了 viewBox 内
 *      （跑出 viewBox 会被裁掉，看不见）。
 *   ② **同一列里多个方框都想居中时，彼此不会重叠**：各自的「空挡」互不相交
 *      （子树区域在布局里本来就是分开的），所以不需要额外的按列收敛逻辑
 *      —— 曾经有一个 `enforceColumnSpacing()`，在改成「空挡 = 整棵子树那一段」后已删除。
 *      第一级只有根一个方框、独占一列，所以它可以完全自由地居中。
 *   ③ **内容还没视口高时不做** —— 那会儿没什么可滚的，硬居中反而会把方框推出内容外。
 *
 * 开关是 `cppCallGraph.stickyParent`（宿主读配置后随消息下发，见 `settingsPayload()`）。
 */
/** 这一帧要钉住的方框（所有展开了下一层、且当前可见的方框）。 */
let stickyPinned: string[] = [];
/** 每个可见方框这一帧的位移（内容坐标的额外下移量；不在表里就是 0）。 */
let stickyShifts = new Map<string, number>();
/** 会被粘性位移影响的可见连线：位移一变就得重画它们。 */
let stickyEdges: Array<{ path: SVGPathElement; from: string; to: string }> = [];

/**
 * 某个节点这一帧**显示**的粘性位移（没被钉住就是 0）。
 *
 * ⚠️ 返回的是 `displayedShifts` 而不是 `stickyShifts`（目标值）：方框的 transform 与连线的
 * 锚点都读这个函数，所以插值动画只需要在这里反映出来，其余渲染路径一行都不用改。
 */
function stickyShiftOf(nodeId: string): number {
  // ⚠️ 动画**不在跑时一律用目标位移**（0.21.0 的语义）。0.22 早先无条件读 `displayedShifts`，
  // 于是只要有一条路径没更新那张表（滚动帧走「动画中」分支、布局帧提前返回、冻结窗口等），
  // 位置就停在旧值上 —— 用户实测的「展开多级后滑不到与下一级平齐」正是这个：
  // **0.21.0 可以，0.22 不行**，说明是我加的这层间接造成的，而不是布局/空挡的限制。
  if (animFrame !== undefined || animFrom !== undefined) {
    return displayedShifts.get(nodeId) ?? 0;
  }
  return stickyShifts.get(nodeId) ?? 0;
}

/**
 * 这一帧要钉住谁：**所有「已经展开了下一层」的可见方框**。
 *
 * 「展开了下一层」= 至少有一个子节点当前可见（被收起的不算、没加载过的不算）。
 * 于是根、以及每一层里展开过的父框都在内；叶子（没有下一层可看）不在内 ——
 * 它们没有什么可当参照的，钉住也没有意义。
 */
function stickyPinnedIds(session: SessionPayload): string[] {
  const pinned: string[] = [];
  for (const [id, node] of Object.entries(session.nodes)) {
    if (!session.boxes[id] || !isVisible(session, id)) {
      continue;
    }
    if (node.children.some((child) => isVisible(session, child))) {
      pinned.push(id);
    }
  }
  return pinned;
}

/** 当前是否该启用粘性父框（设置开着 **且** 内容确实比视口高）。 */
function stickyEnabled(session: SessionPayload | undefined): boolean {
  if (!session || !state.stickyParent) {
    return false;
  }
  const viewportHeight = Number(canvasEl.clientHeight) || 0;
  return viewportHeight > 0 && contentBounds(session).height > viewportHeight;
}

/**
 * 被钉住方框的「空挡」= **它整棵子树在布局里占的那一段**（用户 2026-10-10 定的规则）。
 *
 * 递归定义：有可见子框时 = 第一个子框的空挡上沿 ~ 最后一个子框的空挡下沿
 * （子框的空挡在布局里是首尾相接的）；自己就是叶子（没有可见子框）时 = 自己那一段。
 *
 * 于是父框可以**平行着子框、以及子框再展开出来的更深层**上下滑 ——
 * 用户原话：「第三级的子集也有好几个时，第二级的空挡也要增加到覆盖第三级展开出来的情况」，
 * 否则第二级无法与已展开的第三级保持平齐。
 *
 * 为什么这样最安全：各家的子树区域在布局里本来就是分开的，父框滑不出自己的子树，
 * 就永远撞不到同列的兄弟方框。
 */
function stickySubtreeSlot(
  session: SessionPayload,
  nodeId: string,
  cache: Map<string, { top: number; bottom: number }>,
  visiting?: Set<string>
): { top: number; bottom: number } | undefined {
  const cached = cache.get(nodeId);
  if (cached) {
    return cached;
  }
  const node = session.nodes[nodeId];
  const box = session.boxes[nodeId];
  if (!node || !box || !isVisible(session, nodeId)) {
    return undefined;
  }
  const own = {
    top: box.y,
    bottom: box.y + (box.height || defaultBoxHeight()),
  };
  // 图里可能有环：正在展开的链上再遇到自己就退回「只有自己这一段」
  const path = visiting ?? new Set<string>();
  if (path.has(nodeId)) {
    return own;
  }
  path.add(nodeId);
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const child of node.children) {
    if (!session.boxes[child] || !isVisible(session, child)) {
      continue;
    }
    const childSlot = stickySubtreeSlot(session, child, cache, path);
    if (!childSlot) {
      continue;
    }
    top = Math.min(top, childSlot.top);
    bottom = Math.max(bottom, childSlot.bottom);
  }
  path.delete(nodeId);
  const slot = Number.isFinite(top) ? { top, bottom } : own;
  cache.set(nodeId, slot);
  return slot;
}

/**
 * 算出这一帧每个被钉住方框的位移。
 *
 * 规则（用户 2026-10-10 定）：把它中心对到视口垂直中央，但**只能在自己的空挡里滑**
 * —— 空挡 = 它整棵子树在布局里占的那一段（见 `stickySubtreeSlot()`，跟着子框展开的部分一起长）：
 * 空挡内保持居中，碰到上下界就停住。第一级独占一列、子树铺满内容，所以它可以完全自由居中。
 *
 * 屏幕 y 与内容 y 的关系是 `screenY = svgRect.top + (contentY − view.y)`（1 单位 = 1 像素），
 * 直接读两个 rect 反解即可，不必自己维护滚动量 —— 也就不会累积漂移。
 */
function computeStickyShifts(session: SessionPayload): Map<string, number> {
  const shifts = new Map<string, number>();
  const view = readView(session);
  const canvasRect = canvasEl.getBoundingClientRect();
  const svgRect = svgEl.getBoundingClientRect();
  const wantedScreenCenter = canvasRect.top + canvasEl.clientHeight / 2;
  const bounds = contentBounds(session);
  const slotCache = new Map<string, { top: number; bottom: number }>();
  for (const id of stickyPinned) {
    const box = session.boxes[id];
    const slot = stickySubtreeSlot(session, id, slotCache);
    if (!box || !slot) {
      continue;
    }
    const height = box.height || defaultBoxHeight();
    const wantedTop = wantedScreenCenter - svgRect.top + view.y - height / 2;
    // 空挡内可滑的 top 范围；再夹进内容边界（跑出 viewBox 会被裁掉）
    const minTop = Math.max(bounds.y, slot.top);
    const maxTop = Math.min(
      bounds.y + bounds.height - height,
      Math.max(minTop, slot.bottom - height)
    );
    shifts.set(id, Math.min(maxTop, Math.max(minTop, wantedTop)) - box.y);
  }
  return shifts;
}

/** 重算这一帧「钉住哪些方框、各自移多少」。渲染前与滚动时都走这里。 */
/**
 * 展开/收起后「冻结粘性位移」的时长。
 *
 * 用户 2026-10-14 定的硬约束：**同一次操作只允许一个机制动视口**。回弹的根因就是
 * 粘性用 transform 把内容往下推、相机又用滚动往上拉，两股运动方向相反。
 * 所以操作后这段时间内粘性位移视为 0，只由滚动把「链的跨度」居中；之后粘性再按新滚动位置接管。
 */
const CAMERA_FREEZE_MS = 400;
let stickyFrozenUntil = 0;

function refreshSticky(session: SessionPayload): void {
  stickyPinned = stickyPinnedIds(session);
  const frozen = Date.now() < stickyFrozenUntil;
  stickyShifts =
    !frozen && stickyEnabled(session) ? computeStickyShifts(session) : new Map<string, number>();
  // ⚠️ 目标一变就**同步给正在跑的动画**：否则动画继续朝启动时的**过期目标**收敛，误差正好是
  // 「Δ视口高度 / 2」—— 用户实测的「窗口拉得越扁越能对上」就是这条（2026-10-14）。
  // 同步后：目标每变一次，动画下一帧就朝新目标走；结束那一帧落成目标值，因此静止时与 0.21.0 一致。
  if (animFrom !== undefined) {
    animTarget = new Map(
      Object.entries(session.boxes).map(([id, box]) => [id, box.y + (stickyShifts.get(id) ?? 0)])
    );
  }
}

/**
 * 某条连线一侧锚点的中心 y：加上该端方框（及其所属块）的粘性位移。
 */
function anchorCenterY(nodeId: string, top: number, height: number): number {
  return top + stickyShiftOf(nodeId) + height / 2;
}

/**
 * 一条连线的折线路径。
 *
 * 渲染时用它画、滚动时用它重画 —— 同一份几何，避免两处算法各写一次后漂移。
 */
function edgeGeometry(
  session: SessionPayload,
  edge: { from: string; to: string }
): { d: string; backward: boolean } | undefined {
  const fromBox = boxOf(session, edge.from);
  const toBox = boxOf(session, edge.to);
  if (!fromBox || !toBox) {
    return undefined;
  }
  const fromWidth = session.boxes[edge.from]?.width ?? DEFAULT_BOX_WIDTH;
  const toWidth = session.boxes[edge.to]?.width ?? DEFAULT_BOX_WIDTH;
  const fromHeight = session.boxes[edge.from]?.height ?? defaultBoxHeight();
  const toHeight = session.boxes[edge.to]?.height ?? defaultBoxHeight();
  const backward = fromBox.x > toBox.x;
  const fromAnchor = {
    x: backward ? fromBox.x : fromBox.x + fromWidth,
    y: anchorCenterY(edge.from, fromBox.y, fromHeight),
  };
  const toAnchor = {
    x: backward ? toBox.x + toWidth : toBox.x,
    y: anchorCenterY(edge.to, toBox.y, toHeight),
  };
  // 出/入方框各画一小段直奔线（直角拐弯）。14px 是视觉调出来的：过小会被方框边框遮挡。
  const stub = 14;
  const startX = fromAnchor.x + (backward ? -stub : stub);
  const endX = toAnchor.x + (backward ? stub : -stub);
  return {
    backward,
    d:
      `M ${fromAnchor.x} ${fromAnchor.y} ` +
      `L ${startX} ${fromAnchor.y} ` +
      `L ${startX} ${toAnchor.y} ` +
      `L ${endX} ${toAnchor.y} ` +
      `L ${toAnchor.x} ${toAnchor.y}`,
  };
}

/** 滚动帧是否已排队（用 rAF 合并：一次滚动事件风暴只做一帧的工作）。 */
let stickyFrameQueued = false;

/**
 * 滚动事件的入口：用 `requestAnimationFrame` 合并。
 *
 * 滚轮/触控板一次滑动会连发几十个 scroll 事件，直接逐个跑完整帧 = 几十次强制布局 +
 * 几十轮 DOM 写入。合并成「一帧一次」后开销与帧率绑定，与事件密度无关。
 */
function scheduleStickyFrame(): void {
  if (stickyFrameQueued) {
    return;
  }
  stickyFrameQueued = true;
  requestAnimationFrame(() => {
    stickyFrameQueued = false;
    applyStickyFrame();
  });
}

/**
 * 最近点过加减号的方框（用户 2026-10-14 要求）：**亮粉色框留在这一格**，便于折叠时确认操作的是谁。
 *
 * 与已有两种状态刻意区分、互不干扰：
 *   - 悬停（`.node:hover .box`）是瞬时的，鼠标移开就没了；
 *   - 选中（`selected`，亮白框）只由「单击方框」或「空格」改变。
 * 这里只记住「最后操作的那一格」，点别的加减号即转移，不触碰选中状态。
 */
let lastExpanderTarget: { sessionId: string; nodeId: string } | undefined;

function rememberExpanderTarget(sessionId: string, nodeId: string): void {
  lastExpanderTarget = { sessionId, nodeId };
}

/** 该方框是否是「最后点过加减号」的那一格（仅对当前会话有效）。 */
function isExpanderTarget(sessionId: string, nodeId: string): boolean {
  return lastExpanderTarget?.sessionId === sessionId && lastExpanderTarget.nodeId === nodeId;
}

/** 上一次写进 transform 的字符串：没变就不写 DOM（写 attribute 会触发重新布局）。 */
const lastStickyTransform = new WeakMap<Element, string>();
/** 上一次写进连线 `d` 的字符串：逐帧动画里绝大多数连线没变，白写会重算整条路径。 */
const lastStickyPath = new WeakMap<SVGPathElement, string>();

// ------------------------------------------------------------ 粘性位移的逐帧插值（C2）

/**
 * 为什么需要插值：粘性把「已展开下一层的父框」钉在视口中央，而展开一级会让它的子链变高 →
 * 居中位移量随之改变 → 整行连同后面的内容**瞬间平移**。连开多级就是连续跳，很伤眼睛
 * （用户实测反馈）。这里把位移在 ~180ms 内插值过去，连线用同一个插值后的位移重算 `d`，
 * 所以方框与连线是一起动的 —— 只动方框会变成「框在动、线在跳」，比不动更糟。
 *
 * 实现要点：`stickyShiftOf()` 是**唯一**的显示位移来源（方框 transform 与连线锚点都读它），
 * 所以只要让它返回插值中的值，其余代码一行都不用改。
 */
const ANIM_DURATION_MS = 180;
/**
 * 超过这么多可见方框就**不插值**（直接落位）。
 *
 * 逐帧重画要改每个方框的 transform 与每条连线的 `d`，成本随可见方框数线性增长；大图上
 * 掉帧比瞬移更难受。250 是「开到最大档位仍远低于每帧 4ms 预算」的经验值，
 * 实测口径见 renderCheck 的逐帧计时探针。
 */
const ANIM_GATE_NODES = 250;
/** 位移插值的可见方框数闸门（见 ANIM_GATE_NODES）；导出便于断言与自查。 */
export const ANIM_GATE_NOTE = '位移插值：可见方框 ≤ 250 时按 180ms 插值，超过则直接落位';

/** 当前**显示**的位移（DOM 里就是这个值；动画在跑时它落在起点与目标之间）。 */
let displayedShifts = new Map<string, number>();
/**
 * 每个节点**上一帧真正画出来的总绘制 y**（`box.y + 当时的位移`）。
 *
 * ⚠️ 这是 C2 重做的关键：用户看到的「整行平移」主要来自布局自身的 `box.y` 重排，
 * 而不是粘性位移（第三轮探针实测：粘性位移为 0 时位置仍变了 220px）。
 * 所以插值对象必须是这个**总绘制 y**，而不是位移本身。
 */
let lastPaintedTotal = new Map<string, number>();
/** 动画起点快照；`undefined` 表示没有动画在跑。 */
let animFrom: Map<string, number> | undefined;
/** 动画目标位移。 */
let animTarget: Map<string, number> | undefined;
let animStart = 0;
let animFrame: number | undefined;

/** 缓动：三次方缓出（起始快、收尾稳，位移大时观感更像「滑过去」而不是「弹过去」）。 */
function easeOutCubic(progress: number): number {
  const t = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

/** 插值本身是**纯函数**：测试直接断言它（测试桩没有时间轴，动画时序无法断言）。 */
function lerpShift(from: number, to: number, progress: number): number {
  return from + (to - from) * easeOutCubic(progress);
}

function stopStickyAnimation(): void {
  if (animFrame !== undefined) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(animFrame);
    }
    animFrame = undefined;
  }
  animFrom = undefined;
  animTarget = undefined;
}

/** 直接落到目标位移（滚动路径与「不该动画」的场合走这里）。 */
function snapStickyShifts(): void {
  stopStickyAnimation();
  displayedShifts = new Map(stickyShifts);
}

/** 上一次做过布局动画的会话 id：换会话（首次渲染、切标签）时不该有入场动画。 */
let animatedSessionId: string | undefined;
/** 上一帧的几何签名（见 `geometrySignature`）。 */
let lastGeometrySignature = '';

/**
 * 这一帧的几何签名：会话 id + 每个方框的 y 与高度（宽度也会影响排列，所以一并算进来）。
 *
 * 只比较几何、不比较设置：改设置（打开/关闭粘性或路径显示）造成的重绘不该有位移过渡。
 */
function geometrySignature(session: SessionPayload): string {
  const parts: string[] = [];
  for (const [id, box] of Object.entries(session.boxes)) {
    parts.push(`${id}:${Math.round(box.y)}:${Math.round(box.height)}:${Math.round(box.width)}`);
  }
  return `${session.id}|${parts.join(',')}`;
}

/**
 * 布局路径的入口（`render()` 在算完目标位移后调用）。
 *
 * - 首次渲染这个会话 / 不能动画 / 没有位移差 → 直接落位；
 * - 否则从**当前显示值**插值到新目标，由 `stickyAnimationTick()` 逐帧重画方框与连线。
 */
function beginLayoutStickyAnimation(session: SessionPayload): void {
  if (animatedSessionId !== session.id) {
    animatedSessionId = session.id;
    snapStickyShifts();
    lastPaintedTotal = new Map();
    return;
  }
  beginOrContinueStickyAnimation(session);
}
/** 动画一帧：把显示位移推向目标，重画方框与连线；到点后收尾并停止。 */
function stickyAnimationTick(): void {
  animFrame = undefined;
  const session = activeSession();
  if (!session || !animFrom || !animTarget) {
    stopStickyAnimation();
    return;
  }
  const progress = (Date.now() - animStart) / ANIM_DURATION_MS;
  const next = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const [id, target] of animTarget) {
    const start = animFrom.get(id) ?? target;
    const total = progress >= 1 ? target : lerpShift(start, target, progress);
    totals.set(id, total);
    const box = session.boxes[id];
    // 存回「加在 box.y 上的偏移」：这样 paintStickyFrame 与 edgeGeometry 一行都不用改，
    // 连线读的正是同一个偏移，所以方框与连线必然同帧同步。
    next.set(id, box ? total - box.y : 0);
  }
  displayedShifts = next;
  lastPaintedTotal = totals;
  if (progress >= 1) {
    displayedShifts = new Map(stickyShifts);
    stopStickyAnimation();
  }
  paintStickyFrame(session);
  if (progress < 1) {
    scheduleStickyAnimationFrame();
  }
}

function scheduleStickyAnimationFrame(): void {
  if (animFrame !== undefined || typeof requestAnimationFrame !== 'function') {
    return;
  }
  animFrame = requestAnimationFrame(stickyAnimationTick);
}

/**
 * 决定这一帧的显示位移从哪来：能插值且有位移差就起动画，否则直接落到目标。
 *
 * ⚠️ 必须能「中途换目标」：展开会连着来两帧（估算宽度一帧、实测宽度一帧），
 * 若第二帧无视正在跑的动画直接落位，用户看到的还是跳。这里以**当前显示值**为新起点重起，
 * 位移方向一致，观感连续。
 */
function beginOrContinueStickyAnimation(session: SessionPayload): void {
  const targets = stickyShifts;
  const canAnimate =
    typeof requestAnimationFrame === 'function' && nodesEl.children.length <= ANIM_GATE_NODES;
  // ⚠️ 插值对象是**总绘制 y**（新的 box.y + 新位移），起点是**上一帧真正画出来的**总绘制 y。
  // 用户看到的「整行平移」主要来自 box.y 的重排：实测过「粘性位移为 0 时位置仍变了 220px」，
  // 所以只插值位移是无效的（这正是 C2 前一版失败的原因）。
  const start = new Map<string, number>();
  const target = new Map<string, number>();
  let moved = false;
  for (const [id, box] of Object.entries(session.boxes)) {
    const targetTotal = box.y + (targets.get(id) ?? 0);
    const startTotal = lastPaintedTotal.get(id) ?? targetTotal;
    start.set(id, startTotal);
    target.set(id, targetTotal);
    if (Math.abs(targetTotal - startTotal) > 0.5) {
      moved = true;
    }
  }
  if (!canAnimate || !moved) {
    stopStickyAnimation();
    displayedShifts = new Map(targets);
    lastPaintedTotal = new Map(target);
    return;
  }
  animFrom = start;
  animTarget = target;
  // ⚠️ 首帧必须画在**起点**：位移是相对**新的** `box.y` 的，若沿用上一帧的偏移，
  // render() 会按「新 box.y + 旧偏移」立刻画在终点 —— 这正是 C2 前一版「看起来完全没插值」的原因
  // （诊断输出一直是 `send 后 = 终点`）。所以要用起点总量反算出偏移。
  const initial = new Map<string, number>();
  for (const [id, startTotal] of start) {
    const box = session.boxes[id];
    initial.set(id, box ? startTotal - box.y : 0);
  }
  displayedShifts = initial;
  animStart = Date.now();
  scheduleStickyAnimationFrame();
}

/**
 * 滚动时逐帧调用：只改「方框的位置」与「被钉住方框相关的连线」，不重建整棵树。
 * （重建要重新量所有方框宽度、重排连线，滚动时那样做会卡。）
 *
 * 两个早退：没开粘性、或这一帧没有任何「已展开下一层」的方框可钉 —— 此时各节点在
 * render() 里写下的 transform 已经是正确位置，重复计算没有任何收益。
 */
function applyStickyFrame(): void {
  if (!state.stickyParent || stickyPinned.length === 0) {
    // 没有可钉的方框：显示位移必须清零，否则「收起全部」/关掉粘性之后会残留旧位移
    stopStickyAnimation();
    if (displayedShifts.size > 0) {
      displayedShifts = new Map();
    }
    return;
  }
  const session = activeSession();
  if (!session) {
    return;
  }
  refreshSticky(session);
  // ⚠️ 布局动画正在跑时**不要落位**：展开会让相机平移视口，于是紧跟一串滚动帧；
  // 若滚动帧直接 snap，动画会被当场掐断 —— 真机上就等于没有插值（renderCheck 的用例抓到了这点）。
  // 但**必须加时间上限**：动画窗口之外仍有滚动帧走「动画中」分支的话，画的是一直不变的目标值，
  // 而滚动本身每帧都在更新目标 —— 两边互相争，用户看到的就是**居中方框高频抖动**
  // （2026-10-14 反馈）。所以超期就落位并清空动画状态，让滚动路径重新说了算。
  if (
    (animFrame !== undefined || animFrom !== undefined) &&
    Date.now() - animStart < ANIM_DURATION_MS + 100
  ) {
    paintStickyFrame(session);
    return;
  }
  stopStickyAnimation();
  // 滚动路径**立即落位、不插值**：滚动时位移目标是每帧连续变化的，插值会变成「橡皮筋」，
  // 手感反而更差（而且用户此刻的注意力在滚动上，不需要过渡）。插值只用于布局变化（展开/收起）。
  snapStickyShifts();
  paintStickyFrame(session);
}

/** 把当前显示位移写进 DOM：方框的 transform 与相关连线的 `d`（两处都读 stickyShiftOf）。 */
function paintStickyFrame(session: SessionPayload): void {
  // 每个可见方框都按自己的位移摆好（被钉住的父框在中央，叶子跟着自己的父框）
  for (const element of nodesEl.children) {
    const id = element.getAttribute?.('data-node');
    const box = id ? session.boxes[id] : undefined;
    if (!id || !box) {
      continue;
    }
    const total = box.y + stickyShiftOf(id);
    // 记下这一帧真正画出来的总绘制 y：下一次布局动画的起点即为此值
    lastPaintedTotal.set(id, total);
    const transform = `translate(${box.x} ${total})`;
    // 位移未变则不写 DOM：写 attribute 会让浏览器重新布局这一棵子树
    if (lastStickyTransform.get(element) !== transform) {
      lastStickyTransform.set(element, transform);
      element.setAttribute('transform', transform);
    }
  }
  for (const item of stickyEdges) {
    const geometry = edgeGeometry(session, item);
    if (geometry) {
      const d = geometry.d;
      // 连线同样「没变就不写」：逐帧动画会调用这里几十次，白写 d 会重算整条路径
      if (lastStickyPath.get(item.path) !== d) {
        lastStickyPath.set(item.path, d);
        item.path.setAttribute('d', d);
      }
    }
  }
}

// ------------------------------------------------------------ 搜索栏

/**
 * 按**元素名**搜索当前标签：命中方框黄色高亮，上下箭头在多个命中间跳。
 * 三个开关彼此独立：区分大小写 / 全字 / 正则。
 *
 * 设计取舍：
 *   ① 命中集合在 render() 里重算、类名也在那一帧写进节点分组 —— 与「单击选中」同一套路，
 *      状态只有一份，测试桩按 class 断言即可，不必再维护一套增量更新。
 *   ② 跳转只在**可见**命中之间循环：被收起子树里的命中是隐藏的、滚不过去，
 *      计数用「+N」把它们标出来，免得看起来像「没搜到」。
 *   ③ 输入即重绘（不做防抖）：与现有的展开/收起/切标签一致。命中高亮本来就是整帧重建的
 *      一部分；真遇到超大图卡顿，再考虑加防抖。
 */
const searchState = {
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  /**
   * 搜索范围是否还包含路径（用户 2026-10-15 要求，两个独立开关，就是搜索栏那两个按钮）：
   *   - `matchPath`：方框里那行路径的**显示文本**（`displayPathText` 的结果，
   *     随 `pathDisplay` / `pathTailLevels` 变化 —— 被省略掉的目录名搜不到）；
   *   - `matchFullPath`：**完整路径**（`node.file`，无论那行当前显示成什么样）。
   * 两个都关 = 只搜元素名（0.22 之前的行为）。
   *
   * ⚠️ 命中后的高亮仍然是「方框 + 元素名底纹」：底纹只覆盖元素名那一小段（既有断言钉住），
   * 路径命中时靠方框的 `.match` 框线表达，**不会**给路径那行加底纹。
   */
  matchPath: false,
  matchFullPath: false,
  /** 当前会话里**可见**的命中节点 id（按显示顺序），上下箭头在这个数组里循环。 */
  matches: [] as string[],
  /** 命中的节点 id 集合：渲染时判 class 用，避免逐节点 includes 的平方复杂度。 */
  hits: new Set<string>(),
  /** 命中但被收起、跳不过去的数量。 */
  hidden: 0,
  index: 0,
  /** 正则写出语法错误时为 true。 */
  invalid: false,
};

/** 按当前开关编译「元素名 → 是否命中」；没有输入或正则非法时返回 undefined。 */
function buildNameMatcher(): ((name: string) => boolean) | undefined {
  const query = searchState.query;
  if (!query) {
    searchState.invalid = false;
    return undefined;
  }
  // 全字：两侧不能是「词字符」。这里用 lookaround 而不是 \b —— \b 只认 ASCII 词字符，
  // 在中文或下划线相邻处判定很反直觉（例如 lib_boot 里的 boot 不会被当成整词）。
  const left = searchState.wholeWord ? '(?<![\\w$])' : '';
  const right = searchState.wholeWord ? '(?![\\w$])' : '';
  const body = searchState.regex ? `(?:${query})` : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const pattern = new RegExp(`${left}${body}${right}`, searchState.caseSensitive ? '' : 'i');
    searchState.invalid = false;
    return (name) => pattern.test(name);
  } catch {
    // 正则写到一半本来就可能非法。这里绝不能让异常冒出去，否则整帧渲染会被打断。
    searchState.invalid = true;
    return undefined;
  }
}

/**
 * 元素名底纹矩形（搜索命中高亮）。
 *
 * `renderNode` 与增量刷新 `refreshSearchMarks()` **共用这一份**几何 —— 两处各写一次迟早走形
 * （这个工程已因"同一口径写两遍"出现过问题）。宽度走量宽缓存，重复调用不会真的去量。
 */
function hitRectFor(displayName: string, nameBaseline: number, nameTagPrefix?: string): SVGElement {
  // 标签在名称前面时必须右移：底纹只标元素名，不能盖到标签上（`arrow` 摆法）。
  const offset = nameTagPrefix ? measureTextWidth(nameTagPrefix, NAME_FONT_SIZE, true) : 0;
  const hitWidth = measureTextWidth(displayName, NAME_FONT_SIZE, true);
  return svg('rect', {
    class: 'name-hit',
    x: TEXT_X + offset - NAME_HIT_PAD_X,
    y: nameBaseline - NAME_HIT_ABOVE,
    width: Math.max(1, Math.ceil(hitWidth) + NAME_HIT_PAD_X * 2),
    height: NAME_HIT_HEIGHT,
    rx: 2,
  });
}

/**
 * 查询词变化时**就地**更新命中标记，不重建整张图。
 *
 * 为什么需要：以前每敲一个字符都走 `render()` —— 全量重建 `#nodes`（800 个方框约 40 ms，
 * 连打十个字符就是几百毫秒的顿挫）。而命中只影响两样东西：方框组上的 `match` / `match-current`
 * class，以及元素名底下那层底纹矩形；两者都能就地增删。
 *
 * ⚠️ 结构性的东西（可见性、坐标、框高、图标、加减号）**仍由 `render()` 负责**，这里一概不碰。
 * ⚠️ 折叠起来的命中节点本来就没有方框元素，所以只按已渲染的方框遍历即可（`hits` 里多出来的
 * 那些由 `updateSearchUi()` 的「另有 N 处位于已收起的节点」说明）。
 */
function refreshSearchMarks(session: SessionPayload | undefined): void {
  refreshSearchMatches(session);
  if (!session) {
    return;
  }
  const currentId = currentMatchId();
  for (const group of nodesEl.children) {
    const id = group.getAttribute('data-node');
    if (!id) {
      continue;
    }
    const hit = searchState.hits.has(id);
    if (hit) {
      group.classList.add('match');
    } else {
      group.classList.remove('match');
    }
    if (currentId === id) {
      group.classList.add('match-current');
    } else {
      group.classList.remove('match-current');
    }
    const children = [...group.children];
    const existing = children.find((child) => child.getAttribute('class') === 'name-hit');
    if (hit && !existing) {
      // 底纹必须画在名字**下面**：先 append 底纹，再把名字重新 append 一次
      // （appendChild 对已有子节点是"移动"语义），这样不用依赖 insertBefore。
      const nameEl = children.find((child) => child.getAttribute('class') === 'name');
      if (nameEl) {
        const baseline = Number(nameEl.getAttribute('y') ?? '0');
        // 名称行现在由 tspan 组成：底纹只量**元素名**那一段，并让开前面的标签。
        const spans = Array.from(nameEl.children ?? []);
        const nameSpan = spans.find((child) => child.getAttribute('class') === 'name-text');
        const beforeSpan = spans.find((child) => child.getAttribute('class') === 'name-tag-before');
        group.appendChild(
          hitRectFor(
            nameSpan?.textContent ?? nameEl.textContent ?? '',
            baseline,
            beforeSpan?.textContent ?? undefined
          )
        );
        group.appendChild(nameEl);
      }
    } else if (!hit && existing) {
      existing.remove();
    }
  }
  updateSearchUi();
}

/** 重算命中集合（render() 每帧调用）。 */
function refreshSearchMatches(session: SessionPayload | undefined): void {
  searchState.matches = [];
  searchState.hits = new Set<string>();
  searchState.hidden = 0;
  const matcher = session ? buildNameMatcher() : undefined;
  if (!session || !matcher) {
    searchState.index = 0;
    return;
  }
  for (const node of allNodes(session)) {
    if (!matchesNode(matcher, node)) {
      continue;
    }
    searchState.hits.add(node.id);
    if (isVisible(session, node.id)) {
      searchState.matches.push(node.id);
    } else {
      searchState.hidden += 1;
    }
  }
  if (searchState.index >= searchState.matches.length) {
    searchState.index = 0;
  }
}

/**
 * 一个节点是否命中当前查询：元素名，加上（按开关）路径的**显示文本** / **完整路径**。
 *
 * 作用域互斥说明：`matchPath` 用 `displayPathText` 的结果（与方框里那行逐字相同，
 * 包括自动省略后剩下的窗口），`matchFullPath` 用 `node.file`。两者可同时开，
 * 命中其一即算命中。它们与「显示路径那一行」的开关 `showLocation` **无关**：
 * 关掉路径行时，文字仍然按同一份口径参与搜索（命中表现为方框框线高亮，
 * 不依赖那行是否存在）。
 */
function matchesNode(matcher: (text: string) => boolean, node: GraphNode): boolean {
  if (matcher(node.name)) {
    return true;
  }
  if (searchState.matchPath && matcher(displayPathText(node.file, state.pathOptions, LOC_MAX_CHARS))) {
    return true;
  }
  return searchState.matchFullPath && matcher(node.file);
}

/** 当前命中的节点 id（上下箭头落脚的地方）。 */
function currentMatchId(): string | undefined {
  return searchState.matches[searchState.index];
}

/** 把命中计数、正则描红、开关与箭头的可用状态写回界面。 */
function updateSearchUi(): void {
  const countEl = document.getElementById('search-count');
  if (countEl) {
    if (searchState.invalid) {
      countEl.textContent = '正则错误';
      countEl.classList.add('empty');
    } else if (!searchState.query) {
      countEl.textContent = '';
      countEl.classList.remove('empty');
    } else if (searchState.matches.length === 0) {
      countEl.textContent = '无命中';
      countEl.classList.add('empty');
    } else {
      const hidden = searchState.hidden > 0 ? `，另有 ${searchState.hidden} 处位于已收起的节点` : '';
      countEl.textContent = `第 ${searchState.index + 1}/${searchState.matches.length} 处${hidden}`;
      countEl.classList.remove('empty');
    }
    countEl.title = searchState.hidden > 0 ? `另有 ${searchState.hidden} 个命中在已收起的节点里` : '';
  }
  document.getElementById('search-input')?.classList.toggle('invalid', searchState.invalid);

  const toggles: Array<[string, boolean]> = [
    ['btn-search-case', searchState.caseSensitive],
    ['btn-search-word', searchState.wholeWord],
    ['btn-search-regex', searchState.regex],
    ['btn-search-path', searchState.matchPath],
    ['btn-search-full', searchState.matchFullPath],
  ];
  for (const [id, on] of toggles) {
    const button = document.getElementById(id);
    button?.classList.toggle('on', on);
    // 视觉上的开关状态（.on 样式）必须同时暴露给辅助技术，否则屏幕阅读器只知道"按钮"。
    button?.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  const hasMatches = searchState.matches.length > 0;
  for (const id of ['btn-search-prev', 'btn-search-next']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) {
      button.disabled = !hasMatches;
    }
  }
}

/** 在可见命中之间循环跳：delta = +1 下一个，-1 上一个。 */
function stepMatch(delta: number): void {
  const session = activeSession();
  const total = searchState.matches.length;
  if (!session || total === 0) {
    return;
  }
  searchState.index = (searchState.index + delta + total) % total;
  // 只把「当前命中」的高亮挪过去（不重建 DOM），再把那个方框滚到视图中间
  refreshStateClasses(session);
  const id = currentMatchId();
  if (id) {
    centerOn(session, id);
  }
}

// 搜索栏接线：输入框、三个开关、上下箭头。
// 元素可能不存在（例如 HTML 是旧版本），所以整体做空值保护、不注册就静默跳过。
const searchInputEl = document.getElementById('search-input') as HTMLInputElement | null;
if (searchInputEl) {
  searchInputEl.addEventListener('input', () => {
    searchState.query = searchInputEl.value;
    // 查询变了：从第一处命中重新数起
    searchState.index = 0;
    // 只就地更新命中标记（不重建 DOM）—— 打字是高频操作，全量重建在几百个方框时会明显顿挫。
    refreshSearchMarks(activeSession());
  });

  searchInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      stepMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      searchInputEl.value = '';
      searchState.query = '';
      searchState.index = 0;
      render();
    }
  });

  const toggleWiring: Array<
    [string, 'caseSensitive' | 'wholeWord' | 'regex' | 'matchPath' | 'matchFullPath']
  > = [
    ['btn-search-case', 'caseSensitive'],
    ['btn-search-word', 'wholeWord'],
    ['btn-search-regex', 'regex'],
    ['btn-search-path', 'matchPath'],
    ['btn-search-full', 'matchFullPath'],
  ];
  for (const [id, key] of toggleWiring) {
    document.getElementById(id)?.addEventListener('click', () => {
      searchState[key] = !searchState[key];
      searchState.index = 0;
      render();
    });
  }

  document.getElementById('btn-search-prev')?.addEventListener('click', () => stepMatch(-1));
  document.getElementById('btn-search-next')?.addEventListener('click', () => stepMatch(1));

  // Ctrl/Cmd+F 聚焦搜索框：webview 里没有 VS Code 自带的查找框，这里自己接管。
  window.addEventListener('keydown', (event) => {
    // 只在搜索框**未聚焦**时接管：输入框内本可用 Ctrl+F 选中框内文字，
    // 一律拦截会阻断该行为。另外 `event.key` 在按住 Ctrl 时仍是 'f'，
    // 原来的 'F' 分支是死代码。
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === 'f' &&
      document.activeElement !== searchInputEl
    ) {
      event.preventDefault();
      searchInputEl.focus();
    }
  });
}

// ------------------------------------------------ 临时路径过滤（搜索栏区域，用户 2026-10-15）

/**
 * 临时路径过滤的输入框与计数。
 *
 * 与搜索**互不影响**（用户明确要求分开）：搜索只改高亮与「第 N/M 处」计数，
 * 过滤改的是**哪些方框存在**。两者各有一个输入框、各自独立。
 *
 * 这是**窗口级**功能：查询发给宿主，由宿主裁剪**每个标签**的 payload 再重排 ——
 * 因此切标签、新开标签都自动生效，也不需要面板自己维护一份「谁被隐藏了」的集合。
 * 它同时是**临时**的：不写设置、不进会话快照，清空输入框立即恢复。
 */
const pathFilterInputEl = document.getElementById('path-filter-input') as HTMLInputElement | null;

/** 输入防抖（毫秒）：宿主每个查询都要重算所有标签的布局，逐字符发会让大图明显卡顿。 */
const PATH_FILTER_DEBOUNCE_MS = 200;

let pathFilterTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 把当前查询发给宿主。清空时**不等**防抖（「清空即恢复」必须是立刻的）。
 *
 * 这样也顺带保证了对称性：输入框里的文字永远等于宿主手里的查询。
 */
function postPathFilter(query: string): void {
  if (pathFilterTimer !== undefined) {
    clearTimeout(pathFilterTimer);
    pathFilterTimer = undefined;
  }
  if (query.trim().length === 0) {
    post({ type: 'pathFilter', query });
    return;
  }
  pathFilterTimer = setTimeout(() => {
    pathFilterTimer = undefined;
    post({ type: 'pathFilter', query });
  }, PATH_FILTER_DEBOUNCE_MS);
}

/**
 * 「已隐藏 N 个」。
 *
 * 数字来自**宿主**：命中与否要拿完整会话数据判（面板手上的 payload 已经被裁掉那些节点）。
 * `pending` 用于「刚打完字、宿主还没回」的那一刻 —— 此时旧数字已经不对了，
 * 与其显示一个错数，不如先说明正在过滤。
 */
function updatePathFilterUi(session: SessionPayload | undefined, pending = false): void {
  const countEl = document.getElementById('path-filter-count');
  if (!countEl) {
    return;
  }
  if ((pathFilterInputEl?.value ?? '').trim().length === 0) {
    countEl.textContent = '';
    countEl.classList.remove('empty');
    return;
  }
  if (pending) {
    countEl.textContent = '过滤中…';
    countEl.classList.remove('empty');
    return;
  }
  const hidden = session?.filteredCount ?? 0;
  countEl.textContent = `已隐藏 ${hidden} 个`;
  // 一条都没命中时用警示色（与搜索的「无命中」同一套观感）：否则用户只会觉得「怎么没反应」
  countEl.classList.toggle('empty', hidden === 0);
}

if (pathFilterInputEl) {
  pathFilterInputEl.addEventListener('input', () => {
    updatePathFilterUi(activeSession(), true);
    postPathFilter(pathFilterInputEl.value);
  });

  pathFilterInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      pathFilterInputEl.value = '';
      updatePathFilterUi(activeSession());
      postPathFilter('');
    }
  });
}

/**
 * 到节点总数上限时：两个展开按钮置为禁用态并写明原因，另在工具栏下显示一行提示。
 *
 * 用户反馈「到上限后再点展开、完全展开都没用」—— 病因是那时两个按钮**必然无效**（画不下的
 * 节点不会有方框），却不给任何反馈。禁用 + 写清原因与两条出路，比让用户反复点要好。
 * 不用右下角弹窗：本项目明确不要打扰式提示，改成面板内的一行内联文字。
 */
function applyCapacityState(session: SessionPayload): void {
  const atCapacity = session.atCapacity === true;
  const limit = session.maxLayoutNodes;
  const reason = atCapacity
    ? `已达节点总数上限${limit === undefined ? '' : ` ${limit}`}：` +
      '可在设置中调大 cppCallGraph.maxLayoutNodes，或先收起部分分支后重试'
    : '';
  const defaults: Record<string, string> = {
    'btn-expand-all': '展开全部（受 maxExpandRounds 层数上限约束）',
    'btn-expand-full': '完全展开（不受层数上限约束）',
  };
  for (const [id, defaultTitle] of Object.entries(defaults)) {
    const button = document.getElementById(id) as
      | (HTMLElement & { disabled?: boolean })
      | null;
    if (!button) {
      continue;
    }
    button.disabled = atCapacity;
    button.title = atCapacity ? reason : defaultTitle;
  }
  const hint = document.getElementById('capacity-hint');
  if (hint) {
    hint.textContent = reason;
    hint.hidden = !atCapacity;
  }
}

// 标签栏的自有右键菜单（用户 2026-10-14 要求）：VS Code 给 webview 的默认菜单（剪切/复制/粘贴）
// 无法由扩展扩展，所以自建一套。动作全部复用既有消息（closeTab / closeAllTabs / copyTabText），
// 因此**宿主侧无需改动**。目标标签按它自己的 `data-tab-id` 定位（不按 DOM 下标 ——
// `renderTabs` 会跳过不在 `state.sessions` 里的 id，下标一旦错位就会关错标签）。
let tabMenuTargetId: string | undefined;
const tabMenuEl = document.getElementById('tab-menu');
function hideTabMenu(): void {
  if (tabMenuEl) {
    tabMenuEl.hidden = true;
  }
}
document.getElementById('tabs')?.addEventListener('contextmenu', (event) => {
  const tab = (event.target as HTMLElement | null)?.closest?.('.tab');
  const id = tab?.getAttribute?.('data-tab-id') ?? undefined;
  if (!id || !tabMenuEl) {
    return;
  }
  event.preventDefault();
  tabMenuTargetId = id;
  tabMenuEl.hidden = false;
  tabMenuEl.style.left = `${event.clientX}px`;
  tabMenuEl.style.top = `${event.clientY}px`;
});
tabMenuEl?.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement | null)
    ?.closest?.('[data-action]')
    ?.getAttribute('data-action');
  const id = tabMenuTargetId;
  hideTabMenu();
  if (!action) {
    return;
  }
  const order = [...state.order];
  // 下标**当场按 id 反查**：菜单弹出后标签可能被别处关掉，DOM 与 order 都可能已经变了
  const index = id === undefined ? -1 : order.indexOf(id);
  const closeIds = (ids: string[]): void => {
    for (const each of ids) {
      post({ type: 'closeTab', id: each });
    }
  };
  if (action === 'closeAll') {
    post({ type: 'closeAllTabs' });
    return;
  }
  if (!id || index < 0) {
    return;
  }
  if (action === 'copyTabName') {
    post({ type: 'copyTabText', sessionId: id });
  } else if (action === 'closeSelf') {
    closeIds([id]);
  } else if (action === 'closeOthers') {
    closeIds(order.filter((each) => each !== id));
  } else if (action === 'closeLeft') {
    closeIds(order.slice(0, index));
  } else if (action === 'closeRight') {
    closeIds(order.slice(index + 1));
  }
});
// 点别处 / 滚动时收起标签菜单（与方框菜单同一口径，两者互不干扰）
document.addEventListener('click', hideTabMenu, true);

// 工具栏最左边的按钮：关闭**全部**标签并把整个「调用关系图」视图收起来。
// 按需求，它的行为等同于原来面板标题栏上的「关闭全部调用关系标签」，
// 而不是只关掉当前这一个标签（单个标签的关闭在标签自己的 ✕ 上）。
document.getElementById('btn-close-all')?.addEventListener('click', () => {
  post({ type: 'closeAllTabs' });
});

document.getElementById('btn-expand-all')?.addEventListener('click', () => {
  const session = activeSession();
  if (!session) {
    return;
  }
  // 「展开全部」之前先把「已收起」清干净，并同步给宿主（它按这个集合算坐标）。
  // 否则「收起全部 → 展开全部」之后宿主仍把根当成收起的，或把先前手动收起过的
  // 子树整棵漏在布局外 —— 用户实测的现象就是「只展开到第二级、第二级加号点不开」。
  collapsedSet(session.id).clear();
  postCollapsed(session.id);
  // 展开是逐层请求语言服务，交给宿主做（前端只管画）。
  // 记下 pending：等宿主的响应回来时清掉本地的「已收起」标记，
  // 否则「收起全部后再展开全部」会什么都不发生（数据已加载，但又全被标记为收起）。
  pendingExpandAll = session.id;
  post({ type: 'expandAll', sessionId: session.id });
});

// 「完全展开」：与「展开全部」同一套本地准备（清掉收起标记 + 记 pending），// 区别只在宿主那一侧 —— 它不再受设置里的层数上限约束，会一直展开到没有可展开的节点。
document.getElementById('btn-expand-full')?.addEventListener('click', () => {
  const session = activeSession();
  if (!session) {
    return;
  }
  collapsedSet(session.id).clear();
  postCollapsed(session.id);
  pendingExpandAll = session.id;
  post({ type: 'expandFull', sessionId: session.id });
});

document.getElementById('btn-copy-tab')?.addEventListener('click', () => {
  const session = activeSession();
  if (!session) {
    return;
  }
  post({ type: 'copyTabText', sessionId: session.id });
});

document.getElementById('btn-collapse-all')?.addEventListener('click', () => {
  collapseAll();
});

document.getElementById('btn-settings')?.addEventListener('click', () => {
  // 交给宿主调 VS Code 内置的设置命令
  post({ type: 'openSettings' });
});

document.getElementById('btn-busy-cancel')?.addEventListener('click', () => {
  // 让宿主停下手上的多步解析 —— 引用查找是一串语言服务请求，可以中途停下。
  // 单个语言服务调用（例如展开某个方框）拦不住，那边会自行结束。
  // 本地的「正在展开」标记也要一并清掉：只藏遮罩的话，下一次 render() 会因为
  // loading 非空而让它自己又冒出来（「取消」形同虚设）。
  state.loading.clear();
  post({ type: 'cancelResolve' });
  hostBusy = false;
  hideBusy();
  // ⚠️ 清掉「正在展开」之后必须重绘：否则那个方框的加减号还停在 loading 形态
  // （该形态的点击被吞掉，见 buildExpander），而超时兜底的判据是「这一次 delete 真的删到了」
  // —— 标记已经被这里 clear 掉，delete 返回 false，于是永远不会有人重绘，
  // 那个方框的 ± 就一直是死的，直到别的操作顺带 render()。
  if (activeSession()) {
    render();
  }
});

// ------------------------------------------------------------ 导出菜单

/**
 * 导出格式（与宿主 `commands/exportGraph.ts` 的 `ExportFormat` 取值一致）。
 * 前端独立打包，故此处重复定义 —— 与 `Direction` / `NodeKind` 的处理相同。
 */
type ExportFormat = 'png' | 'svg' | 'md-tree' | 'md-table' | 'json';

/** PNG 栅格化倍数：2 倍分辨率（用户要求）。 */
const EXPORT_SCALE = 2;
/** 导出图片四周的留白（内容单位与像素 1:1，所以这个数字既是留白也是像素）。 */
const EXPORT_PADDING = 12;
/**
 * 画布面积上限（16384 × 16384，浏览器内核的既有上限）。
 *
 * 超过这个面积时 `toDataURL` 不会抛错，而是返回**空数据**（旧版内核）或直接失败，
 * 于是用户会拿到一个 0 字节或全空的 PNG —— 属于「静默产出错文件」。
 * 因此超限时主动报错，并指向不受此上限约束的矢量导出。
 */
const MAX_CANVAS_AREA = 16384 * 16384;
/** PNG 数据 URL 的前缀；取到的数据不以它开头说明画布没有给出有效图像。 */
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
/** 后备路径用的 SVG 数据 URL 前缀（主路径是 `blob:`，见 `rasterizePng` 的说明）。 */
const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;base64,';
/**
 * Blob 的 MIME 类型。
 *
 * 必须带 `charset=utf-8`：元素名与文件路径里有中文，不带字符集时部分环境会把
 * SVG 文本按 latin-1 解码，导出的图里中文变成乱码。
 */
const SVG_BLOB_TYPE = 'image/svg+xml;charset=utf-8';

/**
 * 必须内联到导出 SVG 上的计算样式属性。
 *
 * 颜色、字号、字体族都来自外部样式表里的 CSS 变量（`--node-fg` 等），而
 * `XMLSerializer` 只序列化属性 —— 不内联的话，导出的 SVG 丢掉全部样式，
 * 结果是一张黑图或一堆黑方块。
 *
 * 其中**取值等于初始值的属性不必写**（见 `SVG_INITIAL_STYLE_VALUES`）。
 */
const EXPORT_STYLE_PROPERTIES = [
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

/**
 * 不参与「等于初始值就跳过」的属性：**一律内联**。
 *
 * 为什么单独列出这两个：`font-family` / `font-size` 的 UA 默认值随浏览器、平台与
 * 是否继承而变，并不存在一个稳定的初始值。一旦按某张初始值表把它们跳过，
 * 导出的 SVG 换到另一个环境打开时可能落到另一套字体度量上，文字与方框就对不齐。
 * 其余属性（颜色、描边、透明度）的初始值是规范固定值，跳过是安全的。
 */
const ALWAYS_INLINE_STYLE_PROPERTIES = ['font-family', 'font-size'];

/**
 * SVG 属性的**初始值**（规范值，不是继承值）。
 *
 * 用途：内联计算样式时，取值等于初始值的属性不必写进导出文件，以缩小体积 —— 大图里
 * 每个元素都要写 12 个属性，而其中多数从来没被人设过，算出来正好是初始值
 * （例如 `<path class="edge">` 的 `stroke-dasharray` 就是 `none`）。
 *
 * ⚠️ **适用前提（改动前务必先读这一段）**：`fill` / `stroke` / `stroke-width` /
 * `stroke-dasharray` / `fill-opacity` / `font-weight` / `font-style` / `text-anchor` /
 * `dominant-baseline` 在 SVG 里都是**可继承**属性。省略一个等于初始值的取值，只有在
 * **祖先元素也没有携带该属性的非初始值**时才不改变渲染结果；反之（子元素算出来是初始值、
 * 而某个祖先写了别的值）省略会让子元素在导出文件里**继承祖先的值**，颜色随之出错。
 * 目前 `graph.css` 里颜色/描边规则**全部落在叶子上**（`.box` / `.name` / `.loc` /
 * `.edge` / `.ring` / `.sign-shape` / `.icon-shape` / `.name-hit` / `.capped-ring`），
 * 画布内的容器（`#svg`、`#nodes`、`#edges`、`.node`、`.expander`、`.kind-icon`）都没有
 * 设置这些属性，因此这条省略是安全的。**一旦给容器加上颜色或描边规则，就必须把这里的
 * 判定改成「与父元素的计算值相同才省略」**，否则导出图会出现静默的颜色偏差。
 *
 * `stroke-width` 在浏览器里算出来常带单位（`1px`），故两种写法都算初始值。
 */
const SVG_INITIAL_STYLE_VALUES: Record<string, readonly string[]> = {
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
};

const exportMenuEl = document.getElementById('export-menu') as HTMLDivElement | null;

function hideExportMenu(): void {
  if (exportMenuEl) {
    exportMenuEl.hidden = true;
  }
}

// 点「导出」按钮 → 贴着该按钮下沿弹出菜单（与方框菜单同一套边界收边写法）
document.getElementById('btn-export')?.addEventListener('click', (event) => {
  if (!exportMenuEl) {
    return;
  }
  const button = event.currentTarget as HTMLElement | null;
  const rect = button?.getBoundingClientRect?.();
  // 先显示再量尺寸，否则 offsetWidth 是 0（与方框菜单一致）
  exportMenuEl.hidden = false;
  const width = exportMenuEl.offsetWidth || 180;
  const height = exportMenuEl.offsetHeight || 150;
  const left = Math.max(0, Math.min(rect?.left ?? 0, window.innerWidth - width - 4));
  const bottom = rect ? rect.top + rect.height : 0;
  const top = Math.max(0, Math.min(bottom + 4, window.innerHeight - height - 4));
  exportMenuEl.style.left = `${left}px`;
  exportMenuEl.style.top = `${top}px`;
});

/** 导出格式白名单：把菜单里的 `data-format` 收窄成 `ExportFormat`。 */
function isExportFormat(value: string): value is ExportFormat {
  return (
    value === 'png' ||
    value === 'svg' ||
    value === 'md-tree' ||
    value === 'md-table' ||
    value === 'json'
  );
}

exportMenuEl?.addEventListener('click', (event) => {
  const format = findMenuAttribute(event.target, 'data-format');
  hideExportMenu();
  if (!format || !isExportFormat(format)) {
    return;
  }
  const session = activeSession();
  if (!session) {
    // ⚠️ 这里过去是直接 `return`：点了菜单项什么都不发生、也不报告，用户会以为扩展坏了。
    // 现在与其它导出失败走同一套机制（`error` 消息 → 宿主的输出通道），不留静默路径。
    reportExportFailure(format, '当前没有活动标签，无法导出');
    return;
  }
  beginExport(format, session.id);
});

// 点别处收起导出菜单（捕获阶段先收，按钮自己的点击随后再打开），按 Esc 同样收起。
document.addEventListener('click', hideExportMenu, true);
document.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Escape') {
    hideExportMenu();
  }
});

/**
 * 导出入口。
 *
 * `md-tree` / `md-table` / `json` 的正文由宿主生成（**不带 data**）；
 * `png` / `svg` 必须先在 webview 里抓取画布（只有前端拿得到真实节点与计算样式）。
 *
 * PNG 与 SVG 共用同一份序列化逻辑，只有一处口径不同：克隆体里的 `<title>`。
 *   - SVG 文件：**保留**（人要拿编辑器打开它，悬停提示是唯一的说明来源）；
 *   - PNG：**剔除**（栅格图里根本没有悬停这回事，而大图里每个方框一条提示文本，
 *     正是体积大户）。
 */
function beginExport(format: ExportFormat, sessionId: string): void {
  try {
    if (format === 'md-tree' || format === 'md-table' || format === 'json') {
      post({ type: 'exportGraph', sessionId, format });
      return;
    }
    if (format === 'svg') {
      // 矢量导出：直接把序列化后的 SVG 交给宿主写盘（仍是矢量、可再编辑）。
      const prepared = buildExportSvg({ stripTitles: false });
      if (!prepared) {
        reportExportFailure('svg', '当前没有可导出的图形（画布为空）');
        return;
      }
      // ⚠️ 写盘之前必须先预检：序列化结果本身不合法时，写出去的文件打开就会报错。
      // 因此这里**直接拒绝写文件**，只把诊断交给宿主（宿主写进输出通道）。
      const problem = checkExportXml(prepared.text);
      if (problem !== undefined) {
        reportExportFailure(
          'svg',
          `序列化结果不是合法的 XML，已拒绝写出该文件：${problem}` +
            `（序列化 ${serializedBytes(prepared.text)} 字节）`
        );
        return;
      }
      post({ type: 'exportGraph', sessionId, format, data: prepared.text });
      return;
    }
    // 栅格导出：剔除 `<title>`（只作用于克隆体，真画布一个都不动）。
    const prepared = buildExportSvg({ stripTitles: true });
    if (!prepared) {
      reportExportFailure('png', '当前没有可导出的图形（画布为空）');
      return;
    }
    rasterizePng(prepared, sessionId);
  } catch (error) {
    // 不许静默：抓取 / 序列化任何一步失败都要留下可诊断的记录。
    reportExportFailure(format, error);
  }
}

/**
 * 把当前画布（`#svg`，承载全部方框与连线）复制成一棵**自带样式**的 SVG。
 *
 * 关键点：
 *   ① 样式必须内联（见 `EXPORT_STYLE_PROPERTIES`）；
 *   ② 尺寸取**内容包围盒**加内边距，导出的是全部已渲染内容 ——
 *      不做裁剪，也与当前滚动位置、面板大小无关；
 *   ③ 克隆里保留 `<defs>` 的箭头 marker（`cloneNode(true)` 会一并带上）；
 *   ④ `stripTitles` 只作用于**克隆体**：真画布上的 `<title>`（悬停提示）一个都不能少，
 *      否则用户在面板里悬停方框就再没有提示了；
 *   ⑤ 序列化之前把 XML 1.0 不允许的字符换掉（见 `sanitizeExportXmlChars`）—— 这是真机
 *      「一展开就导出失败 / SVG 打开报错」的根因所在，不能省。
 */
function buildExportSvg(options: {
  stripTitles: boolean;
}): { text: string; width: number; height: number } | undefined {
  const source = svgEl as SVGSVGElement | undefined;
  if (
    !source ||
    typeof source.cloneNode !== 'function' ||
    typeof source.getBBox !== 'function'
  ) {
    return undefined;
  }
  const box = source.getBBox();
  const width = Math.max(1, Math.ceil(box.width + EXPORT_PADDING * 2));
  const height = Math.max(1, Math.ceil(box.height + EXPORT_PADDING * 2));
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute(
    'viewBox',
    `${box.x - EXPORT_PADDING} ${box.y - EXPORT_PADDING} ${width} ${height}`
  );
  // 模板上可能带 hidden 之类的状态属性；导出的是画布本身，一律去掉。
  clone.removeAttribute('hidden');
  // ⚠️ 顺序不可调换：内联样式要靠「原节点与克隆体按下标一一对应」，
  // 必须先内联、再剔除元素（否则下标错位，样式写到别的元素上）。
  inlineExportStyles(source, clone);
  if (options.stripTitles) {
    for (const title of Array.from(clone.querySelectorAll('title'))) {
      title.remove();
    }
  }
  // ⑤ 清掉 XML 1.0 不允许的字符（真机根因：属性值里带节点 id 的 NUL 分隔符）。
  // 必须排在序列化之前，且只作用于克隆体。
  sanitizeExportXmlChars(clone);
  const body = new XMLSerializer().serializeToString(clone);
  return { text: `<?xml version="1.0" encoding="UTF-8"?>\n${body}`, width, height };
}

/**
 * 序列化文本的 UTF-8 字节数。
 *
 * 失败文案一律带上它：真机上「导出失败」既有可能是图本来就大，也有可能是别的原因，
 * 有这个数字即可直接区分（276 个节点的图序列化后约 2.1 MB，小图只有几十 KB）。
 */
function serializedBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * XML 1.0 不允许**直接出现**的控制字符（`\t`、`\n`、`\r` 是允许的，故不在其中）。
 *
 * 用途：各内核对这类字符的态度并不一致 —— 有的直接给出 parsererror，有的照单全收，
 * 因此它必须作为一条**独立判据**，与解析器报错合并返回。
 */
const XML_INVALID_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** 诊断片段里控制字符的可见替身：不可见字符原样写进输出通道，什么也看不出来。 */
const CONTROL_CHAR_PLACEHOLDER = '·';
/** 控制字符诊断片段在命中位置前后各取的字符数。 */
const CONTROL_CHAR_CONTEXT = 40;
/** 单次预检最多列出多少处控制字符：真机上一旦出现，往往每个节点都中，全列会把输出通道刷满。 */
const CONTROL_CHAR_MAX_REPORTS = 5;
/** 解析器报错文本的截断长度：部分内核会把整段输入附在报错里。 */
const PARSE_ERROR_MAX_CHARS = 300;

/** 该字符是否为 XML 1.0 不允许直接出现的控制字符（`\t`、`\n`、`\r` 除外）。 */
function isInvalidXmlControlChar(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f);
}

/**
 * 与 `XML_INVALID_CONTROL_CHARS` 同一字符集，但**不带 `g`**。
 *
 * `g` 正则带 `lastIndex` 状态，拿它做 `test()` 会在连续调用之间漏判 —— 这里必然要被
 * 反复调用（每个属性、每段文本各一次），所以判定另用这一个。
 */
const XML_INVALID_CONTROL_CHAR_TEST = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/** 非法控制字符在导出文本里的替身：`\u2400`（␀，SYMBOL FOR NULL）。 */
const XML_INVALID_CHAR_PLACEHOLDER = '\u2400';

/** 把一段文本里 XML 1.0 不允许的控制字符换成可见替身（没有命中时原样返回）。 */
function sanitizeXmlChars(value: string): string {
  return XML_INVALID_CONTROL_CHAR_TEST.test(value)
    ? value.replace(XML_INVALID_CONTROL_CHARS, XML_INVALID_CHAR_PLACEHOLDER)
    : value;
}

/**
 * 把克隆体里 XML 1.0 不允许直接出现的字符替换掉（**只动克隆体，真画布一个字符不改**）。
 *
 * 为什么必须有这一步（真机根因，2026-10-14 定位）：
 * 节点 id 以 NUL 作分隔符（宿主 `session.ts` 的 `ID_SEPARATOR`），而 id 会随属性值进入画布
 * （真机命中的是 `lib_core_dev_read_byte\u0000file:///…` 这种形态）。裸 `U+0000` 写进属性值后，
 * 序列化结果**不是合法 XML**：
 *   - 浏览器报 `invalid character in attribute value`；
 *   - PNG 走 `<img>` 加载同一份文本，因此必然 `onerror`，导出失败；
 *   - SVG 文件能写出，但打开时「图不全 + 报错」—— 解析器在出错点就停止解析。
 * root-only 时 id 不含 NUL，所以小图能导出、一旦有子节点就失败，与体积无关。
 *
 * 替身取 `␀` 而不是删掉：它若出现在导出文件里，可立即看出「这里原本有个 NUL」。
 * 属性名不改（只改值），因此 `url(#id)` 这类引用不受影响。
 */
function sanitizeExportXmlChars(node: Element): void {
  for (const attribute of Array.from(node.attributes)) {
    const safe = sanitizeXmlChars(attribute.value);
    if (safe !== attribute.value) {
      node.setAttribute(attribute.name, safe);
    }
  }
  // nodeType 用数字：1 = 元素、3 = 文本（测试桩不一定提供 Node.TEXT_NODE 常量）。
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      const text = child.nodeValue ?? '';
      const safe = sanitizeXmlChars(text);
      if (safe !== text) {
        child.nodeValue = safe;
      }
    } else if (child.nodeType === 1) {
      sanitizeExportXmlChars(child as Element);
    }
  }
}

/**
 * 把诊断文本压成单行并截断。
 *
 * 压掉换行是必须的：内核的 parsererror 文本本身就是多行的，不压会把这句失败文案
 * 在输出通道里摊成好几行，反而看不清；截断处补省略号，表明后面还有内容。
 */
function compactDiagnostic(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > PARSE_ERROR_MAX_CHARS
    ? `${compact.slice(0, PARSE_ERROR_MAX_CHARS)}…`
    : compact;
}

/** 取命中位置前后的上下文片段：里面的控制字符换成可见替身，空白压成一个空格以保证只占一行。 */
function controlCharSnippet(text: string, index: number): string {
  const from = Math.max(0, index - CONTROL_CHAR_CONTEXT);
  const to = Math.min(text.length, index + CONTROL_CHAR_CONTEXT + 1);
  let snippet = '';
  for (const character of text.slice(from, to)) {
    if (isInvalidXmlControlChar(character)) {
      snippet += CONTROL_CHAR_PLACEHOLDER;
    } else if (/\s/.test(character)) {
      snippet += ' ';
    } else {
      snippet += character;
    }
  }
  return snippet;
}

/**
 * 导出前的自检：序列化结果本身是否为合法 XML。返回 `undefined` 表示没有发现问题。
 *
 * 为什么需要这一层：真机反馈「导出 PNG（2×）失败、导出的 .svg 打开报错」时，
 * 栅格化的 `onerror` 与「文件打开报错」都只是**症状**，真因可能就在序列化结果里
 * （非法控制字符、结构不合法）。把预检放在导出路径最前面，失败文案一次说清，
 * 不必再靠猜；本函数也因此**只在导出路径上调用**，不参与渲染、布局与动画（那些是热路径）。
 *
 * 两条判据**合并**返回：解析器报错（不同内核对 `parsererror` 的命名空间写法不同，
 * 故同时按元素名与选择器兜住）与控制字符命中，两边都可能是真因。
 *
 * `DOMParser` 不存在时（测试桩、极简环境）**不阻断**：缺了解析器不等于结果不合法。
 */
function checkExportXml(text: string): string | undefined {
  const problems: string[] = [];

  // ① 交给内核自己的 XML 解析器判：「文档里取得到 parsererror 元素」是各内核的共同判据。
  if (typeof DOMParser === 'function') {
    try {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const error =
        doc?.getElementsByTagName?.('parsererror')?.[0] ??
        doc?.querySelector?.('parsererror') ??
        undefined;
      if (error) {
        problems.push(`XML 解析器报错：${compactDiagnostic(String(error.textContent ?? ''))}`);
      }
    } catch (failure) {
      problems.push(
        `XML 解析器调用失败：${failure instanceof Error ? failure.message : String(failure)}`
      );
    }
  }

  // ② 控制字符扫描：只收集前若干处的位置，总数单独记 —— 大图里这类字符可能上万个。
  let total = 0;
  const positions: number[] = [];
  XML_INVALID_CONTROL_CHARS.lastIndex = 0;
  for (
    let hit = XML_INVALID_CONTROL_CHARS.exec(text);
    hit !== null;
    hit = XML_INVALID_CONTROL_CHARS.exec(text)
  ) {
    total += 1;
    if (positions.length < CONTROL_CHAR_MAX_REPORTS) {
      positions.push(hit.index);
    }
  }
  if (total > 0) {
    const details = positions.map((index) => {
      const code = (text.codePointAt(index) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      return `U+${code}（位置 ${index}，片段「${controlCharSnippet(text, index)}」）`;
    });
    const rest = total > positions.length ? `，另有 ${total - positions.length} 处未列出` : '';
    problems.push(`含 XML 1.0 不允许的控制字符 ${total} 处：${details.join('；')}${rest}`);
  }

  return problems.length > 0 ? problems.join('；') : undefined;
}

/** 规范化样式取值：去首尾空白、折成小写、把连续空白压成一个空格，便于与初始值逐字比较。 */
function normalizeStyleValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 该属性的取值是否与 SVG 初始值相同（相同就不必写进导出文件）。
 *
 * `font-family` / `font-size` 不在初始值表里，且由 `ALWAYS_INLINE_STYLE_PROPERTIES`
 * 显式排除在跳过规则之外 —— 一律内联（理由见该常量的说明）。
 */
function isInitialStyleValue(property: string, value: string): boolean {
  if (ALWAYS_INLINE_STYLE_PROPERTIES.includes(property)) {
    return false;
  }
  const initials = SVG_INITIAL_STYLE_VALUES[property];
  return initials !== undefined && initials.includes(normalizeStyleValue(value));
}

/**
 * 把计算样式内联到克隆上。
 *
 * 原节点与克隆节点的 `querySelectorAll('*')` 都是**文档序**，因此按下标一一对应即可
 * （两边结构相同，长度也相同）。
 *
 * ⚠️ 因此这一步必须在**任何增删克隆体元素之前**做完：先剔除 `<title>` 会让克隆体的元素
 * 列表变短，下标随之错位，样式就会写到别的元素上（图整个走形）。
 *
 * 取值等于初始值的属性跳过不写（见 `isInitialStyleValue`）。
 */
function inlineExportStyles(source: Element, clone: Element): void {
  const view = source.ownerDocument?.defaultView ?? window;
  if (!view || typeof view.getComputedStyle !== 'function') {
    return;
  }
  const origins: Element[] = [source, ...Array.from(source.querySelectorAll('*'))];
  const copies: Element[] = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (let index = 0; index < origins.length && index < copies.length; index += 1) {
    const style = view.getComputedStyle(origins[index]);
    // 测试桩的 getComputedStyle 可能只提供属性访问器；取不到就跳过，不能因此整段失败。
    if (!style || typeof style.getPropertyValue !== 'function') {
      continue;
    }
    for (const property of EXPORT_STYLE_PROPERTIES) {
      const value = style.getPropertyValue(property);
      if (!value || isInitialStyleValue(property, value)) {
        continue;
      }
      copies[index].setAttribute(property, value);
    }
  }
}

/** UTF-8 文本 → base64（`btoa` 只接受 Latin-1，元素名/路径里的中文必须先编成字节）。 */
function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(index, index + chunk)));
  }
  return btoa(binary);
}

/**
 * 栅格化成 PNG：2 倍分辨率、**透明背景**（画布不画底色），再把 base64 交给宿主写盘。
 *
 * 五个阶段，顺序不可调换：
 *   ⓪ 先对序列化结果做 XML 自检（`checkExportXml`）—— 结果本身不合法时，后面几步注定失败，
 *      此时直接报错，不再建 blob / data URL；
 *   ① 先建画布、先按 2 倍算尺寸、**先判面积闸门** —— 大图要在加载图像之前就拦掉，
 *      否则白序列化、白编码一份超长 URL，最后才知道根本画不下；
 *   ② 取 2D 上下文（拿不到就没有可画的地方，直接报错）；
 *   ③ 用 **blob URL** 加载 SVG 图像（主路径）；
 *   ④ `onload` 里画图并取 PNG；blob 加载失败时退回 data URL 再试一次，两次都失败才报错。
 * 同步阶段（建画布 / 取上下文 / 建 blob）若抛错，同样走统一的失败出口 —— 所有 PNG 失败
 * 都带序列化字节数，真机上不会只剩一句裸错误。
 *
 * **为什么主路径必须是 blob URL 而不是 data URL**：
 *   Chromium 对 URL 长度有硬上限 **2 MB**（`url::kMaxURLChars = 2 * 1024 * 1024`）。
 *   真机证据：276 个节点的图序列化后 **2154007 字节**，base64 后再涨约 1/3 ≈ 2.87 MB，
 *   这个超长 data URL 会被截断 / 判为非法，`new Image()` 于是走 `onerror`；
 *   而同一次会话里小图（如几十个节点）一切正常 —— 与 CSP 无关：`img-src data:` 本来就在
 *   模板里，而且若真是 CSP 拦截，控制台会留一条 CSP 违规记录，而不是这样静默失败。
 *   blob URL 只是一个指向内存 Blob 的短字符串，不受该上限约束。
 *   data URL 仍保留为**后备**（小图照样能成，也覆盖 `createObjectURL` 不可用的环境）。
 *
 * 失败文案一律带上**序列化字节数**：下次再出问题，可立即判断是「图本来就大」还是其它原因。
 */
function rasterizePng(
  prepared: { text: string; width: number; height: number },
  sessionId: string
): void {
  const bytes = serializedBytes(prepared.text);
  /** 统一的失败出口：每条 PNG 报错都带上序列化字节数。 */
  const fail = (detail: unknown): void => {
    const text = detail instanceof Error ? detail.message : String(detail);
    reportExportFailure('png', `${text}（序列化 ${bytes} 字节）`);
  };

  try {
    // ⓪ 序列化结果自检：必须在**加载图像之前**。
    //    「SVG 图像加载失败」只是症状；序列化结果本身若不是合法 XML，blob URL 与 data URL
    //    两条路都注定失败。这里直接失败并把诊断说清，**不再尝试 blob / data URL**。
    const problem = checkExportXml(prepared.text);
    if (problem !== undefined) {
      fail(`序列化结果不是合法的 XML，栅格化未开始：${problem}`);
      return;
    }

    // ① 画布与面积闸门：必须在加载图像之前。
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(prepared.width * EXPORT_SCALE));
    canvas.height = Math.max(1, Math.round(prepared.height * EXPORT_SCALE));
    if (canvas.width * canvas.height > MAX_CANVAS_AREA) {
      fail(
        `图形过大（导出尺寸 ${canvas.width} × ${canvas.height} 像素，超出画布面积上限），` +
          `请改用「导出矢量图（SVG）」`
      );
      return;
    }
    // ② 2D 上下文。
    const context = canvas.getContext('2d');
    if (!context) {
      fail('无法取得 2D 画布上下文');
      return;
    }

    const image = new Image();
    /** 当前用的 blob URL（用完必须释放，否则整份序列化文本会一直留在内存里）。 */
    let objectUrl: string | undefined;
    /** 是否已经退到 data URL 后备路径。 */
    let triedDataUrl = false;

    const releaseObjectUrl = (): void => {
      if (objectUrl === undefined) {
        return;
      }
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // 释放失败不影响导出结果，忽略。
      }
      objectUrl = undefined;
    };

    /** 后备路径：小图仍可用 data URL 成功（也覆盖禁用 blob 的环境）。 */
    const loadFromDataUrl = (): void => {
      triedDataUrl = true;
      image.src = `${SVG_DATA_URL_PREFIX}${encodeBase64Utf8(prepared.text)}`;
    };

    image.onload = () => {
      // onload 之后这个 URL 已经没有用处，先释放再画图（画图用的是已解码的 image）。
      releaseObjectUrl();
      try {
        // 刻意不填充底色：画布本身透明，导出的 PNG 背景因此是透明的。
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/png');
        if (!url.startsWith(PNG_DATA_URL_PREFIX) || url.length <= PNG_DATA_URL_PREFIX.length) {
          // 面积虽然没超上限，画布仍可能拒绝给出图像；此时不能把空数据当成导出成功。
          throw new Error('画布没有返回有效的 PNG 数据');
        }
        post({
          type: 'exportGraph',
          sessionId,
          format: 'png',
          data: url.slice(PNG_DATA_URL_PREFIX.length),
        });
      } catch (error) {
        fail(error);
      }
    };
    image.onerror = () => {
      // onerror 之后这个 URL 同样要释放（不管是退到后备还是最终失败）。
      releaseObjectUrl();
      if (!triedDataUrl) {
        // blob URL 没成，用 data URL 再试一次：小图仍可成功。
        loadFromDataUrl();
        return;
      }
      fail(
        'SVG 图像加载失败（blob URL 与 data URL 两次都失败；请确认 CSP 含 img-src blob: data:，' +
          '或图形内容不合法）'
      );
    };

    // 主路径：blob URL。
    try {
      objectUrl = URL.createObjectURL(new Blob([prepared.text], { type: SVG_BLOB_TYPE }));
      image.src = objectUrl;
    } catch {
      // 环境不支持 Blob / createObjectURL：直接走后备路径，而不是让整次导出失败。
      objectUrl = undefined;
      loadFromDataUrl();
    }
  } catch (error) {
    // 同步阶段的意外抛错（环境不支持 canvas / Blob 之类）也要带上序列化字节数：
    // 否则真机上只会看到一句裸错误，看不出「图本来就大」还是别的原因。
    fail(error);
  }
}

/**
 * 导出失败必须留下可诊断的痕迹（不许静默什么都不做）。
 *
 * webview 没有输出通道 API，于是复用既有的 `error` 消息：宿主收到后写
 * 「webview 报错：…」（logError），并转给视图的 onError（logWarn），两条都在输出通道里。
 */
function reportExportFailure(format: ExportFormat, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  post({ type: 'error', message: `导出 ${format} 失败：${detail}` });
}

// ------------------------------------------------------------ 与宿主通信

/**
 * 把宿主下发的路径显示设置写进 `state`（`init` 与 `settings` 两条消息共用）。
 *
 * ⚠️ 逐字段判存在、缺失就**保留当前值**：旧宿主只会发 stickyParent / showLocation，
 * 一律覆盖会把路径显示方式重置回默认，界面看起来像"设置不生效"。
 */
function applyPathSettings(settings: WebviewSettings | undefined): void {
  if (!settings) {
    return;
  }
  if (settings.pathDisplay === 'tail' || settings.pathDisplay === 'full') {
    state.pathOptions.mode = settings.pathDisplay;
  }
  if (typeof settings.pathTailLevels === 'number' && Number.isFinite(settings.pathTailLevels)) {
    state.pathOptions.tailLevels = Math.max(0, Math.floor(settings.pathTailLevels));
  }
  if (Array.isArray(settings.pathAnchors)) {
    state.pathOptions.anchors = settings.pathAnchors.filter(
      (pattern): pattern is string => typeof pattern === 'string'
    );
  }
  if (typeof settings.pathShowFileName === 'boolean') {
    state.pathOptions.showFileName = settings.pathShowFileName;
  }
}

function post(message: unknown): void {
  vscode.postMessage(message);
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  try {
    handleHostMessage(event.data);
  } catch (error) {
    // 出问题时报回宿主，避免「什么都没显示也没有任何提示」
    post({
      type: 'error',
      message: `${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}`,
    });
  }
});

function handleHostMessage(message: HostMessage): void {
  switch (message.type) {
    case 'init': {
      // 全量同步：先用摘要重建标签栏，再放当前活动会话的图。
      state.sessions.clear();
      state.order = [];
      state.loading.clear();
      // 按会话索引的本地表也要一起清（与 update 的删除口径保持一致）：
      // 留着只会在恢复出来的会话上套用上一次的收起状态。
      state.viewports.clear();
      state.collapsed.clear();
      // 收起状态**必须用宿主那一份还原**（不是简单地清空）：宿主仍按它算坐标，
      // 清空会让「收起的子树」既没有坐标、又不在本地的收起集合里 —— 父框画着 − 号、
      // 子框一个都不画，用户要点两下才恢复（也是「界面与宿主分叉」）。
      for (const entry of message.collapsed ?? []) {
        if (typeof entry?.sessionId === 'string' && Array.isArray(entry.ids)) {
          state.collapsed.set(entry.sessionId, new Set(entry.ids));
        }
      }
      pendingExpandAll = undefined;
      state.centerRequest = undefined;
      // 设置随 init 一起下发；字段缺失时保留当前值（旧宿主也能用）
      state.stickyParent = message.settings?.stickyParent ?? state.stickyParent;
      state.showLocation = message.settings?.showLocation ?? state.showLocation;
      applyPathSettings(message.settings);
      // 临时路径过滤：把宿主那一份查询还原到输入框（面板重建时输入框是空的）。
      // 只在宿主明确给了字段时改写 —— 旧宿主不带这个字段，不能把用户正在输入的文字清掉。
      if (pathFilterInputEl && typeof message.pathFilterQuery === 'string') {
        pathFilterInputEl.value = message.pathFilterQuery;
      }
      for (const summary of message.summaries ?? []) {
        state.sessions.set(summary.id, {
          id: summary.id,
          title: summary.title,
          description: summary.description,
          direction: summary.direction,
          engineLabel: '',
          // 占位会话也要带上角标：init 只给**活动会话**完整 payload，其余标签在收到各自的
          // sessionUpdate 之前只有这份摘要。漏掉它的话，重载窗口后除活动标签外都没有引擎角标。
          badge: summary.badge,
          rootId: '',
          nodes: {},
          edges: [],
          boxes: {},
          collapsedCount: 0,
        });
        state.order.push(summary.id);
      }
      for (const session of message.sessions) {
        const existing = state.sessions.get(session.id);
        state.sessions.set(session.id, session);
        if (!existing) {
          state.order.push(session.id);
        }
      }
      state.activeId = message.activeId || state.order[state.order.length - 1];
      state.selected = undefined;
      render();
      break;
    }
    case 'sessionUpdate': {
      const session = message.session;
      const existing = state.sessions.get(session.id);
      const isNew = existing === undefined;
      // ⚠️ 「要不要把根方框摆到视图中央」必须按**首次拿到内容**判，不能按 isNew 判。
      // 宿主是先发标签摘要（update）再发内容（sessionUpdate）：addSession 里刚把会话 push 进
      // sessions，紧接着 setViewVisible() 就带着这个新标签发了一次 update，前端于是先建了一个
      // **没有内容的占位会话**。等内容到达时 isNew 已经是 false，居中就永远不会发生 ——
      // 表现是新图停在内容左上角，调用者多的时候连被查询的那个符号都看不见。
      // 反过来，已装好图的会话重发（relayout、回传宽度）不算首次，否则会把用户的滚动位置拽走。
      const hasContent = Object.keys(existing?.nodes ?? {}).length > 0;
      state.sessions.set(session.id, session);
      if (isNew) {
        state.order.push(session.id);
      }
      if (!hasContent) {
        state.centerRequest = session.id;
      }
      // ⚠️ 只有「新会话」才抢活动标签。宿主在 relayout（例如改「显示路径」）时会把
      // 所有会话逐个重新下发一次，无条件设 activeId 会让活动标签跳到最后一个 ——
      // 用户看到的是「标签自己跳了」，而宿主的 activeId 没变，两边就此分叉。
      if (isNew || state.activeId === undefined) {
        state.activeId = session.id;
      }
      // 本会话的本地「正在展开」标记：这次 sessionUpdate 说明这一层数据已经回来了。
      clearSessionLoading(session.id);
      // 到上限时把两个展开按钮置为禁用并写明原因（否则用户点一个必然无效的按钮）
      applyCapacityState(session);
      // 图变了：把 viewBox 原点复位到内容左上角。
      reanchor(session);
      render();
      // 相机：这一帧拿到了新的坐标，展开/收起的滚动调整在这里执行
      applyCameraIntent(session);
      break;
    }
    case 'selectTab': {
      state.activeId = message.id;
      state.selected = undefined;
      render();
      break;
    }
    case 'update': {
      const known = new Set(message.sessions.map((session) => session.id));
      for (const id of [...state.order]) {
        if (!known.has(id)) {
          // 关掉的会话如果还有节点留在「正在展开」里，遮罩会被永久点亮（宿主不会再发
          // 它的 sessionUpdate），所以这里把该会话的标记一并清掉。
          clearSessionLoading(id);
          state.sessions.delete(id);
          state.viewports.delete(id);
          state.collapsed.delete(id);
          // 宽度签名也要回收：会话 id 不复用，留着只是长期占位（与宿主 forgetSession 对应）
          lastReportedWidths.delete(id);
        }
      }
      state.order = message.sessions.map((session) => session.id);
      for (const info of message.sessions) {
        const existing = state.sessions.get(info.id);
        if (existing) {
          existing.title = info.title;
          existing.description = info.description;
          // 角标也要跟着更新（宿主按配置档算好，webview 读不到设置、不该自己猜引擎名）。
          // 漏掉这一句的表现：重载窗口后只有活动标签有引擎角标，其余标签要点一次才出现。
          if (info.badge !== undefined) {
            existing.badge = info.badge;
          }
        } else {
          // 宿主已知但前端还没有内容的会话（例如刚恢复），先占位，等 sessionUpdate。
          state.sessions.set(info.id, {
            id: info.id,
            title: info.title,
            description: info.description,
            direction: info.direction,
            engineLabel: '',
            // 占位会话的 engineLabel 是空的，badge 必须从摘要里带过来，
            // 否则 badgeOf 只能回退到空串（角标不显示）
            badge: info.badge,
            rootId: '',
            nodes: {},
            edges: [],
            boxes: {},
            collapsedCount: 0,
          });
        }
      }
      const requested = message.activeId || state.activeId;
      state.activeId = requested && known.has(requested) ? requested : state.order[0];
      render();
      break;
    }
    case 'settings': {
      // 设置变了（宿主在 onDidChangeConfiguration 里下发）：
      // 只更新开关再重绘一帧，不做别的状态处理。
      state.stickyParent = message.settings?.stickyParent ?? state.stickyParent;
      state.showLocation = message.settings?.showLocation ?? state.showLocation;
      applyPathSettings(message.settings);
      render();
      break;
    }
    case 'busy': {
      // 宿主开始/结束一次较慢的解析（宏、结构体、变量这类要走引用查找的符号）
      hostBusy = message.busy === true;
      if (hostBusy) {
        if (busyLabelEl && typeof message.label === 'string' && message.label.length > 0) {
          busyLabelEl.textContent = message.label;
        }
        updateBusy();
      } else {
        // 结束时用 hideBusy：顺带把文案复位，免得下一阶段沿用上一阶段的文字
        hideBusy();
      }
      break;
    }
  }
}

// 让宿主知道 webview 已经准备好接收初始数据。
post({ type: 'ready' });
