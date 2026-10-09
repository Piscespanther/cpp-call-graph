/**
 * 把当前会话导成纯文本（两空格缩进），方便粘贴到 issue / 文档。
 * 只导出已经展开的节点，不主动触发新的语言服务请求。
 */
import * as vscode from 'vscode';
import { CallSession } from '../hierarchy/session';
import { DIRECTION_LABEL } from '../hierarchy/graphTypes';

const MAX_DEPTH = 8;
const MAX_NODES = 500;

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

/** 复制「地址」：文件路径加行号，例如 `components/BSP/boot/bsp_boot.h:23`。 */
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

export async function buildSessionText(session: CallSession): Promise<string> {
  const root = session.node(session.rootId);
  if (!root) {
    return '';
  }
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在导出${DIRECTION_LABEL[session.direction]}…`,
      cancellable: false,
    },
    async () => {
      const lines: string[] = [
        `# ${DIRECTION_LABEL[session.direction]}：${root.name}（${root.file}:${root.line}）`,
      ];
      const visited = new Set<string>();
      let budget = MAX_NODES;
      const walk = (nodeId: string, depth: number): void => {
        if (budget <= 0 || depth > MAX_DEPTH) {
          return;
        }
        const node = session.node(nodeId);
        if (!node || visited.has(nodeId)) {
          return;
        }
        visited.add(nodeId);
        budget -= 1;
        const indent = '  '.repeat(depth);
        const cycle = node.isCycle ? ' ↻' : '';
        const callSite = node.callSite
          ? `  ← 关系点 ${node.callSite.file}:${node.callSite.line}`
          : '';
        const detail = node.detail ? `  [${node.detail.slice(0, 60)}]` : '';
        lines.push(
          `${indent}- ${node.name}${cycle}   ${node.file}:${node.line}${callSite}${detail}`
        );
        for (const child of node.children) {
          walk(child, depth + 1);
        }
      };
      walk(session.rootId, 0);
      if (budget <= 0) {
        lines.push('  …（已达导出上限，结果被截断）');
      }
      return lines.join('\n');
    }
  );
}
