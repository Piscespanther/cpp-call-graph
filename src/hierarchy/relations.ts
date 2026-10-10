/**
 * 关系抽象层：目前只有「调用关系」一种实现。
 *
 * 走 LSP 调用层级：
 *   vscode.prepareCallHierarchy / provideIncomingCalls / provideOutgoingCalls
 *
 * 备注：宏、变量、类型这些 C/C++ 里没有「调用层级」的符号走**引用查找**
 * （`references.ts` 的 `resolveByReferences()`）：它在会话建立时算好一层
 * `Answer[]`，再由 `CallSession.seedRoot()` 写进图 —— 不经过这里的 `RelationQuery`，
 * 因为那一层来自引用而不是调用层级。
 */
import * as vscode from 'vscode';
import { fetchCallsDetailed } from './callHierarchy';
import { Direction, GraphNode, SessionKind } from './graphTypes';

export interface RelationQuery {
  kind: SessionKind;
}

export interface Answer {
  item: vscode.CallHierarchyItem;
  callSite?: { uri: vscode.Uri; line: number; text: string };
  detail?: string;
  kind?: GraphNode['kind'];
}

export function createQuery(kind: SessionKind): RelationQuery {
  return { kind };
}

/** 展开某个节点，返回它的下一层关系。 */
export async function expandRelation(
  query: RelationQuery,
  direction: Direction,
  item: vscode.CallHierarchyItem
): Promise<Answer[]> {
  void query;
  const calls = await fetchCallsDetailed(direction, item);
  return calls.map((call) => ({ item: call.item, callSite: call.callSite }));
}
