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
 * 占用该间隙，箭头看起来「太短或被盖住」。现在列宽按内容算、间隙有保证，
 * 取 52 作为适中值（56 看着偏长，46 又偏短）。
 */
const COLUMN_GAP = 52;
const ROW_GAP = 12;
/** 防止病态数据把布局撑爆。 */
/**
 * 排布上限：图特别大时不把整张图都算坐标（一帧要排几千个方框会拖垮交互）。
 *
 * ⚠️ 必须 ≥ 宿主的「展开全部」节点预算（`graphView.MAX_EXPAND_NODES = 800`）：
 * 否则展开全部抓回了 800 个节点，布局却只画 500 个 → 用户看到方框凭空消失。
 * renderCheck 里有「MAX_LAYOUT_NODES ≥ MAX_EXPAND_NODES」的源码级断言钉住这条关系。
 */
const MAX_LAYOUT_NODES = 800;

/**
 * 方框最大宽度：防病态长名把画布撑爆。
 *
 * 这个值必须**明显大于**「文字上限宽 + 加减号预留」，否则会把方框钳窄，
 * 文字被截断后仍顶到加减号上（曾经取 320 时出现过该问题，实测压住 0.8px）。
 * 当前文字上限约 40 字符 ≈ 300px，加两侧预留约 320，故取 400 留出余量。
 * 与 webview 里的同名常量必须保持一致。
 */
/**
 * 方框宽度的上限。
 *
 * ⚠️ 0.22 起**没有方框宽度上限**：用户要求「要显示的内容必须完整显示」，所以宽度按实际文字
 * 算，宁可把列推宽（画布可以横向滚动），也不许把名称或路径从中间截断
 * （此前的 600px 钳制会把长度超过它的文字压出方框右边）。
 */
/** 方框最小宽度：太窄会显得像个方块，且放不下加减号。 */
const MIN_BOX_WIDTH = 120;
/**
 * 「省略」模式（`pathTailLevels = 0`）下末尾目录段的字符预算。
 *
 * 这不是截断上限，而是**自动档选择保留几层**的判据：放不下就少留一层，
 * 于是自动档的路径文字本身不会超过这个长度。显式给了层数或锚点时不受它约束，
 * 宽度会照着实际文字长出来。
 */
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
   * 方框里那行路径是否包含最后的文件名（设置 `cppCallGraph.pathShowFileName`）。
   *
   * 关掉后只显示目录部分，`:行号` 仍由调用方拼上；省略/锚点/层数规则照旧作用于目录段。
   * 若去掉文件名后什么都不剩（例如 `main.c` 这种没有目录的路径），退回显示文件名 ——
   * 否则那行会变成光秃秃的 `:12`。
   */
  showFileName?: boolean;
  /**
   * 是否把「锚点命中的那一段目录名」作为标签显示在**元素名同一行**（设置 `cppCallGraph.nameFolderTag`）。
   *
   * 文本形如 `[core] → `，由 `nameTagPrefixFor()` 统一生成（估宽与渲染都用它，避免两侧各写一份格式）；
   * 关掉、或没有命中任何锚点时为 `undefined`。它只影响估宽与那一行的渲染，不参与路径文字的拼装。
   */
  nameFolderTag?: boolean;
  /**
   * 标签的**摆法**（设置 `cppCallGraph.nameFolderTagStyle`）：`arrow` = `[段] → 元素名`（默认，
   * 用户 2026-10-14 确认的格式）；`parenAfter` / `bracketAfter` / `dotAfter` = 元素名在前、
   * 标签以 ` (段)` / ` [段]` / ` · 段` 跟在后面。
   */
  nameFolderTagStyle?: NameFolderTagStyle;
  /**
   * 多个锚点规则同时命中时取哪一段（设置 `cppCallGraph.nameFolderTagPick`）：
   * `first` = `pathAnchors` 里第一个命中的模式（默认）；`deepest` = 最靠文件的那段。
   *
   * ⚠️ 它只在「一条模式能命中**不同文字**（通配/正则/多选）、且没写 `all:`」时才改变结果：
   * 字面量模式命中多处时几处文字一样，取哪个都一样；路径那行更是不看它（永远取最左）。
   * 需要**逐条**指定时，在条目末尾写 `@deepest` / `@first`（见 `parsePattern`），它优先于本项。
   */
  nameFolderTagPick?: NameFolderTagPick;
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
   * **括号决定这个条目还兼作什么**（用户 2026-10-15 口径，也是标签的唯一来源）：
   *   - 不带括号 `src+1` → 只进路径那行；
   *   - 圆括号 `(src+1)` → 路径那行**与**名称行标签都要；
   *   - 方括号 `[src+1]` → **只要标签**，不进路径那行。
   * 括号里可以写多组（`(a)(b)` = 两个标签），末尾可加 `@deepest` / `@first` 逐条指定取值。
   *
   * 越界或名字未命中时该条忽略；**语法**错误会记一条警告，
   * 「在部分路径上没命中」不算错误（多文件图上很常见），只有整个标签里一处都没命中时才提示一次。
   * 解析顺序：先按整串名字精确匹配，再按「名字 + 偏移」，最后按纯偏移 ——
   * 这样目录名本身带 `-`（如 `lib-2`）也不会被误当成偏移。
   */
  anchors: string[];
}

export const DEFAULT_PATH_OPTIONS: PathDisplayOptions = {
  mode: 'tail',
  tailLevels: 0,
  showFileName: true,
  anchors: [],
};

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
 * 段匹配器的解析结果。支持的段写法（`cppCallGraph.pathAnchors` 的条目用这一套，路径那行
 * 与名称行标签共用）：
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
  /**
   * 条目末尾的 `@deepest` / `@first`（可逐条指定取值，优先于设置里的 `nameFolderTagPick`）。
   *
   * 为什么要有它：一个全局开关没法表达「这一条取最靠文件的、那一条取第一个」——
   * 而 `first` / `deepest` 只在模式能命中**不同文字**（通配/正则/多选）时才有区别。
   */
  pick?: NameFolderTagPick;
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
 *   取值：末尾 `@deepest` / `@first`（只影响标签；逐条覆盖 `nameFolderTagPick`）
 *
 * ⚠️ 末段是正则（`re:`）或引号段时不解析偏移：`re:a+1`、`"a+1"` 里的 `+1` 是内容而不是偏移。
 * 同理 `@deepest` 也不解析：目录名真的叫 `x@deepest` 时把它整体加引号即可。
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
  // 逐条的取值后缀（`@deepest` / `@first`）：只影响标签，且优先于设置里的 nameFolderTagPick。
  // ⚠️ 必须排在 isWhollyQuoted **之后** —— 否则 `"x@deepest"` 这种字面量名字会被切掉后缀。
  let pick: NameFolderTagPick | undefined;
  const pickSuffix = /@(deepest|first)$/i.exec(text);
  if (pickSuffix) {
    pick = pickSuffix[1].toLowerCase() === 'deepest' ? 'deepest' : 'first';
    text = text.slice(0, text.length - pickSuffix[0].length).trim();
    if (text.length === 0) {
      return undefined;
    }
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
      pick,
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
    return { raw, exclude, all, keep, fromRoot, offset: 0, specs, pick };
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
    pick,
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
): {
  groups: Array<{ raw: string; all: boolean; pick?: NameFolderTagPick; spans: number[][] }>;
  invalid: string[];
  unmatched: string[];
  excluded: boolean;
} {
  const invalid: string[] = [];
  const unmatched: string[] = [];
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
    return { groups: [], invalid, unmatched, excluded: true };
  }
  const groups: Array<{ raw: string; all: boolean; pick?: NameFolderTagPick; spans: number[][] }> = [];
  for (const plan of plans) {
    if (plan.exclude) {
      continue;
    }
    // `collectAll`：标签链路先**收齐所有命中**，再由 `all:` / `@deepest` / `nameFolderTagPick`
    // 决定取几个。否则匹配阶段已经砍到最左一个，`deepest`（最靠文件）就成了空设置。
    // 路径那行不传它：那里一直是「只保留最左一个」，行为不变。
    const spans = matchSpans(parts, {
      ...plan,
      // ⚠️ `keepEnabled ? plan.keep : false`：传 `keepEnabled` 表示「尊重计划里的 keep」，
      // 不是「强制 keep」—— 写成 `keep: keepEnabled` 会让所有上下文模式都整段保留。
      keep: keepEnabled ? plan.keep : false,
      all: collectAll ? true : plan.all,
    });
    if (spans.length === 0) {
      // ⚠️ 「这条路径上没有该段」**不是**错误：一张图上只要有一个文件不含它就会走到这里。
      // 真正的语法错误在上面（`invalid`）就分开了；「整个标签里一处都没命中」由
      // `unmatchedAnchorPatterns()` 在会话这一层统一报一次（见 graphView.buildPayload）。
      unmatched.push(plan.raw);
      continue;
    }
    groups.push({ raw: plan.raw, all: plan.all, pick: plan.pick, spans });
  }
  return { groups, invalid, unmatched, excluded: false };
}

/**
 * 该条目属于哪种括号语义（用户 2026-10-15 口径，**也是标签的唯一来源**）：
 *
 *   - **圆括号** `(src+1)` / `（src）` → `'both'`：**路径那行与名称行都要**（既当锚点又当标签）；
 *   - **方括号** `[src+1]` / `【src】` → `'tagOnly'`：**只要标签**，**不进路径那行**
 *     （不想让同一个目录在两处各出现一次时用它）；
 *   - 不带括号 → `undefined`：只进路径那行。
 *
 * 与 `parseTagPatterns` 认的四种括号保持一致。
 */
export function tagEntryKind(raw: string): 'both' | 'tagOnly' | undefined {
  const text = String(raw ?? '').trim();
  if (text.length < 3) {
    return undefined;
  }
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '(' && last === ')') || (first === '（' && last === '）')) {
    return 'both';
  }
  if ((first === '[' && last === ']') || (first === '【' && last === '】')) {
    return 'tagOnly';
  }
  return undefined;
}

/** 该条目会不会产生标签（圆括号与方括号都会）。 */
export function isTagEntry(raw: string): boolean {
  return tagEntryKind(raw) !== undefined;
}

/** 该条目是否**只**当标签（方括号）：路径那行要把它排除掉。 */
export function isTagOnlyEntry(raw: string): boolean {
  return tagEntryKind(raw) === 'tagOnly';
}

/**
 * 把锚点模式解析成段下标（**路径那行**用）。
 *
 * ⚠️ 入参应当是**已经剥过括号**的条目（`pathOnlyAnchorPatterns()` 的结果）：
 * 宿主下发给面板的就是那一份，两侧因此拿到同样的模式；把带括号的原文丢进来，
 * 方括号会被当成字面段名、圆括号条目也匹配不上（这正是 `pathOnlyAnchorPatterns` 要解决的问题）。
 *
 * ⚠️ `keep:` 在这里**不生效**（区间被拍平成单段）：路径那行本来就靠列举相邻锚点显示多段
 * （`LIB` + `LIB+1`），若这里也整段保留，同一写法在两条链路里的语义就不同了。有断言钉住。
 *
 * @returns indexes 命中的段下标；invalid **语法**上无法解析的模式
 *   （「这条路径上没有该段」不算错误，见 `unmatchedAnchorPatterns`）
 */
export function resolveAnchorIndexes(
  parts: string[],
  patterns: readonly string[]
): { indexes: Set<number>; invalid: string[] } {
  const { groups, invalid } = planAnchorPatterns(parts, pathOnlyAnchorPatterns(patterns), false);
  const indexes = new Set<number>();
  for (const group of groups) {
    for (const span of group.spans) {
      for (const index of span) {
        indexes.add(index);
      }
    }
  }
  return { indexes, invalid };
}

/**
 * 把设置里的条目换算成**只给路径那行用**的模式列表。
 *
 * 两件事：① 丢掉方括号条目（`[src]` = 只要标签，不进路径那行）；
 * ② 把圆括号条目剥掉括号（`(src+1)` = 两处都要 → 路径这边就是 `src+1`）。
 * 同一条条目里的多组括号会展开成多条（`(a)(b)` → `a`、`b`）。
 *
 * ⚠️ **这个函数是「两侧一致」的关键一环**：宿主把它的结果随 `settings` 消息下发给面板
 * （见 `graphView.settingsPayload()`），面板因此不需要、也不应该再懂括号。
 * 早期版本只有宿主这一侧做预处理、面板拿到的是带括号的原文，于是
 * `pathAnchors: "(LIB)"` 在面板上那一行根本不保留 LIB —— 两侧算出的路径文字不一致
 * （renderCheck 的跨侧等值断言抓到的正是这一条）。
 */
export function pathOnlyAnchorPatterns(entries: readonly string[]): string[] {
  return entries
    .filter((entry) => !isTagOnlyEntry(entry))
    .flatMap((entry) => (isTagEntry(entry) ? parseTagPatterns(entry) : [String(entry ?? '').trim()]))
    .filter((entry) => entry.length > 0);
}

/**
 * 这批锚点模式里，哪些**在给出的所有路径上一处都没命中**（会话级诊断用）。
 *
 * 为什么要单独做这个判断：命中与否是**逐路径**算的（`displayPathText` 每次只看到一条路径），
 * 一张图上只要有一个文件不含某段就会「未命中」——在那里报「无法解析或越界」是误报。
 * 真正的语法错误由 `invalid` 单独报；只有**全都没有命中**才说明用户白写了这一条。
 *
 * 入参是**去重后**的路径（同一文件的多个节点只需检查一次），因此开销与文件数成正比。
 */
export function unmatchedAnchorPatterns(
  files: readonly string[],
  options: PathDisplayOptions
): string[] {
  const patterns = pathOnlyAnchorPatterns(options.anchors);
  if (patterns.length === 0 || files.length === 0) {
    return [];
  }
  const matched = new Set<string>();
  for (const file of files) {
    const segments = file.split(/[\\/]/).filter((part) => part.length > 0);
    if (segments.length <= 1) {
      continue;
    }
    const dirs = options.showFileName === false ? segments.slice(0, -1) : segments;
    const parts = dirs.length > 0 ? dirs : segments;
    const { groups } = planAnchorPatterns(parts, patterns, false);
    for (const group of groups) {
      matched.add(group.raw);
    }
    if (matched.size >= patterns.length) {
      break;
    }
  }
  // 命中的是「剥壳后」的写法，提示时回原样更容易对照设置
  return patterns.filter((pattern) => !matched.has(pattern));
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
 * - `full`：整条原样显示（不截断，方框按完整路径加宽）。
 * - `tail`：末尾窗口（固定层数，或 `tailLevels = 0` 时按字符预算，即 0.20 的行为）+ 锚点段；
 *   自动档会为了塞进预算而缩窗口（显式给了层数或锚点时一律完整显示 —— 0.22 起没有宽度上限，
 *   靠方框加宽来容纳，不再截断）。
 */
export function displayPathText(
  file: string,
  options: PathDisplayOptions = DEFAULT_PATH_OPTIONS,
  max = LOC_MAX_CHARS
): string {
  const segments = file.split(/[\\/]/).filter((part) => part.length > 0);
  if (segments.length <= 1) {
    return file;
  }
  // 只有显式传 false 才去掉文件名（未设置时按显示处理）
  const keepFileName = options.showFileName !== false;
  if (options.mode === 'full') {
    // 完整显示就是要整条：不给截断，方框按实际文字宽度长出来。
    // 关掉文件名时去掉最后一段（若因此为空则仍显示原名，避免那行只剩 `:12`）。
    const kept = keepFileName ? segments : segments.slice(0, -1);
    return kept.length > 0 ? kept.join('/') : file;
  }
  // 省略模式只对**目录段**做省略：关掉文件名时把最后一段（文件名）先摘掉，
  // 层数、字符预算、锚点全部作用于目录段。
  const dirs = keepFileName ? segments : segments.slice(0, -1);
  const parts = dirs.length > 0 ? dirs : segments;

  const resolved = resolveAnchorIndexes(parts, options.anchors);
  const anchors = resolved.indexes;
  // ⚠️ 这里只报**语法**错误（正则写错、条目只剩偏移之类）。
  // 「这条路径上没有那个段」**不是**错误 —— 一张图上只要有一个文件不含它就会走到那条分支，
  // 早期版本把两者混在一起报「无法解析或越界」，于是在正常的图上也会刷出误导警告。
  // 「整个标签里一处都没命中」由 `unmatchedAnchorPatterns()` 在会话这一层统一报一次。
  warnInvalidAnchorPatterns(resolved.invalid, '路径锚点');

  let tailCount =
    options.tailLevels > 0 ? Math.min(options.tailLevels, parts.length) : budgetTailCount(parts, max);
  // 锚点不能因为窗口太宽而被挤掉：先缩窗口（保留到只剩文件名那一层）。
  // ⚠️ 只在**自动档**（tailLevels = 0）缩窗口：显式给了层数或锚点时，用户要的就是那些段，
  // 缩了等于不显示；那种情况下由宽度自适应去容纳（0.22 起没有宽度上限）。
  if (options.tailLevels <= 0) {
    while (tailCount > 1 && assemblePath(parts, anchors, tailCount).length > max) {
      tailCount -= 1;
    }
  }
  // 一律返回拼好的文字，**不截断**：长度超出预算时由方框加宽来容纳。
  return assemblePath(parts, anchors, tailCount);
}

/** 名称行标签里，标签与元素名之间的分隔符（用户 2026-10-14 指定：标签在前）。 */
export const NAME_TAG_SEPARATOR = '→';

/**
 * 按分隔符拆分，但**引号内不拆**。
 *
 * 用途：设置项里的模式用逗号分隔，而目录名/文件名真的可能带逗号（`"a,b"` 这种写法），
 * 直接把整串 `split(',')` 会把一个模式切成两个、两个都匹配不上（表现为「设置没反应」）。
 */
export function splitQuoted(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (const character of text) {
    if (character === '"') {
      inQuote = !inQuote;
      current += character;
      continue;
    }
    if (!inQuote && character === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** 整串是否被一对引号包住（引号内允许有分隔符，表示一条**字面量路径**）。 */
export function isWhollyQuoted(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

/**
 * 把 `"aa/se"` 展开成 `"aa"/"se"`：每一段各自按**字面量**匹配。
 *
 * 这样「整体加引号」就能复用上下文匹配器，不必再写一套字面量路径匹配。
 */
export function quoteEachSegment(text: string): string {
  return text
    .trim()
    .slice(1, -1)
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0)
    .map((segment) => `"${segment}"`)
    .join('/');
}

/**
 * 把设置里的模式文本拆成**多条**模式：**一组括号算一条**，没写括号时整串算一条。
 *
 * 用户 2026-10-14 口径：「支持加多个标签，数量按括号数量来」——
 * 于是 `(lib)(lib+1)` 是两个标签，`lib+1` 仍是一个标签。
 *
 * 容忍四种括号（半角圆/方、全角圆/方/花），因为这一项的显示形态就是一对括号，
 * 用户很自然会连着括号一起写；只认裸模式的话 `(lib+1)` 会**静默匹配不到**（表现为「设置没反应」）。
 * 没写括号时再按逗号拆一次，与 `pathAnchors` 的手感保持一致。
 *
 * ⚠️ 括号扫描与逗号拆分都是**引号感知**的（`("se(1)")`、`"a,b"` 里的括号/逗号不算语法）。
 */
export function parseTagPatterns(raw: string | undefined): string[] {
  const text = (raw ?? '').trim();
  if (text.length === 0) {
    return [];
  }
  const groups: string[] = [];
  let current = '';
  let depth = 0;
  let inQuote = false;
  /** 括号之外、逗号分隔的零散写法（`(a) lib` 里的 `lib`）也要当一组，不能丢。 */
  const flushBare = (): void => {
    if (depth === 0 && current.trim().length > 0) {
      groups.push(current.trim());
    }
    current = '';
  };
  for (const character of text) {
    if (character === '"') {
      inQuote = !inQuote;
      current += character;
      continue;
    }
    if (character === ',' && !inQuote && depth === 0) {
      flushBare();
      continue;
    }
    // ⚠️ 括号集必须与 `tagEntryKind` **完全一致**（四种括号）：
    // 多认一种（例如曾经还认 `{}`）会让 `{src}` 在标签链路里生效、在 `tagEntryKind` 那里
    // 又不算标签，用户看到的是「同一个写法换个位置就不灵」。
    if (!inQuote && '([（【'.includes(character)) {
      depth += 1;
      // 第一层括号只是分组标记，不进内容；嵌套的括号按字面量保留
      if (depth > 1) {
        current += character;
      }
      continue;
    }
    if (!inQuote && ')]）】'.includes(character)) {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) {
          groups.push(current.trim());
          current = '';
          continue;
        }
      }
      current += character;
      continue;
    }
    current += character;
  }
  flushBare();
  return groups.filter((value) => value.length > 0);
}

/**
 * 从命中下标里按 `nameFolderTagPick` 选一个。
 *
 * ⚠️ `indexes` 是 Set<number>，**按模式书写顺序插入**：`first` 取第一个元素就是
 * 「pathAnchors 里第一个命中的模式」（用户 2026-10-14 选定），**不要**改成 Math.min ——
 * 那是 `shallowest`（最靠根的一段），与 `first` 是两种不同口径。
 */
function pickAnchorIndex(indexes: number[], pick: NameFolderTagPick | undefined): number {
  // `deepest` = 最靠文件的那一个；其余（含未设置）都取最左一个。
  // （曾经还有 `shallowest`，它与 `first` 对同一条模式完全等价，已删除以免留下冗余取值。）
  if (pick === 'deepest') {
    return Math.max(...indexes);
  }
  return indexes[0];
}

/**
 * 多个命中**区间**里按 `nameFolderTagPick` 选一个：比较的是区间**末段**（锚点）的下标。
 *
 * `keep:` 时一个命中是多段区间，此时 `first` / `deepest` / `shallowest` 仍按锚点判断，
 * 与不写 `keep:` 时的选择结果一致（否则同一批候选会因为保留整段而换一个命中）。
 */
function pickSpanIndex(spans: number[][], pick: NameFolderTagPick | undefined): number {
  const anchors = spans.map((span) => span[span.length - 1]);
  return Math.max(0, anchors.indexOf(pickAnchorIndex(anchors, pick)));
}

/** 写错的锚点模式要出声（与 `displayPathText` 同一口径），否则用户只看到「设置没反应」。 */
function warnInvalidAnchorPatterns(invalid: readonly string[], where: string): void {
  for (const pattern of invalid) {
    if (!warnedAnchorPatterns.has(pattern)) {
      warnedAnchorPatterns.add(pattern);
      logWarn(
        `${where}「${pattern}」写法无法解析（正则不合法，或条目只剩偏移），已忽略。` +
          `写法：目录名 / 目录名+N / 目录名-N / +N（从根数）/ -N（从文件名往上数）` +
          `/ re:正则 / "字面量" / 前缀 all: 、keep: 、! 。`
      );
    }
  }
}

/**
 * 锚点命中的**那些**目录名（设置 `cppCallGraph.nameFolderTag` 的标签文字）。
 *
 * 与 `displayPathText` 同口径：同一套分段、同一个 `showFileName` 处理、同一套模式解析
 * （见 `parsePattern`）。模式来源**只有一处**：`anchors` 里整体带括号的条目
 * （`(src)` / `[src]`，一组括号一个标签）。
 *
 * 每条模式出一个标签，`all:` 时该模式的**每个**命中各出一个；`keep:` 时标签是整个命中区间
 * （`aa/se`）；一条模式命中多处时取哪一个由条目后缀 `@deepest` / `@first`
 * （或设置里的 `nameFolderTagPick`）决定。没有任何命中、或该路径被 `!` 排除时返回空数组。
 */
export function anchorTagTexts(
  file: string,
  options: PathDisplayOptions = DEFAULT_PATH_OPTIONS
): string[] {
  const segments = file.split(/[\\/]/).filter((part) => part.length > 0);
  if (segments.length <= 1) {
    return [];
  }
  // 与 displayPathText 完全一致：关掉文件名时先摘掉最后一段（文件名）
  const dirs = options.showFileName === false ? segments.slice(0, -1) : segments;
  const parts = dirs.length > 0 ? dirs : segments;
  // 标签的模式来源**只有一处**（用户 2026-10-15 的口径：同一个设置里用括号区分）：
  // `pathAnchors` 里整体带括号的条目 —— 圆括号 `(src+1)` = 路径与标签两处都要、
  // 方括号 `[src+1]` = 只要标签。原先那个「标签专用」的独立设置（`nameFolderTagPattern`）
  // 能力与 `[..]` 完全重合，已合并掉：两处都写只会让同一件事有两个入口。
  const inline = options.anchors
    .filter((entry) => isTagEntry(entry))
    .flatMap((entry) => parseTagPatterns(entry));
  if (inline.length === 0) {
    return [];
  }
  // 标签链路**收齐全部命中**再挑（`collectAll = true`），这样 `@deepest` / `nameFolderTagPick`
  // 才有意义；路径那行继续「只保留最左一个」，两项互不影响。
  const { groups, invalid, excluded } = planAnchorPatterns(parts, inline, true, true);
  warnInvalidAnchorPatterns(invalid, '名称行标签的锚点模式');
  if (excluded) {
    return [];
  }
  const texts: string[] = [];
  for (const group of groups) {
    // 一条模式（一组括号）：`all:` 时每个命中各出一个标签，否则按 `@deepest` / `@first`
    // （条目后缀）或设置里的 `nameFolderTagPick` 选一个。
    const spans = group.all
      ? group.spans
      : [group.spans[pickSpanIndex(group.spans, group.pick ?? options.nameFolderTagPick)]];
    for (const span of spans) {
      texts.push(span.map((index) => parts[index]).join('/'));
    }
  }
  return texts;
}

/** 单个标签的便捷形式（多条时取第一条）：留给只需要一处的调用方与断言。 */
export function anchorTagText(
  file: string,
  options: PathDisplayOptions = DEFAULT_PATH_OPTIONS
): string | undefined {
  return anchorTagTexts(file, options)[0];
}

/** 名称行标签的摆法（设置 `cppCallGraph.nameFolderTagStyle`）。 */
export type NameFolderTagStyle = 'arrow' | 'parenAfter' | 'bracketAfter' | 'dotAfter';

/** 一条模式命中多个段时取哪一个（设置 `cppCallGraph.nameFolderTagPick`）。 */
export type NameFolderTagPick = 'first' | 'deepest';

/**
 * 名称行标签的两段文字：`arrow` 只用 `prefix`（`[core] → `），三种后置摆法只用 `suffix`。
 * 开关关闭、或没有命中任何锚点时返回 `undefined` —— 这时不显示任何标签。
 *
 * 为什么由宿主生成**已经格式化好**的文字、而不是把目录段发给 webview 让它自己拼：
 * 格式只有一处定义，两侧就不可能各写一份而慢慢分叉；估宽与实际渲染用的也是同一个字符串。
 */
export function nameTagPartsFor(
  file: string,
  options: PathDisplayOptions = DEFAULT_PATH_OPTIONS
): { prefix?: string; suffix?: string } | undefined {
  if (options.nameFolderTag !== true) {
    return undefined;
  }
  const tags = anchorTagTexts(file, options);
  if (tags.length === 0) {
    return undefined;
  }
  switch (options.nameFolderTagStyle ?? 'arrow') {
    // 多条标签按顺序并列（用户 2026-10-14 口径：数量按括号数量来）：
    // `[LIB] [core] → 元素名` / `元素名 (LIB) (core)`。单条时的文字与 8.10.5 逐字一致。
    case 'parenAfter':
      return { suffix: tags.map((tag) => ` (${tag})`).join('') };
    case 'bracketAfter':
      return { suffix: tags.map((tag) => ` [${tag}]`).join('') };
    case 'dotAfter':
      return { suffix: tags.map((tag) => ` · ${tag}`).join('') };
    default:
      return { prefix: `${tags.map((tag) => `[${tag}]`).join(' ')} ${NAME_TAG_SEPARATOR} ` };
  }
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
  // 名称一律用全名：0.22 起不许从中间截断（长度由方框宽度去容纳）
  // 名称行可能带路径标签（设置 `cppCallGraph.nameFolderTag`）：四种摆法里两种加在前面、
  // 两种加在后面，所以两段都要算进名称宽 —— 否则列位置按窄的排、标签会压到加减号那一带。
  const nameTag = nameTagPartsFor(node.file, pathOptions);
  const nameText =
    `${nameTag?.prefix ?? ''}${node.isCycle ? '↻ ' : ''}${node.name}` +
    `${nameTag?.suffix ?? ''}`;
  const nameWidth = (textWidthMilli(nameText) * 13) / 1000;
  const locText = showLocation
    ? `${displayPathText(node.file, pathOptions, LOC_MAX_CHARS)}:${node.line}`
    : '';
  const locWidth = (textWidthMilli(locText) * 12) / 1000;
  // 22 是文字起点，13 是加减号，5 是右边距，6 是安全余量（与 webview 同口径）
  const total = 22 + Math.max(nameWidth, locWidth) + 10 + 13 + 5 + 6;
  return Math.max(MIN_BOX_WIDTH, Math.ceil(total));
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
  pathOptions: PathDisplayOptions = DEFAULT_PATH_OPTIONS,
  /**
   * 节点总数上限（设置 `cppCallGraph.maxLayoutNodes`，默认 `MAX_LAYOUT_NODES`）。
   *
   * 超出部分**不上图**（没有坐标），并在输出通道里说明。上限越大越占内存与渲染时间：
   * webview 一次整帧重绘在 400 节点约 8ms、1200 节点约 30ms（压测数字），所以别盲目调大。
   */
  maxNodes = MAX_LAYOUT_NODES
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
    if (placed >= maxNodes) {
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

  // 截断**不能静默**，而且要能落到方框上。
  // ⚠️ 这段判断必须放在循环**之后**：截断只发生在「已经排满上限」之后，而排满的那一瞬间
  // 还没有任何节点被跳过 —— 早先把警告写在循环内、判据是「已有跳过 && 刚好排满」，
  // 两个条件永远不会同时成立，警告从来没打印过（等于没兑现这条承诺）。
  const omittedByCap: Record<string, number> = {};
  if (truncatedIds.size > 0) {
    /**
     * 沿 parent 上溯到第一个有方框的祖先（被丢弃的节点自己没有方框，计数记在它头上看不到）。
     *
     * ⚠️ 必须**记忆化 + 路径压缩**：不做的话每个被丢弃节点都要上溯一次，深链上总代价近似
     * O(深度²) —— 实测 1000 层 4.9ms、2000 层 47.6ms（压测里唯一超线性的一项）。
     */
    const nearestPlacedCache = new Map<string, string | undefined>();
    const nearestPlaced = (id: string): string | undefined => {
      if (nearestPlacedCache.has(id)) {
        return nearestPlacedCache.get(id);
      }
      const walked: string[] = [];
      let cursor = nodes[id]?.parent;
      let result: string | undefined;
      let guard = 0;
      while (cursor !== undefined && guard < 10000) {
        if (boxes[cursor] !== undefined) {
          result = cursor;
          break;
        }
        if (nearestPlacedCache.has(cursor)) {
          result = nearestPlacedCache.get(cursor);
          break;
        }
        walked.push(cursor);
        cursor = nodes[cursor]?.parent;
        guard += 1;
      }
      nearestPlacedCache.set(id, result);
      // 路径压缩：这一趟走过的中间节点共享同一个答案
      for (const node of walked) {
        nearestPlacedCache.set(node, result);
      }
      return result;
    };
    // ⚠️ 必须按**整棵子树**计数：被丢弃的节点在入栈前就被 `continue` 掉了，它们的子节点
    // 从未入栈，只数 `truncatedIds` 会**少报**（上限 2 的用例里实际少 5 个，旧实现只报 2 个，
    // 而且方框上的省略标记也会偏小 —— 是 layoutCheck 的新用例抓出来的）。
    const counted = new Set<string>();
    const pending: string[] = [...truncatedIds];
    while (pending.length > 0) {
      const id = pending.pop() as string;
      if (counted.has(id)) {
        continue;
      }
      counted.add(id);
      const owner = nearestPlaced(id);
      if (owner !== undefined) {
        omittedByCap[owner] = (omittedByCap[owner] ?? 0) + 1;
      }
      const node = nodes[id];
      if (node) {
        for (const child of kidsOf(node)) {
          if (boxes[child] === undefined) {
            pending.push(child);
          }
        }
      }
    }
    logWarn(
      `图过大：本次只排布了前 ${maxNodes} 个方框，另有 ${counted.size} 个节点未显示` +
        `（可先收起部分分支，或分次展开；也可在设置中调大 cppCallGraph.maxLayoutNodes）。`
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
    // 实测宽度**不设上限**：webview 按完整文字量出来的宽就是要用的宽（0.22 起不截断）。
    const width =
      typeof measured === 'number' && Number.isFinite(measured) && measured > 0
        ? Math.max(MIN_BOX_WIDTH, Math.round(measured))
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
    omittedByCap,
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
