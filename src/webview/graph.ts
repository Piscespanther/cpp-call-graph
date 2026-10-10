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
  rootId: string;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  boxes: Record<string, Box>;
  collapsedCount: number;
}

interface SessionSummary {
  id: string;
  title: string;
  description: string;
  direction: Direction;
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
}

/** 需要下发给 webview 的设置项（与宿主 settingsPayload() 一一对应）。 */
interface WebviewSettings {
  /** 纵向滚动时把父方框钉在窗口垂直中央。 */
  stickyParent?: boolean;
  /** 方框里是否显示「文件路径:行号」那一行。 */
  showLocation?: boolean;
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

/** 遮罩延迟：快查询不闪一下（毫秒）。 */
const BUSY_DELAY_MS = 240;
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
 * 与本地正在展开某个方框（`state.loading`）。延迟一小会儿才显示，避免快查询闪一下。
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
  selected: undefined as string | undefined,
  loading: new Set<string>(),
  /** 每个会话里被手动收起的节点（只影响显示，不丢数据）。 */
  collapsed: new Map<string, Set<string>>(),
  /** 待居中的会话：新查询时把根方框摆到视图中间。 */
  centerRequest: undefined as string | undefined,
  /** 由宿主下发的设置：纵向滚动时是否把父方框钉在窗口垂直中央。 */
  stickyParent: true,
  /** 由宿主下发的设置：方框里是否显示「文件路径:行号」那一行。 */
  showLocation: true,
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

/** 常量：文字截断上限与方框宽度范围。 */
const NAME_MAX_CHARS = 30;
const LOC_MAX_CHARS = 40;
/** 方框最小宽度：太窄会显得像个方块，且放不下加减号。 */
const MIN_BOX_WIDTH = 120;
/**
 * 方框最大宽度：防病态长名把画布撑爆。
 *
 * 这个值必须**明显大于**「文字上限宽 + 加减号预留」，否则会把方框钳窄，
 * 文字被截断后仍顶到加减号上（曾经取 320 就踩了这个坑，实测压住 0.8px）。
 * 当前文字上限约 40 字符 ≈ 300px，加两侧预留约 320，故取 400 留出余量。
 */
const MAX_BOX_WIDTH = 400;
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
/** 两行文字的字号，与 graph.css 里的 .name / .loc 保持一致（量宽要用）。 */
const NAME_FONT_SIZE = 13;
const LOC_FONT_SIZE = 12;

/** 节点上显示的名称（与 renderNode 里的写法保持一致，含循环标记）。 */
function nodeNameText(node: GraphNode): string {
  return `${node.isCycle ? '↻ ' : ''}${truncateMiddle(node.name, NAME_MAX_CHARS)}`;
}

/** 节点上显示的「路径:行号」。 */
function nodeLocText(node: GraphNode): string {
  return `${shortenPath(node.file, LOC_MAX_CHARS)}:${node.line}`;
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
 *   ① 结果按「文字 + 字号 + 粗细」缓存（同名元素在后续帧里直接命中，开销归零）；
 *   ② 探测节点常驻复用，不再每次新建 / 挂载 / 摘除（少大量 DOM 变更）。
 * 只缓存**量成功**的结果：退到估算时不缓存，免得一帧的失败被永久记住。
 */
const MEASURE_CACHE_LIMIT = 4000;
const measureCache = new Map<string, number>();
let measureProbe: SVGTextElement | undefined;

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
  const key = `${fontSize}|${bold ? 'b' : 'n'}|${text}`;
  const cached = measureCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const probe = probeElement();
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
    if (measureCache.size >= MEASURE_CACHE_LIMIT) {
      measureCache.clear();
    }
    measureCache.set(key, measured);
    return measured;
  }
  return text.length * fontSize * (bold ? 0.66 : 0.6);
}

/**
 * 按内容算方框宽度：取「名称」与「路径:行号」两行里更宽的那个，
 * 右边给加减号留出固定位置（不让它压到文字上）。
 */
function measureBoxWidth(node: GraphNode): number {
  const nameWidth = measureTextWidth(nodeNameText(node), NAME_FONT_SIZE, true);
  // 关掉「显示路径」时方框只按名称算宽 —— 否则右边会空出一整块（路径那一行的宽度）
  const locWidth = state.showLocation
    ? measureTextWidth(nodeLocText(node), LOC_FONT_SIZE, false)
    : 0;
  const content = Math.max(nameWidth, locWidth);
  const total = TEXT_X + content + EXPANDER_GAP + EXPANDER_BOX + ICON_X + WIDTH_SAFETY;
  return Math.min(MAX_BOX_WIDTH, Math.max(MIN_BOX_WIDTH, Math.ceil(total)));
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
function markSelected(session: SessionPayload, node: GraphNode): void {
  if (state.selected === node.id) {
    return;
  }
  state.selected = node.id;
  post({ type: 'selectNode', nodeId: node.id, sessionId: session.id });
  render();
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

/** 图变了：把 viewBox 原点复位到内容左上角。 */
function reanchor(session: SessionPayload): void {
  const bounds = contentBounds(session);
  state.viewports.set(session.id, { x: bounds.x, y: bounds.y });
}

function activeSession(): SessionPayload | undefined {
  return state.activeId ? state.sessions.get(state.activeId) : undefined;
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
 * 注意别写成 `visibleNodes` 那种直接 pop 的栈式遍历：那样兄弟节点是**倒序**的。
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
    tab.title = `${session.direction === 'callers' ? '被调用关系' : '调用关系'} · ${session.description}${session.engineLabel ? ` · ${session.engineLabel}` : ''}`;

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = session.title;
    tab.appendChild(label);

    // 元素名右侧放方向图标：进来 = 被调用关系，出去 = 调用关系。
    // 方向原先是用「被调用:名字」这种前缀表达的，既啰嗦又占地方，改成图标。
    tab.appendChild(createDirectionIcon(session.direction));

    if (state.order.length > 1 && session.engineLabel) {
      const engine = document.createElement('span');
      engine.className = 'tab-engine';
      engine.textContent = shortEngine(session.engineLabel);
      tab.appendChild(engine);
    }

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.title = '关闭这个标签';
    close.textContent = '✕';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      post({ type: 'closeTab', id });
    });
    tab.appendChild(close);

    tab.addEventListener('click', () => {
      post({ type: 'selectTab', id });
    });
    tabsEl.appendChild(tab);
  }
  tabsEl.style.display = state.order.length > 0 ? 'flex' : 'none';
  toolbarEl.classList.toggle('is-empty', state.order.length === 0);
}

function shortEngine(label: string): string {
  if (label.startsWith('clangd')) {
    return 'clangd';
  }
  if (label.includes('cpptools')) {
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

  // 视口（见最上方「视口模型」的说明）：
  //   SVG 元素尺寸 = viewBox 尺寸 = 内容尺寸，1 内容单位恒等于 1 像素。
  //   没有缩放功能，平移交给滚动条；界面尺寸永远与实际像素 1:1。
  const view = readView(session);
  const contentSize = contentBounds(session);
  const width = Math.max(1, contentSize.width);
  const height = Math.max(1, contentSize.height);
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
  const group = svg('g', {
    class: [
      'node',
      node.depth === 0 ? 'root' : '',
      node.isCycle ? 'cycle' : '',
      state.selected === node.id ? 'selected' : '',
      searchState.hits.has(node.id) ? 'match' : '',
      currentMatchId() === node.id ? 'match-current' : '',
    ]
      .filter(Boolean)
      .join(' '),
    // 链上节点各自带上自己的粘性位移：纵向滚动时它们都停在视口垂直中央（见「粘性父框」一节）
    transform: `translate(${position.x} ${position.y + stickyShiftOf(node.id)})`,
    'data-node': node.id,
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
    const hitWidth = measureTextWidth(displayName, NAME_FONT_SIZE, true);
    group.appendChild(
      svg('rect', {
        class: 'name-hit',
        x: TEXT_X - NAME_HIT_PAD_X,
        y: nameBaseline - NAME_HIT_ABOVE,
        width: Math.max(1, Math.ceil(hitWidth) + NAME_HIT_PAD_X * 2),
        height: NAME_HIT_HEIGHT,
        rx: 2,
      })
    );
  }

  const nameText = svg('text', { x: TEXT_X, y: nameBaseline, class: 'name' });
  nameText.textContent = displayName;
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
  // 用 mousedown 记录、window mouseup 统一处理，避免冒泡顺序把点击吃掉。
  //
  // 模式判定顺序很关键（曾经写错导致「减号永远不出现、折叠不了」）：
  //   node.canExpand 在**子节点已加载**后依然是 true，所以不能把它放在前面，
  //   否则「已展开、有子节点」的节点会拿到 expand 模式（显示加号），
  //   点下去走的是「展开」分支（对已加载节点是空操作），折叠分支成了死代码。
  //   正确顺序：先判「已展开且有子节点」→ collapse，再判「可展开或已被收起」→ expand。
  const isCollapsed = collapsedSet(session.id).has(node.id);
  const hasVisibleChildren = !isCollapsed && node.children.length > 0;
  if (state.loading.has(node.id)) {
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
  return `${node.name}\n${node.file}:${node.line}`;
}

/** 从中间截断，保留首尾，适合函数名（如 veryLongFunctionName → veryLong…Name）。 */
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** 路径太长时保留结尾几段，避免文字溢出方框（完整路径在 tooltip 里）。 */
function shortenPath(file: string, max: number): string {
  if (file.length <= max) {
    return file;
  }
  const parts = file.split(/[\\/]/);
  let result = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const candidate = `${parts[i]}/${result}`;
    if (candidate.length + 1 > max) {
      break;
    }
    result = candidate;
  }
  return `…/${result}`;
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
      collapsedSet(sessionId).add(nodeId);
      // 收起状态变了：让宿主按「收起的子树不占高度」重算一次坐标
      postCollapsed(sessionId);
      render();
    } else {
      const session = state.sessions.get(sessionId);
      const node = session?.nodes[nodeId];
      if (session && node && !state.loading.has(nodeId)) {
        if (node.loaded) {
          // 数据已有，只是被收起过：直接展开，不需要再问语言服务
          collapsedSet(sessionId).delete(nodeId);
          postCollapsed(sessionId);
          render();
        } else {
          state.loading.add(nodeId);
          // 以被点的方框为基准，展开后它不要在屏幕上跳动。
          // （粘性父框开着时，紧接着这一帧会把它钉到视口中央 —— 以那条不变式为准；
          //   关掉设置或内容本来就不高时，才由这里保住它的屏幕位置。）
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
 * 从事件目标往上找带 data-action 的菜单项。
 *
 * 不用 `closest()`：它属于 Element 接口，测试桩与部分环境不一定提供，
 * 自己走 parentNode 更稳，逻辑也只有几行。
 */
function findMenuAction(target: EventTarget | null): string | undefined {
  let node = target as (HTMLElement & { parentNode?: Node | null }) | null;
  const guard = new Set<unknown>();
  while (node && !guard.has(node)) {
    guard.add(node);
    const action = (node as HTMLElement).getAttribute?.('data-action');
    if (action) {
      return action;
    }
    node = (node.parentNode as typeof node) ?? null;
  }
  return undefined;
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
// 用 scheduleStickyFrame 合并：滚动事件密度远高于帧率，逐个处理等于白做几十次。
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

/** 某个节点这一帧的粘性位移（没被钉住就是 0）。 */
function stickyShiftOf(nodeId: string): number {
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
function refreshSticky(session: SessionPayload): void {
  stickyPinned = stickyPinnedIds(session);
  stickyShifts = stickyEnabled(session) ? computeStickyShifts(session) : new Map<string, number>();
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
 * 渲染时用它画、滚动时用它重画 —— 同一份几何，避免两处算法各写一遍后漂移。
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
  // 出/入方框各画一小段直奔线（直角拐弯）。14px 是视觉调出来的：太小会被方框边框吃掉。
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

/** 上一次写进 transform 的字符串：没变就不写 DOM（写 attribute 会触发重新布局）。 */
const lastStickyTransform = new WeakMap<Element, string>();

/**
 * 滚动时逐帧调用：只改「方框的位置」与「被钉住方框相关的连线」，不重建整棵树。
 * （重建要重新量所有方框宽度、重排连线，滚动时那样做会卡。）
 *
 * 两个早退：没开粘性、或这一帧没有任何「已展开下一层」的方框可钉 —— 此时各节点在
 * render() 里写下的 transform 已经是正确位置，白算一遍没有任何收益。
 */
function applyStickyFrame(): void {
  if (!state.stickyParent || stickyPinned.length === 0) {
    return;
  }
  const session = activeSession();
  if (!session) {
    return;
  }
  refreshSticky(session);
  // 每个可见方框都按自己的位移摆好（被钉住的父框在中央，叶子跟着自己的父框）
  for (const element of nodesEl.children) {
    const id = element.getAttribute?.('data-node');
    const box = id ? session.boxes[id] : undefined;
    if (!id || !box) {
      continue;
    }
    const transform = `translate(${box.x} ${box.y + stickyShiftOf(id)})`;
    // 位移没变就别写 DOM：写 attribute 会让浏览器重新布局这一棵子树
    if (lastStickyTransform.get(element) !== transform) {
      lastStickyTransform.set(element, transform);
      element.setAttribute('transform', transform);
    }
  }
  for (const item of stickyEdges) {
    const geometry = edgeGeometry(session, item);
    if (geometry) {
      item.path.setAttribute('d', geometry.d);
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
  // 在中文或下划线相邻处判定很反直觉（例如 bsp_boot 里的 boot 不会被当成整词）。
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
    if (!matcher(node.name)) {
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
      const hidden = searchState.hidden > 0 ? ` +${searchState.hidden}` : '';
      countEl.textContent = `${searchState.index + 1}/${searchState.matches.length}${hidden}`;
      countEl.classList.remove('empty');
    }
    countEl.title = searchState.hidden > 0 ? `另有 ${searchState.hidden} 个命中在已收起的节点里` : '';
  }
  document.getElementById('search-input')?.classList.toggle('invalid', searchState.invalid);

  const toggles: Array<[string, boolean]> = [
    ['btn-search-case', searchState.caseSensitive],
    ['btn-search-word', searchState.wholeWord],
    ['btn-search-regex', searchState.regex],
  ];
  for (const [id, on] of toggles) {
    document.getElementById(id)?.classList.toggle('on', on);
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
  // 重绘一帧让「当前命中」的高亮跟过去，再把那个方框滚到视图中间
  render();
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
    render();
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

  const toggleWiring: Array<[string, 'caseSensitive' | 'wholeWord' | 'regex']> = [
    ['btn-search-case', 'caseSensitive'],
    ['btn-search-word', 'wholeWord'],
    ['btn-search-regex', 'regex'],
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
    if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      searchInputEl.focus();
    }
  });
}

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
});

// ------------------------------------------------------------ 与宿主通信

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
      // 留着只会白占内存，还可能在恢复出来的会话上套用上一次的收起状态。
      state.viewports.clear();
      state.collapsed.clear();
      pendingExpandAll = undefined;
      state.centerRequest = undefined;
      // 设置随 init 一起下发；字段缺失时保留当前值（旧宿主也能用）
      state.stickyParent = message.settings?.stickyParent ?? state.stickyParent;
      state.showLocation = message.settings?.showLocation ?? state.showLocation;
      for (const summary of message.summaries ?? []) {
        state.sessions.set(summary.id, {
          id: summary.id,
          title: summary.title,
          description: summary.description,
          direction: summary.direction,
          engineLabel: '',
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
      const isNew = !state.sessions.has(session.id);
      state.sessions.set(session.id, session);
      if (isNew) {
        state.order.push(session.id);
        // 新查询：等这一帧画完后把根方框摆到视图中间
        state.centerRequest = session.id;
      }
      // ⚠️ 只有「新会话」才抢活动标签。宿主在 relayout（例如改「显示路径」）时会把
      // 所有会话逐个重发一遍，无条件设 activeId 会让活动标签跳到最后一个 ——
      // 用户看到的是「标签自己跳了」，而宿主的 activeId 没变，两边就此分叉。
      if (isNew || state.activeId === undefined) {
        state.activeId = session.id;
      }
      for (const id of Object.keys(session.nodes)) {
        state.loading.delete(id);
      }
      // 图变了：把 viewBox 原点复位到内容左上角。
      reanchor(session);
      render();
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
          // 它的 sessionUpdate），所以这里按节点 id 一并清掉。
          const gone = state.sessions.get(id);
          if (gone) {
            for (const nodeId of Object.keys(gone.nodes)) {
              state.loading.delete(nodeId);
            }
          }
          state.sessions.delete(id);
          state.viewports.delete(id);
          state.collapsed.delete(id);
        }
      }
      state.order = message.sessions.map((session) => session.id);
      for (const info of message.sessions) {
        const existing = state.sessions.get(info.id);
        if (existing) {
          existing.title = info.title;
          existing.description = info.description;
        } else {
          // 宿主已知但前端还没有内容的会话（例如刚恢复），先占位，等 sessionUpdate。
          state.sessions.set(info.id, {
            id: info.id,
            title: info.title,
            description: info.description,
            direction: info.direction,
            engineLabel: '',
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
