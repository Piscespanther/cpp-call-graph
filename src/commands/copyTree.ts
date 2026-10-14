/**
 * 把当前会话导成纯文本（两空格缩进），方便粘贴到 issue / 文档。
 * 只导出已经展开的节点，不主动触发新的语言服务请求。
 *
 * ⚠️ 正文逻辑在 `commands/exportGraph.ts` 的 `buildMarkdownTree()`（不引用 vscode API，
 * 便于断言）；本文件只保留进度提示、剪贴板命令与既有函数签名。
 * ⚠️ 入参是 `ExportSession`（**所见视图**，见 `graphView.exportView()`）：调用方若直接把
 * `CallSession` 传进来也能用（字段相容），但那样会把过滤掉的节点一起复制出去。
 */
import * as vscode from 'vscode';
import { CallSession } from '../hierarchy/session';
import { DIRECTION_LABEL } from '../hierarchy/graphTypes';
import { ExportSession, buildMarkdownTree } from './exportGraph';

/** 复制结果：交给调用方展示，避免在这里弹任何 UI。 */
export interface CopyResult {
  ok: boolean;
  /** 成功时是复制的内容（用于日志/提示），失败时是原因。 */
  text: string;
}

/** 复制「元素」：只要选中节点的符号名。 */
export async function copyNodeName(session: CallSession, nodeId?: string): Promise<CopyResult> {
  const id = nodeId ?? session.rootId;
  const node = session.node(id);
  if (!node) {
    return { ok: false, text: '找不到要复制的元素（节点可能已被关闭或尚未加载）' };
  }
  await vscode.env.clipboard.writeText(node.name);
  return { ok: true, text: node.name };
}

/** 复制「地址」：文件路径加行号，例如 `components/LIB/boot/lib_boot.h:23`。 */
export async function copyNodeLocation(
  session: CallSession,
  nodeId?: string
): Promise<CopyResult> {
  const id = nodeId ?? session.rootId;
  const node = session.node(id);
  if (!node) {
    return { ok: false, text: '找不到要复制的地址（节点可能已被关闭或尚未加载）' };
  }
  const text = `${node.file}:${node.line}`;
  await vscode.env.clipboard.writeText(text);
  return { ok: true, text };
}

export async function buildSessionText(session: ExportSession): Promise<string> {
  const root = session.node(session.rootId);
  if (!root) {
    return '';
  }
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `正在导出${DIRECTION_LABEL[session.direction]}…`,
      cancellable: false,
    },
    // 正文交给纯函数：输出与改动前逐字一致，这里只剩进度提示与既有签名。
    async () => buildMarkdownTree(session)
  );
}
