/**
 * 关系抽象层：目前只有「调用关系」一种实现。
 *
 * 走 LSP 调用层级：
 *   vscode.prepareCallHierarchy / provideIncomingCalls / provideOutgoingCalls
 *
 * 备注：宏、变量、类型这些 C/C++ 里没有「调用层级」的符号，需要引用查找
 * （vscode.executeReferenceProvider）。该能力曾实现过一版但按需求移除了，
 * 需要时在这里新增一种 RelationQuery 即可，图/布局/会话层不用改。
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
