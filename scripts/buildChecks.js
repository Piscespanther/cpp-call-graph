/** 把供冒烟测试使用的 TS 检查脚本打包成 CommonJS（vscode 为 external）。 */
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
  logLevel: 'warning',
};

/**
 * 产物健全性检查。
 *
 * 立此检查的原因：曾发生过「打包出来的 webview.js 是旧的、缺少自适应宽度逻辑」，
 * 而所有测试都跑在**刚构建**的产物上、全部通过，于是发出去的包是坏的。
 * 这里至少把「产物明显不完整」的情况拦在打包之前。
 */
function checkBundles() {
  const expectations = [
    { file: 'dist/webview.js', minBytes: 20000, label: 'Webview 前端' },
    { file: 'dist/extension.js', minBytes: 30000, label: '扩展主体' },
  ];
  for (const { file, minBytes, label } of expectations) {
    const full = path.join(__dirname, '..', file);
    if (!fs.existsSync(full)) {
      throw new Error(`产物缺失：${file}（${label} 没有构建成功）`);
    }
    const { size, mtime } = fs.statSync(full);
    if (size < minBytes) {
      throw new Error(
        `产物疑似不完整：${file} 只有 ${size} 字节（应 ≥ ${minBytes}）——` +
          `可能是旧产物或被部分覆盖，请重新构建`
      );
    }
    console.log(`[checks] ${file} 就绪（${size} 字节，${mtime.toISOString()}）`);
  }
}

async function main() {
  await Promise.all([
    esbuild.build({
      ...shared,
      entryPoints: ['scripts/engineCheck.ts'],
      outfile: 'dist/engine-check.js',
    }),
    esbuild.build({
      ...shared,
      entryPoints: ['scripts/layoutCheck.ts'],
      outfile: 'dist/layout-check.js',
    }),
  ]);
  console.log('[checks] engine-check.js + layout-check.js 已生成');
  checkBundles();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
