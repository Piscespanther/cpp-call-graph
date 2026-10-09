/**
 * 图与会话的共享类型（放在单独文件里，避免 graphLayout 与 session 互相 import 成环）。
 */

/** 调用关系方向。 */
export type CallDirection = 'callers' | 'callees';

/** 视图里的一条关系轴。 */
export type Direction = CallDirection;

export type SessionKind = 'call';

export function kindOf(_direction: Direction): SessionKind {
  return 'call';
}

export function isCallDirection(direction: Direction): direction is CallDirection {
  return direction === 'callers' || direction === 'callees';
}

/** 箭头是否指向右（时间顺序：调用者 → 被调用者）。 */
export function flowsRight(direction: Direction): boolean {
  return direction === 'callees';
}

/** 是否由根指向外（调用关系是，被调用关系反过来）。 */
export function isOutgoing(direction: Direction): boolean {
  return direction === 'callees';
}

export const DIRECTION_LABEL: Record<Direction, string> = {
  callers: '被调用关系',
  callees: '调用关系',
};

export const DIRECTION_SHORT: Record<Direction, string> = {
  callers: '被调用',
  callees: '调用',
};

export interface CallSite {
  file: string;
  line: number;
  /** 发生调用/引用的那一行源码（去首尾空白，过长会截断）。 */
  text: string;
}

/**
 * 节点类型：尽量覆盖 vscode.SymbolKind 的全部取值，
 * 这样只要语言服务能给出调用层级，枚举/结构体/成员等也能显示（不再只有函数）。
 *   function / method / constructor / operator —— 函数族
 *   enum / enumMember —— 枚举族
 *   class / interface / struct / typeParameter —— 类型族
 *   variable / field / property / constant —— 变量族
 *   namespace / module / package —— 命名空间族
 *   other —— 兜底
 */
export type NodeKind =
  | 'function'
  | 'method'
  | 'constructor'
  | 'operator'
  | 'enum'
  | 'enumMember'
  | 'class'
  | 'interface'
  | 'struct'
  | 'typeParameter'
  | 'variable'
  | 'field'
  | 'property'
  | 'constant'
  | 'namespace'
  | 'module'
  | 'package'
  | 'other';

export interface GraphNode {
  id: string;
  name: string;
  /** 函数签名 / 宏定义体等补充信息。 */
  detail?: string;
  file: string;
  line: number;
  /** 关系发生点：谁在第几行引用了/调用了谁。 */
  callSite?: CallSite;
  direction: Direction;
  /** 相对根节点的层数，0 为根。 */
  depth: number;
  isCycle: boolean;
  children: string[];
  parent?: string;
  /** 子节点是否已加载（点击 + 之后才加载）。 */
  loaded: boolean;
  kind: NodeKind;
}

export interface GraphEdge {
  id: string;
  /** 箭头起点（靠近根或时间较早的一侧）。 */
  from: string;
  /** 箭头指向。 */
  to: string;
  depth: number;
}

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphLayout {
  boxes: Record<string, LayoutBox>;
  width: number;
  height: number;
  minX: number;
  minY: number;
}

/** 全部合法的节点类型，供运行时校验（历史数据的归一化用）。 */
export const KNOWN_NODE_KINDS = [
  'function',
  'method',
  'constructor',
  'operator',
  'enum',
  'enumMember',
  'class',
  'interface',
  'struct',
  'typeParameter',
  'variable',
  'field',
  'property',
  'constant',
  'namespace',
  'module',
  'package',
  'other',
] as const;

/** vscode.SymbolKind 的数值含义（写全，便于对照）。 */
export const SYMBOL_KIND_NAME: Record<number, string> = {
  0: 'File',
  1: 'Module',
  2: 'Namespace',
  3: 'Package',
  4: 'Class',
  5: 'Method',
  6: 'Property',
  7: 'Field',
  8: 'Constructor',
  9: 'Enum',
  10: 'Interface',
  11: 'Function',
  12: 'Variable',
  13: 'Constant',
  14: 'String',
  15: 'Number',
  16: 'Boolean',
  17: 'Array',
  18: 'Object',
  19: 'Key',
  20: 'Null',
  21: 'EnumMember',
  22: 'Struct',
  23: 'Event',
  24: 'Operator',
  25: 'TypeParameter',
};

/** 把语言服务给出的 SymbolKind 数值映射到节点类型（覆盖全部取值）。 */
export function symbolKindToNodeKind(kind: number): NodeKind {
  switch (kind) {
    case 5: // Method
      return 'method';
    case 8: // Constructor
      return 'constructor';
    case 24: // Operator
      return 'operator';
    case 11: // Function
    case 23: // Event
      return 'function';
    case 9: // Enum
      return 'enum';
    case 21: // EnumMember
      return 'enumMember';
    case 4: // Class
      return 'class';
    case 10: // Interface
      return 'interface';
    case 22: // Struct
      return 'struct';
    case 25: // TypeParameter
      return 'typeParameter';
    case 12: // Variable
      return 'variable';
    case 7: // Field
      return 'field';
    case 6: // Property
    case 19: // Key
      return 'property';
    case 13: // Constant
      return 'constant';
    case 2: // Namespace
      return 'namespace';
    case 1: // Module
      return 'module';
    case 3: // Package
      return 'package';
    default:
      // 0 File / 14 String / 15 Number / 16 Boolean / 17 Array / 18 Object / 20 Null
      return 'other';
  }
}
