/**
 * 会话模型：每一次「显示被调用关系 / 显示调用关系 / 显示引用 …」= 一个标签页。
 *
 * 每个会话独立持有自己的关系图（节点、子节点、引用点、展开状态），互不影响；
 * 关闭某个标签只是丢弃这个会话，其它标签继续存在。
 *
 * 两类关系共用这一套模型：
 *   - call：函数 ←→ 调用者（被调用关系 / 调用关系）
 *   - refs：宏、宏函数、变量、类型等的引用关系（被引用关系 / 引用关系）
 */
import * as vscode from 'vscode';
import { itemKey } from './callHierarchy';
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

export interface RootDescriptor {
  name: string;
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

export interface SerializedSession {
  id: string;
  direction: Direction;
  kind: SessionKind;
  engineLabel: string;
  root: RootDescriptor;
  nodes: GraphNode[];
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

export class CallSession {
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
    this.edges = collectEdges(this.nodeRecord(), rootId);
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
   */
  async expand(nodeId: string): Promise<number> {
    const node = this.nodes.get(nodeId);
    const item = this.items.get(nodeId);
    if (!node || !item || node.loaded || node.isCycle) {
      return 0;
    }
    const ancestors = this.ancestorKeys(node);
    const results = await expandRelation(this.query, this.direction, item);
    return this.applyResults(node, results, ancestors);
  }

  private applyResults(
    node: GraphNode,
    results: Answer[],
    ancestors: string[]
  ): number {
    const seen = new Set<string>();
    let added = 0;
    for (const result of results) {
      const key = itemKey(result.item);
      const isCycle = key === this.rootId || ancestors.includes(key);
      const id = isCycle
        ? `${node.id}>cycle@${key}@${result.item.selectionRange.start.line}`
        : `${node.id}>${key}`;
      if (this.nodes.has(id)) {
        if (!node.children.includes(id)) {
          node.children.push(id);
        }
        continue;
      }
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
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
      nodes: [...this.nodes.values()].map((node) => ({ ...node, children: [...node.children] })),
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
      const restored: GraphNode = {
        ...node,
        children: [...node.children],
        // 旧版本存下来的 kind 可能是已废弃的值（如 'macro' / 'type'），
        // 统一归一化，避免恢复到不认识的类型后角标画不出来。
        kind: normalizeNodeKind(node.kind),
        // 恢复时把「已加载但子节点丢失」的节点重置为可展开，避免出现空 + 号。
        loaded: node.loaded && (!node.children.length || node.isCycle),
      };
      session.nodes.set(restored.id, restored);
    }
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

/** 从节点 id 里取出该目标本身的 key（id 形如 `<父id>><key>`，环节点带 `>cycle@` 后缀）。 */
export function baseKeyOf(id: string): string {
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
