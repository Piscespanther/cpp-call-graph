/**
 * 构建脚本：
 *  1) 扩展主体 src/extension.ts -> dist/extension.js（vscode 为 external）
 *  2) Webview 前端 src/webview/graph.ts -> dist/webview.js（浏览器 IIFE，无 external）
 *  .html / .css 通过 esbuild 的 text loader 内联进扩展包，避免多一份资源分发。
 */
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  loader: { '.html': 'text', '.css': 'text' },
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['src/webview/graph.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'dist/webview.js',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(webviewOptions),
    ]);
    await Promise.all(contexts.map((context) => context.watch()));
    console.log('[esbuild] watching extension + webview...');
    return;
  }
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
