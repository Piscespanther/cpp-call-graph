/** esbuild 的 text loader 让 `import x from './a.css?text'` 变成字符串。 */
declare module '*?text' {
  const content: string;
  export default content;
}
