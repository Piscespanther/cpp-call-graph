/**
 * 引擎层（配置档表驱动）的验证脚本（配合 scripts/smoke.js 的 vscode 桩使用）。
 * 单独跑：先由 esbuild 打包成 dist/engine-check.js，再用 smoke 的桩加载。
 *
 * 0.21 起这里覆盖三类事：
 *  ① 内置 clangd / cpptools 的可用性与显示名（与 0.20 行为一致）
 *  ② 自定义引擎（设置 `cppCallGraph.customEngines`）能被识别、能给出角标
 *  ③ 「选中引擎」的解析：auto / any / 具体 id / custom + customEngineId，以及未知 id 的退回
 */
import {
  badgeFor,
  clangdExecutable,
  describeEngine,
  engineProfiles,
  explainUnavailable,
  isProfileAvailable,
  listAvailableEngines,
  matchesProfile,
  pickPolicy,
  preferredEngine,
  profileById,
  selectedProfile,
} from '../src/hierarchy/callHierarchy';

/** 造一个最小的 item，用来验证认领规则（不依赖真实语言服务）。 */
function fakeItem(name: string, detail: string): {
  name: string;
  detail: string;
  kind: number;
  uri: { toString(): string };
  range: unknown;
  selectionRange: unknown;
  tags: never[];
} {
  return {
    name,
    detail,
    kind: 11,
    uri: { toString: () => 'file:///fake' },
    range: {},
    selectionRange: {},
    tags: [],
  };
}

export function report(): string[] {
  const engines = listAvailableEngines();
  const lines = [
    `clangdExecutable = ${clangdExecutable() ?? '(未找到)'}`,
    `listAvailableEngines = [${engines.join(', ')}]`,
    `preferredEngine = ${preferredEngine()}`,
    `engineProfiles = [${engineProfiles()
      .map((profile) => profile.id)
      .join(', ')}]`,
    `pickPolicy = ${pickPolicy()}`,
    `explainUnavailable('clangd') = ${explainUnavailable('clangd') ?? '(可用)'}`,
    `describeEngine('clangd') = ${describeEngine('clangd')}`,
    `describeEngine('cpptools') = ${describeEngine('cpptools')}`,
    `describeEngine('unknown') = ${describeEngine('unknown')}`,
  ];

  // 自定义引擎：id 不在内置表里，靠设置接进来。
  const custom = profileById('my-engine');
  lines.push(
    `customProfile(my-engine) = ${
      custom ? `${custom.label} / badge=${custom.badge ?? '(无)'} / 可用=${isProfileAvailable(custom)}` : '(未定义)'
    }`
  );
  if (custom) {
    lines.push(`matchesProfile(my-engine, 'my-engine_thing') = ${matchesProfile(fakeItem('myEngine_thing', '') as never, custom)}`);
    lines.push(`badgeFor('my-engine') = ${badgeFor('my-engine')}`);
  }

  // 「选中引擎」的当前解析结果（含未知 id / 不可用时的退回说明）。
  const selection = selectedProfile();
  lines.push(
    `selectedProfile = ${selection.profile ? selection.profile.id : '(不认领)'}${
      selection.warning ? ` ⚠ ${selection.warning}` : ''
    }`
  );
  // 未知 id 的解释（纯函数，不依赖当前设置）。
  lines.push(`explainUnavailable('nope') = ${explainUnavailable('nope') ?? '(可用)'}`);
  return lines;
}
