/**
 * 临时路径过滤的查询语义（用户 2026-10-15 要求）。
 *
 * 与设置里的 `cppCallGraph.excludeFolders` 是**两件事**，只是共用同一套裁剪规则：
 *   - `excludeFolders` 是**长期**配置、写在设置里、随工作区生效；
 *   - 这里是**临时**过滤：文字只存在于面板的输入框与宿主的一个字段里，
 *     不写设置、不进会话快照，清空输入即完全恢复。
 *
 * 匹配口径（用户 2026-10-15 在选项里确认）：**子串 + 通配**。
 *   - 不含通配字符时是不区分大小写的**子串**匹配：写 `lib` 就是「路径里出现 lib」；
 *   - `*` 段内任意长（不跨 `/`）、`?` 单个字符（不跨 `/`）、写成 `**` 后紧跟一个 `/` 表示任意层
 *     （可以零层）；
 *   - 整条**不锚定**两端 —— 与「子串」是同一套直觉：想看「路径中间夹着某一段」，把它写出来即可
 *     （例如 `lib` 与 `sub` 之间还有什么都不影响命中）；
 *   - `\` 与 `/` 等价（Windows 路径），大小写不敏感，其余字符一律**字面量**
 *     （包括 `|`：临时过滤没有「多选」语义，写 `a|b` 就是找这一串字符）。
 *
 * 匹配对象是节点的 `file`，即**相对工作区**的路径（与目录过滤同一份口径）：
 * 会话中存储的即为该值；绝对路径含机器相关的盘符与目录名，拿来匹配反而不稳定。
 */

import { NodeFilter, applyNodeFilter, normalizeFolderPath } from './folderFilter';

/**
 * 把查询文字编译成正则；空查询返回 `undefined`（= 不过滤任何节点）。
 *
 * 刻意不抛异常：输入框里的任何文字都必须能用，「不合法」在临时过滤里没有意义
 * （用户写到一半时的中间状态不该报错，也不该让整帧渲染中断）。
 */
export function compilePathQuery(query: string): RegExp | undefined {
  const text = normalizeFolderPath(query);
  if (text.length === 0) {
    return undefined;
  }
  let source = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '*') {
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
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\|]/g, '\\$&');
  }
  return new RegExp(source, 'i');
}

/**
 * 编译成统一的节点过滤器（形状与目录过滤器相同，因此共用同一套裁剪规则）。
 *
 * `problems` 恒为空：查询永远「有效」，没有命中就是没有命中。
 */
export function createPathQueryFilter(query: string): NodeFilter {
  const regexp = compilePathQuery(query);
  return {
    test(file: string): boolean {
      return regexp !== undefined && regexp.test(normalizeFolderPath(file));
    },
    activeCount: regexp === undefined ? 0 : 1,
    problems: [],
  };
}

/**
 * 按临时查询裁剪节点表（规则见 `applyNodeFilter`：命中节点连同整棵子树、根永不隐藏）。
 *
 * 空查询直接原样返回：没有过滤时不应为每个标签无效遍历整棵树。
 */
export function applyPathQueryFilter<T extends { file: string; children: string[] }>(
  nodes: Record<string, T>,
  rootId: string,
  query: string
): { nodes: Record<string, T>; hidden: number } {
  const filter = createPathQueryFilter(query);
  if (filter.activeCount === 0) {
    return { nodes, hidden: 0 };
  }
  return applyNodeFilter(nodes, rootId, (node) => filter.test(node.file));
}
