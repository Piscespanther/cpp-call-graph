/**
 * 图布局的几何验证：列方向、同行不重叠、父节点垂直居中、连线端点顺序。
 * 单独运行：node scripts/layoutCheck.js（由 npm run smoke 一并构建执行）
 */
import { GraphNode, collectEdges, createLayout } from '../src/hierarchy/graphLayout';

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
    if (gap < 24) {
      throw new Error(
        `相邻列之间只剩 ${gap}px，箭头画不下（应 ≥24px）：` +
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

  return lines;
}
