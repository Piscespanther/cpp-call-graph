/**
 * 语言服务「引擎」的配置档（profile）层。
 *
 * 设计要点（0.21 起）：
 *  ① **查询路径与引擎无关**：取数据只用 VS Code 内置的三条命令
 *     （`vscode.prepareCallHierarchy` / `provideIncomingCalls` / `provideOutgoingCalls`）。
 *     任何实现 Call Hierarchy 的语言服务接进来就能出图，不需要为它写适配代码。
 *  ② **这一层只管"标注与识别"**：显示名、角标、可用性判断、不可用时的解释、
 *     以及"某个结果算不算这个引擎给的"（认领规则）。
 *  ③ 内置的 clangd / cpptools 只是**表里的两条数据**；用户可以在设置
 *     `cppCallGraph.customEngines` 里加自己的条目（同 id 时覆盖内置项），
 *     从而做到「换一个类似引擎时只改设置」。
 *
 * ⚠️ 为什么"认领"不能做成通用能力：`prepareCallHierarchy` 返回的是**所有 provider 的聚合结果**，
 * 而 `CallHierarchyItem` 里**没有 provider 字段**，所以无法可靠地判断"这一份是谁给的"。
 * 因此默认策略是"不认领、按选区离光标最近挑"；只有用户显式选了某个 profile 且它配了
 * `match` 时才尝试认领，认不到就退回就近挑（绝不因为配置问题导致查不出结果）。
 */
import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/** 引擎标识：内置 id（clangd / cpptools）或用户在设置里自定义的 id。 */
export type EngineId = string;

/** 兼容旧名字：会话标签里展示的引擎名（认不出时为 `unknown`）。 */
export type EngineLabel = string;

/**
 * `cppCallGraph.languageService` 的取值：
 *  - `auto`   由 VS Code 决定（等价于不认领；展示上用探测到的引擎名）
 *  - `any`    明确不指定引擎（不认领，就近挑）
 *  - `custom` 读 `cppCallGraph.customEngineId`
 *  - 其它值   直接当作 profile id
 */
export type EngineChoice = string;

/** 多引擎共存时怎么挑（`cppCallGraph.enginePickPolicy`）。 */
export type PickPolicy = 'nearest' | 'preferSelected' | 'onlySelected';

export interface EngineProfile {
  /** 唯一 id（即设置中填写的内容）。 */
  id: string;
  /** 展示名（不含版本）。 */
  label: string;
  /** 判断"装了没"用的扩展 ID；省略表示不依赖任何扩展。 */
  extensionId?: string;
  /** 需要外部可执行文件时的内置探测钩子（目前只有 clangd 用到）。 */
  requiresExecutable?: 'clangd';
  /** 标签角标**文字**（任意短文本，不做白名单校验；省略则不显示角标）。 */
  badge?: string;
  /** 认领规则：item 的 name / detail 含这些子串（大小写不敏感）就算这个引擎给的。 */
  match?: { name?: string; detail?: string };
  /** 不可用时的解释（内置项有默认文案，自定义项可用它覆盖）。 */
  advice?: string;
}

const SECTION = 'cppCallGraph';

/** 内置引擎表。**cli 行为与 0.20 逐一致**，只是从代码分支变成了数据。 */
export const BUILTIN_ENGINES: readonly EngineProfile[] = [
  {
    id: 'clangd',
    label: 'clangd',
    extensionId: 'llvm-vs-code-extensions.vscode-clangd',
    requiresExecutable: 'clangd',
    badge: 'clangd',
  },
  {
    id: 'cpptools',
    label: 'C/C++ (cpptools)',
    extensionId: 'ms-vscode.cpptools',
    badge: 'cpptools',
  },
];

export function isExtensionActiveOrInstalled(id: string): boolean {
  return vscode.extensions.getExtension(id) !== undefined;
}

// ------------------------------------------------- clangd 可执行文件探测
//
// 注意：装了 clangd *扩展* 不等于有 clangd *程序*。VS Code 的 clangd 扩展
// 只是个客户端，它需要真正的 clangd 可执行文件，否则不会注册任何 provider，
// 也就无法提供调用关系。
// 另外 clang 编译器（clang.exe / clang++.exe）不能替代 clangd.exe。

let clangdPathCache: { value: string | undefined } | undefined;

/** 从 PATH 里找可执行文件（含 Windows 的 .exe/.cmd/.bat）。 */
function findOnPath(command: string): string | undefined {
  if (!command) {
    return undefined;
  }
  // 已经给了具体路径
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : undefined;
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(entry, command + extension);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** 常见的 clangd 安装位置（winget / LLVM 官方安装器 / MSYS2 / scoop 等）。 */
function findInCommonLocations(): string | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programData = process.env.ProgramData ?? 'C:\\ProgramData';
  const candidates = [
    'C:\\Program Files\\LLVM\\bin\\clangd.exe',
    'C:\\Program Files (x86)\\LLVM\\bin\\clangd.exe',
    localAppData ? path.join(localAppData, 'Programs', 'LLVM', 'bin', 'clangd.exe') : '',
    localAppData ? path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'clangd.exe') : '',
    programData ? path.join(programData, 'chocolatey', 'bin', 'clangd.exe') : '',
    home ? path.join(home, 'scoop', 'shims', 'clangd.exe') : '',
    'C:\\msys64\\mingw64\\bin\\clangd.exe',
    'C:\\msys64\\clang64\\bin\\clangd.exe',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * 解析 clangd 可执行文件的实际位置，找不到返回 undefined。
 * 优先级：clangd.path 设置 → PATH → 常见安装目录。结果会缓存。
 */
export function clangdExecutable(): string | undefined {
  if (clangdPathCache !== undefined) {
    return clangdPathCache.value;
  }
  const configured = vscode.workspace.getConfiguration('clangd').get<string>('path', 'clangd');
  const found = findOnPath(configured) ?? findOnPath('clangd') ?? findInCommonLocations();
  clangdPathCache = { value: found };
  return found;
}

/** 设置变化后丢弃缓存，重新探测。 */
export function invalidateExecutableCache(): void {
  clangdPathCache = undefined;
}

// ------------------------------------------------------------ 配置档解析

/** 读设置里的自定义引擎条目（格式不对的整条丢弃，不让它污染后面的判断）。 */
function readCustomEngines(): EngineProfile[] {
  const raw = vscode.workspace
    .getConfiguration(SECTION)
    .get<unknown[]>('customEngines', []);
  if (!Array.isArray(raw)) {
    return [];
  }
  const profiles: EngineProfile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
      continue;
    }
    const matchName = typeof item.matchName === 'string' ? item.matchName.trim() : '';
    const matchDetail = typeof item.matchDetail === 'string' ? item.matchDetail.trim() : '';
    profiles.push({
      id,
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id,
      extensionId:
        typeof item.extensionId === 'string' && item.extensionId.trim()
          ? item.extensionId.trim()
          : undefined,
      badge: typeof item.badge === 'string' && item.badge.trim() ? item.badge.trim() : undefined,
      match:
        matchName || matchDetail
          ? { name: matchName || undefined, detail: matchDetail || undefined }
          : undefined,
      advice:
        typeof item.advice === 'string' && item.advice.trim() ? item.advice.trim() : undefined,
    });
  }
  return profiles;
}

/** 全部配置档：内置 + 自定义（同 id 时自定义覆盖内置）。 */
export function engineProfiles(): EngineProfile[] {
  const byId = new Map<string, EngineProfile>();
  for (const profile of BUILTIN_ENGINES) {
    byId.set(profile.id, profile);
  }
  for (const profile of readCustomEngines()) {
    byId.set(profile.id, profile);
  }
  return [...byId.values()];
}

export function profileById(id: string): EngineProfile | undefined {
  return engineProfiles().find((profile) => profile.id === id);
}

/** 该配置档现在是否"真的可能"提供调用层级。 */
export function isProfileAvailable(profile: EngineProfile): boolean {
  if (profile.requiresExecutable === 'clangd' && !clangdExecutable()) {
    return false;
  }
  if (profile.extensionId && !isExtensionActiveOrInstalled(profile.extensionId)) {
    return false;
  }
  return true;
}

/** 当前可用（可能提供调用层级）的引擎 id 列表，顺序即内置/自定义表的顺序。 */
export function listAvailableEngines(): EngineId[] {
  return engineProfiles()
    .filter((profile) => isProfileAvailable(profile))
    .map((profile) => profile.id);
}

/** 最可能的引擎：优先 clangd，其次表里第一个可用的。 */
export function preferredEngine(): EngineLabel {
  return listAvailableEngines()[0] ?? 'unknown';
}

export function describeEngine(label: EngineLabel): string {
  const profile = profileById(label);
  if (!profile) {
    return label && label !== 'unknown' ? label : '未识别的语言服务';
  }
  const version = profile.extensionId
    ? (vscode.extensions.getExtension(profile.extensionId)?.packageJSON?.version ?? '')
    : '';
  const base = version ? `${profile.label} ${version}` : profile.label;
  if (profile.requiresExecutable === 'clangd') {
    const executable = clangdExecutable();
    return executable ? `${base}（${executable}）` : base;
  }
  return base;
}

/** 该配置档不可用时给出原因；可用或不需要解释时返回 undefined。 */
export function explainUnavailable(id: EngineId): string | undefined {
  const profile = profileById(id);
  if (!profile) {
    return `设置里没有 id 为「${id}」的引擎：可用的有 ${engineProfiles()
      .map((item) => item.id)
      .join(', ')}。可在 cppCallGraph.customEngines 里定义它。`;
  }
  if (profile.advice) {
    return isProfileAvailable(profile) ? undefined : profile.advice;
  }
  if (profile.requiresExecutable === 'clangd' && !clangdExecutable()) {
    return 'clangd 扩展已安装，但找不到 clangd 可执行文件。clangd 扩展仅为客户端，需要另外安装 clangd（例如 `winget install LLVM.LLVM`，或设置 `clangd.path`）';
  }
  if (profile.extensionId && !isExtensionActiveOrInstalled(profile.extensionId)) {
    return `没有安装它依赖的扩展（${profile.extensionId}）`;
  }
  return undefined;
}

/** 用户当前选的引擎（`auto` / `any` 时返回 undefined = 不认领）。 */
export function selectedProfile(): {
  profile?: EngineProfile;
  /** 选择本身有问题时的说明（未知 id、选了不可用的引擎等）。 */
  warning?: string;
} {
  const config = vscode.workspace.getConfiguration(SECTION);
  const choice = String(config.get<string>('languageService', 'auto') ?? 'auto').trim();
  if (!choice || choice === 'auto' || choice === 'any') {
    return {};
  }
  const id = choice === 'custom' ? String(config.get<string>('customEngineId', '') ?? '').trim() : choice;
  if (!id) {
    return { warning: 'languageService 选了「自定义」，但 customEngineId 是空的；已按「不指定引擎」处理。' };
  }
  const profile = profileById(id);
  if (!profile) {
    return {
      warning: `找不到 id 为「${id}」的引擎（可用：${engineProfiles()
        .map((item) => item.id)
        .join(', ')}）；已按「不指定引擎」处理。可在 cppCallGraph.customEngines 里定义它。`,
    };
  }
  if (!isProfileAvailable(profile)) {
    // ⚠️ 不可用时**不能**把 profile 交给调用方 —— 否则它会照常参与"认领"，
    // 而警告里写着"已按不指定引擎处理"。在 `onlySelected` 档下这会造成"查不出结果"
    // （那本该只在用户明确接受该风险时才发生）。这里直接只回警告。
    return {
      warning: `引擎「${profile.label}」当前不可用：${
        explainUnavailable(profile.id) ?? '原因未知'
      }；已按「不指定引擎」处理。`,
    };
  }
  return { profile };
}

/** 多引擎共存时的挑选策略。 */
export function pickPolicy(): PickPolicy {
  const value = String(
    vscode.workspace.getConfiguration(SECTION).get<string>('enginePickPolicy', 'nearest') ?? 'nearest'
  ).trim();
  return value === 'preferSelected' || value === 'onlySelected' ? value : 'nearest';
}

/** 这个 item 是否符合该配置档的认领规则（没配规则时一律返回 false）。 */
export function matchesProfile(item: vscode.CallHierarchyItem, profile: EngineProfile): boolean {
  const rule = profile.match;
  if (!rule) {
    return false;
  }
  const name = (item.name ?? '').toLowerCase();
  const detail = (item.detail ?? '').toLowerCase();
  const wantedName = (rule.name ?? '').toLowerCase();
  const wantedDetail = (rule.detail ?? '').toLowerCase();
  if (wantedName && name.includes(wantedName)) {
    return true;
  }
  if (wantedDetail && detail.includes(wantedDetail)) {
    return true;
  }
  return false;
}

/** 会话角标 id：认得出用 profile.badge，否则给 `unknown`（webview 有兜底图标）。 */
export function badgeFor(label: EngineLabel): string {
  return profileById(label)?.badge ?? 'unknown';
}
