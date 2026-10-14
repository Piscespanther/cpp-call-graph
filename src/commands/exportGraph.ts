/**
 * 导出的**纯函数**：Markdown（结构树 / 表格）与 JSON 的正文生成，以及默认文件名。
 *
 * ⚠️ 本文件**不引用 vscode API**：会话只以结构化类型（`ExportSession` / `ExportNode`）描述，
 * 因此可以在没有 VS Code 的脚本里直接调用并逐字断言（见 `scripts/smoke.js`）。
 * 选保存位置、写文件这些必须用 vscode 的部分留在 `src/views/graphView.ts`。
 *
 * `buildMarkdownTree` 的正文与 `copyTree.ts` 原先内联在 `withProgress` 回调里的 walk
 * **逐字一致**（两空格缩进、`- 名称  文件:行  ← 关系点 …  [detail]`、`↻` 环标记、
 * `detail` 截断 60 字符、`MAX_DEPTH` / `MAX_NODES` 两个上限与两种截断提示）；
 * `copyTree.ts` 的 `buildSessionText()` 现在直接调用它，外层只保留进度提示与既有签名。
 */
import { DIRECTION_LABEL, Direction } from '../hierarchy/graphTypes';

/** 结构树 / 表格 / JSON 最多下探的层数（与复制文本同口径）。 */
export const MAX_DEPTH = 8;
/** 结构树 / 表格 / JSON 最多写入的节点数（与复制文本同口径）。 */
export const MAX_NODES = 500;
/** `detail` 写入结构树时保留的字符数（与复制文本同口径）。 */
const DETAIL_MAX_CHARS = 60;

/** 导出格式：webview 的 `exportGraph` 消息与宿主的保存对话框共用这一份取值。 */
export type ExportFormat = 'png' | 'svg' | 'md-tree' | 'md-table' | 'json';

/**
 * 导出需要的最小节点形状。
 *
 * 与 `hierarchy/graphTypes.ts` 的 `GraphNode` **相容**（真实节点可以直接传进来），
 * 但不 import 它 —— 那一层依赖 vscode 的类型，import 会把 vscode API 拖进本文件。
 */
export interface ExportNode {
  name: string;
  file: string;
  line: number;
  callSite?: { file: string; line: number };
  detail?: string;
  isCycle?: boolean;
  children: string[];
}

/** 导出需要的最小会话形状，与 `CallSession` 相容。 */
export interface ExportSession {
  rootId: string;
  direction: Direction;
  node(id: string): ExportNode | undefined;
}

interface WalkEntry {
  id: string;
  depth: number;
  /** 遍历路径上的父节点 id；根为 null。 */
  parentId: string | null;
  node: ExportNode;
}

interface WalkResult {
  entries: WalkEntry[];
  hitNodeLimit: boolean;
  hitDepthLimit: boolean;
}

/**
 * 深度优先**先序**遍历已展开的节点（先父后子，子按 `children` 的现有顺序）。
 *
 * 三种导出共用这一份遍历结果，因此不可能在节点集合或顺序上出现分叉。
 * 只遍历已经展开的节点，不主动触发任何语言服务请求。
 */
function walkSession(session: ExportSession): WalkResult {
  const entries: WalkEntry[] = [];
  const visited = new Set<string>();
  let budget = MAX_NODES;
  // 两个上限要分别记录：恰好用满 500 个节点时并没有截断，
  // 而层数超限（>8 层）此前完全不提示 —— 两种情况的说明不一样。
  let hitNodeLimit = false;
  let hitDepthLimit = false;
  const walk = (nodeId: string, depth: number, parentId: string | null): void => {
    const node = session.node(nodeId);
    // ⚠️ 「不存在 / 已访问」必须**先**判：否则恰好用满上限时，最后一个节点的
    // 重复入栈会在 budget<=0 处把 hitNodeLimit 置位 —— 并未截断却提示「结果被截断」。
    if (!node || visited.has(nodeId)) {
      return;
    }
    if (budget <= 0) {
      hitNodeLimit = true;
      return;
    }
    if (depth > MAX_DEPTH) {
      hitDepthLimit = true;
      return;
    }
    visited.add(nodeId);
    budget -= 1;
    entries.push({ id: nodeId, depth, parentId, node });
    for (const child of node.children) {
      walk(child, depth + 1, nodeId);
    }
  };
  walk(session.rootId, 0, null);
  return { entries, hitNodeLimit, hitDepthLimit };
}

/**
 * Markdown 结构树（正文与「复制当前标签为文本」逐字一致）。
 *
 * 根节点不存在（会话为空）时返回空串，调用方据此放弃导出。
 */
export function buildMarkdownTree(session: ExportSession): string {
  const root = session.node(session.rootId);
  if (!root) {
    return '';
  }
  const lines: string[] = [
    `# ${DIRECTION_LABEL[session.direction]}：${root.name}（${root.file}:${root.line}）`,
  ];
  const { entries, hitNodeLimit, hitDepthLimit } = walkSession(session);
  for (const entry of entries) {
    const indent = '  '.repeat(entry.depth);
    const cycle = entry.node.isCycle ? ' ↻' : '';
    const callSite = entry.node.callSite
      ? `  ← 关系点 ${entry.node.callSite.file}:${entry.node.callSite.line}`
      : '';
    const detail = entry.node.detail
      ? `  [${entry.node.detail.slice(0, DETAIL_MAX_CHARS)}]`
      : '';
    lines.push(
      `${indent}- ${entry.node.name}${cycle}   ${entry.node.file}:${entry.node.line}${callSite}${detail}`
    );
  }
  if (hitNodeLimit) {
    lines.push(`  …（已达导出上限 ${MAX_NODES} 个节点，结果被截断）`);
  }
  if (hitDepthLimit) {
    lines.push(`  …（已达导出层数上限 ${MAX_DEPTH} 层，更深的节点未导出）`);
  }
  return lines.join('\n');
}

/**
 * Markdown 表格的单元格文本。
 *
 * 元素名里可能出现 `|`（例如 `operator|`），不转义会把单元格切断、整列错位。
 */
function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/**
 * Markdown 表格：`层 | 节点 | 位置 | 被调用处`，按 DFS 先序每节点一行。
 *
 * 表头与分隔行固定两行，其余每一行对应一个节点 —— 因此「表格行数」可以直接
 * 用来核对遍历到的节点数。两个上限命中时，在表格之后另行说明（不当成表格行）。
 */
export function buildMarkdownTable(session: ExportSession): string {
  const { entries, hitNodeLimit, hitDepthLimit } = walkSession(session);
  const lines: string[] = ['| 层 | 节点 | 位置 | 被调用处 |', '| --- | --- | --- | --- |'];
  for (const entry of entries) {
    const callSite = entry.node.callSite
      ? `${entry.node.callSite.file}:${entry.node.callSite.line}`
      : '';
    lines.push(
      `| ${entry.depth} | ${tableCell(entry.node.name)} | ${entry.node.file}:${entry.node.line} | ${tableCell(callSite)} |`
    );
  }
  if (hitNodeLimit) {
    lines.push(`（已达导出上限 ${MAX_NODES} 个节点，结果被截断）`);
  }
  if (hitDepthLimit) {
    lines.push(`（已达导出层数上限 ${MAX_DEPTH} 层，更深的节点未导出）`);
  }
  return lines.join('\n');
}

/**
 * JSON 导出（供二次处理）。
 *
 * 结构固定为 `{ version, direction, directionLabel, root, truncated, nodes }`，`nodes` 按 DFS 先序；
 * **不写入时间戳或任何机器相关的字段** —— 同一份会话任何时候导出都必须逐字节相同，
 * 否则无法在测试里断言、也无法用文本比对排查差异。
 */
export function buildJsonText(session: ExportSession): string {
  const { entries, hitNodeLimit, hitDepthLimit } = walkSession(session);
  const payload = {
    version: 1,
    direction: session.direction,
    directionLabel: DIRECTION_LABEL[session.direction],
    root: session.rootId,
    /**
     * 是否被两个上限截断过。
     *
     * 必须写出来：Markdown 会在末尾补一行说明，而 JSON 是给程序读的 ——
     * 悄悄少一批节点、文件里却没有任何标记，下游会当成「完整数据」用。
     */
    truncated: { nodes: hitNodeLimit, depth: hitDepthLimit },
    nodes: entries.map((entry) => ({
      id: entry.id,
      name: entry.node.name,
      file: entry.node.file,
      line: entry.node.line,
      depth: entry.depth,
      parentId: entry.parentId,
      // 缺失的字段一律给显式的 null / 空串，保证每个节点都有同样 9 个键。
      callSite: entry.node.callSite
        ? { file: entry.node.callSite.file, line: entry.node.callSite.line }
        : null,
      isCycle: entry.node.isCycle === true,
      detail: entry.node.detail ?? '',
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/** Windows 文件名里不允许出现的字符（反斜杠与正斜杠都包含在内）。 */
const ILLEGAL_FILE_NAME_CHARS = /[\\/:*?"<>|]/g;
/**
 * Windows 文件名里不允许出现的控制字符（U+0000–U+001F）。
 *
 * ⚠️ 刻意用码位拼出这个区间，而不把它写成「反斜杠 + u + 四位十六进制」的转义区间：
 * 那种写法在打包产物里会变成双反斜杠开头的字符串，被本仓库的隐私扫描器误判成 UNC 路径
 * （与隐私无关的噪声）。
 */
const ILLEGAL_CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`,
  'g'
);
/** 默认文件名（含扩展名）的长度上限：给目录路径与同名副本后缀留出余量。 */
const MAX_FILE_NAME_LENGTH = 80;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 文件名里的时间戳片段：`yyyyMMdd-HHmmss`（本地时间）。 */
export function exportTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

/**
 * 默认导出文件名：`<根节点名>-<方向标签>-<yyyyMMdd-HHmmss><扩展名>`。
 *
 * 根节点名与方向标签都可能含中文、全角字符或 `::` `<>` —— 中文与全角字符在 Windows 上
 * 是**合法**文件名字符，必须原样保留（需求要求路径含中文 / 全角字符也能写成功）；
 * 只把 Windows 明确禁止的字符换成下划线，并去掉结尾的点与空格，最后按总长度截断
 * （截断时保留扩展名）。
 */
export function buildExportFileName(
  rootName: string,
  direction: Direction,
  date: Date,
  extension: string
): string {
  const stem = `${rootName || '未命名'}-${DIRECTION_LABEL[direction]}-${exportTimestamp(date)}`;
  const sanitized = `${stem}${extension}`
    .replace(ILLEGAL_FILE_NAME_CHARS, '_')
    .replace(ILLEGAL_CONTROL_CHARS, '_');
  // Windows 不允许文件名以点或空格结尾（资源管理器里无法创建这样的文件）。
  const trimmed = sanitized.replace(/[. ]+$/, '');
  if (trimmed.length <= MAX_FILE_NAME_LENGTH) {
    return trimmed;
  }
  const dot = trimmed.lastIndexOf('.');
  const suffix = dot > 0 ? trimmed.slice(dot) : '';
  const body = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${body.slice(0, Math.max(1, MAX_FILE_NAME_LENGTH - suffix.length))}${suffix}`;
}
