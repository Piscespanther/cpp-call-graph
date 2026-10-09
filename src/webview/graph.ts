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

type HostMessage = InitMessage | SessionUpdateMessage | SelectTabMessage | UpdateMessage;

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
/** 几何缺失时的兜底尺寸（正常路径下不会用到）。与 NODE_HEIGHT / 量宽结果相称。 */
const DEFAULT_BOX_WIDTH = 200;
const NODE_HEIGHT_FALLBACK = 36;
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
 */
function measureTextWidth(text: string, fontSize: number, bold: boolean): number {
  if (!text) {
    return 0;
  }
  const probe = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
  if (bold) {
    probe.setAttribute('font-weight', '600');
  }
  probe.setAttribute('font-size', `${fontSize}px`);
  probe.textContent = text;
  try {
    probe.setAttribute('visibility', 'hidden');
    // 用可选调用：万一调用时机过早（svgEl 尚未取到），也只会退到估算，不会抛错
    svgEl?.appendChild(probe);
    const length = (probe as unknown as { getComputedTextLength?: () => number })
      .getComputedTextLength;
    if (typeof length === 'function') {
      const measured = length.call(probe);
      if (Number.isFinite(measured) && measured > 0) {
        return measured;
      }
    }
    const width = probe.getBBox().width;
    if (Number.isFinite(width) && width > 0) {
      return width;
    }
  } catch {
    // 忽略：退到估算
  } finally {
    // 无论量成功与否都要摘掉，避免残留节点影响后续统计与渲染
    probe.remove();
  }
  return text.length * fontSize * (bold ? 0.66 : 0.6);
}

/**
 * 按内容算方框宽度：取「名称」与「路径:行号」两行里更宽的那个，
 * 右边给加减号留出固定位置（不让它压到文字上）。
 */
function measureBoxWidth(node: GraphNode): number {
  const nameWidth = measureTextWidth(nodeNameText(node), NAME_FONT_SIZE, true);
  const locWidth = measureTextWidth(nodeLocText(node), LOC_FONT_SIZE, false);
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
function reportMeasuredWidths(session: SessionPayload): void {
  const widths: Array<{ id: string; width: number }> = [];
  for (const node of visibleNodes(session)) {
    const geometry = session.boxes[node.id];
    if (geometry) {
      widths.push({ id: node.id, width: geometry.width });
    }
  }
  if (widths.length > 0) {
    post({ type: 'reportWidths', sessionId: session.id, widths });
  }
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
function buildKindIcon(kind: NodeKind): SVGGElement {
  const codicon = KIND_TO_ICON[kind] ?? KIND_TO_ICON.other;
  const icon = svg('g', {
    class: `kind-icon kind-${kind}`,
    transform: `translate(${ICON_X} ${ICON_Y}) scale(${ICON_BOX / 16})`,
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
 * 用户点了「收起全部」（或逐个收起了方框）之后，数据其实还在、只是被本地标记为
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

  for (const edge of session.edges) {
    if (!isVisible(session, edge.from) || !isVisible(session, edge.to)) {
      continue;
    }
    const fromBox = boxOf(session, edge.from);
    const toBox = boxOf(session, edge.to);
    if (!fromBox || !toBox) {
      continue;
    }
    // 边的 from/to 已经带有方向语义（callers 里 from 是调用者、指向左侧的被调用方）。
    // 按实际左右位置取锚点，画成 90° 折线：出方框一小段 → 竖直走 → 水平进目标 → 进方框一小段。
    // 注意：宽度是自适应后逐节点不同的，两个锚点必须各取自己那个方框的几何
    // （曾经两个锚点都用 from 的宽度，目标方框较宽/较窄时箭头就接不上边）。
    const fromGeometry = session.boxes[edge.from];
    const toGeometry = session.boxes[edge.to];
    const fromW = fromGeometry?.width ?? DEFAULT_BOX_WIDTH;
    const toW = toGeometry?.width ?? DEFAULT_BOX_WIDTH;
    const fromH = fromGeometry?.height ?? NODE_HEIGHT_FALLBACK;
    const toH = toGeometry?.height ?? NODE_HEIGHT_FALLBACK;
    const backward = fromBox.x > toBox.x;
    const fromAnchor = backward
      ? { x: fromBox.x, y: fromBox.y + fromH / 2 }
      : { x: fromBox.x + fromW, y: fromBox.y + fromH / 2 };
    const toAnchor = backward
      ? { x: toBox.x + toW, y: toBox.y + toH / 2 }
      : { x: toBox.x, y: toBox.y + toH / 2 };

    // 出/入方框各画一小段直奔线（直角拐弯），让箭头看起来是一条清晰的折线。
    // 14px 是视觉上调出来的：太小会被方框边框「吃掉」，看起来像箭头很短。
    const stub = 14;
    const startX = fromAnchor.x + (backward ? -stub : stub);
    const endX = toAnchor.x + (backward ? stub : -stub);
    const path = svg('path', {
      d:
        `M ${fromAnchor.x} ${fromAnchor.y} ` +
        `L ${startX} ${fromAnchor.y} ` +
        `L ${startX} ${toAnchor.y} ` +
        `L ${endX} ${toAnchor.y} ` +
        `L ${toAnchor.x} ${toAnchor.y}`,
      class: 'edge',
    });
    const toNode = session.nodes[edge.to];
    if (toNode?.isCycle) {
      path.classList.add('cycle');
    }
    edgesEl.appendChild(path);
  }

  for (const node of visibleNodes(session)) {
    const position = boxOf(session, node.id);
    const geometry = session.boxes[node.id];
    if (!position || !geometry) {
      continue;
    }
    nodesEl.appendChild(renderNode(session, node, position, geometry));
  }

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
    ]
      .filter(Boolean)
      .join(' '),
    transform: `translate(${position.x} ${position.y})`,
    'data-node': node.id,
  });

  group.appendChild(
    svg('rect', { class: 'box', width: geometry.width, height: geometry.height, rx: 0 })
  );

  // 第一行开头放符号角标（模仿 VS Code 的小图标），文字从图标右侧开始。
  group.appendChild(buildKindIcon(node.kind));

  // 两行布局：第一行「图标 + 名称 + 加减号」，第二行「文件路径:行号」。
  // 方框宽度已按这两行的实际渲染宽度量好（measureSessionWidths），
  // 所以文字不会溢出，右边的加减号也不会压到文字上。
  const nameText = svg('text', { x: TEXT_X, y: NAME_BASELINE, class: 'name' });
  nameText.textContent = nodeNameText(node);
  group.appendChild(nameText);

  const locText = svg('text', { x: TEXT_X, y: LOC_BASELINE, class: 'loc' });
  locText.textContent = nodeLocText(node);
  group.appendChild(locText);

  const title = svg('title', {});
  title.textContent = buildTooltip(node);
  group.appendChild(title);

  // 单击：选中并高亮这个方框（按需求；跳转仍然是双击）。
  // 注意事件顺序：单击先触发、双击后触发，所以双击时会先选中再跳转——
  // 这正是想要的效果（跳转的对象就是刚选中的那个）。
  group.addEventListener('click', (event) => {
    event.stopPropagation();
    markSelected(session, node);
  });

  // 双击才跳转（按需求：单击不再打开文件）。
  // 同时 preventDefault：双击会让浏览器选词/选中 SVG 文本，留下蓝色选区，
  // 而这里的方框是交互元素，不该出现选区（CSS 里也做了 user-select: none 兜底）。
  group.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    event.preventDefault();
    // 兜底再选一次，保证「复制元素 / 复制地址」复制的就是跳转的对象
    markSelected(session, node);
    post({ type: 'openLocation', nodeId: node.id, sessionId: session.id });
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
    transform: `translate(${geometry.width - ICON_X - EXPANDER_BOX / 2} ${ICON_Y + ICON_BOX / 2})`,
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
      ? `展开：${node.direction === 'callers' ? '谁调用了' : '它调用了谁'} ${node.name}`
      : mode === 'collapse'
        ? `收起 ${node.name} 的下一层`
        : mode === 'loading'
          ? '正在加载…'
          : '没有下一层调用关系';
  expander.appendChild(tip);

  if (mode === 'leaf') {
    // 叶子：不可点，只是占位保持视觉一致
    return expander;
  }

  expander.addEventListener('mousedown', (event) => {
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
      render();
    } else {
      const session = state.sessions.get(sessionId);
      const node = session?.nodes[nodeId];
      if (session && node && !state.loading.has(nodeId)) {
        if (node.loaded) {
          // 数据已有，只是被收起过：直接展开，不需要再问语言服务
          collapsedSet(sessionId).delete(nodeId);
          render();
        } else {
          state.loading.add(nodeId);
          // 以被点的方框为基准，展开后它不要在屏幕上跳动
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
  render();
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
      state.activeId = session.id;
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
  }
}

// 让宿主知道 webview 已经准备好接收初始数据。
post({ type: 'ready' });
