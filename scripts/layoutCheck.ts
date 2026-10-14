/**
 * 图布局的几何验证：列方向、同行不重叠、父节点垂直居中、连线端点顺序。
 * 单独运行：node scripts/layoutCheck.js（由 npm run smoke 一并构建执行）
 */
import {
  GraphNode,
  collectEdges,
  createLayout,
  displayPathText,
  estimateBoxWidth,
  nameTagPartsFor,
  parseTagPatterns,
  pathOnlyAnchorPatterns,
  resolveAnchorIndexes,
  splitQuoted,
  tagEntryKind,
  unmatchedAnchorPatterns,
} from '../src/hierarchy/graphLayout';
import { arrangeByProximity, pathCloseness } from '../src/hierarchy/session';
import {
  addFolderEntry,
  applyFolderFilter,
  createFolderFilter,
  isFolderFiltered,
  removeFolderEntry,
} from '../src/hierarchy/folderFilter';
import {
  applyPathQueryFilter,
  compilePathQuery,
  createPathQueryFilter,
} from '../src/hierarchy/pathQuery';
function node(
  id: string,
  direction: 'callers' | 'callees',
  depth: number,
  children: string[],
  parent?: string
): GraphNode {
  return {
    id,
    name: id,
    file: 'demo.cpp',
    line: 1,
    direction,
    depth,
    isCycle: false,
    children,
    parent,
    loaded: true,
    kind: 'function',
  };
}

export function report(): string[] {
  const lines: string[] = [];

  // ---- 被调用关系：调用者在右侧，深度越大越靠右 ----
  {
    const nodes: Record<string, GraphNode> = {
      root: node('root', 'callers', 0, ['a', 'b']),
      a: node('a', 'callers', 1, ['a1'], 'root'),
      b: node('b', 'callers', 1, ['b1', 'b2'], 'root'),
      a1: node('a1', 'callers', 2, [], 'a'),
      b1: node('b1', 'callers', 2, [], 'b'),
      b2: node('b2', 'callers', 2, [], 'b'),
    };
    const layout = createLayout(nodes, 'root');
    const rootBox = layout.boxes.root;
    for (const id of ['a', 'b', 'a1', 'b1', 'b2']) {
      if (layout.boxes[id].x <= rootBox.x) {
        throw new Error(`callers 模式下 ${id} 应该在根右侧：x=${layout.boxes[id].x} vs root=${rootBox.x}`);
      }
    }
    // 同列的兄弟不能重叠
    if (layout.boxes.a.y + layout.boxes.a.height > layout.boxes.b.y) {
      throw new Error('callers 模式下 a 与 b 垂直重叠');
    }
    // 父节点应垂直居中于其子节点
    const aCenter = layout.boxes.a.y + layout.boxes.a.height / 2;
    const a1Center = layout.boxes.a1.y + layout.boxes.a1.height / 2;
    if (Math.abs(aCenter - a1Center) > 0.001) {
      throw new Error(`callers 模式下 a 未相对 a1 居中：${aCenter} vs ${a1Center}`);
    }
    const bCenter = layout.boxes.b.y + layout.boxes.b.height / 2;
    const bSpan = (layout.boxes.b1.y + (layout.boxes.b2.y + layout.boxes.b2.height)) / 2;
    if (Math.abs(bCenter - bSpan) > 0.001) {
      throw new Error(`callers 模式下 b 未居中于 b1/b2：${bCenter} vs ${bSpan}`);
    }
    lines.push(
      `callers: root.x=${rootBox.x} a.x=${layout.boxes.a.x} b.y=${layout.boxes.b.y.toFixed(0)} 宽=${layout.width.toFixed(0)} 高=${layout.height.toFixed(0)}`
    );

    const edges = collectEdges(nodes, 'root');
    const toRoot = edges.filter((edge) => edge.to === 'root');
    if (toRoot.length !== 2) {
      throw new Error(`callers 模式下应有 2 条指向 root 的连线，实际 ${toRoot.length}`);
    }
    lines.push(`callers: 边数=${edges.length}，指向 root 的边=${toRoot.length}`);
  }

  // ---- 调用关系：被调用者在右侧，深度越大越靠右 ----
  {
    const nodes: Record<string, GraphNode> = {
      root: node('root', 'callees', 0, ['x']),
      x: node('x', 'callees', 1, ['x1'], 'root'),
      x1: node('x1', 'callees', 2, [], 'x'),
    };
    const layout = createLayout(nodes, 'root');
    if (!(layout.boxes.x.x > layout.boxes.root.x && layout.boxes.x1.x > layout.boxes.x.x)) {
      throw new Error('callees 模式下深度应向右递增');
    }
    lines.push(
      `callees: root.x=${layout.boxes.root.x} x.x=${layout.boxes.x.x} x1.x=${layout.boxes.x1.x}`
    );
  }

  // ---- 环节点：仍应拿到坐标 ----
  {
    const cycle = node('c', 'callers', 1, [], 'root');
    cycle.isCycle = true;
    const nodes: Record<string, GraphNode> = {
      root: node('root', 'callers', 0, ['c']),
      c: cycle,
    };
    const layout = createLayout(nodes, 'root');
    if (!layout.boxes.c) {
      throw new Error('环节点应参与布局');
    }
    lines.push(`cycle: c.x=${layout.boxes.c.x}（与 c 同层，未额外占列）`);
  }

  // ---- 列间隙：相邻两列之间必须留出足够空间画箭头 ----
  // 立此检查的原因：曾经列宽固定 230 而方框按内容可到 337，
  // 方框越过列边界占用了列间隙，表现为「箭头太短或被方框盖住」。
  {
    const nodes: Record<string, GraphNode> = {
      // 名字刻意用长名，逼出「方框比固定列宽还宽」的历史场景
      long_root: node('long_root', 'callees', 0, ['long_child']),
      long_child: node('long_child', 'callees', 1, [], 'long_root'),
    };
    for (const key of Object.keys(nodes)) {
      nodes[key].name = `${key}_with_a_rather_long_symbol_name`;
      nodes[key].file = 'components/LIB/boot/some_rather_deep_directory/file.h';
    }
    const layout = createLayout(nodes, 'long_root');
    const left = layout.boxes.long_root;
    const right = layout.boxes.long_child;
    const gap = right.x - (left.x + left.width);
    lines.push(
      `列间隙（长名）: ${gap.toFixed(0)}px（左宽 ${left.width}，右 x=${right.x}）`
    );
    // 判据用设计值 COLUMN_GAP(52)，不再用"收缩一半也算过"的 24
    if (gap < 52 - 0.5) {
      throw new Error(
        `相邻列之间只剩 ${gap}px，小于设计的列间隙 52px（箭头画不下）：` +
          `左方框右边缘 ${left.x + left.width}，右方框左边缘 ${right.x}`
      );
    }
  }

  // ---- 估宽必须是实际方框宽度的上界 ----
  // 宿主给的列宽是估的，webview 会按实测宽度画方框。若估宽**小于**实测，
  // 方框就会互相重叠、箭头被盖住。这里用「实测最坏情况」反过来校验：
  // 等宽字体下 13px 粗体约 6.9px/字符、12px 常规约 5.8px/字符。
  {
    const nodes: Record<string, GraphNode> = {
      wide: node('wide', 'callees', 0, []),
    };
    // 名称取满 30 字符上限（截断后长度封顶）
    nodes.wide.name = 'abcdefghijklmnopqrstuvwxyz1234';
    nodes.wide.file = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnop.h';
    const layout = createLayout(nodes, 'wide');
    const estimated = layout.boxes.wide.width;
    // 与 webview 的 measureBoxWidth 同口径：22 + 内容 + 10 + 13 + 5 + 6
    const realName = 6.9 * 30;
    const realLoc = 5.8 * 41;
    const realBox = 22 + Math.max(realName, realLoc) + 10 + 13 + 5 + 6;
    lines.push(
      `估宽上界校验: 估 ${estimated.toFixed(0)}px vs 实测上限 ${realBox.toFixed(0)}px`
    );
    if (estimated < realBox) {
      throw new Error(
        `宿主估宽 ${estimated.toFixed(0)}px 小于实测上限 ${realBox.toFixed(0)}px，` +
          `方框会越过列边界并互相重叠（表现为箭头被盖住）`
      );
    }
  }

  // ---- 收起的子树不再占高度（否则同级之间会永远留一段「空挡」）----
  // 用户 2026-10-10 实测反馈：第二级展开第三级后有大空挡，把第三级折叠后空挡还在。
  // 原因是折叠只在 webview 本地生效，宿主仍按「子树已展开」算高度。现在 webview 会把
  // 收起集合下发，宿主用 createLayout(..., collapsed) 重算。
  {
    const nodes: Record<string, GraphNode> = {
      root: node('root', 'callers', 0, ['a', 'b']),
      a: node('a', 'callers', 1, ['a1', 'a2', 'a3'], 'root'),
      a1: node('a1', 'callers', 2, [], 'a'),
      a2: node('a2', 'callers', 2, [], 'a'),
      a3: node('a3', 'callers', 2, [], 'a'),
      b: node('b', 'callers', 1, [], 'root'),
    };
    const full = createLayout(nodes, 'root');
    const folded = createLayout(nodes, 'root', undefined, new Set(['a']));
    if (folded.boxes.a1 || folded.boxes.a2 || folded.boxes.a3) {
      throw new Error('被收起的子树不该拿到坐标（它已经不占了，留着坐标就会撑出空挡）');
    }
    if (!(folded.boxes.b.y < full.boxes.b.y)) {
      throw new Error(
        `收起 a 之后 b 应当上移、把空挡收掉：折叠后 b.y=${folded.boxes.b.y} vs 展开时 ${full.boxes.b.y}`
      );
    }
    // 收起后 a 自己变成叶子，于是与 b 之间正好是正常行距
    const gap = folded.boxes.b.y - (folded.boxes.a.y + folded.boxes.a.height);
    if (Math.abs(gap - 12) > 0.001) {
      throw new Error(`收起 a 之后 a 与 b 之间应当是正常行距 12px，实际 ${gap}`);
    }
    lines.push(
      `收起重排: b.y ${full.boxes.b.y} → ${folded.boxes.b.y}（空挡收掉 ${(full.boxes.b.y - folded.boxes.b.y).toFixed(0)}px）`
    );
  }

  // ---- 路径显示方式：**必须完整显示，不许截断**（0.22 起没有宽度上限） ----
  {
    const longPath = `${'verylongdirectoryname/'.repeat(6)}sub_main.c`; // 远超 40 字符
    const fullNode = node('fullpath', 'callees', 0, []);
    fullNode.name = 'fn';
    fullNode.file = longPath;
    fullNode.line = 1234;
    const fullOptions = { mode: 'full' as const, tailLevels: 0, anchors: [] };
    const fullWidth = estimateBoxWidth(fullNode, true, fullOptions);
    const anchoredWidth = estimateBoxWidth(fullNode, true, {
      mode: 'tail',
      tailLevels: 2,
      anchors: ['+3', 'verylongdirectoryname'],
    });
    const cjkFull = estimateBoxWidth(
      { ...fullNode, file: `${'全角目录名/'.repeat(6)}实现文件.cpp` },
      true,
      fullOptions
    );
    lines.push(
      `路径显示: 超长路径 full ${fullWidth.toFixed(0)}px / 带锚点 tail ${anchoredWidth.toFixed(0)}px / ` +
        `全角 full ${cjkFull.toFixed(0)}px（不再有宽度上限）`
    );
    // ① 完整模式必须原样给出整条路径，一个 '…' 都不许有
    const fullText = displayPathText(longPath, fullOptions);
    if (fullText !== longPath) {
      throw new Error(
        `full 模式必须原样显示整条路径，实际「${fullText}」——中间截断是不允许的`
      );
    }
    // ② 方框宽度必须随文字增长（证明 600px 钳制已去掉）
    if (fullWidth <= 600) {
      throw new Error(
        `超长路径的估宽只有 ${fullWidth.toFixed(0)}px（≤600）——宽度又被钳住了，文字会溢出方框`
      );
    }
    // ③ 单调性：路径更长就必须更宽，否则说明还在按固定上限收敛
    const longerWidth = estimateBoxWidth(
      { ...fullNode, file: `${longPath}/deeper/another.c` },
      true,
      fullOptions
    );
    if (!(longerWidth > fullWidth)) {
      throw new Error(
        `更长的路径没有得到更宽的方框：${fullWidth.toFixed(0)}px → ${longerWidth.toFixed(0)}px`
      );
    }
    // ④ 显式层数的 tail 模式也不许**段内**截断。
    //    注意 `…` 单独成段是合法的：那是 assemblePath 表示"这里跳过了若干层"，
    //    非法的只有段内出现省略号（例如 `verylong…name`）。
    const tailText = displayPathText(longPath, {
      mode: 'tail',
      tailLevels: 2,
      anchors: ['verylongdirectoryname'],
    });
    const truncatedSegment = tailText
      .split('/')
      .find((segment) => segment.includes('…') && segment !== '…');
    if (truncatedSegment !== undefined) {
      throw new Error(`显式层数的 tail 模式下有段被截断：「${truncatedSegment}」`);
    }
  }

  // ---- 全角长路径不得溢出方框（最坏字身 = 1 倍字号） ----
  // 0.22 起宽度没有上限，判据改为「估宽必须不小于文字 + 留白所需」。
  {
    const worst = node('worst', 'callees', 0, []);
    worst.name = '函'.repeat(30);
    worst.file = '源'.repeat(36) + '.cpp';
    worst.line = 9999;
    const estimated = estimateBoxWidth(worst, true);
    const namePx = 30 * 13; // 30 个全角 × 13px 粗体
    const locPx = 40 * 12; // 40 个全角 × 12px
    const need = Math.max(namePx, locPx) + 22 + 10 + 13 + 5 + 6;
    lines.push(
      `全角最坏情形: 估 ${estimated.toFixed(0)}px，文字+留白至少需要 ${need.toFixed(0)}px`
    );
    if (estimated < need - 1) {
      throw new Error(
        `全角最坏情形下估宽 ${estimated.toFixed(0)}px 小于需要 ${need.toFixed(0)}px —— ` +
          '文字会溢出方框并压到加减号'
      );
    }
    // 名称不再截断：更长的名字必须得到更宽的方框
    const longer = estimateBoxWidth({ ...worst, name: '函'.repeat(60) }, true);
    if (!(longer > estimated)) {
      throw new Error(
        `名称从 30 字加到 60 字，方框没有变宽（${estimated.toFixed(0)}px → ${longer.toFixed(0)}px）——` +
          '说明名称仍被按字符数截断'
      );
    }
  }


  // 中文与全角标点的字身宽度约等于 1 倍字号，ASCII 约为 0.8 倍。
  // 判据用**同字符数的 ASCII 路径做对照**：含中文的那条必须估得更宽。
  // （之前一律按 ASCII 系数算，两者会得到完全相同的宽度 —— 这正是 bug 的形态。）
  {
    const cjkName = '函数名字一二三四五六七八九十';
    const cjkPath = '源码/模块/子目录/实现文件.cpp';
    const cjkNode = node('cjk', 'callees', 0, []);
    cjkNode.name = cjkName;
    cjkNode.file = cjkPath;
    cjkNode.line = 42;

    // 字符数完全相同、但全是 ASCII 的路径
    const asciiFile = `${'a'.repeat(Math.max(1, [...cjkPath].length - 4))}.cpp`;
    const asciiNode = { ...cjkNode, file: asciiFile };

    const cjkWidth = estimateBoxWidth(cjkNode, true);
    const asciiWidth = estimateBoxWidth(asciiNode, true);
    lines.push(
      `中文估宽: 同样 ${[...cjkPath].length} 个字符 → 中文路径 ${cjkWidth.toFixed(0)}px，` +
        `纯 ASCII 路径 ${asciiWidth.toFixed(0)}px`
    );
    if (cjkWidth <= asciiWidth) {
      throw new Error(
        `含全角的路径估宽 ${cjkWidth.toFixed(0)}px 没有比同长度的 ASCII 路径（${asciiWidth.toFixed(0)}px）更宽 —— ` +
          `估宽公式把全角字符也按 ASCII 系数算了，方框会压住文字`
      );
    }
  }


  //
  // webview 会把**实测宽度**报回来，宿主优先用它；但第一帧还没有实测宽度，
  // 靠 estimateBoxWidth 估。关掉路径时如果还按带路径的宽度估，列位置会先宽后窄地跳变一次。
  {
    const long: GraphNode = {
      ...node('longpath', 'callers', 1, [], 'root'),
      name: 'f',
      file: 'some/very/long/path/to/a/source/file/named/demo.cpp',
      line: 123,
    };
    const withLoc = estimateBoxWidth(long, true);
    const withoutLoc = estimateBoxWidth(long, false);
    if (!(withoutLoc < withLoc)) {
      throw new Error(
        `关掉「显示路径」时估宽应当变小：带路径 ${withLoc} vs 不带 ${withoutLoc}`
      );
    }
    // 只剩名字时，宽度应贴近「名字宽 + 加减号预留」这一档，而不是路径那一档
    const nameOnly = estimateBoxWidth({ ...long, name: 'a'.repeat(40) }, false);
    if (nameOnly <= withoutLoc) {
      throw new Error(`关掉路径后宽度应当由名字决定（长名 ${nameOnly} 应当比短名 ${withoutLoc} 宽）`);
    }
    lines.push(`路径开关估宽: ${withLoc} → ${withoutLoc}（长名时 ${nameOnly}）`);

    // ---- 名称行路径标签（设置 `cppCallGraph.nameFolderTag` / `…Style` / `…Pick`） ----
    // 四种摆法都要成立，且估宽必须把标签算进去 —— 否则列位置按窄的排、标签会压住加减号。
    {
      const tagFile = 'components/LIB/core/lib_core.c';
      const tagNode: GraphNode = { ...long, file: tagFile, name: 'fn', isCycle: false };
      const base = {
        mode: 'tail' as const,
        tailLevels: 2,
        nameFolderTag: true,
        // ⚠️ 标签**只有一个来源**：`pathAnchors` 里的括号条目（`nameFolderTagPattern` 已并入它）。
        // 因此下面这些用例必须显式给出带括号的模式，估宽那条也一样。
        anchors: ['(LIB)'],
      };
      // ⚠️ 必须用「不显示路径」那一档：显示路径时方框宽取名称行与路径行的**较大者**，
      // 路径行更宽时标签不会改变总宽（那是正确行为，不是缺陷）。
      const off = estimateBoxWidth(tagNode, false, { ...base, nameFolderTag: false });
      const arrow = estimateBoxWidth(tagNode, false, {
        ...base,
        nameFolderTagStyle: 'arrow' as const,
      });
      const paren = estimateBoxWidth(tagNode, false, {
        ...base,
        nameFolderTagStyle: 'parenAfter' as const,
      });
      if (!(arrow > off) || !(paren > off)) {
        throw new Error(
          `打开名称行标签后估宽必须变大：关闭 ${off} / arrow ${arrow} / 后置 ${paren}`
        );
      }
      // 取段口径（`nameFolderTagPick`）：**一条模式**命中多个段时取哪一个。
      // 用可区分的名字（`lib` / `libs` 都命中 `lib*`），否则两个候选文字相同、断言没有区分度。
      // ⚠️ 只有两个取值了：`shallowest` 与 `first` 对同一条模式完全等价，已删除。
      const pickFile = 'lib/a/libs/b.c';
      const pickOptions = { ...base, anchors: ['(lib*)'] };
      const first = nameTagPartsFor(pickFile, { ...pickOptions, nameFolderTagPick: 'first' });
      const deepest = nameTagPartsFor(pickFile, { ...pickOptions, nameFolderTagPick: 'deepest' });
      if (first?.prefix !== '[lib] → ') {
        throw new Error(`first 应当取最靠根的那一段（lib），实际「${first?.prefix}」`);
      }
      if (deepest?.prefix !== '[libs] → ') {
        throw new Error(`deepest 应当取最靠文件的那一段（libs），实际「${deepest?.prefix}」`);
      }
      // 逐条的取值后缀 `@deepest` / `@first`（用户 2026-10-16）：比全局开关更细 ——
      // 一个设置里可以「这条取最靠文件的、那条取第一个」。全局项仍作为默认值。
      const perEntryDeep = nameTagPartsFor(pickFile, {
        ...pickOptions,
        anchors: ['(lib*@deepest)'],
        nameFolderTagPick: 'first',
      });
      const perEntryFirst = nameTagPartsFor(pickFile, {
        ...pickOptions,
        anchors: ['(lib*@first)'],
        nameFolderTagPick: 'deepest',
      });
      if (perEntryDeep?.prefix !== '[libs] → ') {
        throw new Error(
          `条目后缀 @deepest 应当压过全局的 first（期望 libs），实际「${perEntryDeep?.prefix}」`
        );
      }
      if (perEntryFirst?.prefix !== '[lib] → ') {
        throw new Error(
          `条目后缀 @first 应当压过全局的 deepest（期望 lib），实际「${perEntryFirst?.prefix}」`
        );
      }
      // 名字真的带 `@deepest` 时用整条引号保住它
      const quotedPick = nameTagPartsFor('x/f@deepest/f.c', {
        mode: 'tail',
        tailLevels: 1,
        nameFolderTag: true,
        anchors: ['("f@deepest")'],
      });
      if (quotedPick?.prefix !== '[f@deepest] → ') {
        throw new Error(`引号里的 @deepest 应当按字面量处理，实际「${quotedPick?.prefix}」`);
      }
      // 正交性（用户 2026-10-15）：只配**裸**条目时**不得出标签**，
      // 否则路径那行与名称行会重复显示同一个目录。
      const anchorsOnly = nameTagPartsFor(tagFile, {
        mode: 'tail',
        tailLevels: 2,
        anchors: ['LIB', 'core'],
        nameFolderTag: true,
      });
      if (anchorsOnly !== undefined) {
        throw new Error('只配了裸锚点条目时不得出标签（路径那行已经显示它了）');
      }
      // 反过来：标签配了括号模式、路径那行没别的锚点时，标签照常显示（两项互不依赖）
      const tagWithoutAnchors = nameTagPartsFor(tagFile, {
        mode: 'tail',
        tailLevels: 2,
        nameFolderTag: true,
        anchors: ['(core)'],
      });
      if (tagWithoutAnchors?.prefix !== '[core] → ') {
        throw new Error(
          `只配标签模式时应当照常出标签（core），实际「${tagWithoutAnchors?.prefix}」`
        );
      }
      // 同一个设置里**用括号区分**（用户 2026-10-15 的原意）：`src+1` 进路径那行，`(src+1)` 变标签，
      // 而且 `+N` / `-N` 在标签里照样生效（这正是「tag 也要能加一减一」）。
      const bracketFile = 'a/src/sub/x.c';
      const bracketTag = nameTagPartsFor(bracketFile, {
        mode: 'tail',
        tailLevels: 2,
        anchors: ['(src+1)'],
        nameFolderTag: true,
      });
      if (bracketTag?.prefix !== '[sub] → ') {
        throw new Error(
          `(src+1) 应当作为标签取 src 的下一层（sub），实际「${bracketTag?.prefix}」`
        );
      }
      const bracketMinus = nameTagPartsFor(bracketFile, {
        mode: 'tail',
        tailLevels: 2,
        anchors: ['(sub-1)'],
        nameFolderTag: true,
      });
      if (bracketMinus?.prefix !== '[src] → ') {
        throw new Error(`(sub-1) 应当取 sub 的上一层（src），实际「${bracketMinus?.prefix}」`);
      }
      // 两种括号语义不同（用户 2026-10-15）：**方括号 = 只当标签**，路径那行必须与「无锚点」
      // 逐字相同；**圆括号 = 两处都要**，路径那行必须保留它（同时也会出标签）。
      const squareTag = nameTagPartsFor(bracketFile, {
        mode: 'tail',
        tailLevels: 2,
        anchors: ['[src]'],
        nameFolderTag: true,
      });
      if (squareTag?.prefix !== '[src] → ') {
        throw new Error(`[src] 应当照常出标签，实际「${squareTag?.prefix}」`);
      }
      const squarePath = { mode: 'tail' as const, tailLevels: 1, anchors: ['[src]'] };
      if (
        displayPathText(bracketFile, squarePath) !==
        displayPathText(bracketFile, { ...squarePath, anchors: [] })
      ) {
        throw new Error('方括号条目只当标签，不得影响路径那行');
      }
      const roundPath = { mode: 'tail' as const, tailLevels: 1, anchors: ['(src)'] };
      if (
        displayPathText(bracketFile, roundPath) ===
        displayPathText(bracketFile, { ...roundPath, anchors: [] })
      ) {
        throw new Error('圆括号条目「两处都要」：路径那行必须保留它');
      }
      // 括号是标签的**唯一标记**（用户 2026-10-16 合并后的口径）：圆括号与方括号都出标签
      // （区别只在路径那行保不保留它）；**裸写不再出标签** —— 那是路径专用的写法。
      const parenInline = nameTagPartsFor(tagFile, { ...base, anchors: ['(lib+1)'] });
      const bracketInline = nameTagPartsFor(tagFile, { ...base, anchors: ['[lib+1]'] });
      const bareInline = nameTagPartsFor(tagFile, { ...base, anchors: ['lib+1'] });
      if (parenInline?.prefix !== '[core] → ') {
        throw new Error(`模式「(lib+1)」应当解析出 core，实际「${parenInline?.prefix}」`);
      }
      const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
      if (!same(parenInline, bracketInline)) {
        throw new Error('圆括号与方括号都该出标签：(lib+1) 与 [lib+1] 的结果应当一致');
      }
      if (bareInline !== undefined) {
        throw new Error(
          `裸写「lib+1」只该影响路径那行、不得出标签，实际「${bareInline?.prefix}」`
        );
      }
      // 圆括号条目的标签与「同一段写进裸条目」在标签文字上一致（两处都要 vs 只路径的差别在路径那行）
      const inlinePrefix: string | undefined = parenInline?.prefix;
      const anchorsPrefix: string | undefined = first?.prefix;
      if (inlinePrefix === anchorsPrefix) {
        throw new Error(
          `(lib+1) 与 (lib*) 是两条不同模式，不该给出同一个标签「${inlinePrefix}」`
        );
      }
      // 模式写错：不显示标签（并已由 resolveAnchorIndexes 记入 invalid 供上层提示）
      if (nameTagPartsFor(tagFile, { ...base, anchors: ['(nosuchdir)'] }) !== undefined) {
        throw new Error('自带的模式没有命中时不得显示标签');
      }
      // 多标签：**数量按括号数量来**（用户 2026-10-14 追加）。两组括号 = 两个标签，按书写顺序并列。
      const two = nameTagPartsFor(tagFile, { ...base, anchors: ['(lib)(lib+1)'] });
      if (two?.prefix !== '[LIB] [core] → ') {
        throw new Error(`两组括号应当出两个标签（[LIB] [core] → ），实际「${two?.prefix}」`);
      }
      const twoParen = nameTagPartsFor(tagFile, {
        ...base,
        anchors: ['(lib)(lib+1)'],
        nameFolderTagStyle: 'parenAfter',
      });
      if (twoParen?.suffix !== ' (LIB) (core)') {
        throw new Error(`后置摆法的两个标签应当是「 (LIB) (core)」，实际「${twoParen?.suffix}」`);
      }
      // 其中一组解析不出：只少那一个标签，其余照常（不能整条消失）
      const partial = nameTagPartsFor(tagFile, {
        ...base,
        anchors: ['(lib)(nosuchdir)'],
      });
      if (partial?.prefix !== '[LIB] → ') {
        throw new Error(`一组解析不出时应当只剩另一组（[LIB] → ），实际「${partial?.prefix}」`);
      }
      // 向后兼容：没写括号的单条模式仍然只出一个标签
      const single = nameTagPartsFor(tagFile, { ...base, anchors: ['(lib)'] });
      if (single?.prefix !== '[LIB] → ') {
        throw new Error(`单条模式应当只出一个标签（[LIB] → ），实际「${single?.prefix}」`);
      }

      // 「路径上下文限定」消歧（用户 2026-10-14 的场景）：两条路径里都有 `se`，
      // 只写 `se` 时两条都会命中（这正是要解决的歧义，作为对照留着）；
      // 写 `a/se` 只命中**紧跟在 `a` 之后**的那一个。
      const inlineBase = {
        mode: 'tail' as const,
        tailLevels: 0,
        anchors: [] as string[],
        nameFolderTag: true,
      };
      const pathOne = 'a/se/named_by_file/x/y.c';
      const pathTwo = 'a/tt/a/m/se/y.c';
      const bareTag = (file: string) =>
        nameTagPartsFor(file, { ...inlineBase, anchors: ['(se)'] });
      const scopedTag = (file: string) =>
        nameTagPartsFor(file, { ...inlineBase, anchors: ['(a/se)'] });
      if (bareTag(pathOne)?.prefix !== '[se] → ' || bareTag(pathTwo)?.prefix !== '[se] → ') {
        throw new Error('对照前提不成立：不写上下文时两条路径都应当命中 se');
      }
      if (scopedTag(pathOne)?.prefix !== '[se] → ') {
        throw new Error(`a/se 应当在第一条路径命中 se，实际「${scopedTag(pathOne)?.prefix}」`);
      }
      if (scopedTag(pathTwo) !== undefined) {
        throw new Error('a/se 不得在「a/tt/a/m/se」里命中（那里 a 后面分别是 tt 与 m）');
      }
      // 以分隔符开头 = 必须从工作区根开始
      const rootedTag = (file: string) =>
        nameTagPartsFor(file, { ...inlineBase, anchors: ['(/a/se)'] });
      if (rootedTag(pathOne)?.prefix !== '[se] → ' || rootedTag(pathTwo) !== undefined) {
        throw new Error('/a/se 应当只命中从工作区根开始的那一条');
      }
      // 上下文 + 偏移：`a/se+1` → 命中 se 之后的那一段
      const offsetTag = nameTagPartsFor(pathOne, {
        ...inlineBase,
        anchors: ['(a/se+1)'],
      });
      if (offsetTag?.prefix !== '[named_by_file] → ') {
        throw new Error(`a/se+1 应当命中偏移后的那一段，实际「${offsetTag?.prefix}」`);
      }
      // 回归：目录名里含 `-` 时仍按**整串**匹配（`lib-2` 不能被当成「mods 减 1」）
      const dashTag = nameTagPartsFor('x/lib-2/f.c', {
        ...inlineBase,
        anchors: ['(lib-2)'],
      });
      if (dashTag?.prefix !== '[lib-2] → ') {
        throw new Error(`lib-2 应当按整串目录名命中，实际「${dashTag?.prefix}」`);
      }
      // 前缀 `all:` = 该模式的**所有**命中（用户 2026-10-14：「可以匹配上所有的这个名字」）。
      // 与上下文、偏移都能组合。
      const multiPath = 'se/a/se/b.c';
      const allTag = nameTagPartsFor(multiPath, {
        ...inlineBase,
        anchors: ['(all:se)'],
      });
      if (allTag?.prefix !== '[se] [se] → ') {
        throw new Error(`all:se 应当把两个 se 都取出来，实际「${allTag?.prefix}」`);
      }
      // 对照组：不写 `all:` 时仍只取最左一个（证明前缀真的改了语义）
      const oneTag = nameTagPartsFor(multiPath, { ...inlineBase, anchors: ['(se)'] });
      if (oneTag?.prefix !== '[se] → ') {
        throw new Error(`不写 all: 时仍只取一个，实际「${oneTag?.prefix}」`);
      }
      // 与上下文组合：两处都满足「a/se」时都要取
      const allScoped = nameTagPartsFor('a/se/x/a/se/y.c', {
        ...inlineBase,
        anchors: ['(all:a/se)'],
      });
      if (allScoped?.prefix !== '[se] [se] → ') {
        throw new Error(`all:a/se 应当把两处上下文命中都取出来，实际「${allScoped?.prefix}」`);
      }
      // 与偏移组合：每个命中各偏移一层（两处 se 各自的下一个目录段是 a 与 b）
      const allOffset = nameTagPartsFor('se/a/se/b/c.c', {
        ...inlineBase,
        anchors: ['(all:se+1)'],
      });
      if (allOffset?.prefix !== '[a] [b] → ') {
        throw new Error(`all:se+1 应当对每个命中各偏移一层（a、b），实际「${allOffset?.prefix}」`);
      }
      // 段内通配与多选（第一档语法）：`*` 任意长、`?` 单字符、`a|b` 任一命中
      const globPath = 'components/group_a/src/group_b/f.c';
      const globTag = nameTagPartsFor(globPath, {
        ...inlineBase,
        anchors: ['(group_*)'],
      });
      if (globTag?.prefix !== '[group_a] → ') {
        throw new Error(`group_* 应当命中 group_a（只取最左），实际「${globTag?.prefix}」`);
      }
      const allGlob = nameTagPartsFor(globPath, {
        ...inlineBase,
        anchors: ['(all:group_*)'],
      });
      if (allGlob?.prefix !== '[group_a] [group_b] → ') {
        throw new Error(`all:group_* 应当把两块板都取出来，实际「${allGlob?.prefix}」`);
      }
      const altTag = nameTagPartsFor('x/tt/m/se/f.c', {
        ...inlineBase,
        anchors: ['(m|tt)'],
      });
      if (altTag?.prefix !== '[tt] → ') {
        throw new Error(`m|tt 应当命中 tt（最左），实际「${altTag?.prefix}」`);
      }
      const questionTag = nameTagPartsFor('x/ab/x/abc/f.c', {
        ...inlineBase,
        anchors: ['(a?)'],
      });
      if (questionTag?.prefix !== '[ab] → ') {
        throw new Error(`a? 应当只命中两字符的 ab，实际「${questionTag?.prefix}」`);
      }
      lines.push(
        `名称行标签全命中: all:se → 「${allTag?.prefix}」/ all:a/se → 「${allScoped?.prefix}」/ ` +
          `all:se+1 → 「${allOffset?.prefix}」`
      );
      lines.push(
        `名称行标签通配: group_* → 「${globTag?.prefix}」/ all:group_* → 「${allGlob?.prefix}」/ ` +
          `m|tt → 「${altTag?.prefix}」/ a? → 「${questionTag?.prefix}」`
      );

      // `keep:`：把**整段区间**当一个标签（用户 2026-10-15：`(aa/se)` 要整体显示）
      const keepPath = 'x/aa/se/f.c';
      const keepTag = nameTagPartsFor(keepPath, {
        ...inlineBase,
        anchors: ['(keep:aa/se)'],
      });
      if (keepTag?.prefix !== '[aa/se] → ') {
        throw new Error(`keep:aa/se 应当整体显示成 aa/se，实际「${keepTag?.prefix}」`);
      }
      // 对照组：不写 keep 时仍只显示末段
      const noKeepTag = nameTagPartsFor(keepPath, {
        ...inlineBase,
        anchors: ['(aa/se)'],
      });
      if (noKeepTag?.prefix !== '[se] → ') {
        throw new Error(`不写 keep 时应当只显示 se，实际「${noKeepTag?.prefix}」`);
      }
      // 与 `all:` 组合：每处命中各出一个整段标签
      const allKeep = nameTagPartsFor('x/aa/se/y/aa/se/f.c', {
        ...inlineBase,
        anchors: ['(all:keep:aa/se)'],
      });
      if (allKeep?.prefix !== '[aa/se] [aa/se] → ') {
        throw new Error(`all:keep:aa/se 应当出两个整段标签，实际「${allKeep?.prefix}」`);
      }
      // 与偏移组合：区间整体平移，仍保持相邻（se 的下一个目录段是 mid）
      const keepOffset = nameTagPartsFor('x/aa/se/mid/f.c', {
        ...inlineBase,
        anchors: ['(keep:aa/se+1)'],
      });
      if (keepOffset?.prefix !== '[se/mid] → ') {
        throw new Error(`keep:aa/se+1 应当整体平移到 se/mid，实际「${keepOffset?.prefix}」`);
      }
      // 路径那行不受 `keep:` 影响（它会剥掉前缀但按单段处理）：与不写 keep 的结果完全相同
      const pathOptions = { mode: 'tail' as const, tailLevels: 1, anchors: ['aa/se'] };
      if (
        displayPathText(keepPath, pathOptions) !==
        displayPathText(keepPath, { ...pathOptions, anchors: ['keep:aa/se'] })
      ) {
        throw new Error('路径那行不应当因为 keep: 而改变（keep 只作用于标签）');
      }
      lines.push(
        `名称行标签整段保留: keep:aa/se → 「${keepTag?.prefix}」/ 不写 → 「${noKeepTag?.prefix}」/ ` +
          `all:keep:aa/se → 「${allKeep?.prefix}」/ keep:+1 → 「${keepOffset?.prefix}」`
      );

      // 引号 = 字面量（用户 2026-10-15：路径本身就带这些识别字符怎么办）
      // ① `*` 的差别：glob 会先命中 `a1b`，加引号后只命中真正的 `a*b`
      const starPath = 'x/a1b/y/a*b/f.c';
      const globStar = nameTagPartsFor(starPath, {
        ...inlineBase,
        anchors: ['(a*b)'],
      });
      if (globStar?.prefix !== '[a1b] → ') {
        throw new Error(`不加引号时 a*b 是通配、应当先命中 a1b，实际「${globStar?.prefix}」`);
      }
      const quotedStar = nameTagPartsFor(starPath, {
        ...inlineBase,
        anchors: ['("a*b")'],
      });
      if (quotedStar?.prefix !== '[a*b] → ') {
        throw new Error(`加引号后应当只命中字面量 a*b，实际「${quotedStar?.prefix}」`);
      }
      // ② `|` 的差别：不加引号是「或」，加引号是字面量
      const barPath = 'x/a/y/a|b/f.c';
      const globBar = nameTagPartsFor(barPath, { ...inlineBase, anchors: ['(a|b)'] });
      if (globBar?.prefix !== '[a] → ') {
        throw new Error(`不加引号时 a|b 是「或」、应当先命中 a，实际「${globBar?.prefix}」`);
      }
      const quotedBar = nameTagPartsFor(barPath, { ...inlineBase, anchors: ['("a|b")'] });
      if (quotedBar?.prefix !== '[a|b] → ') {
        throw new Error(`加引号后应当只命中字面量 a|b，实际「${quotedBar?.prefix}」`);
      }
      // ③ 逗号：两个模式一起写时，引号内的逗号**不能**被当成分隔符
      const commaPath = 'x/a,b/se/f.c';
      const commaTag = nameTagPartsFor(commaPath, {
        ...inlineBase,
        anchors: ['("a,b")(se)'],
      });
      if (commaTag?.prefix !== '[a,b] [se] → ') {
        throw new Error(`引号内的逗号不应拆开模式，实际「${commaTag?.prefix}」`);
      }
      // ④ 空格：段内空格原样保留（`Program Files` 这种目录名）
      const spaceTag = nameTagPartsFor('x/Program Files/se/f.c', {
        ...inlineBase,
        anchors: ['(keep:Program Files/se)'],
      });
      if (spaceTag?.prefix !== '[Program Files/se] → ') {
        throw new Error(`段内空格应当原样保留，实际「${spaceTag?.prefix}」`);
      }
      // ⑤ 长得像偏移的目录名：整段优先，`+3` 当字面量而不是「从根数第 3 段」
      const plusName = nameTagPartsFor('x/+3/f.c', { ...inlineBase, anchors: ['(+3)'] });
      if (plusName?.prefix !== '[+3] → ') {
        throw new Error(`+3 应当先按字面量目录名命中，实际「${plusName?.prefix}」`);
      }
      // ⑥ 拆分器的单元断言：引号感知
      const splitPlain = splitQuoted('a,b', ',');
      const splitQuotedText = splitQuoted('"a,b",c', ',');
      if (
        splitPlain.length !== 2 ||
        splitQuotedText.length !== 2 ||
        splitQuotedText[0] !== '"a,b"' ||
        splitQuotedText[1] !== 'c'
      ) {
        throw new Error(
          `引号感知的逗号拆分不正确：${JSON.stringify(splitPlain)} / ${JSON.stringify(splitQuotedText)}`
        );
      }
      lines.push(
        `名称行标签引号字面量: a*b → 「${globStar?.prefix}」vs 「${quotedStar?.prefix}」/ ` +
          `a|b → 「${globBar?.prefix}」vs 「${quotedBar?.prefix}」/ 逗号 → 「${commaTag?.prefix}」/ ` +
          `空格 → 「${spaceTag?.prefix}」/ +3 → 「${plusName?.prefix}」`
      );

      // ---- 组合矩阵（用户 2026-10-15：「仔细思考所有可能组合，并做测试」） ----
      //
      // 覆盖维度：前缀（`all:` / `keep:` / 两者与顺序）、段匹配器（字面量 / 通配 / 多选 / 引号 /
      // `re:` / `**`）、路径形态（单段 / 连续上下文 / 从根）、偏移（`+N` `-N`、越界、字面优先）、
      // 排除（`!` 命中 / 不命中 / 通配 / `**`）、多模式（并列 / 重复 / 与排除混用）、边界（空模式、
      // 只有 `!`、未闭合引号、非法正则、只写 `**`）、以及大小写不敏感。
      //
      // 期望值后缀统一省略（`[x] → ` 只写 `[x]`），避免每行重复写出箭头。
      const matrix: Array<[string, string, string, string[] | undefined]> = [
        // `**`（任意层）
        ['** 在开头', 'q/w/e/se/f.c', '(**/se)', ['[se]']],
        ['** 在中间', 'a/x/y/se/f.c', '(a/**/se)', ['[se]']],
        ['** 在结尾', 'a/x/y/f.c', '(a/**)', ['[a]']],
        ['** + all:', 'se/x/se/y/f.c', '(all:**/se)', ['[se]', '[se]']],
        ['** + keep:（整段含跨过的层）', 'a/x/y/se/f.c', '(keep:a/**/se)', ['[a/x/y/se]']],
        ['** + 偏移', 'a/m/se/f.c', '(a/**/se+1)', ['[f.c]']],
        ['只写 **（没有可锚定的段）', 'a/b/f.c', '(**)', undefined],
        // `re:` 正则
        ['re: 整段', 'src/group_a/x/f.c', '(re:^group_[ab]$)', ['[group_a]']],
        ['re: 作为上下文段', 'src/group_a/x/f.c', '(re:^group_[ab]$/x)', ['[x]']],
        ['re: 大小写不敏感', 'src/group_a/x/f.c', '(re:^GROUP_A$)', ['[group_a]']],
        ['re: 里的 +1 是内容不是偏移', 'x/aa1/f.c', '(re:a+1)', ['[aa1]']],
        ['re: 与偏移组合', 'src/x/y/f.c', '(re:^src$/x+1)', ['[y]']],
        ['re: 写错（非法正则）', 'src/a/f.c', '(re:[)', undefined],
        // 排除 `!`
        ['! 命中即整条作废', 'src/tmp/se/f.c', '(!tmp)(se)', undefined],
        ['! 不命中则照常', 'src/ok/se/f.c', '(!tmp)(se)', ['[se]']],
        ['! 带通配', 'src/temp2/se/f.c', '(!temp*)(se)', undefined],
        ['! 带 **', 'a/b/cache/se/f.c', '(!**/cache)(se)', undefined],
        ['只有 !（没有可用模式）', 'src/a/f.c', '(!)', undefined],
        // 前缀顺序与叠加
        ['前缀顺序可以反写 keep:all:', 'x/aa/se/y/aa/se/f.c', '(keep:all:aa/se)', ['[aa/se]', '[aa/se]']],
        ['括号内逗号不拆模式', 'x/a,b/se/f.c', '("a,b")(se)', ['[a,b]', '[se]']],
        // 段匹配器与边界
        ['大小写不敏感', 'x/Se/f.c', '(SE)', ['[Se]']],
        ['多选', 'x/lib/y/f.c', '(lib|vendor)', ['[lib]']],
        ['引号段不解析偏移', 'x/a+1/f.c', '("a+1")', ['[a+1]']],
        ['未闭合引号', 'x/abc/f.c', '("abc)', undefined],
        ['偏移越界', 'x/se/f.c', '(se+99)', undefined],
        ['名字里带连字符（整段优先）', 'x/lib-2/f.c', '(lib-2)', ['[lib-2]']],
        ['名字里带加号（整段优先）', 'x/+3/f.c', '(+3)', ['[+3]']],
        ['重复模式各自出标签', 'x/se/f.c', '(se)(se)', ['[se]', '[se]']],
        ['多模式 + 排除混用', 'x/a/c/f.c', '(a)(!b)(c)', ['[a]', '[c]']],
        ['从工作区根锚定', 'a/b/se/f.c', '(/a/b/se)', ['[se]']],
        ['从根锚定不成立时不命中', 'z/a/b/se/f.c', '(/a/b/se)', undefined],
        ['空括号＝裸写法（只影响路径那行）', 'x/se/f.c', '()', undefined],
      ];
      const matrixTag = (file: string, pattern: string): string[] | undefined => {
        const parts = nameTagPartsFor(file, { ...inlineBase, anchors: [pattern] });
        return parts?.prefix?.replace(/ → $/, '').match(/\[[^\]]*\]/g) ?? undefined;
      };
      for (const [label, file, pattern, expected] of matrix) {
        const actual = matrixTag(file, pattern);
        const same =
          expected === undefined
            ? actual === undefined
            : actual !== undefined && actual.length === expected.length &&
              actual.every((value, index) => value === expected[index]);
        if (!same) {
          throw new Error(
            `组合矩阵「${label}」不符：模式 ${pattern} 在 ${file} 上期望 ` +
              `${expected === undefined ? '不显示标签' : expected.join('')}，实际 ` +
              `${actual === undefined ? '不显示标签' : actual.join('')}`
          );
        }
      }
      // 路径那行：`**`、`!` 与从根锚定（只比对“与参照写法等价 / 不等价”，不写死拼装细节）
      const pathBase = { mode: 'tail' as const, tailLevels: 1 };
      const deepOne = displayPathText('a/x/y/se/f.c', { ...pathBase, anchors: ['**/se'] });
      const deepTwo = displayPathText('a/x/y/se/f.c', { ...pathBase, anchors: ['a/**/se'] });
      if (deepOne !== deepTwo || !deepOne.includes('se')) {
        throw new Error(`**/se 与 a/**/se 应当命中同一个 se，实际「${deepOne}」「${deepTwo}」`);
      }
      const excluded = displayPathText('src/tmp/se/f.c', { ...pathBase, anchors: ['!tmp', 'tmp'] });
      const noAnchor = displayPathText('src/tmp/se/f.c', { ...pathBase, anchors: [] });
      if (excluded !== noAnchor) {
        throw new Error(`路径那行被 ! 排除后应当与「没有锚点」完全一致，实际「${excluded}」「${noAnchor}」`);
      }
      const kept = displayPathText('src/tmp/se/f.c', { ...pathBase, anchors: ['tmp'] });
      if (kept === noAnchor) {
        throw new Error(`对照组失败：不写 ! 时 tmp 应当被保留，实际与无锚点相同「${kept}」`);
      }
      lines.push(
        `组合矩阵: ${matrix.length} 条全部通过（** / re: / ! / 前缀 / 偏移 / 引号 / 边界交叉）`
      );

      // ---- 锚点条目的「路径那一份」与诊断（用户 2026-10-16 的两轮改动） ----
      {
        // ① 括号预处理：面板只收到这一份，两侧因此同规则（曾经的 F0：面板不认括号，
        //    于是 `(LIB)` 在面板上的路径行不保留 LIB、与宿主算出的文字不一致）
        const pathOnly = pathOnlyAnchorPatterns(['(a+1)', '[b]', 'c', '(d)(e)', '']);
        if (pathOnly.join('|') !== 'a+1|c|d|e') {
          throw new Error(
            `pathOnlyAnchorPatterns 应当剥圆括号、丢方括号、展开多组：期望 a+1|c|d|e，实际 ${pathOnly.join('|')}`
          );
        }
        // 圆括号条目剥壳后**确实**进路径那行；方括号条目**确实**不进
        const roundPath = displayPathText('a/src/sub/x.c', {
          mode: 'tail',
          tailLevels: 1,
          anchors: ['(src)'],
        });
        const squarePath = displayPathText('a/src/sub/x.c', {
          mode: 'tail',
          tailLevels: 1,
          anchors: ['[src]'],
        });
        const noPath = displayPathText('a/src/sub/x.c', { mode: 'tail', tailLevels: 1, anchors: [] });
        if (!roundPath.includes('src') || roundPath === noPath) {
          throw new Error(`圆括号条目应当保留该段（两处都要），实际「${roundPath}」`);
        }
        if (squarePath !== noPath) {
          throw new Error(`方括号条目只当标签，路径那行必须与无锚点一致，实际「${squarePath}」`);
        }
        // ② 括号集只有四种（`{src}` 不再被当成分组，前后两处必须一致）
        if (tagEntryKind('{src}') !== undefined || tagEntryKind('（src）') !== 'both') {
          throw new Error('tagEntryKind 只应认四种括号（()（）[]【】），且圆括号 = 两处都要');
        }
        const braceGroups = parseTagPatterns('{src}');
        if (braceGroups.join('|') !== '{src}') {
          throw new Error(`{src} 不再是分组写法（应原样返回），实际 ${braceGroups.join('|')}`);
        }
        // ③ 括号组之外的零散写法不再被丢掉（F5）：`(a) b` → 两组
        const mixed = parseTagPatterns('(a) b, (c)');
        if (mixed.join('|') !== 'a|b|c') {
          throw new Error(`括号与裸写法混排应当都保留：期望 a|b|c，实际 ${mixed.join('|')}`);
        }
        // ④ 会话级诊断：只在**一条路径都没有**该段时才报「一处都没命中」（F10）
        const unmatched = unmatchedAnchorPatterns(
          ['a/one/x.c', 'a/two/y.c'],
          { mode: 'tail', tailLevels: 1, anchors: ['one', '(nosuch)'] }
        );
        if (unmatched.join('|') !== 'nosuch') {
          throw new Error(
            `只有真的一条都没命中的条目才该被列出：期望 nosuch，实际 ${unmatched.join('|') || '（空）'}`
          );
        }
        if (unmatchedAnchorPatterns(['a/one/x.c'], { mode: 'tail', tailLevels: 1, anchors: ['one'] }).length > 0) {
          throw new Error('命中了就不该出现在「一处都没命中」的列表里');
        }
        // ⑤ 「这条路径上没有这个段」**不是语法错误**（F10）：invalid 只装真解析不了的写法。
        //    这条只能在纯函数上验：冒烟夹具的路径是单段的，displayPathText 会提前返回。
        const noMatchReport = resolveAnchorIndexes(['a', 'b', 'c'], ['nosuch']);
        if (noMatchReport.invalid.length !== 0) {
          throw new Error(
            `未命中的条目不得算作语法错误（它只是这条路径上没有），实际 invalid=${JSON.stringify(
              noMatchReport.invalid
            )}`
          );
        }
        const brokenReport = resolveAnchorIndexes(['a', 'b', 'c'], ['re:(']);
        if (brokenReport.invalid.length !== 1) {
          throw new Error(
            `正则写错的条目必须进 invalid（宿主据此提示），实际 ${JSON.stringify(brokenReport.invalid)}`
          );
        }
        // 圆括号条目在这里同样被剥壳（宿主内部这一份与下发面板的那一份必须一致）
        const roundIndexes = resolveAnchorIndexes(['x', 'src', 'y'], ['(src)']);
        if (!roundIndexes.indexes.has(1)) {
          throw new Error(
            `圆括号条目应当按 src 命中第 1 段，实际 ${JSON.stringify([...roundIndexes.indexes])}`
          );
        }
        lines.push(
          `锚点条目: 括号预处理 1 组 + 圆/方括号对路径行的差别 + 括号集与混排 + 会话级诊断 + 语法/未命中分离全部通过`
        );
      }

      // ---- 目录过滤（设置 `cppCallGraph.excludeFolders`，用户 2026-10-15） ----
      {
        const roots = ['c:/work/project'];
        const filterCases: Array<[string, string, string, boolean]> = [
          ['相对路径命中目录本身', 'components/vendor', 'components/vendor/a.c', true],
          ['相对路径命中子树', 'components/vendor', 'components/vendor/deep/b.c', true],
          ['前缀相似的目录不命中', 'components/vendor', 'components/vendor2/a.c', false],
          ['大小写不敏感', 'Components/Vendor', 'components/vendor/a.c', true],
          ['反斜杠等价', 'components\\vendor', 'components/vendor/a.c', true],
          ['结尾斜杠忽略', 'components/vendor/', 'components/vendor/a.c', true],
          ['点斜杠前缀忽略', './components/vendor', 'components/vendor/a.c', true],
          ['工作区内的绝对路径', 'c:/work/project/components/vendor', 'components/vendor/a.c', true],
          ['绝对路径大小写不同', 'C:/Work/Project/components/vendor', 'components/vendor/a.c', true],
          ['通配任意层命中', '**/test', 'a/b/test/x.c', true],
          ['通配任意层不命中同名前缀', '**/test', 'a/b/tests/x.c', false],
          ['通配段内', '*/generated', 'build/generated/a.c', true],
          ['条目写成文件也能命中', 'demo.cpp', 'demo.cpp', true],
        ];
        for (const [label, entry, file, expected] of filterCases) {
          const hit = createFolderFilter([entry], roots).test(file);
          if (hit !== expected) {
            throw new Error(
              `目录过滤「${label}」不符：条目 ${entry} 对 ${file} 期望 ${expected}，实际 ${hit}`
            );
          }
        }
        const outside = createFolderFilter(['c:/elsewhere/vendor'], roots);
        if (outside.activeCount !== 0 || outside.problems.length !== 1) {
          throw new Error(
            `工作区外的绝对路径应当记为无效条目并给出原因，实际 ${JSON.stringify(outside.problems)}`
          );
        }
        if (createFolderFilter(['c:/work/project'], roots).activeCount !== 0) {
          throw new Error('整个工作区不应当被过滤（否则图会整个空掉）');
        }
        if (createFolderFilter(['   '], roots).activeCount !== 0) {
          throw new Error('空白条目应当被忽略');
        }
        // 裁剪：命中的节点连同**整棵子树**一起隐藏；根永不参与过滤
        const tree = {
          root: { file: 'root.c', children: ['a', 'b'] },
          a: { file: 'a.c', children: ['a1'] },
          a1: { file: 'x/a1.c', children: [] },
          b: { file: 'b/b.c', children: ['b1'] },
          b1: { file: 'b/b1.c', children: [] },
        };
        const pruneFilter = createFolderFilter(['b'], roots);
        const pruned = applyFolderFilter(tree, 'root', pruneFilter);
        if (pruned.hidden !== 2 || pruned.nodes.b !== undefined || pruned.nodes.b1 !== undefined) {
          throw new Error(`裁剪应当隐藏 b 与它的子树（共 2 个），实际 hidden=${pruned.hidden}`);
        }
        if (pruned.nodes.root.children.join(',') !== 'a') {
          throw new Error(
            `被隐藏的子节点必须从父节点的 children 里去掉，实际 ${JSON.stringify(pruned.nodes.root.children)}`
          );
        }
        const rootFiltered = applyFolderFilter(
          { root: { file: 'x/root.c', children: [] } },
          'root',
          createFolderFilter(['x'], roots)
        );
        if (rootFiltered.hidden !== 0 || rootFiltered.nodes.root === undefined) {
          throw new Error('根节点永不参与过滤（否则误加一条就会把整张图清空）');
        }
        // 列表编辑：加去重、移除连带子条目、父目录覆盖判断
        const one = addFolderEntry([], 'components/vendor');
        if (one.length !== 1 || addFolderEntry(one, 'components\\vendor').length !== 1) {
          throw new Error('加入同一条目（写法不同）时应当去重');
        }
        const many = addFolderEntry(
          addFolderEntry(one, 'components/vendor/sub'),
          'third_party'
        );
        const removedParent = removeFolderEntry(many, 'components/vendor');
        if (removedParent.removed !== 2 || removedParent.entries.join(',') !== 'third_party') {
          throw new Error(
            `移除父目录时应当连带内部子条目，实际 removed=${removedParent.removed}、剩 ${removedParent.entries.join(',')}`
          );
        }
        if (
          !isFolderFiltered(many, 'components/vendor/sub/deep') ||
          isFolderFiltered(many, 'components/other')
        ) {
          throw new Error('isFolderFiltered 应当把「被父条目覆盖的子目录」也算作已过滤');
        }
        lines.push(
          `目录过滤: ${filterCases.length} 条匹配用例 + 无效条目/裁剪/列表编辑断言全部通过`
        );
      }

      // ---- 临时路径过滤（面板搜索栏右侧的输入框，用户 2026-10-15） ----
      // 与目录过滤共用裁剪规则，但查询语义是「子串 + 通配」，且**不锚定**两端。
      {
        const queryCases: Array<[string, string, string, boolean]> = [
          ['子串命中路径中间', 'vendor', 'components/vendor/a.c', true],
          ['子串不区分大小写', 'VENDOR', 'components/vendor/a.c', true],
          ['反斜杠等价', 'components\\vendor', 'components/vendor/a.c', true],
          ['点斜杠前缀忽略', './components/vendor', 'components/vendor/a.c', true],
          ['直接命中文件名', 'demo.cpp', 'src/demo.cpp', true],
          ['不含该子串则不命中', 'vendor', 'components/other/a.c', false],
          ['段内通配', 'group_*/src', 'lib/group_a/src/x.c', true],
          ['段内通配不跨斜杠', 'group_*/src', 'lib/group_a/mid/src/x.c', false],
          ['单字符通配', 'group_?/x.c', 'lib/group_a/x.c', true],
          ['任意层通配可以零层', 'lib/**/x.c', 'lib/x.c', true],
          ['任意层通配可以多层', 'lib/**/x.c', 'lib/a/b/x.c', true],
          ['任意层通配不误命中同名前缀', 'lib/**/x.c', 'other/lib2/x.c', false],
          ['两个星号不接斜杠时按任意字符处理', 'a**b', 'a/xx/b.c', true],
          ['空白查询不过滤任何节点', '   ', 'anything/at/all.c', false],
        ];
        for (const [label, query, file, expected] of queryCases) {
          const hit = createPathQueryFilter(query).test(file);
          if (hit !== expected) {
            throw new Error(
              `临时过滤「${label}」不符：查询 ${query} 对 ${file} 期望 ${expected}，实际 ${hit}`
            );
          }
        }
        if (compilePathQuery('   ') !== undefined) {
          throw new Error('空白查询应当返回 undefined（不过滤），而不是一个永远不命中的正则');
        }
        // 裁剪：与目录过滤同一条规则 —— 命中节点连同整棵子树、根永不隐藏
        const tree = {
          root: { file: 'root.c', children: ['a', 'b'] },
          a: { file: 'a.c', children: ['a1'] },
          a1: { file: 'x/a1.c', children: [] },
          b: { file: 'b/b.c', children: ['b1'] },
          b1: { file: 'b/b1.c', children: [] },
        };
        const pruned = applyPathQueryFilter(tree, 'root', 'b');
        if (pruned.hidden !== 2 || pruned.nodes.b !== undefined || pruned.nodes.b1 !== undefined) {
          throw new Error(`临时过滤应当隐藏 b 与它的子树（共 2 个），实际 hidden=${pruned.hidden}`);
        }
        if (pruned.nodes.root.children.join(',') !== 'a') {
          throw new Error(
            `被临时过滤隐藏的子节点必须从父节点的 children 里去掉，实际 ` +
              JSON.stringify(pruned.nodes.root.children)
          );
        }
        const deep = applyPathQueryFilter(tree, 'root', 'x/a1');
        if (deep.hidden !== 1 || deep.nodes.a1 !== undefined || deep.nodes.a === undefined) {
          throw new Error(`按子路径过滤应当只隐藏 a1（1 个），实际 hidden=${deep.hidden}`);
        }
        const rootKept = applyPathQueryFilter(
          { root: { file: 'x/root.c', children: [] } },
          'root',
          'x'
        );
        if (rootKept.hidden !== 0 || rootKept.nodes.root === undefined) {
          throw new Error('根节点永不参与临时过滤（否则一个查询就能把整张图清空）');
        }
        const untouched = applyPathQueryFilter(tree, 'root', '');
        if (untouched.nodes !== tree || untouched.hidden !== 0) {
          throw new Error('空查询必须原样返回（不过滤时不遍历整棵树）');
        }
        const noMatch = applyPathQueryFilter(tree, 'root', 'zzz');
        if (noMatch.hidden !== 0 || Object.keys(noMatch.nodes).length !== 5) {
          throw new Error('没有命中时不得丢节点');
        }
        lines.push(
          `临时路径过滤: ${queryCases.length} 条匹配用例 + 根节点/空查询/裁剪断言全部通过`
        );
      }
      lines.push(
        `名称行标签消歧: se 裸写两条都命中 → a/se 只命中「${scopedTag(pathOne)?.prefix}」；` +
          `a/se+1 → 「${offsetTag?.prefix}」`
      );
      // 四种摆法各生成一次，逐字比对（前后位置不同，不能只看有没有方括号）
      const styles: Array<[string, string | undefined]> = [
        // ⚠️ 样本必须用**固定模式**取（`base` 里的 `(LIB)`），不要复用上面按 pick 得到的标签：
        // pick 的用例换了文件与模式，直接拿它的结果会让这张表跟着变。
        ['arrow', nameTagPartsFor(tagFile, { ...base, nameFolderTagStyle: 'arrow' })?.prefix],
        ['parenAfter', nameTagPartsFor(tagFile, { ...base, nameFolderTagStyle: 'parenAfter' })?.suffix],
        [
          'bracketAfter',
          nameTagPartsFor(tagFile, { ...base, nameFolderTagStyle: 'bracketAfter' })?.suffix,
        ],
        ['dotAfter', nameTagPartsFor(tagFile, { ...base, nameFolderTagStyle: 'dotAfter' })?.suffix],
      ];
      const expected: Record<string, string | undefined> = {
        arrow: '[LIB] → ',
        parenAfter: ' (LIB)',
        bracketAfter: ' [LIB]',
        dotAfter: ' · LIB',
      };
      for (const [style, text] of styles) {
        if (text !== expected[style]) {
          throw new Error(`摆法 ${style} 的标签文字应当是「${expected[style]}」，实际「${text}」`);
        }
      }
      // 未命中锚点 → 不显示标签（而不是显示一对空括号）；开关关闭 → 一律 undefined
      if (nameTagPartsFor('src/main.c', { ...base, anchors: ['LIB'] }) !== undefined) {
        throw new Error('没有任何锚点命中时不得显示标签');
      }
      if (nameTagPartsFor(tagFile, { ...base, nameFolderTag: false }) !== undefined) {
        throw new Error('开关关闭时不得生成任何标签文字');
      }
      lines.push(
        `名称行标签: first「${first?.prefix}」/ deepest「${deepest?.prefix}」/ ` +
          `估宽 关 ${off.toFixed(0)} → arrow ${arrow.toFixed(0)} → 后置 ${paren.toFixed(0)}`
      );
    }

    // 方框**高度**也要跟着变：显示路径时两行（43），关掉后单行（26）——
    // 并且整幅内容的高度要跟着缩，否则滚动范围里会留一片空白。
    const tall: Record<string, GraphNode> = {
      root: node('root', 'callers', 0, ['a', 'b']),
      a: node('a', 'callers', 1, [], 'root'),
      b: node('b', 'callers', 1, [], 'root'),
    };
    const twoLine = createLayout(tall, 'root');
    const oneLine = createLayout(tall, 'root', undefined, undefined, false);
    if (!(oneLine.boxes.root.height < twoLine.boxes.root.height)) {
      throw new Error(
        `关掉路径后方框应当变矮：两行 ${twoLine.boxes.root.height} vs 单行 ${oneLine.boxes.root.height}`
      );
    }
    if (!(oneLine.height < twoLine.height)) {
      throw new Error(
        `关掉路径后整幅内容应当变矮：两行 ${twoLine.height} vs 单行 ${oneLine.height}`
      );
    }
    // 单行的两个方框之间仍是正常行距（高度变了，间距不得被占用）
    const compactGap =
      oneLine.boxes.b.y - (oneLine.boxes.a.y + oneLine.boxes.a.height);
    if (Math.abs(compactGap - 12) > 0.001) {
      throw new Error(`单行布局里同级之间仍应是 12px 行距，实际 ${compactGap}`);
    }
    lines.push(
      `路径开关框高: ${twoLine.boxes.root.height} → ${oneLine.boxes.root.height}` +
        `（内容高 ${twoLine.height} → ${oneLine.height}）`
    );
  }

  // ---- 节点总数上限的截断必须落到**最近的已排布祖先**上 ----
  // 被丢弃的节点自己没有方框，计数若记在它头上用户什么都看不到（0.22 首版缺陷）。
  {
    const nodes: Record<string, GraphNode> = {
      root: node('root', 'callees', 0, ['c']),
      // c 是「被截断的那一层」的父框：上限只放得下 root 与 c，
      // 于是 c1、c2 及其全部子节点都要归到 c 上（最近的已排布祖先）。
      c: node('c', 'callees', 1, ['c1', 'c2'], 'root'),
      c1: node('c1', 'callees', 2, ['c1a', 'c1b'], 'c'),
      c2: node('c2', 'callees', 2, ['c2a'], 'c'),
      c1a: node('c1a', 'callees', 3, [], 'c1'),
      c1b: node('c1b', 'callees', 3, [], 'c1'),
      c2a: node('c2a', 'callees', 3, [], 'c2'),
    };
    // 上限 2 → 只排布 root 与 c（BFS 顺序），其余 5 个节点全部归到 c 上
    const layout = createLayout(nodes, 'root', undefined, undefined, true, undefined, 2);
    const placed = Object.keys(layout.boxes).length;
    if (placed !== 2) {
      throw new Error(`上限 2 时应当只排布 2 个方框，实际 ${placed}`);
    }
    const capped = layout.omittedByCap;
    if ((capped.c ?? 0) !== 5) {
      throw new Error(
        `因上限未排布的 5 个节点应当全部归到最近的已排布祖先 c 上，实际 ${JSON.stringify(capped)}`
      );
    }
    if (capped.root !== undefined || capped.c1 !== undefined) {
      throw new Error(
        `省略计数不该挂到别处（root 未直接丢子节点、c1 自己没有方框）：${JSON.stringify(capped)}`
      );
    }
    // 未超上限时不该有任何省略计数（否则正常图会平白多出标记）
    const full = createLayout(nodes, 'root');
    if (Object.keys(full.omittedByCap).length !== 0) {
      throw new Error(`未超上限时不该有省略计数：${JSON.stringify(full.omittedByCap)}`);
    }
    lines.push(`上限截断归类: 上限 2 时 c 上记 ${capped.c} 个省略、未超限时无省略计数`);
  }

  // ---- 同级排序：与父项路径最接近的子项必须落在中段 ----
  // 这条改动**改变持久化的 children 顺序**（并列目录下同名文件与函数很多），
  // 是 0.22 里唯一「改了既有语义却没有防线」的地方，所以用纯函数断言钉住。
  {
    // 亲疏分档：同文件 > 同目录 > 公共目录段数
    const same = pathCloseness('a/b/c.c', 'a/b/c.c');
    const sameDir = pathCloseness('a/b/c.c', 'a/b/d.c');
    const oneCommon = pathCloseness('a/b/c.c', 'a/x/d.c');
    if (!(same > sameDir && sameDir > oneCommon)) {
      throw new Error(
        `亲疏分档应当 同文件 > 同目录 > 公共段数：${same} / ${sameDir} / ${oneCommon}`
      );
    }

    const files: Record<string, string> = {
      far1: 'a/x/f1.c',
      near: 'a/b/c.c', // 与父项同目录 → 最亲
      far2: 'a/y/f2.c',
      far3: 'a/z/f3.c',
    };
    const fileOf = (id: string) => files[id] ?? '';
    const order = arrangeByProximity('a/b/c.c', ['far1', 'far2', 'far3', 'near'], fileOf);
    // ⚠️ 偶数个子项时「中间」是一段（4 个时是索引 1~2），所以断言的是**中段区间**，
    // 而不是某个固定下标 —— 固定下标会把「合法居中」误判为失败（第一版就是这样）。
    const centerLow = Math.ceil(order.length / 2) - 1;
    const centerHigh = Math.floor(order.length / 2);
    const at = order.indexOf('near');
    if (at < centerLow || at > centerHigh) {
      throw new Error(
        `最亲的子项应当落在中段（允许 ${centerLow}~${centerHigh}），实际在 ${at}：${order.join(',')}`
      );
    }
    if (order.length !== 4 || new Set(order).size !== 4) {
      throw new Error(`重排不得增删或重复子项：${order.join(',')}`);
    }
    // 只有两个子项时不重排（避免为「居中」做无意义的交换）
    const two = arrangeByProximity('a/b/c.c', ['far1', 'near'], fileOf);
    if (two.join(',') !== 'far1,near') {
      throw new Error(`只有两个子项时不该重排，实际 ${two.join(',')}`);
    }
    // 全部同分（都同目录）时保持原顺序，避免抖动
    const allNear = arrangeByProximity('a/b/c.c', ['p', 'q', 'r'], () => 'a/b/z.c');
    if (allNear.join(',') !== 'p,q,r') {
      throw new Error(`同分时应当保持原顺序，实际 ${allNear.join(',')}`);
    }
    lines.push(
      `同级排序: 亲疏 ${same}/${sameDir}/${oneCommon}，最亲者居中 → ${order.join(',')}`
    );
  }

  return lines;
}
