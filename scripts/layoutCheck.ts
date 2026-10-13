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
} from '../src/hierarchy/graphLayout';
import { arrangeByProximity, pathCloseness } from '../src/hierarchy/session';

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
  // 方框越过了列边界把间隙吃掉，表现为「箭头太短或被方框盖住」。
  {
    const nodes: Record<string, GraphNode> = {
      // 名字刻意用长名，逼出「方框比固定列宽还宽」的历史场景
      long_root: node('long_root', 'callees', 0, ['long_child']),
      long_child: node('long_child', 'callees', 1, [], 'long_root'),
    };
    for (const key of Object.keys(nodes)) {
      nodes[key].name = `${key}_with_a_rather_long_symbol_name`;
      nodes[key].file = 'components/BSP/boot/some_rather_deep_directory/file.h';
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
    const longPath = `${'verylongdirectoryname/'.repeat(6)}lcd_init.c`; // 远超 40 字符
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
  // 靠 estimateBoxWidth 估。关掉路径时如果还按带路径的宽度估，列位置会先宽后窄地跳一下。
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
    // 单行的两个方框之间仍是正常行距（高度变了，间距不能被吃掉）
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
