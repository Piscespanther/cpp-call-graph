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
  checkCssHasNoBom();
}

/**
 * 内联样式表**绝不能**带 BOM。
 *
 * 立此检查的原因（2026-10-14 事故）：`graph.css` 被编辑器工具写成了带 BOM 的 UTF-8，BOM 随
 * 内联 `<style>` 进入浏览器，CSS 解析器把它当非法记号、**丢掉紧随其后的第一条规则** ——
 * 而所有自定义属性（`--node-bg` / `--edge` / `--node-fg` / `--tab-bg` …）都定义在 `:root` 里。
 * 变量全空后 `fill` / `stroke` / `color` 一律回落到初始值 black：方框全黑、箭头全黑、
 * 标签文字全黑，而带内联颜色的小图标照常显示。改一处颜色样式就整幅界面发黑，极难联想到 BOM。
 */
function checkCssHasNoBom() {
  const file = path.join(__dirname, '..', 'src', 'webview', 'graph.css');
  const bytes = fs.readFileSync(file);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(
      'src/webview/graph.css 带 UTF-8 BOM：它会让内联样式表的第一条规则（:root）被解析器丢弃，' +
        '导致所有主题变量失效、界面整片变黑。请去掉 BOM 后重新构建'
    );
  }
  const text = bytes.toString('utf8');
  if (!text.startsWith(':root')) {
    throw new Error(
      `src/webview/graph.css 必须以 :root 开头（实际开头：${JSON.stringify(text.slice(0, 12))}）` +
        '—— 前面多出任何字符都会让 :root 整条失效'
    );
  }
  console.log('[checks] graph.css 无 BOM 且以 :root 开头');
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
