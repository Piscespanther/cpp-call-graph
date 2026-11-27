/**
 * 临时路径过滤的查询语义（用户 2026-10-15 要求，2026-10-17 扩充）。
 *
 * 与设置里的 `cppCallGraph.excludeFolders` 是**两件事**，只是共用同一套裁剪规则：
 *   - `excludeFolders` 是**长期**配置、写在设置里、随工作区生效；
 *   - 这里是**临时**过滤：文字只存在于面板的输入框与宿主的一个字段里，
 *     不写设置、不进会话快照，清空输入即完全恢复。
 *
 * 匹配素材（2026-10-17 起可切换，开关在面板上、与「搜索」无关）：
 *   - **路径**（默认）：节点的 `file`，即**相对工作区**的路径（与目录过滤同一份口径）。
 *     会话中存储的即为该值；绝对路径含机器相关的盘符与目录名，拿来匹配反而不稳定。
 *   - **名称行标签**（开关「包含标签」/「仅标签」）：名称行上那段标签文字，即 payload 里的
 *     `nameTagPrefix` / `nameTagSuffix`（宿主用 `nameTagPartsFor()` 现算，两侧因此同源）。
 *     它只有在设置 `cppCallGraph.nameFolderTag` 打开、且锚点在当前路径上命中时才存在；
 *     此时用户可以按标签的**写法**过滤（例如写 `[lib]` 命中带 `lib` 标签的方框）。
 *
 * 查询可以写**多条**，用逗号分隔，**任一命中即命中**（OR 语义）。拆分是**引号感知**的
 * （与 `pathAnchors` 同一套规则）：`"a,b"` 里的逗号不算分隔符，整段引号表示一条**字面量**。
 *
 * 命中之后有两种处置方式（用户 2026-11-20 明确要求，由面板上第三个开关「仅保留」切换）：
 *   - **排除**（默认）：命中节点连同整棵子树都不显示 —— 用来「把噪音拿掉」；
 *   - **仅保留**：只保留命中节点与它们**到根的祖先链**，其余不显示 —— 用来「只看某几条」。
 *
 * 单条的匹配口径（用户 2026-10-15 在选项里确认）：**子串 + 通配**。
 *   - 不含通配字符时是不区分大小写的**子串**匹配：写 `lib` 就是「路径里出现 lib」；
 *   - `*` 段内任意长（不跨 `/`）、`?` 单个字符（不跨 `/`）、写成 `**` 后紧跟一个 `/` 表示任意层
 *     （可以零层）；
 *   - 整条**不锚定**两端 —— 与「子串」是同一套直觉：想看「路径中间夹着某一段」，把它写出来即可
 *     （例如 `lib` 与 `sub` 之间还有什么都不影响命中）；
 *   - `\` 与 `/` 等价（Windows 路径），大小写不敏感，其余字符一律**字面量**
 *     （包括 `|`：临时过滤没有「多选」语义，写 `a|b` 就是找这一串字符）。
 */

import { NodeFilter, applyNodeFilter, normalizeFolderPath } from './folderFilter';
import { splitQuoted } from './graphLayout';

/**
 * 查询里的一条（已经过引号处理）。
 *
 * `literal` 为真表示这一条整体带过引号：整段按字面量匹配，其中的 `*` / `?` 不作通配 ——
 * 与 `pathAnchors` 里 `"..."` 的语义一致，否则「用引号把逗号括起来」会顺带改变通配行为。
 */
export interface PathQueryItem {
  /** 参与匹配的文字（整体加引号时已去掉外层引号）。 */
  readonly text: string;
  /** 是否整段按字面量匹配。 */
  readonly literal: boolean;
}

/**
 * 把输入框里的整串文字拆成若干条查询（引号感知，空项丢弃）。
 *
 * 空项必须丢掉：`a,,b` 或结尾多打一个逗号时，若把空串当成一条查询，它会匹配**一切**
 * （空正则命中任意字符串），表现为「打错一个逗号，整张图被清空」。
 */
export function splitPathQueries(text: string): PathQueryItem[] {
  const items: PathQueryItem[] = [];
  for (const raw of splitQuoted(String(text ?? ''), ',')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const literal = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
    items.push({ text: literal ? trimmed.slice(1, -1) : trimmed, literal });
  }
  return items;
}

/**
 * 把**一条**查询文字编译成正则；空查询返回 `undefined`（= 不过滤任何节点）。
 *
 * 刻意不抛异常：输入框里的任何文字都必须能用，「不合法」在临时过滤里没有意义
 * （用户写到一半时的中间状态不该报错，也不该让整帧渲染中断）。
 *
 * @param literal 整段按字面量编译（`*` / `?` 不作通配），见 `PathQueryItem.literal`。
 */
export function compilePathQuery(query: string, literal = false): RegExp | undefined {
  const text = normalizeFolderPath(query);
  if (text.length === 0) {
    return undefined;
  }
  let source = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!literal && character === '*') {
      // 两个星号后紧跟一个斜杠 = 任意层（含零层）：与目录过滤的 `**` 语义一致，只是不锚定两端。
      // 单独一个 `**`（后面不是斜杠）退化为「任意字符，含斜杠」。
      if (text[index + 1] === '*') {
        if (text[index + 2] === '/') {
          source += '(?:[^/]+/)*';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (!literal && character === '?') {
      source += '[^/]';
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\|"]/g, '\\$&');
  }
  return new RegExp(source, 'i');
}

/** 把整串查询编译成若干条正则（每条独立匹配，调用方按 OR 使用）。 */
export function compilePathQueries(text: string): RegExp[] {
  const regexps: RegExp[] = [];
  for (const item of splitPathQueries(text)) {
    const regexp = compilePathQuery(item.text, item.literal);
    if (regexp !== undefined) {
      regexps.push(regexp);
    }
  }
  return regexps;
}

/**
 * 过滤器的匹配素材与开关（对应面板上的三个开关）。
 *
 * 默认值即「三个开关都关」= 只看路径、命中即排除，与 2026-10-16 之前的行为逐字一致。
 */
export interface PathQueryOptions {
  /** 「包含标签」：路径**或**标签文字命中即命中。 */
  readonly matchTag?: boolean;
  /** 「仅标签」：只看标签文字，不看路径（它已隐含「包含标签」）。 */
  readonly tagOnly?: boolean;
  /**
   * 「仅保留」（用户 2026-11-20 要求）：翻转语义 —— 只保留**命中节点与它们到根的祖先链**，
   * 其余全部隐藏。默认 false = 排除（命中节点连同整棵子树都不显示）。
   *
   * 与「包含标签 / 仅标签」**正交**：那两个决定「什么算命中」，这一个决定「命中之后是留还是去」，
   * 因此可以叠加（例如「按标签保留」= 仅标签 + 仅保留）。
   */
  readonly keepOnly?: boolean;
  /**
   * 取该文件的名称行标签文字（`nameTagPrefix` + `nameTagSuffix`）。
   *
   * 由调用方注入：宿主手上有 `PathDisplayOptions`，能算出与 payload 完全相同的文字；
   * 面板不需要懂这套规则，匹配因此仍然只在宿主一处进行。
   */
  readonly tagText?: (relativeFile: string) => string;
}

/**
 * 编译成统一的节点过滤器（形状与目录过滤器相同，因此共用同一套裁剪规则）。
 *
 * `problems` 恒为空：查询永远「有效」，没有命中就是没有命中。
 */
export function createPathQueryFilter(query: string, options: PathQueryOptions = {}): NodeFilter {
  const regexps = compilePathQueries(query);
  const matchTag = options.matchTag === true || options.tagOnly === true;
  const tagOnly = options.tagOnly === true;
  const tagText = options.tagText;
  const hit = (subject: string): boolean => {
    if (subject.length === 0 || regexps.length === 0) {
      return false;
    }
    const normalized = normalizeFolderPath(subject);
    return regexps.some((regexp) => regexp.test(normalized));
  };
  return {
    test(file: string): boolean {
      if (regexps.length === 0) {
        return false;
      }
      if (!tagOnly && hit(file)) {
        return true;
      }
      if (matchTag && tagText !== undefined && hit(tagText(file))) {
        return true;
      }
      return false;
    },
    activeCount: regexps.length,
    problems: [],
  };
}

/**
 * 「仅保留」模式的裁剪：保留**命中节点**与它们**到根的祖先链**，其余全部隐藏。
 *
 * 为什么必须保留祖先：布局是按 `children` 从根递归排的，父节点被去掉时子节点根本不会上图 ——
 * 只留命中节点本身，用户看到的会是一张只剩孤零零几个框（甚至只有根）的空图。
 * 为什么**不**保留命中节点的子树：「只保留」的直觉是「只看我写的这些」，
 * 未命中的后代应当一并消失；要连整棵子树一起看，改用排除模式写反向条件即可。
 *
 * 根永不隐藏（与排除模式同一口径），因此命中为空时结果是「只剩根 + 隐藏 N 个」。
 */
function keepMatchingNodes<T extends { file: string; children: string[] }>(
  nodes: Record<string, T>,
  rootId: string,
  filter: NodeFilter
): { nodes: Record<string, T>; hidden: number } {
  // 节点表只保证 `children`，没有 `parent` 字段 —— 反查表在这里现建一次（O(n)）。
  const parentOf = new Map<string, string>();
  for (const [id, node] of Object.entries(nodes)) {
    for (const child of node.children) {
      if (!parentOf.has(child)) {
        parentOf.set(child, id);
      }
    }
  }
  const kept = new Set<string>();
  if (nodes[rootId] !== undefined) {
    kept.add(rootId);
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (!filter.test(node.file)) {
      continue;
    }
    // 从命中节点往上把祖先链一并收进保留集；`guard` 防脏数据形成的环
    let cursor: string | undefined = id;
    let guard = 0;
    while (cursor !== undefined && !kept.has(cursor) && guard < 100000) {
      kept.add(cursor);
      cursor = parentOf.get(cursor);
      guard += 1;
    }
  }
  const result: Record<string, T> = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (!kept.has(id)) {
      continue;
    }
    // 与 `applyNodeFilter` 同一口径：`children` 不能留下指向被隐藏节点的引用
    result[id] = { ...node, children: node.children.filter((child) => kept.has(child)) };
  }
  return { nodes: result, hidden: Object.keys(nodes).length - kept.size };
}

/**
 * 按临时查询裁剪节点表。
 *
 * 两种模式（用户 2026-11-20 确认的两种用法）：
 *   - **排除**（默认）：命中节点连同整棵子树隐藏 —— 规则见 `applyNodeFilter`；
 *   - **仅保留**（`keepOnly`）：只保留命中节点与它们到根的祖先链 —— 见 `keepMatchingNodes`。
 *
 * 空查询直接原样返回：没有过滤时不应为每个标签无效遍历整棵树。
 */
export function applyPathQueryFilter<T extends { file: string; children: string[] }>(
  nodes: Record<string, T>,
  rootId: string,
  query: string,
  options: PathQueryOptions = {}
): { nodes: Record<string, T>; hidden: number } {
  const filter = createPathQueryFilter(query, options);
  if (filter.activeCount === 0) {
    return { nodes, hidden: 0 };
  }
  if (options.keepOnly === true) {
    return keepMatchingNodes(nodes, rootId, filter);
  }
  return applyNodeFilter(nodes, rootId, (node) => filter.test(node.file));
}
