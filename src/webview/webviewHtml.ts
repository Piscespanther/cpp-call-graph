/** 生成 WebviewView / WebviewPanel 的 HTML（内联 CSS，脚本通过 asWebviewUri 引入）。 */
import * as vscode from 'vscode';
import template from './graph.html?text';
import styles from './graph.css?text';

/**
 * 允许 webview 加载的本地资源根目录。
 *
 * 必须显式给出扩展自身的目录：`localResourceRoots` 一旦被设成空数组
 * （或漏掉 `dist`），`<script src=".../webview.js">` 会被直接拦掉，
 * webview 脚本永远不会执行 —— 表现就是面板/视图一片空白，而且宿主完全
 * 收不到任何错误（因为这是 workbench 侧的静默拦截，不是脚本报错）。
 */
export function webviewResourceRoots(): vscode.Uri[] {
  return [vscode.Uri.file(__dirname)];
}

export function renderGraphHtml(webview: vscode.Webview): string {
  const nonce = createNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(vscode.Uri.file(__dirname), 'webview.js')
  ).toString();
  // 必须用 replaceAll：nonce 在 CSP、<style>、<script> 里各出现一次，
  // 只替换第一个会导致 <script nonce="{{nonce}}"> 与 CSP 不匹配，
  // 脚本被 CSP 拒绝执行 —— 表现同样是「面板一片空白」。
  return template
    .replaceAll('{{cspSource}}', webview.cspSource)
    .replaceAll('{{nonce}}', nonce)
    .replaceAll('{{scriptUri}}', scriptUri)
    .replace('</head>', `<style nonce="${nonce}">${styles}</style></head>`);
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
