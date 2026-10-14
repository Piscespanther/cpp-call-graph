/**
 * 目录过滤：把某些目录（及其子树）下的节点从图里去掉（用户 2026-10-15 要求）。
 *
 * ⚠️ 与「锚点模式」（`pathAnchors`）是两件事：
 * 锚点决定**路径怎么显示**，过滤决定**这个节点显不显示**。因此这里不共用那套语法，
 * 只有通配那部分（`*` / `?` / `**`）是同一套语义。
 *
 * 条目三种写法（可混用）：
 *   - 相对路径：相对工作区根，例如 `components/LIB/core`（`./` 前缀会被去掉）
 *   - 绝对路径：例如 `c:/work/project/vendor`；若它不在任何工作区内，则永远命中不了任何节点
 *     （会话里存的是相对路径），这种条目会被记为「无效条目」并在日志里说明
 *   - 通配：`*` 段内任意长、`?` 单字符、`**` 任意层，例如 `** /test`（按目录名过滤）
 *
 * 匹配语义：条目不区分大小写、`\` 与 `/` 等价、结尾斜杠忽略；
 * 命中「该目录本身」以及「它下面的一切」（`entry` 或 `entry/...`）。
 *
 * 本模块另外承担两件与「目录」无关、但**同一套**的公共设施：
 *   - `NodeFilter`：payload 级节点过滤器的统一形状（目录过滤与**临时路径过滤**都用它）；
 *   - `applyNodeFilter()`：裁剪规则本身（命中节点连同整棵子树不进结果、根永不隐藏）。
 * 临时路径过滤的查询语义在 `pathQuery.ts`，它同样产出一个 `NodeFilter`，裁剪规则不重写第二遍。
 */

/** 归一化：反斜杠转正斜杠、去掉重复与结尾斜杠、转小写（Windows 大小写不敏感）。 */
export function normalizeFolderPath(value: string): string {
  const unified = String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');
  const trimmed = unified.endsWith('/') ? unified.replace(/\/+$/, '') : unified;
  return trimmed.toLowerCase();
}

/**
 * 把通配写法的**一段**编成正则片段（`*` 段内任意长、`?` 单字符，其余一律字面量）。
 *
 * ⚠️ 转义集里**必须**包含 `|`：这里的条目没有「多选」语义（不像 `pathAnchors` 的段匹配器
 * 那样把 `|` 当多选），漏掉它会让 `a|b` 变成正则的或，与设置说明不符。
 */
function segmentSource(segment: string): string {
  let source = '';
  for (const character of segment) {
    if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\|]/g, '\\$&');
    }
  }
  return source;
}

/**
 * 把一条（已归一化的）条目编成正则：`**` = 任意层，其余按段编译。
 *
 * 整条正则锚定在开头，并要求「与该条目自身完全相同」或「其后跟随 `/`」—— 后者就是「子树」语义。
 */
export function compileFolderEntry(relativeEntry: string): RegExp {
  const segments = relativeEntry.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    // 空条目（例如用户写了 `/`）不匹配任何文件，避免「整个工作区都被过滤」这种误伤
    return /$^/;
  }
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment === '**') {
      parts.push('(?:[^/]+/)*');
      continue;
    }
    // `a**b` 这种混合写法按段内通配处理（`**` 的层语义只认「整段就是 **」）
    parts.push(`${segmentSource(segment)}/`);
  }
  let source = `^${parts.join('')}`;
  // 最后一段可能后跟子树，也可能就是文件本身：`(?:.*)?` 的写法等价于「可有可无的尾巴」
  source = source.replace(/\/$/, '');
  const regex = new RegExp(`${source}(?:/.*)?$`, 'i');
  return regex;
}

/** 把一条用户条目换算成「相对工作区根」的归一化形式。 */
export function toRelativeEntry(
  entry: string,
  workspaceRoots: readonly string[]
): { relative?: string; reason?: string } {
  const normalized = normalizeFolderPath(entry);
  if (normalized.length === 0) {
    return { reason: '空条目' };
  }
  // 绝对路径（`c:/...`、`/...`、UNC）→ 落在某个工作区内才有效
  const isAbsolute = /^[a-z]:\//.test(normalized) || normalized.startsWith('/');
  if (!isAbsolute) {
    return { relative: normalized };
  }
  for (const root of workspaceRoots) {
    const normalizedRoot = normalizeFolderPath(root);
    if (normalizedRoot.length === 0) {
      continue;
    }
    if (normalized === normalizedRoot) {
      // 整个工作区：不给过滤（等于全空，用户多半是误操作）
      return { reason: '不能过滤整个工作区' };
    }
    if (normalized.startsWith(`${normalizedRoot}/`)) {
      return { relative: normalized.slice(normalizedRoot.length + 1) };
    }
  }
  return { reason: '不在任何工作区内（会话里存的是相对路径，因此匹配不到）' };
}

/** payload 级节点过滤器的对外形态（目录过滤与临时路径过滤共用）。 */
export interface NodeFilter {
  /** 该文件（相对工作区的路径）是否应当连同子树一起从图里去掉。 */
  test(relativeFile: string): boolean;
  /** 生效的条目数（查询过滤恒为 0 或 1）。 */
  readonly activeCount: number;
  /**
   * 无效条目及原因（宿主写日志用）。
   *
   * ⚠️ 只有目录过滤会产生它（用户可能在设置里写一条不在任何工作区内的绝对路径）；
   * 查询过滤恒为空数组 —— 输入框里的文字永远合法，不该给用户报「无效」。
   */
  readonly problems: readonly string[];
}

/**
 * 编译过滤器。参数里的 `entries` 是设置里的原文，`workspaceRoots` 是本机工作区根（绝对路径）。
 *
 * 每个节点的 `file` 都是**相对工作区**的路径（`session.ts` 里的 `relativeFile`），
 * 因此这里统一换算成相对形式再匹配。
 */
export function createFolderFilter(
  entries: readonly string[],
  workspaceRoots: readonly string[]
): NodeFilter {
  const regexps: RegExp[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const text = String(entry ?? '').trim();
    if (text.length === 0) {
      continue;
    }
    const converted = toRelativeEntry(text, workspaceRoots);
    if (converted.relative === undefined) {
      problems.push(`${text}（${converted.reason ?? '无法解析'}）`);
      continue;
    }
    regexps.push(compileFolderEntry(converted.relative));
  }
  return {
    test(relativeFile: string): boolean {
      if (regexps.length === 0) {
        return false;
      }
      const normalized = normalizeFolderPath(relativeFile);
      return regexps.some((regexp) => regexp.test(normalized));
    },
    activeCount: regexps.length,
    problems,
  };
}

/**
 * 往列表里加一条（已存在则原样返回）。**不**顺带删除冗余的子条目 —— 加操作不销毁用户已有配置。
 *
 * 返回新列表（调用方负责写回设置）。
 */
export function addFolderEntry(entries: readonly string[], entry: string): string[] {
  const text = String(entry ?? '').trim();
  const next = entries.map((item) => String(item ?? ''));
  if (text.length === 0 || next.some((item) => normalizeFolderPath(item) === normalizeFolderPath(text))) {
    return next;
  }
  return [...next, text];
}

/**
 * 从列表里移除一条，并**把落在它内部的子条目一并移除**（用户 2026-10-15 口径：
 * 「如果已经在里面的则通过选项取消，如果内部也有被过滤的子文件夹一并取消」）。
 *
 * 为什么连子条目一起删：父条目已经在过滤这棵子树，取消父条目后若保留子条目，
 * 用户会认为「已经取消、子目录却仍在过滤」—— 一并取消才符合「这个目录不再过滤」的意图。
 *
 * 返回 `{ entries, removed }`：`removed` 是被移除的条目数（0 表示本来就不在列表里）。
 */
export function removeFolderEntry(
  entries: readonly string[],
  entry: string
): { entries: string[]; removed: number } {
  const target = normalizeFolderPath(entry);
  const kept: string[] = [];
  let removed = 0;
  for (const item of entries) {
    const text = String(item ?? '');
    const normalized = normalizeFolderPath(text);
    const inside = normalized === target || normalized.startsWith(`${target}/`);
    if (target.length > 0 && inside) {
      removed += 1;
      continue;
    }
    kept.push(text);
  }
  return { entries: kept, removed };
}

/** 该目录是否**已经被过滤**（它本身在列表里，或它的某个父目录在列表里）。 */
export function isFolderFiltered(entries: readonly string[], folder: string): boolean {
  const target = normalizeFolderPath(folder);
  if (target.length === 0) {
    return false;
  }
  return entries.some((item) => {
    const normalized = normalizeFolderPath(item);
    return normalized.length > 0 && (target === normalized || target.startsWith(`${normalized}/`));
  });
}

/**
 * 按过滤结果裁剪节点表：命中的节点**连同整棵子树**都不进结果。
 *
 * ⚠️ 根节点永不参与过滤：否则用户误加一条就可能把整张图清空（设置说明里也是这么写的）。
 *
 * 这是**目录过滤与临时路径过滤共用的裁剪规则**：两者只差「哪个节点算命中」，
 * 而「命中即整棵子树消失、根永不隐藏、`children` 不留悬空引用」这三条必须逐字一致 ——
 * 各写一次迟早走形。
 *
 * @param shouldHide 该节点是否命中（`file` 是相对工作区的路径）
 * @returns nodes 裁剪后的节点表（`children` 已同步，不会留下指向被隐藏节点的引用）；
 *   hidden 被隐藏的节点数（含子树，供日志说明过滤掉多少）
 */
export function applyNodeFilter<T extends { file: string; children: string[] }>(
  nodes: Record<string, T>,
  rootId: string,
  shouldHide: (node: T) => boolean
): { nodes: Record<string, T>; hidden: number } {
  const kept: Record<string, T> = {};
  let hidden = 0;
  const subtreeSize = (id: string, guard: Set<string>): number => {
    const node = nodes[id];
    if (node === undefined || guard.has(id)) {
      return 0; // 数据理论上无环；这里仍加保护，免得脏数据把计数变成死循环
    }
    guard.add(id);
    let total = 1;
    for (const child of node.children) {
      total += subtreeSize(child, guard);
    }
    return total;
  };
  const walk = (id: string, isRoot: boolean): void => {
    const node = nodes[id];
    if (node === undefined) {
      return;
    }
    if (!isRoot && shouldHide(node)) {
      hidden += subtreeSize(id, new Set<string>());
      return;
    }
    const copy = { ...node, children: [] as string[] };
    kept[id] = copy;
    for (const child of node.children) {
      walk(child, false);
      if (kept[child] !== undefined) {
        copy.children.push(child);
      }
    }
  };
  walk(rootId, true);
  return { nodes: kept, hidden };
}

/**
 * 按目录过滤器裁剪节点表（见 `applyNodeFilter` 的规则说明）。
 *
 * @returns nodes 裁剪后的节点表；hidden 被隐藏的节点数（含子树）
 */
export function applyFolderFilter<T extends { file: string; children: string[] }>(
  nodes: Record<string, T>,
  rootId: string,
  filter: NodeFilter
): { nodes: Record<string, T>; hidden: number } {
  if (filter.activeCount === 0) {
    return { nodes, hidden: 0 };
  }
  return applyNodeFilter(nodes, rootId, (node) => filter.test(node.file));
}
