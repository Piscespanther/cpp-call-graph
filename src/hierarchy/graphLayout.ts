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
const MAX_LAYOUT_NODES = 500;

/**
 * 方框最大宽度：防病态长名把画布撑爆。
 *
 * 这个值必须**明显大于**「文字上限宽 + 加减号预留」，否则会把方框钳窄，
 * 文字被截断后仍顶到加减号上（曾经取 320 就踩了这个坑，实测压住 0.8px）。
 * 当前文字上限约 40 字符 ≈ 300px，加两侧预留约 320，故取 400 留出余量。
 * 与 webview 里的同名常量必须保持一致。
 */
const MAX_BOX_WIDTH = 400;
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

/** 与 webview 的 shortenPath 等价（用于估宽，必须同步改）。 */
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

/**
 * 估一个节点的方框宽度（宿主侧，用于**排列列位置**）。
 *
 * 与 webview 的 measureBoxWidth 公式保持一致：
 *   TEXT_X(22) + max(名称宽, 路径宽) + 加减号预留
 * 只是把「实测宽」换成「字符数 × 字号 × 保守系数」。
 *
 * @param showLocation 方框里是否显示「文件路径:行号」那一行（设置 `cppCallGraph.showLocation`）。
 *   关掉时只按名称估宽，方框才会跟着收窄 —— 否则列位置仍按带路径的宽度排，右边会空一大截。
 */
export function estimateBoxWidth(node: GraphNode, showLocation = true): number {
  const nameText = `${node.isCycle ? '↻ ' : ''}${truncateMiddle(node.name, NAME_MAX_CHARS)}`;
  const nameWidth = (nameText.length * 13 * CHAR_WIDTH_MILLI) / 1000;
  const locText = showLocation ? `${shortenPath(node.file, LOC_MAX_CHARS)}:${node.line}` : '';
  const locWidth = (locText.length * 12 * CHAR_WIDTH_MILLI) / 1000;
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
 */
export function createLayout(
  nodes: Record<string, GraphNode>,
  rootId: string,
  measuredWidths?: Map<string, number>,
  collapsed?: ReadonlySet<string>,
  showLocation = true
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
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || boxes[id] !== undefined || Object.keys(boxes).length > MAX_LAYOUT_NODES) {
      continue;
    }
    const node = nodes[id];
    if (!node) {
      continue;
    }
    boxes[id] = { x: 0, y: 0, width: 0, height: 0 };
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
        : estimateBoxWidth(node, showLocation);
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
