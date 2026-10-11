/**
 * 图布局引擎（方案 B）。
 *
 * 输入是一棵已展开的关系树，输出每个函数框的绝对坐标。
 *
 * 布局规则（与需求一致）：
 *   - 根永远在最左列（x = 0）；
 *   - 调用关系 / 引用关系：相关节点依次向右排开，箭头 左 → 右；
 *   - 被调用关系 / 被引用关系：相关节点同样向右排开，箭头 右 → 左（谁指向了根）。
 *   - 同一列内的框上下并列；父框垂直居中于其子框整体范围。
 */
import {
  GraphEdge,
  GraphLayout,
  GraphNode,
  LayoutBox,
  flowsRight,
} from './graphTypes';
import { logWarn } from '../util/log';

export type {
  CallSite,
  GraphEdge,
  GraphLayout,
  GraphNode,
  LayoutBox,
} from './graphTypes';

/**
 * 节点框宽度：仅作为**兜底/初始值**。
 * 实际宽度由 webview 按两行文字的实测宽度决定（见 graph.ts 的 measureBoxWidth），
 * 这里给出的是宿主排布列位置时的保守估宽基础（见 estimateBoxWidth）。
 */
export const NODE_WIDTH = 230;
/**
 * 方框高度。两行文字的墨迹各约 12 / 10px。
 *
 * 按需求调的优先级：**行间空隙要够大**（不能让两行看着挤），
 * 同时**路径到下边框要小**。当前取值为：
 *   名称上方留白 6px、两行墨迹之间留 6px、路径下方留白 9px
 * 注意这里**不再追求上下留白相等**——加大行距必然占掉空间，
 * 因此下留白略大于上留白是可接受的（曾有一版要求对称，已按新需求放宽）。
 * 改这里必须同步改 webview 里的 NAME_BASELINE / LOC_BASELINE / ICON_Y，
 * 并按**真实字体墨迹**复核（只比基线差会算错）。
 */
export const NODE_HEIGHT = 43;
/**
 * **单行**方框的高度：设置 `cppCallGraph.showLocation` 关掉时用（方框里只有元素名）。
 *
 * 26 = 13px 粗体名称的墨迹（基线上方 9 / 下方 3）加上下各 7px 留白。
 * 改这里必须同步改 webview 里 `nameBaselineFor()` / `iconYFor()` 的口径
 * （基线取 框高/2 + 3，图标在框里垂直居中）。
 */
export const NODE_HEIGHT_COMPACT = 26;
/** 左侧留一点内边距，但第一个方框基本贴着左边缘。 */
export const MARGIN_LEFT = 16;
export const MARGIN_TOP = 10;
/**
 * 列间距：这是**箭头真正可见的那一段**。
 *
 * 曾经固定为 46，那时列宽也固定 230、而方框按内容可更宽，方框越过列边界
 * 把这个间隙吃掉，箭头看起来「太短或被盖住」。现在列宽按内容算、间隙有保证，
 * 取 52 作为适中值（56 看着偏长，46 又偏短）。
 */
const COLUMN_GAP = 52;
const ROW_GAP = 12;
/** 防止病态数据把布局撑爆。 */
/**
 * 排布上限：图特别大时不把整张图都算坐标（一帧要排几千个方框会拖垮交互）。
 *
 * ⚠️ 必须 ≥ 宿主的「展开全部」节点预算（`graphView.MAX_EXPAND_NODES = 800`）：
 * 否则展开全部明明抓回了 800 个节点，布局却只画 500 个 → 用户看到方框凭空消失。
 * renderCheck 里有「MAX_LAYOUT_NODES ≥ MAX_EXPAND_NODES」的源码级断言钉住这条关系。
 */
const MAX_LAYOUT_NODES = 800;

/**
 * 方框最大宽度：防病态长名把画布撑爆。
 *
 * 这个值必须**明显大于**「文字上限宽 + 加减号预留」，否则会把方框钳窄，
 * 文字被截断后仍顶到加减号上（曾经取 320 就踩了这个坑，实测压住 0.8px）。
 * 当前文字上限约 40 字符 ≈ 300px，加两侧预留约 320，故取 400 留出余量。
 * 与 webview 里的同名常量必须保持一致。
 */
/**
 * 方框宽度的上限。
 *
 * ⚠️ 不能只按 ASCII 估：路径截断上限是 40 个字符（再加 `:行号`），而**全角**字符的字身约 1 倍字号
 * —— 最坏情形 45 个全角字符 ≈ 540px 文字，加上左侧起点 22 与右侧留白（10+13+5+6）共 596px。
 * 上限若按 ASCII 的 400，这类路径会被钳住 → 文字画出方框右边、压到加减号。
 * 因此按「最坏字身 + 全部留白」定成 600（两侧各一份，renderCheck 有等值断言）。
 */
export const MAX_BOX_WIDTH = 600;
/** 方框最小宽度：太窄会显得像个方块，且放不下加减号。 */
const MIN_BOX_WIDTH = 120;
/** 文字截断上限，必须与 webview 里的一致，否则估宽会和实际文字对不上。 */
const NAME_MAX_CHARS = 30;
const LOC_MAX_CHARS = 40;
/**
 * 每字符宽度占字号的千分比，用于宿主侧估宽。
 *
 * 校准依据（真实字体 Consolas）：13px 粗体约 6.9px/字符（0.53em），
 * 12px 常规约 5.8px/字符（0.49em）。这里取 800（0.8em）作为**保守上界**——
 * webview 有精确测量，宿主只要不低估即可；取太大会把列推得极远、箭头拉得很长
 * （曾用 1300，等于 17px/字符，是实际值的 2~3 倍，箭头长到不合理）。
 * 中文字符比英文宽，0.8em 对中文偏小，但中文路径少见，且列间还有 COLUMN_GAP 兜底。
 */
const CHAR_WIDTH_MILLI = 800;

/** 与 webview 的 truncateMiddle 等价（用于估宽，必须同步改）。 */
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** 与 webview 的 displayPathText 等价（用于估宽，必须同步改）。 */
/**
 * 路径在方框里怎么显示（设置项 `cppCallGraph.pathDisplay` / `pathTailLevels` / `pathAnchors`）。
 *
 * ⚠️ 这份逻辑在宿主与 webview 各有一份（宿主用来估宽、webview 用来渲染），
 * **改动必须同步**；renderCheck 里有跨侧等值断言（同一批路径两边算出的字符串必须一致）。
 */
export interface PathDisplayOptions {
  /** `tail`：省略中间目录；`full`：宽度允许时显示整条路径。 */
  mode: 'tail' | 'full';
  /** 末尾保留几层（含文件名）；**0 = 按字符预算自动**，即 0.20 及以前的行为。 */
  tailLevels: number;
  /**
   * 必须显示的目录段，可任意组合多层。每条模式只保留**它自己解析出的那一段**，
   * 因此「基准目录不显示、只显示偏移出来的那一段」是天然支持的；要连基准一起显示，
   * 把它也单列一条即可。写法：
   *
   *   `名字`        该名字的那一段（大小写不敏感，取最左命中）
   *   `名字+N`      先按名字定位，再**向下**偏移 N 层（N > 0）
   *   `名字-N`      先按名字定位，再**向上**偏移 N 层
   *   `+N`          从工作区根数第 N 段（1 = 最左那一段）
   *   `-N`          从文件名往上数第 N 段（1 = 文件所在目录）
   *
   * 越界或名字未命中时该条忽略（宿主会记一条警告；webview 只忽略，保持两侧输出一致）。
   * 解析顺序：先按整串名字精确匹配，再按「名字 + 偏移」，最后按纯偏移 ——
   * 这样目录名本身带 `-`（如 `chip-01`）也不会被误当成偏移。
   */
  anchors: string[];
}

export const DEFAULT_PATH_OPTIONS: PathDisplayOptions = {
  mode: 'tail',
  tailLevels: 0,
  anchors: [],
};

/**
 * 把锚点模式解析成段下标。
 *
 * @returns indexes 命中的段下标；invalid 无法解析或越界的模式（宿主据此记警告）
 */
export function resolveAnchorIndexes(
  parts: string[],
  patterns: readonly string[]
): { indexes: Set<number>; invalid: string[] } {
  const indexes = new Set<number>();
  const invalid: string[] = [];
  for (const raw of patterns) {
    const pattern = String(raw ?? '').trim();
    if (!pattern) {
      continue;
    }
    const lower = parts.map((part) => part.toLowerCase());
    // ① 整串就是一个真实目录名（优先，避免 `chip-01` 被当成偏移）
    const exact = lower.indexOf(pattern.toLowerCase());
    if (exact >= 0) {
      indexes.add(exact);
      continue;
    }
    // ② 名字 + 偏移
    const named = /^(.+?)([+-])(\d+)$/.exec(pattern);
    if (named) {
      const base = lower.indexOf(named[1].toLowerCase());
      if (base < 0) {
        invalid.push(pattern);
        continue;
      }
      const offset = Number.parseInt(named[3], 10) * (named[2] === '-' ? -1 : 1);
      const index = base + offset;
      if (index >= 0 && index < parts.length) {
        indexes.add(index);
      } else {
        invalid.push(pattern);
      }
      continue;
    }
    // ③ 纯偏移
    const plain = /^([+-])(\d+)$/.exec(pattern);
    if (plain) {
      const count = Number.parseInt(plain[2], 10);
      // `+N` 从根数（1 = 最左一段）；`-N` 从文件名往上数（1 = 文件所在目录）
      const index = plain[1] === '+' ? count - 1 : parts.length - 2 - (count - 1);
      if (index >= 0 && index < parts.length) {
        indexes.add(index);
      } else {
        invalid.push(pattern);
      }
      continue;
    }
    invalid.push(pattern);
  }
  return { indexes, invalid };
}

/** 已经警告过的锚点模式：逐帧重排时同一个错别字只提示一次。 */
const warnedAnchorPatterns = new Set<string>();

/**
 * 末尾窗口按**字符预算**能放下几段（0.20 及以前的行为，也是 `tailLevels = 0` 的默认口径）。
 *
 * 与当年的 `shortenPath` 同规则：整条放得下就全要；否则从末尾往前累加，
 * 直到再加一段会超出预算（`+1` 是给省略号留的位置）。
 */
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

/** 把「末尾窗口 + 锚点段」拼成显示串：被跳过的连续段压缩成一个 `…`。 */
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

/**
 * 按设置把一条路径变成方框里显示的文字。
 *
 * - `full`：整条放得下就用整条；放不下则保留**首尾**（首部正是能区分 chip/board 的那几段，
 *   尾部是文件名），完整路径始终在悬停提示里。
 * - `tail`：末尾窗口（固定层数，或 `tailLevels = 0` 时按字符预算）+ 锚点段；
 *   锚点**优先保留**，窗口放不下时先缩窗口，实在放不下才退回保留首尾。
 */
export function displayPathText(
  file: string,
  options: PathDisplayOptions = DEFAULT_PATH_OPTIONS,
  max = LOC_MAX_CHARS
): string {
  const parts = file.split(/[\\/]/).filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return file;
  }
  if (options.mode === 'full') {
    return file.length <= max ? file : truncateMiddle(file, max);
  }

  const resolved = resolveAnchorIndexes(parts, options.anchors);
  const anchors = resolved.indexes;
  // 写错的锚点模式要出声，否则用户只会看到"设置没反应"；同一模式只提示一次
  for (const pattern of resolved.invalid) {
    if (!warnedAnchorPatterns.has(pattern)) {
      warnedAnchorPatterns.add(pattern);
      logWarn(
        `路径锚点「${pattern}」无法解析或越界，已忽略。写法：目录名 / 目录名+N / 目录名-N / +N（从根数）/ -N（从文件名往上数）。`
      );
    }
  }

  let tailCount =
    options.tailLevels > 0 ? Math.min(options.tailLevels, parts.length) : budgetTailCount(parts, max);
  // 锚点不能因为窗口太宽而被挤掉：先缩窗口（保留到只剩文件名那一层）
  while (tailCount > 1 && assemblePath(parts, anchors, tailCount).length > max) {
    tailCount -= 1;
  }
  const text = assemblePath(parts, anchors, tailCount);
  return text.length <= max ? text : truncateMiddle(file, max);
}

/** 一段文字的「宽度毫数」（每 1000 毫 = 1 倍字号）。
 *
 * ⚠️ 必须区分 ASCII 与非 ASCII：CJK / 全角标点的字身宽度接近 1 倍字号，
 * 用一个 0.8 的系数去估中文会**明显偏窄** —— 节点名与文件路径都可能含中文或全角标点
 * （例如全角 `！`、`（`），估窄了方框就会压住内容。
 * 估算取保守上界即可：宁可估宽一点，也不要压字。
 */
function textWidthMilli(text: string): number {
  let total = 0;
  for (const character of text) {
    // U+2E80 起是 CJK 部首/汉字，U+FF01 起是全角形式，都按 1 倍字号算
    total += (character.codePointAt(0) ?? 0) > 0x2e7f ? 1000 : CHAR_WIDTH_MILLI;
  }
  return total;
}

/**
 * 估一个节点的方框宽度（宿主侧，用于**排列列位置**）。
 *
 * 与 webview 的 measureBoxWidth 公式保持一致：
 *   TEXT_X(22) + max(名称宽, 路径宽) + 加减号预留
 * 只是把「实测宽」换成「字符宽 × 字号」（见 textWidthMilli）。
 *
 * @param showLocation 方框里是否显示「文件路径:行号」那一行（设置 `cppCallGraph.showLocation`）。
 *   关掉时只按名称估宽，方框才会跟着收窄 —— 否则列位置仍按带路径的宽度排，右边会空一大截。
 * @param pathOptions 路径显示方式（设置项，见 `PathDisplayOptions`）——估宽必须与实际渲染同一口径。
 */
export function estimateBoxWidth(
  node: GraphNode,
  showLocation = true,
  pathOptions: PathDisplayOptions = DEFAULT_PATH_OPTIONS
): number {
  const nameText = `${node.isCycle ? '↻ ' : ''}${truncateMiddle(node.name, NAME_MAX_CHARS)}`;
  const nameWidth = (textWidthMilli(nameText) * 13) / 1000;
  const locText = showLocation
    ? `${displayPathText(node.file, pathOptions, LOC_MAX_CHARS)}:${node.line}`
    : '';
  const locWidth = (textWidthMilli(locText) * 12) / 1000;
  // 22 是文字起点，13 是加减号，5 是右边距，6 是安全余量（与 webview 同口径）
  const total = 22 + Math.max(nameWidth, locWidth) + 10 + 13 + 5 + 6;
  return Math.min(MAX_BOX_WIDTH, Math.max(MIN_BOX_WIDTH, Math.ceil(total)));
}

/**
 * 布局入口。
 *
 * @param measuredWidths webview 回传的**实测方框宽度**（按节点 id）。
 *   宿主无法自行测量文字（没有排版引擎），只能估算；而估算偏大就会把列推远、
 *   箭头拉长。所以 webview 每帧把量到的真实宽度报回来，这里优先采用，
 *   于是「列间距」严格等于 COLUMN_GAP。缺失的节点退回估宽。
 * @param collapsed webview 里**被收起**的节点集合。收起的子树必须当作不存在：
 *   否则它仍然占着高度，同级的兄弟之间会留下一段空荡荡的「空挡」
 *   （用户 2026-10-10 实测反馈：把第三级折叠后第二级的空挡还在）。
 *   这些节点**不会拿到坐标**，等 webview 展开时再来一次布局即可。
 * @param showLocation 方框里是否显示「文件路径:行号」（设置 `cppCallGraph.showLocation`）。
 *   关掉时估宽只算名称，否则 webview 还没回传实测宽度的那一帧会按带路径的宽度排，右边空一截。
 * @param pathOptions 路径显示方式（设置项，见 `PathDisplayOptions`）：
 *   省略策略会改变路径文字的长度，估宽必须与实际渲染用同一份口径，否则列宽与文字对不上。
 */
export function createLayout(
  nodes: Record<string, GraphNode>,
  rootId: string,
  measuredWidths?: Map<string, number>,
  collapsed?: ReadonlySet<string>,
  showLocation = true,
  pathOptions: PathDisplayOptions = DEFAULT_PATH_OPTIONS
): GraphLayout {
  /** 被收起的节点当作叶子：子树既不给坐标，也不占高度。 */
  const kidsOf = (node: GraphNode): string[] => (collapsed?.has(node.id) ? [] : node.children);
  /** 这一版布局用的方框高度：显示路径时两行（43），不显示时单行（26）。 */
  const nodeHeight = showLocation ? NODE_HEIGHT : NODE_HEIGHT_COMPACT;
  const boxes: Record<string, LayoutBox> = {};
  /** 每个节点在第几列（BFS 第一层深度），用于按列平移。 */
  const columnOf = new Map<string, number>();
  /** 每列中最宽的方框，决定列间距。 */
  const columnWidths = new Map<number, number>();
  const stack: string[] = [rootId];
  columnOf.set(rootId, 0);
  // 已排布数量用计数器：原来在循环条件里写 `Object.keys(boxes).length > MAX`，
  // 每轮数一次键是 O(n²)，而且判据是「大于」→ 实际会多放一个（off-by-one）。
  let placed = 0;
  /** 因为超出上限而没拿到坐标的节点（去重后计数，同一节点被多次入栈只算一次）。 */
  const truncatedIds = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || boxes[id] !== undefined) {
      continue;
    }
    if (placed >= MAX_LAYOUT_NODES) {
      truncatedIds.add(id);
      continue;
    }
    const node = nodes[id];
    if (!node) {
      continue;
    }
    boxes[id] = { x: 0, y: 0, width: 0, height: 0 };
    placed += 1;
    const column = columnOf.get(id) ?? 0;
    for (const child of kidsOf(node)) {
      // 同一节点可能被多次入栈，取已记录的最浅列（画面上更靠左，不会盖住）
      const existing = columnOf.get(child);
      const next = column + 1;
      if (existing === undefined || next < existing) {
        columnOf.set(child, next);
      }
      stack.push(child);
    }
  }

  // 截断**不能静默**：以前用户只看到方框少了，不知道是图太大。走输出通道说明。
  // ⚠️ 这段判断必须放在循环**之后**：截断只发生在「已经排满上限」之后，而排满的那一瞬间
  // 还没有任何节点被跳过 —— 早先把警告写在循环内、判据是「已有跳过 && 刚好排满」，
  // 两个条件永远不会同时成立，警告从来没打印过（等于没兑现这条承诺）。
  if (truncatedIds.size > 0) {
    logWarn(
      `图过大：本次只排布了前 ${MAX_LAYOUT_NODES} 个方框，另有 ${truncatedIds.size} 个节点未显示` +
        `（可先收起部分分支，或分次展开）。`
    );
  }

  const heights = new Map<string, number>();
  // 深度优先的迭代后序遍历，避免深树递归爆栈。
  const order: string[] = [];
  {
    const seen = new Set<string>();
    const dfs: string[] = [rootId];
    while (dfs.length > 0) {
      const id = dfs.pop() as string;
      if (seen.has(id) || boxes[id] === undefined) {
        continue;
      }
      seen.add(id);
      order.push(id);
      const node = nodes[id];
      if (node) {
        for (const child of [...node.children].reverse()) {
          dfs.push(child);
        }
      }
    }
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i];
    const node = nodes[id];
    if (!node) {
      continue;
    }
    const kids = kidsOf(node).filter((child) => boxes[child] !== undefined);
    if (kids.length === 0) {
      heights.set(id, nodeHeight);
      continue;
    }
    let sum = 0;
    for (const child of kids) {
      sum += (heights.get(child) ?? nodeHeight) + ROW_GAP;
    }
    heights.set(id, Math.max(nodeHeight, sum - ROW_GAP));
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const place = (id: string, top: number): void => {
    const node = nodes[id];
    if (!node || boxes[id] === undefined) {
      return;
    }
    const subtreeHeight = heights.get(id) ?? nodeHeight;
    const y = top + (subtreeHeight - nodeHeight) / 2;
    // 先按「零偏移」落位，等各列的预估宽度都收齐后再统一平移（见下面 shift 列）。
    // 优先用 webview 回传的实测宽度；没有才退回估宽。
    const measured = measuredWidths?.get(id);
    const width =
      typeof measured === 'number' && Number.isFinite(measured) && measured > 0
        ? Math.min(MAX_BOX_WIDTH, Math.max(MIN_BOX_WIDTH, Math.round(measured)))
        : estimateBoxWidth(node, showLocation, pathOptions);
    boxes[id] = { x: 0, y, width, height: nodeHeight };
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + nodeHeight);
    // breadth：该节点在第几列，供后续按列平移
    const column = columnOf.get(id) ?? 0;
    columnWidths.set(column, Math.max(columnWidths.get(column) ?? 0, boxes[id].width));

    const kids = kidsOf(node).filter((child) => boxes[child] !== undefined);
    let cursor = top;
    for (const child of kids) {
      place(child, cursor);
      cursor += (heights.get(child) ?? nodeHeight) + ROW_GAP;
    }
  };
  place(rootId, 0);

  // 按列平移：第 n 列的 x = 前面各列「最宽方框 + 列间距」之和。
  // 这样列宽随内容变化，方框之间始终留出 COLUMN_GAP，箭头那一段不会被盖住。
  const columnCount = Math.max(0, ...columnWidths.keys()) + 1;
  const columnX: number[] = [];
  let cursorX = 0;
  for (let column = 0; column < columnCount; column += 1) {
    columnX.push(cursorX);
    cursorX += (columnWidths.get(column) ?? MIN_BOX_WIDTH) + COLUMN_GAP;
  }
  for (const id of Object.keys(boxes)) {
    const column = columnOf.get(id) ?? 0;
    boxes[id].x = columnX[column] ?? 0;
    minX = Math.min(minX, boxes[id].x);
    maxX = Math.max(maxX, boxes[id].x + boxes[id].width);
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = NODE_WIDTH;
    maxY = nodeHeight;
  }
  return {
    boxes,
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * 收集整棵树的边。箭头方向按「时间顺序」：
 *   - 被调用 / 被引用：父是被参照的一方，子是指向它的一方 → 箭头由子指向父（向左）；
 *   - 调用 / 引用：父指向子 → 箭头由父指向子（向右）。
 */
export function collectEdges(
  nodes: Record<string, GraphNode>,
  rootId: string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const node = nodes[id];
    if (!node) {
      continue;
    }
    for (const child of node.children) {
      const childNode = nodes[child];
      if (!childNode) {
        continue;
      }
      const forward = flowsRight(childNode.direction);
      edges.push({
        id: `${id}->${child}`,
        from: forward ? id : child,
        to: forward ? child : id,
        depth: childNode.depth,
      });
      stack.push(child);
    }
  }
  return edges;
}
