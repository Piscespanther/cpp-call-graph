/**
 * 引擎探测逻辑的验证脚本（配合 scripts/smoke.js 的 vscode 桩使用）。
 * 单独跑：先由 esbuild 打包成 dist/engine-check.js，再用 smoke 的桩加载。
 */
import {
  clangdExecutable,
  describeEngine,
  explainUnavailable,
  listAvailableEngines,
  preferredEngine,
  resolveEngineChoice,
} from '../src/hierarchy/callHierarchy';

export function report(): string[] {
  const engines = listAvailableEngines();
  return [
    `clangdExecutable = ${clangdExecutable() ?? '(未找到)'}`,
    `listAvailableEngines = [${engines.join(', ')}]`,
    `preferredEngine = ${preferredEngine()}`,
    `resolveEngineChoice('clangd') = ${resolveEngineChoice('clangd')}`,
    `resolveEngineChoice('cpptools') = ${resolveEngineChoice('cpptools')}`,
    `explainUnavailable('clangd') = ${explainUnavailable('clangd') ?? '(可用)'}`,
    `describeEngine('clangd') = ${describeEngine('clangd')}`,
    `describeEngine('cpptools') = ${describeEngine('cpptools')}`,
  ];
}
