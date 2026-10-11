/**
 * C/C++ 调用关系数据层。
 *
 * 数据来源是 VS Code 内置的三个命令（等价于 LSP 的 call hierarchy 请求）：
 *   - vscode.prepareCallHierarchy   (uri, position)  ~ textDocument/prepareCallHierarchy
 *   - vscode.provideIncomingCalls   (item)           ~ callHierarchy/incomingCalls
 *   - vscode.provideOutgoingCalls   (item)           ~ callHierarchy/outgoingCalls
 *
 * 关于「用哪个语言服务」：**0.21 起没有 clangd / cpptools 的分支了** ——
 * 引擎信息（显示名、角标、可用性、认领规则）全部在 `engines.ts` 里以配置档（表）描述，
 * 用户还能在设置里加自定义条目。这里只负责「取数据」与「按策略挑一个」：
 *   · 默认（`nearest`）不认领，按 `selectionRange` 离光标最近挑 —— 与 0.20 行为一致；
 *   · 用户显式选了某个配置档且它配了 `match` 时，才先在它认领的结果里挑，认不到就退回就近挑；
 *   · 只有 `onlySelected` 才可能"查不出结果"，那需要用户明确选择。
 */
import * as vscode from 'vscode';
import { existsSync } from 'node:fs';

import { CallDirection, Direction } from './graphTypes';
import {
  EngineChoice,
  EngineId,
  EngineLabel,
  EngineProfile,
  PickPolicy,
  badgeFor,
  clangdExecutable,
  describeEngine,
  engineProfiles,
  explainUnavailable,
  invalidateExecutableCache,
  isExtensionActiveOrInstalled,
  isProfileAvailable,
  listAvailableEngines,
  matchesProfile,
  pickPolicy,
  preferredEngine,
  profileById,
  selectedProfile,
} from './engines';

export type { CallDirection, Direction };
export type { EngineChoice, EngineId, EngineLabel, EngineProfile, PickPolicy };
// 这些名字以前定义在本文件里，为了不惊动所有调用方继续从这里转出。
export {
  badgeFor,
  clangdExecutable,
  describeEngine,
  explainUnavailable,
  engineProfiles,
  isExtensionActiveOrInstalled,
  isProfileAvailable,
  listAvailableEngines,
  matchesProfile,
  pickPolicy,
  preferredEngine,
  profileById,
  selectedProfile,
};
export const invalidateClangdCache = invalidateExecutableCache;

export const LANG_IDS = [
  'c',
  'cpp',
  'cuda-cpp',
  'objective-c',
  'objective-cpp',
] as const;

export function isSupportedLanguage(languageId: string): boolean {
  return (LANG_IDS as readonly string[]).includes(languageId);
}

/** 调用层级的稳定 key，用于去重与环检测。 */
export function itemKey(item: vscode.CallHierarchyItem): string {
  const r = item.selectionRange ?? item.range;
  return [
    item.uri.toString(),
    r.start.line,
    r.start.character,
    r.end.line,
    r.end.character,
    item.name,
  ].join('|');
}

// ------------------------------------------------------------ 引擎可用性
//
// 0.21 起"哪个引擎可用 / 该显示什么 / 该认领哪些结果"全部搬到了 `engines.ts`
// （表驱动 + 支持设置里的自定义条目）。这里不再有 clangd / cpptools 的分支。

// ------------------------------------------------------------ 探测（识别引擎）

interface ProbeEntry {
  item: vscode.CallHierarchyItem;
  engine: EngineLabel;
}

export interface ProbeResult {
  /** 该位置由哪些引擎提供结果。 */
  engines: EngineLabel[];
  /** 各引擎解析出来的名称，用于诊断展示。 */
  detail: string;
}

/**
 * 因为引擎信息不会出现在返回值里，这里用一个特定夹具文件来区分：
 * 夹具里只有一个函数 `cppCallGraphProbeTarget`，
 * prepareCallHierarchy 的结果里包含这个名字的那一份就是这个引擎给出的。
 */
async function probingDocument(
  context: vscode.ExtensionContext
): Promise<vscode.TextDocument | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const target = vscode.Uri.joinPath(
    context.globalStorageUri,
    'cpp-call-graph-probe.cpp'
  );
  const source = [
    '// 由 C/C++ 调用关系图扩展生成，仅用于识别当前生效的语言服务，可以随时删除。',
    'int cppCallGraphProbeTarget(int value) { return value + 1; }',
    '',
  ].join('\n');
  try {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    let needsWrite = true;
    if (existsSync(target.fsPath)) {
      try {
        const bytes = await vscode.workspace.fs.readFile(target);
        needsWrite = Buffer.from(bytes).toString('utf8') !== source;
      } catch {
        needsWrite = true;
      }
    }
    if (needsWrite) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(source, 'utf8'));
    }
    return await vscode.workspace.openTextDocument(target);
  } catch {
    return undefined;
  }
}

/** 用夹具文件探测当前有哪些语言服务真的提供调用层级。 */
export async function probeEngines(
  context: vscode.ExtensionContext
): Promise<ProbeResult | undefined> {
  const document = await probingDocument(context);
  if (!document) {
    return undefined;
  }
  const line = document.lineAt(1);
  const character = line.text.indexOf('cppCallGraphProbeTarget');
  if (character < 0) {
    return undefined;
  }
  const position = new vscode.Position(1, character + 1);
  let prepared: vscode.CallHierarchyItem[] = [];
  try {
    prepared =
      (await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        document.uri,
        position
      )) ?? [];
  } catch {
    return undefined;
  }
  if (prepared.length === 0) {
    return undefined;
  }

  const profiles = engineProfiles();
  const entries: ProbeEntry[] = prepared.map((item, index) => {
    // 先用各配置档自己的认领规则判断（表驱动，自定义引擎也能被认出来）；
    // 认不出再按"谁真的可用"的顺序推测（与 listAvailableEngines 一致）——仅诊断展示用。
    const claimed = profiles.find((profile) => matchesProfile(item, profile));
    if (claimed) {
      return { item, engine: claimed.id };
    }
    const fallback = listAvailableEngines();
    const engine: EngineLabel =
      prepared.length === 2 ? (fallback[index] ?? 'unknown') : 'unknown';
    return { item, engine };
  });

  const engines: EngineLabel[] = [];
  const parts: string[] = [];
  for (const entry of entries) {
    if (!engines.includes(entry.engine)) {
      engines.push(entry.engine);
    }
    parts.push(`${entry.engine}:${entry.item.name}`);
  }
  return { engines, detail: parts.join(' | ') };
}

// ------------------------------------------------------------ 解析与查询

export interface ResolvedItem {
  item: vscode.CallHierarchyItem;
  engine: EngineLabel;
  /** 同一位置所有引擎给出的函数名，用于诊断。 */
  allNames: string[];
}

/**
 * 从 VS Code 聚合回来的候选里挑一个。
 *
 * 为什么不能只取第一个：`vscode.prepareCallHierarchy` 会把请求发给**所有**
 * 已注册的 provider 并聚合结果。同一个位置可能返回多个 item（各自的
 * `selectionRange` 不同），随便取第一个可能取到离光标更远的那个符号——
 * 在枚举/结构体这类符号上尤其容易出错（枚举名与它旁边的标识符时常紧挨着）。
 *
 * 挑选规则（按优先级）：
 *   1. 选区离光标最近的那个。`selectionRange` 是符号**名字本身**的范围，
 *      贴近 VS Code 自己的实现（`getWordRangeAtPosition`）。
 *   2. 距离相同时取数组靠前的（即 VS Code 的 provider 注册顺序）。
 *
 * 说明：这里**不需要**引擎偏好参数。用户一次只启用 clangd 或 cpptools 中的一个，
 * 所以聚合结果里的每一项都来自同一个语言服务，按位置挑即可。
 */
export function pickByChoice(
  items: vscode.CallHierarchyItem[],
  cursor?: vscode.Position
): vscode.CallHierarchyItem | undefined {
  if (items.length === 0) {
    return undefined;
  }
  if (!cursor) {
    return items[0];
  }

  /** 光标到某个选区的最短列距离；0 表示光标落在选区内。 */
  const distanceTo = (item: vscode.CallHierarchyItem): number => {
    const range = item.selectionRange ?? item.range;
    if (!range) {
      return Number.POSITIVE_INFINITY;
    }
    // 不同行的符号不可能更近，直接给一个很大的值
    if (cursor.line < range.start.line || cursor.line > range.end.line) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (cursor.character < range.start.character) {
      return range.start.character - cursor.character;
    }
    if (cursor.character > range.end.character) {
      return cursor.character - range.end.character;
    }
    return 0;
  };

  // 并列时按数组顺序（即 VS Code 的 provider 注册顺序）取靠前的。
  // 用户一次只开一个语言服务，所以这条几乎用不到，留着是为了两个都装时不乱选。
  let best = items[0];
  let bestDistance = distanceTo(best);
  for (let index = 1; index < items.length; index += 1) {
    const item = items[index];
    const distance = distanceTo(item);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 在给定位置解析符号的调用层级。
 *
 * 会以光标处为中心向左右各扩展若干列重试：直接在关键字/空白处右键时也能命中符号名。
 *
 * 注意：**不能「第一个有结果的偏移就返回」**。光标可能正落在 `ENUM_A` 的
 * 第 2 个字符上，此时偏移 0 命中的却是紧邻的另一个符号；而偏移 -1 才是
 * 用户真正指的那个。所以这里把所有偏移的候选都收起来，最后统一按
 * 「选区离光标最近」挑（见 pickByChoice）。
 */
export async function resolveAt(
  document: vscode.TextDocument,
  position: vscode.Position,
  /** 用户显式选中的配置档（`auto` / `any` / 不可用时为 undefined = 不认领）。 */
  selected: EngineProfile | undefined,
  policy: PickPolicy,
  /** 不认领时用来标注会话（探测到的引擎名，或 'unknown'）。 */
  expected: EngineLabel
): Promise<ResolvedItem | undefined> {
  const offsets = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5];
  const allItems: vscode.CallHierarchyItem[] = [];
  let collectedNames: string[] = [];

  for (const delta of offsets) {
    const character = position.character + delta;
    if (character < 0 || character > document.lineAt(position.line).text.length) {
      continue;
    }
    const probe = new vscode.Position(position.line, character);
    let prepared: vscode.CallHierarchyItem[] | undefined;
    try {
      prepared = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        document.uri,
        probe
      );
    } catch (error) {
      // 某个语言服务（例如没装 clangd 可执行文件的 clangd）可能报错。
      // 这里只记录原因，继续尝试下一个光标位置。
      lastPrepareError = error instanceof Error ? error.message : String(error);
      lastPrepareErrorAt = new Date().toISOString();
      continue;
    }
    const found = prepared ?? [];
    if (found.length > 0) {
      collectedNames = collectedNames.concat(found.map((item) => item.name));
      allItems.push(...found);
      if (delta === 0) {
        // 光标正下方就有符号：这就是 VS Code 自己会用的那个词，不必再左右试。
        // 继续试探只会多花几次 RPC，还可能把更远的符号也拉进候选。
        break;
      }
    }
  }

  if (allItems.length === 0) {
    return undefined;
  }

  lastPrepareError = `已解析出 ${allItems.length} 个候选：${[...new Set(collectedNames)].join(', ')}`;
  lastPrepareErrorAt = new Date().toISOString();

  // 挑选策略：
  //   nearest（默认）—— 不认领，按选区离光标最近挑（与 0.20 一致，最安全）
  //   preferSelected  —— 先只在选中配置档认领的结果里挑；认不到退回就近挑（并留痕）
  //   onlySelected    —— 只认选中配置档；认不到就没有结果（用户明确选择了这个档）
  let claimedCount = 0;
  let picked: vscode.CallHierarchyItem | undefined;
  if (selected && policy !== 'nearest') {
    const claimed = allItems.filter((item) => matchesProfile(item, selected));
    claimedCount = claimed.length;
    if (claimedCount > 0) {
      picked = pickByChoice(claimed, position);
    } else if (policy === 'onlySelected') {
      lastPrepareError = `引擎「${selected.label}」在此位置没有结果（策略 onlySelected），已放弃就近挑`;
      lastPrepareErrorAt = new Date().toISOString();
      return undefined;
    } else {
      lastPrepareError = `引擎「${selected.label}」在此位置没有认领到结果，已退回就近挑`;
      lastPrepareErrorAt = new Date().toISOString();
    }
  }
  picked = picked ?? pickByChoice(allItems, position);
  if (!picked) {
    return undefined;
  }
  // 认领成功时标注选中的引擎；否则标注探测到的（认不出就是 unknown）。
  const engine: EngineLabel =
    selected && claimedCount > 0 ? selected.id : expected;
  return {
    item: picked,
    engine,
    allNames: [...new Set(collectedNames)],
  };
}

/** 最近一次 prepareCallHierarchy 的异常或结果，供诊断输出使用。 */
let lastPrepareError: string | undefined;
let lastPrepareErrorAt: string | undefined;

export function lastPrepareDiagnostic(): string {
  if (!lastPrepareError) {
    return '(尚未调用过 prepareCallHierarchy)';
  }
  return `${lastPrepareErrorAt}: ${lastPrepareError}`;
}

/** 供诊断使用：直接问一次语言服务，返回原始结果数量与名字。 */
export async function probePosition(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<{ count: number; names: string[]; error?: string }> {
  try {
    const prepared =
      (await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        document.uri,
        position
      )) ?? [];
    return { count: prepared.length, names: prepared.map((item) => `${item.name}(${item.detail ?? ''})`) };
  } catch (error) {
    return { count: 0, names: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** 诊断：对某个已解析的 item 分别问 incoming / outgoing，返回数量与错误。 */
export async function probeCalls(
  item: vscode.CallHierarchyItem
): Promise<{ incoming: number; outgoing: number; error?: string }> {
  let incoming = 0;
  let outgoing = 0;
  let error: string | undefined;
  try {
    const calls =
      (await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        'vscode.provideIncomingCalls',
        item
      )) ?? [];
    incoming = calls.length;
  } catch (caught) {
    error = `incoming: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
  try {
    const calls =
      (await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
        'vscode.provideOutgoingCalls',
        item
      )) ?? [];
    outgoing = calls.length;
  } catch (caught) {
    error = `${error ? `${error}; ` : ''}outgoing: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
  return { incoming, outgoing, error };
}

/** 拉取一层调用关系。 */
export async function fetchCalls(
  direction: CallDirection,
  item: vscode.CallHierarchyItem
): Promise<vscode.CallHierarchyItem[]> {
  return (await fetchCallsDetailed(direction, item)).map((entry) => entry.item);
}

/**
 * 拉取一层调用关系，并带上「调用点」信息。
 *
 * VS Code 的 CallHierarchyIncomingCall / OutgoingCall 都带 fromRanges：
 *   - incomingCalls 的 fromRanges = 调用者函数体内部发生调用的位置
 *   - outgoingCalls 的 fromRanges = 本函数体内调用对方的实际位置
 * 取第一个 range 作为调用点，就能回答「谁在第几行调用了谁」。
 */
export async function fetchCallsDetailed(
  direction: Direction,
  item: vscode.CallHierarchyItem
): Promise<DetailedCall[]> {
  if (direction === 'callers') {
    const incoming =
      (await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        'vscode.provideIncomingCalls',
        item
      )) ?? [];
    return Promise.all(
      incoming.map(async (call) => ({
        item: call.from,
        callSite: await callSiteOf(call.from.uri, call.fromRanges?.[0]),
      }))
    );
  }
  const outgoing =
    (await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
      'vscode.provideOutgoingCalls',
      item
    )) ?? [];
  return Promise.all(
    outgoing.map(async (call) => ({
      item: call.to,
      callSite: await callSiteOf(item.uri, call.fromRanges?.[0]),
    }))
  );
}

export interface DetailedCall {
  item: vscode.CallHierarchyItem;
  /** 调用点：发生在 uri 的哪个位置，以及那一行源码。 */
  callSite?: { uri: vscode.Uri; line: number; text: string };
}

async function callSiteOf(
  uri: vscode.Uri,
  range: vscode.Range | undefined
): Promise<DetailedCall['callSite']> {
  if (!range) {
    return undefined;
  }
  try {
    // 优先复用已打开的文档，避免为了拿一行文字就打开编辑器。
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString()
    );
    const document = open ?? (await vscode.workspace.openTextDocument(uri));
    const line = range.start.line;
    const text =
      line >= 0 && line < document.lineCount
        ? document.lineAt(line).text.trim().slice(0, 160)
        : '';
    return { uri, line, text };
  } catch {
    return { uri, line: range.start.line, text: '' };
  }
}

/** 当前工作区是否已经有 compile_commands.json / compile_flags.txt（clangd 的索引前提）。 */
export function hasCompileDatabase(): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    for (const name of ['compile_commands.json', 'compile_flags.txt']) {
      if (existsSync(vscode.Uri.joinPath(folder.uri, name).fsPath)) {
        return true;
      }
    }
    // 常见的构建目录
    for (const dir of ['build', 'out', 'cmake-build-debug', 'cmake-build-release']) {
      if (
        existsSync(
          vscode.Uri.joinPath(folder.uri, dir, 'compile_commands.json').fsPath
        )
      ) {
        return true;
      }
    }
  }
  return false;
}
