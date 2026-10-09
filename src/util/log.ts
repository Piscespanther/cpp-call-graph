/** 输出通道，用于打印诊断信息，不干扰底部面板的树视图。 */
import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('C/C++ 调用关系图', {
      log: true,
    });
  }
  return channel;
}

export function logInfo(message: string): void {
  getChannel().info(message);
}

export function logWarn(message: string): void {
  getChannel().warn(message);
}

export function logError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error ?? '');
  getChannel().error(detail ? `${message}: ${detail}` : message);
}

export function showLog(): void {
  getChannel().show(true);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}
