/**
 * 引用查找：给**没有调用层级**的符号兜底。
 *
 * 为什么需要它：调用层级只建立在可调用符号（函数、方法、构造函数、运算符）上。
 * 宏定义、typedef/using 别名、结构体/类/枚举名、枚举成员、字段、变量这些符号
 * 在 clangd 与 cpptools 上都拿不到 `prepareCallHierarchy` 结果 —— 但「谁引用了它」
 * 这件事是有意义的，于是走引用查找（`vscode.executeReferenceProvider`），
 * 结果与调用层级同形：根 = 该符号，第一层 = **引用点所在的函数**。
 *
 * 关键设计：第一层用 `prepareCallHierarchy` 在**引用点位置**再问一次，
 * 于是拿到的是那个外层函数的**真实** `CallHierarchyItem` —— 它可继续展开、
 * 可双击跳转，与正常调用层级的那一层完全一样。图/布局/会话层都不需要改。
 */
import * as vscode from 'vscode';
import { Answer } from './relations';
import { logWarn } from '../util/log';

/** 引用点数量上限：宏常被广泛使用，避免一次抓回上千个把画布撑爆。 */
export const MAX_REFERENCE_HITS = 200;

/** 文本搜索兜底时只扫这些后缀（C/C++ 头文件与源文件）。 */
const TEXT_SEARCH_INCLUDE = '**/*.{c,cc,cpp,cxx,c++,h,hh,hpp,hxx,h++,inl,ipp,tpp}';

export interface ReferenceHit {
  uri: vscode.Uri;
  /** 引用那一行的行号（0 基），与 VS Code 的 Position.line 一致。 */
  line: number;
  /** 命中处的字符列（0 基）。 */
  character: number;
}

export interface RootSymbol {
  name: string;
  /** 悬停/占位用的补充信息，例如宏定义那一行的原文。 */
  detail?: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

export interface ReferenceResolution {
  root: vscode.CallHierarchyItem;
  answers: Answer[];
  /** 结果来源：语言服务的引用，还是退化的文本搜索。 */
  source: 'languageService' | 'textSearch';
  /** 被丢弃的引用点数量（超过上限时）。 */
  dropped: number;
}

/** C 标识符：字母/下划线开头，可含数字。 */
function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * 取光标处的标识符。
 *
 * 光标常见地停在标识符**右边一位**（点完词尾），所以先左收一格再判断 ——
 * 与 callHierarchy 里「左右各试若干列」的做法同源，只是这里一次定位。
 */
export function wordAt(
  document: vscode.TextDocument,
  position: vscode.Position
): { word: string; range: vscode.Range } | undefined {
  const text = document.lineAt(position.line).text;
  let index = Math.min(position.character, text.length);
  if (!isIdentChar(text[index]) && index > 0 && isIdentChar(text[index - 1])) {
    index -= 1;
  }
  if (!isIdentChar(text[index])) {
    return undefined;
  }
  let start = index;
  let end = index + 1;
  while (start > 0 && isIdentChar(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && isIdentChar(text[end])) {
    end += 1;
  }
  const word = text.slice(start, end);
  // 纯数字不是标识符（光标停在字面量上时不兜底）
  if (!/^[A-Za-z_]/.test(word)) {
    return undefined;
  }
  return { word, range: new vscode.Range(position.line, start, position.line, end) };
}

/**
 * 该标识符在当前文件里是不是宏定义，以及是不是**函数式宏**（名字后面紧跟左括号）。
 *
 * 只扫当前文件：宏定义跨文件的情况（`-D` 定义的、写在别处的）交给语言服务的引用查询，
 * 拿不到就如实返回空，不做跨文件文本猜测。
 */
export function macroShapeOf(
  document: vscode.TextDocument,
  word: string
): { functionLike: boolean; line: number; text: string } | undefined {
  const pattern = new RegExp(`^\\s*#\\s*define\\s+${word}(\\s*\\(|(?=[^A-Za-z0-9_]))`);
  for (let line = 0; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    if (!/#\s*define/.test(text)) {
      continue;
    }
    const match = pattern.exec(text);
    if (match) {
      return {
        // 名字后面紧跟 '(' → 函数式宏；否则是对象式宏
        functionLike: (match[1] ?? '').includes('('),
        line,
        text: text.trim(),
      };
    }
  }
  return undefined;
}

/** 文件内符号树里包含该位置的最内层符号（用于给非可调用符号定图标与名字）。 */
function innermostSymbol(
  symbols: readonly vscode.DocumentSymbol[],
  position: vscode.Position
): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    const range = symbol.range ?? symbol.selectionRange;
    if (!range || !range.contains(position)) {
      continue;
    }
    const inner = symbol.children?.length
      ? innermostSymbol(symbol.children, position)
      : undefined;
    return inner ?? symbol;
  }
  return undefined;
}

/** 语言服务的引用查询（同一个位置可能要多试几个偏移，见 callHierarchy 的说明）。 */
async function queryReferences(
  document: vscode.TextDocument,
  positions: vscode.Position[]
): Promise<ReferenceHit[]> {
  const hits: ReferenceHit[] = [];
  const seen = new Set<string>();
  for (const position of positions) {
    let list: vscode.Location[] | undefined;
    try {
      list = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        document.uri,
        position
      );
    } catch (error) {
      // ⚠️ 不能静默跳过：吞掉异常会让「语言服务报错」在下游被当成「这里没有引用」，
      // 用户与排查者看到的都是一个错误结论（输出通道里连一行线索都没有）。
      logWarn(
        `引用查询失败（${document.uri.fsPath} @ ${position.line + 1}:${position.character + 1}）：${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }
    for (const location of list ?? []) {
      const range = location.range ?? (location as unknown as { targetRange?: vscode.Range }).targetRange;
      if (!range) {
        continue;
      }
      const key = `${location.uri.toString()}#${range.start.line}:${range.start.character}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      hits.push({ uri: location.uri, line: range.start.line, character: range.start.character });
    }
    if (hits.length > 0) {
      break;
    }
  }
  return hits;
}

/** 文本搜索兜底：语言服务不给宏引用时（例如索引未就绪）退到按词搜索。 */
async function textSearch(word: string): Promise<ReferenceHit[]> {
  const workspace = vscode.workspace as unknown as {
    findTextInFiles?: (
      query: { pattern: string; isRegExp?: boolean; isCaseSensitive?: boolean },
      options: { maxResults?: number; include?: string },
      callback: (result: { uri: vscode.Uri; matches?: Array<{ range: vscode.Range }> }) => void
    ) => Thenable<unknown>;
  };
  if (typeof workspace.findTextInFiles !== 'function') {
    return [];
  }
  const hits: ReferenceHit[] = [];
  await workspace.findTextInFiles(
    { pattern: `\\b${word}\\b`, isRegExp: true, isCaseSensitive: true },
    { maxResults: MAX_REFERENCE_HITS, include: TEXT_SEARCH_INCLUDE },
    (result) => {
      for (const match of result.matches ?? []) {
        hits.push({
          uri: result.uri,
          line: match.range.start.line,
          character: match.range.start.character,
        });
      }
    }
  );
  return hits;
}

/** 读某一行原文（引用点那一行，用于界面上的「引用发生处」）。 */
async function lineTextOf(
  hit: ReferenceHit,
  cache: Map<string, vscode.TextDocument | undefined>
): Promise<string> {
  const key = hit.uri.toString();
  if (!cache.has(key)) {
    try {
      cache.set(key, await vscode.workspace.openTextDocument(hit.uri));
    } catch (error) {
      logWarn(
        `读取引用所在文件失败（${hit.uri.fsPath}）：${error instanceof Error ? error.message : String(error)}`
      );
      cache.set(key, undefined);
    }
  }
  const document = cache.get(key);
  if (!document || hit.line >= document.lineCount) {
    return '';
  }
  return document.lineAt(hit.line).text.trim().slice(0, 120);
}

/** 文档符号树的缓存（同一个文件只问一次语言服务）。 */
type SymbolCache = Map<string, readonly vscode.DocumentSymbol[] | undefined>;

async function symbolsOf(uri: vscode.Uri, cache: SymbolCache): Promise<readonly vscode.DocumentSymbol[]> {
  const key = uri.toString();
  if (!cache.has(key)) {
    let symbols: readonly vscode.DocumentSymbol[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
      );
    } catch (error) {
      logWarn(
        `取文档符号失败（${uri.fsPath}）：${error instanceof Error ? error.message : String(error)}`
      );
      symbols = undefined;
    }
    cache.set(key, symbols);
  }
  return cache.get(key) ?? [];
}

/**
 * 把引用点收敛成一层「节点」：每个引用点先问一次 `prepareCallHierarchy`
 * （拿到包含它的函数），拿不到再退到文件符号树（拿非可调用符号，例如全局初始化表达式）。
 * 同一个符号的多个引用点合并成一个节点，`callSite` 记第一次引用的位置。
 */
async function answersFromHits(
  hits: ReferenceHit[],
  isCancelled: () => boolean = () => false,
  symbolCache: SymbolCache = new Map()
): Promise<Answer[]> {
  const byKey = new Map<string, Answer>();
  const documentCache = new Map<string, vscode.TextDocument | undefined>();
  for (const hit of hits) {
    // 每个引用点都要问一次语言服务，这一步最慢 —— 用户点「取消」就在这里尽快收尾
    if (isCancelled()) {
      return [...byKey.values()];
    }
    const position = new vscode.Position(hit.line, hit.character);
    let item: vscode.CallHierarchyItem | undefined;
    try {
      const prepared = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        hit.uri,
        position
      );
      item = prepared?.[0];
    } catch {
      item = undefined;
    }
    if (!item) {
      // 退到符号树：引用可能出现在函数之外（全局初始化、#if 条件等）
      const symbol = innermostSymbol(await symbolsOf(hit.uri, symbolCache), position);
      if (symbol) {
        item = new vscode.CallHierarchyItem(
          symbol.kind,
          symbol.name,
          '',
          hit.uri,
          symbol.range ?? symbol.selectionRange,
          symbol.selectionRange ?? symbol.range
        );
      }
    }
    const text = await lineTextOf(hit, documentCache);
    if (!item) {
      // 连符号都拿不到：以「这一行的原文」占位，至少让用户看到引用点在这里
      const name = text.length > 0 ? text : `${hit.uri.fsPath.split(/[\\/]/).pop() ?? ''}:${hit.line + 1}`;
      const range = new vscode.Range(position, position);
      item = new vscode.CallHierarchyItem(
        // Object 会落到节点类型映射的兜底（other），与正常图里认不出的符号同一处理
        vscode.SymbolKind.Object,
        name,
        '',
        hit.uri,
        range,
        range
      );
    }
    const identity = `${item.uri.toString()}#${item.kind}#${item.name}#${item.selectionRange.start.line}`;
    if (byKey.has(identity)) {
      continue;
    }
    byKey.set(identity, {
      item,
      callSite: { uri: hit.uri, line: hit.line, text },
    });
  }
  return [...byKey.values()];
}

/**
 * 入口：给定光标位置，返回「根符号 + 第一层引用者」。
 *
 * 返回 `undefined` 表示这里既没有调用层级、也没有可用的引用（例如光标在关键字、
 * 字面量、注释或空白处）—— 调用方按原来的方式静默记日志即可。
 */
export async function resolveByReferences(
  document: vscode.TextDocument,
  position: vscode.Position,
  isCancelled: () => boolean = () => false
): Promise<ReferenceResolution | undefined> {
  const found = wordAt(document, position);
  if (!found) {
    return undefined;
  }
  const { word, range } = found;
  const macro = macroShapeOf(document, word);

  // 先问语言服务（权威）：宏、类型、变量、枚举成员等都可能给引用
  let hits = await queryReferences(document, [
    new vscode.Position(range.start.line, range.start.character),
    position,
    new vscode.Position(range.start.line, range.end.character),
  ]);
  if (isCancelled()) {
    return undefined;
  }
  let source: ReferenceResolution['source'] = 'languageService';
  if (hits.length === 0) {
    // 只有确认是宏才退到文本搜索：否则会命中同名标识符，噪声太大
    if (!macro) {
      return undefined;
    }
    hits = await textSearch(word);
    source = 'textSearch';
    if (hits.length === 0) {
      return undefined;
    }
  }

  // 定义处不算「引用者」：`#define FOO …` 这一行必然包含 FOO（文本搜索一定命中它，
  // 语言服务的引用查询通常也会带上定义处）。留着会多出一个名字是整行原文的假引用者。
  if (macro) {
    const selfKey = `${document.uri.toString()}#${macro.line}`;
    hits = hits.filter((hit) => `${hit.uri.toString()}#${hit.line}` !== selfKey);
    if (hits.length === 0) {
      return undefined;
    }
  }

  const dropped = Math.max(0, hits.length - MAX_REFERENCE_HITS);
  const limited = hits.slice(0, MAX_REFERENCE_HITS);
  const symbolCache: SymbolCache = new Map();
  const answers = await answersFromHits(limited, isCancelled, symbolCache);
  if (answers.length === 0 || isCancelled()) {
    return undefined;
  }

  // 非宏符号：问一次符号树，拿它的真实类型（图标与正常图同款）。
  // 复用上面那份缓存，避免同一个文件被问两次。
  const symbolAtCursor = macro
    ? undefined
    : innermostSymbol(
        await symbolsOf(document.uri, symbolCache),
        new vscode.Position(range.start.line, range.start.character)
      );
  // 根符号的类型（决定方框角标，复用现有图标集，不引入新图标）：
  //   函数式宏 → 与函数同款；对象式宏 → 与常量同款；
  //   其余符号（类型、变量、枚举成员…）用符号树给出的真实类型，与正常图一致
  const kind = macro
    ? macro.functionLike
      ? vscode.SymbolKind.Function
      : vscode.SymbolKind.Constant
    : symbolAtCursor?.kind ?? vscode.SymbolKind.Constant;
  const definitionLine = macro
    ? macro.line
    : symbolAtCursor?.selectionRange.start.line ?? range.start.line;
  const root = new vscode.CallHierarchyItem(
    kind,
    word,
    macro?.text ?? '',
    document.uri,
    macro
      ? new vscode.Range(definitionLine, 0, definitionLine, document.lineAt(definitionLine).text.length)
      : symbolAtCursor?.range ?? range,
    symbolAtCursor?.selectionRange ?? range
  );
  return { root, answers, source, dropped };
}
