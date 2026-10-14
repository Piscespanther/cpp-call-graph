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

/**
 * 扩展是否正在停止（`deactivate` 时置位）。
 *
 * 窗口重载/退出时，所有在途的语言服务请求与文件读取都会以 `Canceled` 结束，
 * 那时逐文件写一条警告毫无意义（真机上曾一次刷出十几行）。
 */
let shuttingDown = false;

/** 供 `deactivate()` 调用：之后取消类错误不再写警告。 */
export function markShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * 该错误是否属于「请求被取消」（而不是真的失败）。
 *
 * 判据有两条：错误文本含 `cancel`（VS Code 取消请求时给的就是 `Canceled`），
 * 或者扩展已经在停止过程中。
 */
export function isCancellation(error: unknown): boolean {
  if (shuttingDown) {
    return true;
  }
  const text = error instanceof Error ? error.message : String(error ?? '');
  return /cancel/i.test(text);
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
