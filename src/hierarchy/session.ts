/**
 * 会话模型：每一次「被调用关系图 / 调用关系图」= 一个标签页。
 *
 * 每个会话独立持有自己的关系图（节点、子节点、引用点、展开状态），互不影响；
 * 关闭某个标签只是丢弃这个会话，其它标签继续存在。
 *
 * 两条取数路径共用这一套模型：
 *   - 调用关系：`expandRelation()` → 语言服务的调用层级（`provideIncomingCalls` 等）
 *   - 引用关系：宏、类型、变量这类**没有调用层级**的符号，由 `references.ts` 用引用查找
 *     预先算好一层，再经 `seedRoot()` 按同样的形状写进图（下面各层照旧走调用层级）
 */
import * as vscode from 'vscode';
import { itemKey } from './callHierarchy';
import { logInfo, logWarn } from '../util/log';
import {
  Answer,
  RelationQuery,
  createQuery,
  expandRelation,
} from './relations';
import {
  Direction,
  GraphEdge,
  GraphNode,
  SessionKind,
  kindOf,
  symbolKindToNodeKind,
  KNOWN_NODE_KINDS,
} from './graphTypes';
import { collectEdges } from './graphLayout';

/**
 * 单次展开的等待上限。
 *
 * 语言服务若挂住不返回（大工程首次解析、clangd 卡在索引上），`await` 会一直悬着：
 * 节点永久点不开、`inflight` 永久占位，而日志还会写成「没有下一层调用关系」——
 * 等于把「没响应」伪装成「本来就没有」。加上限后至少能放弃并让用户重试。
 *
 * 写成可变对象是为了让测试把它调小（生产用默认值 20 秒）；
 * `smoke.js` 通过产物导出的 `__session.expandTimeout` 读它。
 */
export const expandTimeout = { ms: 20000 };

/** 展开超时（与真正的失败区分开：超时只记警告、不标记节点已加载）。 */
class ExpandTimeoutError extends Error {}

/** 给展开请求加超时；超时抛 ExpandTimeoutError，底层请求继续跑但不再改状态。 */
async function withExpandTimeout<T>(work: Promise<T>, nodeName: string): Promise<T> {
  const limit = expandTimeout.ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // 亚秒上限只在测试里出现；生产是 20 秒。别写成「超过 0 秒」。
          const waited = limit >= 1000 ? `${Math.round(limit / 1000)} 秒` : `${limit} 毫秒`;
          reject(new ExpandTimeoutError(`展开「${nodeName}」等待语言服务超过 ${waited}`));
        }, limit);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * 两条路径的「亲疏」分值：同文件最高，其次同目录，再次按公共目录段数。
 *
 * 用途是同级排序：并列目录下常有同名的文件与函数，把与父项**路径最接近**的那个放在
 * 兄弟序列的正中，视线不用来回找（用户 2026-10-13 的需求）。
 */
export function pathCloseness(parentFile: string, childFile: string): number {
  if (!parentFile || !childFile) {
    return 0;
  }
  if (parentFile === childFile) {
    return 100000;
  }
  const parentDirs = parentFile.split(/[\\/]/).slice(0, -1);
  const childDirs = childFile.split(/[\\/]/).slice(0, -1);
  if (parentDirs.join('/') === childDirs.join('/')) {
    return 90000;
  }
  let common = 0;
  while (
    common < parentDirs.length &&
    common < childDirs.length &&
    parentDirs[common] === childDirs[common]
  ) {
    common += 1;
  }
  return common;
}

/**
 * 把子项排成「最亲的居中」：最亲的一组放中段，其余保持原相对顺序上下分摊。
 *
 * 只动顺序，不动数据；布局按 `children` 的顺序纵向堆叠，所以这里就是最终的上下顺序。
 */
export function arrangeByProximity(
  parentFile: string,
  childIds: string[],
  fileOf: (id: string) => string
): string[] {
  if (childIds.length <= 2) {
    return childIds;
  }
  const scored = childIds.map((id) => ({ id, score: pathCloseness(parentFile, fileOf(id)) }));
  const best = Math.max(...scored.map((item) => item.score));
  const centerIds = new Set(scored.filter((item) => item.score === best).map((item) => item.id));
  if (centerIds.size === 0 || centerIds.size === childIds.length) {
    return childIds;
  }
  const center = childIds.filter((id) => centerIds.has(id));
  const rest = childIds.filter((id) => !centerIds.has(id));
  const half = Math.floor(rest.length / 2);
  return [...rest.slice(0, half), ...center, ...rest.slice(half)];
}

export interface RootDescriptor {  name: string;
  detail?: string;
  kind: vscode.SymbolKind;
  uri: string;
  range: SerializedRange;
  selectionRange: SerializedRange;
}

interface SerializedRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/**
 * 快照里的节点：在 `GraphNode` 之外多存一份「语言服务给的项」。
 *
 * ⚠️ 必须存：`expand()` 与「双击跳转」都依赖每个节点的 item。只恢复根的话，
 * 重载窗口后除根以外所有方框的双击跳转都会静默失效，叶子的「+」点了也没反应。
 * 旧版本快照没有这个字段，恢复时按「无 item」处理（当叶子，不画死「+」）。
 */
export interface SerializedNode extends GraphNode {
  item?: RootDescriptor;
}

export interface SerializedSession {
  id: string;
  direction: Direction;
  kind: SessionKind;
  engineLabel: string;
  root: RootDescriptor;
  nodes: SerializedNode[];
  createdAt: number;
}

export function serializeItem(item: vscode.CallHierarchyItem): RootDescriptor {
  return {
    name: item.name,
    detail: item.detail,
    kind: item.kind,
    uri: item.uri.toString(),
    range: serializeRange(item.range),
    selectionRange: serializeRange(item.selectionRange ?? item.range),
  };
}

function serializeRange(range: vscode.Range): SerializedRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function deserializeRange(range: SerializedRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}

export function deserializeItem(descriptor: RootDescriptor): vscode.CallHierarchyItem {
  const uri = vscode.Uri.parse(descriptor.uri);
  return {
    name: descriptor.name,
    detail: descriptor.detail,
    kind: descriptor.kind,
    tags: [],
    uri,
    range: deserializeRange(descriptor.range),
    selectionRange: deserializeRange(descriptor.selectionRange),
  } as vscode.CallHierarchyItem;
}

/**
 * 节点 id 的分隔符：**必须选符号名里不可能出现的字符**。
 *
 * 曾经用 `>`，而 C++ 的 `operator>` / `operator>>` / `operator->` / `operator<=>` 名字里
 * 自带 `>`，`baseKeyOf()`（靠 lastIndexOf('>') 取 key）会把 key 切错，
 * 环检测随之失效、图上多出重复方框。改用 NUL：源码里不可能出现，uri/key 里也不会。
 * 旧快照里的 id 仍是 `>` 分隔 —— `baseKeyOf()` 保留了旧格式的兜底分支。
 */
const ID_SEPARATOR = '\u0000';

/** 每层最多保留多少条（`cppCallGraph.maxChildrenPerNode`，默认 200）。
 *  ⚠️ 全工程只此一处读取该设置：手改 settings.json 写入 0/负数/NaN 时统一退到 200，
 *  避免下游算出 `nodeBudget = 负数` 之类的边界（曾让「展开全部」直接空转）。
 *  ⚠️ 下限还要夹一次 1：设置页的 `minimum: 1` 只画下划线、不阻止读取，手写 0.5 这种小数会
 *  满足 `> 0` 但 `Math.floor(0.5) === 0` —— 那时任何节点都展不开，图上永远只剩根。 */
export function maxChildrenPerNodeLimit(): number {
  const value = vscode.workspace
    .getConfiguration('cppCallGraph')
    .get<number>('maxChildrenPerNode', 200);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 200;
}

export class CallSession {
  /** 正在展开中的节点（并发护栏：同一节点不被同时展开两次）。 */
  private readonly inflight = new Set<string>();
  readonly id: string;
  readonly direction: Direction;
  readonly kind: SessionKind;
  readonly rootItem: vscode.CallHierarchyItem;
  readonly createdAt: number;
  engineLabel: string;

  private nodes = new Map<string, GraphNode>();
  private items = new Map<string, vscode.CallHierarchyItem>();
  private edges: GraphEdge[] = [];
  private query: RelationQuery;

  constructor(
    id: string,
    direction: Direction,
    rootItem: vscode.CallHierarchyItem,
    engineLabel: string,
    createdAt = Date.now()
  ) {
    this.id = id;
    this.direction = direction;
    this.kind = kindOf(direction);
    this.rootItem = rootItem;
    this.engineLabel = engineLabel;
    this.createdAt = createdAt;
    this.query = createQuery(this.kind);

    const rootId = itemKey(rootItem);
    this.nodes.set(rootId, {
      id: rootId,
      name: rootItem.name,
      detail: rootItem.detail,
      file: relativeFile(rootItem.uri),
      line: rootItem.selectionRange.start.line + 1,
      direction,
      depth: 0,
      isCycle: false,
      children: [],
      loaded: false,
      kind: symbolKindToNodeKind(rootItem.kind),
    });
    this.items.set(rootId, rootItem);
    // 边由 graph() 现算（这里算一次的结果下一次必然被覆盖，属于白做）
  }

  get rootId(): string {
    return itemKey(this.rootItem);
  }

  /**
   * 标签标题：只放元素名。
   *
   * 曾经拼成「被调用:bsp_boot」这种带方向前缀的形式，但方向已经由标签上的
   * 箭头图标表达了（`call-incoming` / `call-outgoing`），前缀纯属重复，
   * 还把真正有用的名字挤到后面。方向文案仍由 DIRECTION_SHORT 提供，
   * 用于视图标题与提示。
   */
  get title(): string {
    return this.rootItem.name;
  }

  get description(): string {
    return `${relativeFile(this.rootItem.uri)}:${this.rootItem.selectionRange.start.line + 1}`;
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  item(id: string): vscode.CallHierarchyItem | undefined {
    return this.items.get(id);
  }

  nodeRecord(): Record<string, GraphNode> {
    const record: Record<string, GraphNode> = {};
    for (const [id, node] of this.nodes) {
      record[id] = node;
    }
    return record;
  }

  graph(): { nodes: Record<string, GraphNode>; edges: GraphEdge[] } {
    this.edges = collectEdges(this.nodeRecord(), this.rootId);
    return { nodes: this.nodeRecord(), edges: this.edges };
  }

  get collapsedCount(): number {
    let count = 0;
    for (const node of this.nodes.values()) {
      if (!node.loaded && !node.isCycle) {
        count += 1;
      }
    }
    return count;
  }

  /** 除根以外是否真的有节点（没有就说明这个关系确实不存在）。 */
  get hasContent(): boolean {
    return this.nodes.size > 1;
  }

  /**
   * 展开一个节点：向语言服务请求它的下一层关系并写入图。
   * 返回新增的节点数量（0 表示确实是叶子）。
   *
   * @param maxNew 本次最多新增几个子项（省略即只受 `maxChildrenPerNode` 约束）。
   *   「展开全部」用它把**剩余预算**传进来：预算是每次 expand **之前**检查的，而单次 expand
   *   最多能新增 maxChildrenPerNode 个，不夹这一层总数就会冲过布局上限
   *   （默认档位下 799 + 200 = 999 > 800），超出的节点既没有方框也没有连线。
   */
  async expand(nodeId: string, maxNew?: number): Promise<number> {
    const node = this.nodes.get(nodeId);
    const item = this.items.get(nodeId);
    if (!node || !item || node.loaded || node.isCycle) {
      return 0;
    }
    // 并发护栏：`node.loaded` 要等 await 之后才置位，而 VS Code 不串行化消息 ——
    // 「点 + 后立刻点展开全部」或「连点两次展开全部」会让同一节点被并发展开，
    // 结果是重复语言服务请求 + `omitted` 重复累加。
    if (this.inflight.has(nodeId)) {
      return 0;
    }
    this.inflight.add(nodeId);
    try {
      const ancestors = this.ancestorKeys(node);
      const results = await withExpandTimeout(
        expandRelation(this.query, this.direction, item),
        node.name
      );
      return this.applyResults(node, results, ancestors, maxNew);
    } catch (error) {
      if (error instanceof ExpandTimeoutError) {
        // ⚠️ 不能把超时当成「没有下一层」：那会把「语言服务没响应」写成「这一层本来就没有调用关系」，
        // 用户据此以为结果正确。这里只记警告，且**不标记 node.loaded** —— 节点仍可再点一次重试。
        logWarn(`${error.message}；本次展开已放弃（节点未标记为已加载，可重试）。`);
        return 0;
      }
      throw error;
    } finally {
      this.inflight.delete(nodeId);
    }
  }

  /**
   * 把「引用查找」得到的一层结果直接灌进根节点 —— 供宏、类型、变量这类
   * **没有调用层级**的符号使用。
   *
   * 与 `expand()` 的区别只在于那一层的来源：调用层级来自语言服务，引用来自
   * `resolveByReferences()`。写进图时走的是同一个 `applyResults()`，所以子节点的 id、
   * 边、调用点、图标类型都与正常展开完全一致 —— 下面的层照旧可以继续展开。
   */
  seedRoot(answers: Answer[]): number {
    const node = this.nodes.get(this.rootId);
    if (!node || node.loaded) {
      return 0;
    }
    return this.applyResults(node, answers, [this.rootId]);
  }

  private applyResults(
    node: GraphNode,
    results: Answer[],
    ancestors: string[],
    maxNew?: number
  ): number {
    let added = 0;
    // 每层数量上限：设置的**名字**就是"每个节点最多几个子项"，所以在这里真正生效
    // （此前它只被「展开全部」的预算用到，手动展开完全不截断 —— 那是个名不副实的 bug）。
    // maxNew 是「展开全部」按剩余预算给的更紧的一层上限，取两者较小值。
    const perNode = maxChildrenPerNodeLimit();
    const limit = Math.max(0, Math.min(perNode, maxNew ?? Number.POSITIVE_INFINITY));
    const omitted = results.length > limit ? results.length - limit : 0;
    if (omitted > 0) {
      node.omitted = (node.omitted ?? 0) + omitted;
      logInfo(
        `「${node.name}」的下一层共 ${results.length} 条，本次上限 ${limit} 条` +
          `（maxChildrenPerNode=${perNode}${maxNew !== undefined ? `，剩余预算 ${maxNew}` : ''}），` +
          `省略 ${omitted} 条。`
      );
    }
    const limited = omitted > 0 ? results.slice(0, limit) : results;
    for (const result of limited) {
      const key = itemKey(result.item);
      const isCycle = key === this.rootId || ancestors.includes(key);
      const id = isCycle
        ? `${node.id}${ID_SEPARATOR}cycle@${key}@${result.item.selectionRange.start.line}`
        : `${node.id}${ID_SEPARATOR}${key}`;
      // 同一个 id 只可能来自同一份结果（id 由 key 决定），已在图里就只补一条父子边。
      if (this.nodes.has(id)) {
        if (!node.children.includes(id)) {
          node.children.push(id);
        }
        continue;
      }
      this.nodes.set(id, {
        id,
        name: result.item.name,
        detail: result.detail ?? result.item.detail,
        file: relativeFile(result.item.uri),
        line: result.item.selectionRange.start.line + 1,
        callSite: result.callSite
          ? {
              file: relativeFile(result.callSite.uri),
              line: result.callSite.line + 1,
              text: result.callSite.text,
            }
          : undefined,
        direction: this.direction,
        depth: node.depth + 1,
        isCycle,
        children: [],
        parent: node.id,
        loaded: isCycle,
        // 类型一律由语言服务给出的 SymbolKind 推导（枚举/结构体/成员等都能落到具体类型）
        kind: symbolKindToNodeKind(result.item.kind),
      });
      this.items.set(id, result.item);
      node.children.push(id);
      added += 1;
    }
    node.loaded = true;
    node.children = arrangeByProximity(
      node.file,
      node.children,
      (id) => this.nodes.get(id)?.file ?? ''
    );
    return added;
  }

  private ancestorKeys(node: GraphNode): string[] {
    const keys: string[] = [];
    let current: GraphNode | undefined = node;
    const guard = new Set<string>();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      keys.push(baseKeyOf(current.id));
      current = current.parent ? this.nodes.get(current.parent) : undefined;
    }
    keys.push(this.rootId);
    return keys;
  }

  serialize(): SerializedSession {
    return {
      id: this.id,
      direction: this.direction,
      kind: this.kind,
      engineLabel: this.engineLabel,
      root: serializeItem(this.rootItem),
      createdAt: this.createdAt,
      nodes: [...this.nodes.values()].map((node) => {
        const item = this.items.get(node.id);
        return {
          ...node,
          children: [...node.children],
          item: item ? serializeItem(item) : undefined,
        };
      }),
    };
  }

  static restore(snapshot: SerializedSession): CallSession {
    const item = deserializeItem(snapshot.root);
    const session = new CallSession(
      snapshot.id,
      snapshot.direction,
      item,
      snapshot.engineLabel,
      snapshot.createdAt
    );
    session.nodes = new Map();
    session.items = new Map();
    for (const node of snapshot.nodes) {
      const withItem = node.item;
      const restored: SerializedNode = {
        ...node,
        children: [...node.children],
        // 旧版本存下来的 kind 可能是已废弃的值（如 'macro' / 'type'），
        // 统一归一化，避免恢复到不认识的类型后角标画不出来。
        kind: normalizeNodeKind(node.kind),
        // 有 item 的节点**按原样**恢复加载态（数据还在，展开/跳转都可用）；
        // 没有 item 的（旧快照）只能当叶子 —— 否则会画出一个点了没反应的「+」。
        // ⚠️ 这里曾经写成 `node.loaded && (!node.children.length || node.isCycle)`：
        // 有子节点时右半恒为 false，于是**所有已展开的父节点（含根）恢复后都变成未加载** ——
        // 表现为重载窗口后「展开全部」对整棵已展开的树重发一轮请求，且 `omitted` 被重复累加。
        loaded: withItem ? node.loaded : true,
      };
      session.nodes.set(restored.id, restored);
      if (withItem) {
        try {
          session.items.set(restored.id, deserializeItem(withItem));
        } catch (error) {
          logWarn(`恢复节点 ${restored.id} 的语言服务项失败：${String(error)}`);
        }
      }
    }
    // 根始终以快照里的 root 为准（它一定存在）
    session.items.set(session.rootId, item);
    return session;
  }
}

/** 归一化历史数据里的节点类型。 */
function normalizeNodeKind(kind: unknown): GraphNode['kind'] {
  const value = String(kind ?? '');
  if ((KNOWN_NODE_KINDS as readonly string[]).includes(value)) {
    return value as GraphNode['kind'];
  }
  // 旧值映射：宏/类型等旧分类退化成最接近的当前分类
  if (value === 'macro') {
    return 'function';
  }
  if (value === 'type') {
    return 'class';
  }
  return 'other';
}

/**
 * 从节点 id 里取出该目标本身的 key。
 *
 * 新格式：`<父id>\0<key>`，环节点带 `\0cycle@` 前缀；`\0` 不会出现在符号名里，切分是明确的。
 * 旧格式（0.20 及以前持久化下来的快照）：`<父id>><key>`，且 `key` 末尾是符号名 ——
 * 对含 `>` 的名字（`operator>`）本来就切不准，这里保留原样只为让旧快照还能用。
 */
export function baseKeyOf(id: string): string {
  const nul = id.lastIndexOf(ID_SEPARATOR);
  if (nul >= 0) {
    const rest = id.slice(nul + 1);
    const cycleMarker = 'cycle@';
    if (rest.startsWith(cycleMarker)) {
      const body = rest.slice(cycleMarker.length);
      const at = body.lastIndexOf('@');
      return at >= 0 ? body.slice(0, at) : body;
    }
    return rest;
  }
  // ↓ 旧格式兜底
  const marker = '>cycle@';
  const cycleIndex = id.indexOf(marker);
  if (cycleIndex >= 0) {
    const rest = id.slice(cycleIndex + marker.length);
    const at = rest.lastIndexOf('@');
    return at >= 0 ? rest.slice(0, at) : rest;
  }
  const index = id.lastIndexOf('>');
  return index >= 0 ? id.slice(index + 1) : id;
}

export function relativeFile(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}
