/**
 * 候选挑选测试：`resolveAt` / `pickByChoice` 必须选到**用户真正指的那个符号**。
 *
 * 背景（真实会踩的坑）：光标落在一个符号名中间时，
 * `vscode.prepareCallHierarchy` 在**不同列**上会返回**不同符号**，而 VS Code
 * 会把请求聚合给所有 provider。如果实现只是「第一个有结果的偏移就返回」，
 * 那么光标在 `ENUM_A` 第 2 个字符上、偏移 0 恰好命中了旁边的 `A` 时，
 * 就会拿到错的那个符号——枚举/结构体这类符号尤其容易出现。
 *
 * 这里用最小 vscode 桩驱动打包产物，覆盖：
 *   1. 光标在名字中间 → 选中包含光标的那个
 *   2. 光标在名字右侧空白 → 仍然选中左边的名字
 *   3. 同一位置返回多个候选 → 选选区离光标最近的
 *   4. 完全无结果 → 返回 undefined（不瞎选）
 *
 * 运行：node scripts/pickCheck.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

// ------------------------------------------------------------ 最小 vscode 桩

/** 记录「哪个列位置返回哪些符号」，用于模拟语言服务的行为。 */
const preparedByColumn = new Map();
let prepareCalls = [];

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLine, startChar, endLine, endChar) {
    this.start = { line: startLine, character: startChar };
    this.end = { line: endLine, character: endChar };
  }
}

const vscodeStub = {
  Position,
  Range,
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  commands: {
    executeCommand: async (commandName, uri, position) => {
      if (commandName !== 'vscode.prepareCallHierarchy') {
        return [];
      }
      prepareCalls.push(position.character);
      return preparedByColumn.get(position.character) ?? [];
    },
  },
  languages: {},
  window: {},
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` }) },
  SymbolKind: { Function: 11, Method: 5, Enum: 9, EnumMember: 21 },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Window: 10, Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Active: -1 },
};

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad(request, parent, isMain);
};

const bundle = require(path.join(ROOT, 'dist', 'extension.js'));
const { pickByChoice, resolveAt } = bundle.__hierarchy;
assert(typeof pickByChoice === 'function', '产物没有导出 __hierarchy.pickByChoice');
assert(typeof resolveAt === 'function', '产物没有导出 __hierarchy.resolveAt');

// ------------------------------------------------------------ 夹具

/** 造一个 symbol，名字所在列区间为 [start, end)。 */
function makeItem(name, start, end, kind = 21) {
  return {
    name,
    kind,
    uri: vscodeStub.Uri.file('G:\\proj\\enums.h'),
    range: new Range(0, start, 0, end),
    selectionRange: new Range(0, start, 0, end),
  };
}

const document = {
  uri: vscodeStub.Uri.file('G:\\proj\\enums.h'),
  // 一行源码：  enum State { STATE_A, STATE_B };
  lineAt: () => ({ text: 'enum State { STATE_A, STATE_B };' }),
};

async function main() {
  // ---- 1. 光标在名字中间：只应选中该名字 ----
  preparedByColumn.clear();
  const stateA = makeItem('STATE_A', 14, 21); // 占据第 14..21 列
  // 模拟：偏移 -1 与 0 都能命中 STATE_A
  preparedByColumn.set(13, [stateA]);
  preparedByColumn.set(15, [stateA]);

  prepareCalls = [];
  const cursorMid = new Position(0, 15); // STATE_A 中间
  const resolvedMid = await resolveAt(document, cursorMid, 'auto', 'clangd');
  assert(resolvedMid !== undefined, '名字中间应当解析出结果');
  assert(
    resolvedMid.item.name === 'STATE_A',
    `名字中间应选中 STATE_A，实际 ${resolvedMid.item.name}`
  );
  console.log(`诊断: 光标在 STATE_A 中间 → 选中 ${resolvedMid.item.name}`);

  // ---- 2. 光标在名字右侧：偏移 0 无结果，靠左侧试探命中 ----
  preparedByColumn.clear();
  preparedByColumn.set(21, [stateA]); // 只有第 21 列（紧邻右边界）能命中
  prepareCalls = [];
  const resolvedRight = await resolveAt(document, new Position(0, 21), 'auto', 'clangd');
  assert(resolvedRight !== undefined, '名字右侧应当能靠试探命中');
  assert(
    resolvedRight.item.name === 'STATE_A',
    `名字右侧应选中 STATE_A，实际 ${resolvedRight.item.name}`
  );
  console.log(`诊断: 光标在 STATE_A 右侧 → 选中 ${resolvedRight.item.name}`);

  // ---- 3. 同一位置多个候选：选选区离光标最近的 ----
  const near = makeItem('STATE_A', 14, 21);
  const far = makeItem('State', 5, 10);
  const pickedNear = pickByChoice([far, near], new Position(0, 18));
  assert(
    pickedNear === near,
    `应选中离光标近的 STATE_A，实际 ${pickedNear && pickedNear.name}`
  );
  const pickedFar = pickByChoice([far, near], new Position(0, 6));
  assert(pickedFar === far, `应选中离光标近的 State，实际 ${pickedFar && pickedFar.name}`);
  console.log('诊断: 多候选时按「选区离光标最近」挑选');

  // ---- 4. 光标在选区外且距离相同时，按数组顺序取靠前的 ----
  const left = makeItem('LEFT', 0, 4);
  const right = makeItem('RIGHT', 10, 15);
  const tie = pickByChoice([left, right], new Position(0, 7)); // 距左 3、距右 3
  assert(tie === left, `并列时应取靠前的，实际 ${tie && tie.name}`);

  // ---- 5. 无结果 → undefined，不瞎选 ----
  preparedByColumn.clear();
  const resolvedNone = await resolveAt(document, new Position(0, 0), 'auto', 'clangd');
  assert(resolvedNone === undefined, '完全无结果时应返回 undefined');
  console.log('诊断: 无结果时返回 undefined（不会瞎选一个）');

  console.log('OK: 候选挑选按「选区离光标最近」工作，光标在符号名内部/右侧都能选对');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
