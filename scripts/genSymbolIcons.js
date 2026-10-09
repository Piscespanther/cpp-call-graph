/**
 * 从 VS Code 自带的 codicon.ttf 里提取符号图标的**真实字形轮廓**，生成 SVG 路径，
 * 输出到 src/webview/symbolIcons.ts。
 *
 * 为什么这样做：手画图标永远对不齐 VS Code 大纲/标签里的样子。
 * codicon.ttf 是 VS Code 本体用的图标字体，直接解析它的 glyf 表即可拿到权威形状。
 * 生成的路径是纯 SVG，不依赖字体文件，也不增加分发体积。
 *
 * ---------------------------------------------------------------------------
 * 许可说明（重要）
 *
 * 本脚本读取的 codicon.ttf 属于 @vscode/codicons：
 *   Copyright (c) Microsoft Corporation
 *   许可：Creative Commons Attribution 4.0 International (CC BY 4.0)
 *   （该包的图标/字体/文档为 CC BY 4.0，构建脚本为 MIT）
 *   https://creativecommons.org/licenses/by/4.0/
 *
 * 提取出的字形轮廓属于 CC BY 4.0 意义上的「改编素材」，**必须保留署名**。
 * 因此生成的文件头部带有版权与许可说明，且仓库根目录提供
 * THIRD-PARTY-NOTICES.txt（随扩展分发）。
 *
 * 注意：不要移除生成文件里的许可头——去掉它即构成违反 CC BY 4.0 的署名义务。
 * ---------------------------------------------------------------------------
 *
 * 用法：node scripts/genSymbolIcons.js
 *       node scripts/genSymbolIcons.js --verify   （只校验，不写入）
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 定位 VS Code 自带的 codicon.ttf。
 *
 * 这个路径**因机器而异**（Windows 上还带一个安装提交哈希目录，如
 * `resources\app\<hash>\resources\app\out\media\codicon.ttf`），
 * 所以绝不能写死，否则别人 clone 下来就跑不通。
 *
 * 解析顺序：
 *   1. 环境变量 CODICON_TTF（显式指定，优先级最高）
 *   2. 常见安装位置（Windows / macOS / Linux）逐个探测
 *   3. 从 PATH 里的 code / code-insiders 反推安装目录
 * 都找不到就返回 undefined，由调用方决定是跳过还是报错。
 */
function findCodiconFont() {
  const explicit = process.env.CODICON_TTF;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const relative = ['out', 'media', 'codicon.ttf'];
  const bases = [];

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    for (const dir of ['Microsoft VS Code', 'Microsoft VS Code Insiders', 'VSCodium']) {
      bases.push(path.join(programFiles, dir, 'resources', 'app'));
      if (localAppData) {
        bases.push(path.join(localAppData, 'Programs', dir, 'resources', 'app'));
      }
    }
  } else if (process.platform === 'darwin') {
    for (const dir of ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app', 'VSCodium.app']) {
      bases.push(path.join('/Applications', dir, 'Contents', 'Resources', 'app'));
      bases.push(path.join(process.env.HOME ?? '', 'Applications', dir, 'Contents', 'Resources', 'app'));
    }
  } else {
    for (const dir of ['/usr/share/code', '/usr/share/code-insiders', '/usr/lib/code', '/opt/visual-studio-code', '/usr/share/codium']) {
      bases.push(path.join(dir, 'resources', 'app'));
    }
  }

  // Windows 上安装目录下可能还有一层提交哈希目录，做一次浅层枚举
  for (const base of [...bases]) {
    if (!fs.existsSync(base)) {
      continue;
    }
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[0-9a-f]{8,}$/i.test(entry.name)) {
          bases.push(path.join(base, entry.name, 'resources', 'app'));
        }
      }
    } catch {
      // 目录不可读就跳过
    }
  }

  for (const base of bases) {
    const candidate = path.join(base, ...relative);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 退路：从 PATH 里的 code 命令反推
  for (const command of ['code', 'code-insiders']) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) {
        continue;
      }
      const candidate = path.join(dir, '..', 'resources', 'app', ...relative);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // 最后一招（Windows）：查注册表拿到实际安装目录——能覆盖安装在非默认盘符的情况
  if (process.platform === 'win32') {
    const fromRegistry = findWindowsInstallDirs();
    for (const dir of fromRegistry) {
      const candidate = path.join(dir, 'resources', 'app', ...relative);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      // 安装目录下可能还有一层提交哈希目录
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && /^[0-9a-f]{8,}$/i.test(entry.name)) {
            const nested = path.join(dir, entry.name, 'resources', 'app', ...relative);
            if (fs.existsSync(nested)) {
              return nested;
            }
          }
        }
      } catch {
        // 忽略不可读目录
      }
    }
  }

  return undefined;
}

/**
 * Windows：从注册表读出 VS Code 的安装目录，覆盖「装在非默认盘符」的情况。
 *
 * 实现要点（都踩过）：
 *   1. 不能用固定键名——用户级安装的键是 GUID，如
 *      HKCU\...\Uninstall\{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1
 *   2. `reg query <root> /s /f "Visual Studio Code"` 实测抓不到该键，
 *      所以改为把整个根的 InstallLocation 全列出来，再按值筛选。
 *   3. 安装目录下还有一层提交哈希目录（形如 `<8 位十六进制>`），字体在它里面。
 */
function findWindowsInstallDirs() {
  const { execFileSync } = require('node:child_process');
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const dirs = [];
  for (const root of roots) {
    let output = '';
    try {
      output = execFileSync('reg', ['query', root, '/s', '/v', 'InstallLocation'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      continue; // 该根键不存在
    }
    for (const match of output.matchAll(/InstallLocation\s+REG_SZ\s+(.+)/g)) {
      const dir = match[1].trim().replace(/\\+$/, '');
      // 只保留看起来是 VS Code 的安装目录（避免把无关软件当候选）
      if (!/vscode|vs code|vscodium/i.test(dir) && !/[\\/]Code$/i.test(dir)) {
        continue;
      }
      if (dir && !dirs.includes(dir)) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

const FONT = findCodiconFont();

/**
 * NodeKind → codicon 名称。必须覆盖 graphTypes.ts 里的**全部** NodeKind，
 * 否则该类型会退回兜底图标（脚本会检查这一点）。
 * 对应关系取自 VS Code 自己的 SymbolKind → codicon 映射。
 */
const KIND_TO_CODICON = {
  function: 'symbol-method',
  method: 'symbol-method',
  constructor: 'symbol-method',
  operator: 'symbol-operator',
  enum: 'symbol-enum',
  enumMember: 'symbol-enum-member',
  class: 'symbol-class',
  interface: 'symbol-interface',
  struct: 'symbol-struct',
  typeParameter: 'symbol-parameter',
  variable: 'symbol-variable',
  field: 'symbol-field',
  property: 'symbol-property',
  constant: 'symbol-constant',
  namespace: 'symbol-module',
  module: 'symbol-module',
  package: 'symbol-module',
  event: 'symbol-event',
  key: 'symbol-key',
  string: 'symbol-string',
  number: 'symbol-numeric',
  boolean: 'symbol-boolean',
  array: 'symbol-array',
  file: 'symbol-file',
  other: 'symbol-color',
};

/** 需要从字体里提取的 codicon 集合（去重）。 */
const NEEDED = Object.fromEntries(
  [...new Set(Object.values(KIND_TO_CODICON))].map((name) => [name, name])
);


// 从 codicon.css 读到的码点（VS Code 自带，用于交叉校验）
const CODEPOINTS = {
  'symbol-method': 0xea8c,
  'symbol-class': 0xeb5b,
  'symbol-struct': 0xea91,
  'symbol-enum': 0xea95,
  'symbol-enum-member': 0xeb5e,
  'symbol-interface': 0xeb61,
  'symbol-variable': 0xea88,
  'symbol-field': 0xeb5f,
  'symbol-property': 0xeb65,
  'symbol-constant': 0xeb5d,
  'symbol-module': 0xea8b,
  'symbol-parameter': 0xea92,
  'symbol-operator': 0xeb64,
  'symbol-event': 0xea86,
  'symbol-key': 0xea93,
  'symbol-string': 0xeb8d,
  'symbol-numeric': 0xea90,
  'symbol-boolean': 0xea8f,
  'symbol-array': 0xea8a,
  'symbol-file': 0xeb60,
  'symbol-color': 0xeb5c,
};

// 找不到字体时的处理：
//   - 校验模式（--verify）直接跳过：生成文件已提交进仓库，普通构建/测试不需要字体
//   - 生成模式报错并给出解决办法，而不是静默产出错误结果
if (!FONT) {
  if (process.argv.includes('--verify')) {
    console.log('未找到 VS Code 的 codicon.ttf，跳过校验（生成文件已提交，构建不受影响）');
    process.exit(0);
  }
  console.error('找不到 VS Code 自带的 codicon.ttf。');
  console.error('请用环境变量指定字体路径后重试，例如：');
  console.error('  Windows: $env:CODICON_TTF="C:\\Program Files\\Microsoft VS Code\\resources\\app\\out\\media\\codicon.ttf"');
  console.error('  macOS/Linux: CODICON_TTF=/usr/share/code/resources/app/out/media/codicon.ttf node scripts/genSymbolIcons.js');
  process.exit(1);
}

const buffer = fs.readFileSync(FONT);

// ------------------------------------------------------------ TTF 基础读取

const readUint16 = (offset) => buffer.readUInt16BE(offset);
const readInt16 = (offset) => buffer.readInt16BE(offset);
const readUint32 = (offset) => buffer.readUInt32BE(offset);

const numTables = readUint16(4);
const tables = {};
for (let i = 0; i < numTables; i += 1) {
  const base = 12 + i * 16;
  const tag = buffer.toString('ascii', base, base + 4);
  tables[tag] = { offset: readUint32(base + 8), length: readUint32(base + 12) };
}
if (!tables.cmap || !tables.glyf || !tables.head || !tables.loca || !tables.maxp) {
  throw new Error('字体缺少必要的表（cmap/glyf/head/loca/maxp）');
}

const head = tables.head.offset;
const unitsPerEm = readUint16(head + 18);
const indexToLocFormat = readInt16(head + 50);
const numGlyphs = readUint16(tables.maxp.offset + 4);
const numHMetrics = readUint16(tables.hhea.offset + 34);

// ------------------------------------------------------------ cmap：码点 → 字形

function buildCmap() {
  const base = tables.cmap.offset;
  const numSubtables = readUint16(base + 2);
  let best;
  for (let i = 0; i < numSubtables; i += 1) {
    const record = base + 4 + i * 8;
    const platformId = readUint16(record);
    const encodingId = readUint16(record + 2);
    const subtableOffset = readUint32(record + 4);
    const isUnicode = platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (isUnicode && best === undefined) {
      best = base + subtableOffset;
    }
  }
  if (best === undefined) {
    throw new Error('找不到 Unicode cmap 子表');
  }
  const format = readUint16(best);
  const map = new Map();
  if (format === 4) {
    const segCountX2 = readUint16(best + 6);
    const segCount = segCountX2 / 2;
    const endBase = best + 14;
    const startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2;
    const rangeBase = deltaBase + segCountX2;
    for (let s = 0; s < segCount; s += 1) {
      const end = readUint16(endBase + s * 2);
      const start = readUint16(startBase + s * 2);
      const delta = readInt16(deltaBase + s * 2);
      const rangeOffset = readUint16(rangeBase + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c += 1) {
        let glyph;
        if (rangeOffset === 0) {
          glyph = (c + delta) & 0xffff;
        } else {
          const index = rangeBase + s * 2 + rangeOffset + (c - start) * 2;
          if (index + 1 >= buffer.length) {
            continue;
          }
          glyph = readUint16(index);
          if (glyph !== 0) {
            glyph = (glyph + delta) & 0xffff;
          }
        }
        if (glyph !== 0) {
          map.set(c, glyph);
        }
      }
    }
  } else if (format === 12) {
    const nGroups = readUint32(best + 12);
    for (let g = 0; g < nGroups; g += 1) {
      const rec = best + 16 + g * 12;
      const start = readUint32(rec);
      const end = readUint32(rec + 4);
      const startGlyph = readUint32(rec + 8);
      for (let c = start; c <= end; c += 1) {
        map.set(c, startGlyph + (c - start));
      }
    }
  } else {
    throw new Error(`暂不支持的 cmap 格式：${format}`);
  }
  return map;
}

const cmap = buildCmap();

// ------------------------------------------------------------ loca / hmtx

const loca = new Uint32Array(numGlyphs + 1);
for (let i = 0; i <= numGlyphs; i += 1) {
  loca[i] =
    indexToLocFormat === 0
      ? readUint16(tables.loca.offset + i * 2) * 2
      : readUint32(tables.loca.offset + i * 4);
}

function advanceWidth(glyphId) {
  const base = tables.hmtx.offset;
  const index = Math.min(glyphId, numHMetrics - 1);
  return readUint16(base + index * 4);
}

// ------------------------------------------------------------ 字形轮廓 → SVG

/** 把 TTF 的二次贝塞尔轮廓转成 SVG path（缩放并翻转 y 轴，输出 16×16 坐标）。 */
function glyphToSvgPath(glyphId) {
  const glyfStart = tables.glyf.offset;
  const start = glyfStart + loca[glyphId];
  const end = glyfStart + loca[glyphId + 1];
  if (end <= start) {
    return undefined;
  }
  const numberOfContours = readInt16(start);
  if (numberOfContours < 0) {
    // 复合字形：这里只处理简单字形，遇到就报错而不是静默画错
    throw new Error(`字形 ${glyphId} 是复合字形，暂不支持`);
  }
  const xMin = readInt16(start + 2);
  const yMin = readInt16(start + 4);
  const xMax = readInt16(start + 6);
  const yMax = readInt16(start + 8);

  let cursor = start + 10;
  const endPts = [];
  for (let i = 0; i < numberOfContours; i += 1) {
    endPts.push(readUint16(cursor));
    cursor += 2;
  }
  const instructionLength = readUint16(cursor);
  cursor += 2 + instructionLength;

  const numPoints = numberOfContours === 0 ? 0 : endPts[endPts.length - 1] + 1;
  const flags = [];
  while (flags.length < numPoints) {
    const flag = buffer.readUInt8(cursor);
    cursor += 1;
    flags.push(flag);
    if (flag & 0x08) {
      const repeat = buffer.readUInt8(cursor);
      cursor += 1;
      for (let r = 0; r < repeat; r += 1) {
        flags.push(flag);
      }
    }
  }
  const xs = [];
  let x = 0;
  for (const flag of flags) {
    if (flag & 0x02) {
      const delta = buffer.readUInt8(cursor);
      cursor += 1;
      x += flag & 0x10 ? delta : -delta;
    } else if (!(flag & 0x10)) {
      x += readInt16(cursor);
      cursor += 2;
    }
    xs.push(x);
  }
  const ys = [];
  let y = 0;
  for (const flag of flags) {
    if (flag & 0x04) {
      const delta = buffer.readUInt8(cursor);
      cursor += 1;
      y += flag & 0x20 ? delta : -delta;
    } else if (!(flag & 0x20)) {
      y += readInt16(cursor);
      cursor += 2;
    }
    ys.push(y);
  }

  // 坐标变换：codicon 的字形是 16px 设计尺寸，单位通常是 1000/em（也可能是 2048）
  const scale = 16 / unitsPerEm;
  const tx = (value) => +(value * scale).toFixed(2);
  const ty = (value) => +((unitsPerEm - value) * scale).toFixed(2); // 翻转 y

  const parts = [];
  let contourStart = 0;
  for (const contourEnd of endPts) {
    const points = [];
    for (let i = contourStart; i <= contourEnd; i += 1) {
      points.push({ x: xs[i], y: ys[i], on: (flags[i] & 0x01) === 1 });
    }
    contourStart = contourEnd + 1;
    if (points.length === 0) {
      continue;
    }
    // 若首点不在曲线上，从末尾找一个在曲线上的点作为起点
    let list = points;
    if (!points[0].on) {
      const last = points[points.length - 1];
      if (last.on) {
        list = [last, ...points.slice(0, -1)];
      } else {
        list = [
          { x: (last.x + points[0].x) / 2, y: (last.y + points[0].y) / 2, on: true },
          ...points,
        ];
      }
    }
    parts.push(`M ${tx(list[0].x)} ${ty(list[0].y)}`);
    for (let i = 1; i <= list.length; i += 1) {
      const current = list[i % list.length];
      const previous = list[(i - 1) % list.length];
      if (current.on) {
        parts.push(`L ${tx(current.x)} ${ty(current.y)}`);
      } else {
        const next = list[(i + 1) % list.length];
        const controlX = current.x;
        const controlY = current.y;
        const endX = next.on ? next.x : (current.x + next.x) / 2;
        const endY = next.on ? next.y : (current.y + next.y) / 2;
        parts.push(`Q ${tx(controlX)} ${ty(controlY)} ${tx(endX)} ${ty(endY)}`);
        if (!next.on) {
          i += 1; // 已消费掉下一个点作为终点
        }
      }
      if (i % list.length === 0) {
        break;
      }
    }
    parts.push('Z');
  }
  return { path: parts.join(' ').replace(/\s+/g, ' '), xMin, yMin, xMax, yMax };
}

// ------------------------------------------------------------ 生成

const entries = [];
for (const name of Object.keys(NEEDED)) {
  const code = CODEPOINTS[name];
  if (code === undefined) {
    throw new Error(`${name} 缺少码点登记（请补 CODEPOINTS）`);
  }
  const glyphId = cmap.get(code);
  if (!glyphId) {
    throw new Error(`${name} (U+${code.toString(16)}) 在字体里找不到字形`);
  }
  const result = glyphToSvgPath(glyphId);
  if (!result) {
    throw new Error(`${name} 的字形是空的`);
  }
  entries.push({
    kind: name,
    name,
    code,
    path: result.path,
    advance: advanceWidth(glyphId),
    bbox: `${result.xMin},${result.yMin},${result.xMax},${result.yMax}`,
  });
}

console.log(`unitsPerEm=${unitsPerEm} numGlyphs=${numGlyphs}`);
for (const entry of entries) {
  console.log(
    `${entry.kind.padEnd(12)} ${entry.name.padEnd(22)} U+${entry.code
      .toString(16)
      .toUpperCase()} advance=${entry.advance} bbox=${entry.bbox} pathLen=${entry.path.length}`
  );
}

const out = `/**
 * VS Code 符号图标的真实轮廓（自动生成，请勿手改；改请改 scripts/genSymbolIcons.js）。
 *
 * 来源：VS Code 自带的 codicon.ttf，由 scripts/genSymbolIcons.js 解析 glyf 表得到。
 * 这些路径就是大纲（Outline）与文件标签里显示的符号图标形状，
 * 因此渲染出来与 VS Code 一致（颜色由主题的 --vscode-symbolIcon-* 决定）。
 *
 * 坐标系统一为 16×16（codicon 的设计尺寸），y 轴已翻转为 SVG 方向。
 * 单条 path + fill-rule="nonzero" 即可正确渲染（字形自带正确的绕向）。
 *
 * ---------------------------------------------------------------------------
 * 许可说明（重要）
 *
 * 下面这些 path 数据**派生自** @vscode/codicons 的图标字形：
 *   Copyright (c) Microsoft Corporation
 *   许可：Creative Commons Attribution 4.0 International (CC BY 4.0)
 *   https://creativecommons.org/licenses/by/4.0/
 *
 * 本项目对原始素材做了修改：从字体的 glyf 表提取轮廓、转换为 SVG path、
 * y 轴翻转并缩放到 16×16、且只取其中 21 个字形。
 *
 * 因此**这部分数据不适用本项目的 MIT 许可**，完整署名与免责声明见仓库根目录的
 * THIRD-PARTY-NOTICES.txt（该文件随扩展一起分发）。
 * ---------------------------------------------------------------------------
 */
export interface SymbolIcon {
  /** SVG path，坐标范围 0..16。 */
  path: string;
  /** codicon 名称，便于对照与排查。 */
  codicon: string;
}

/**
 * NodeKind → codicon 名称。
 * 多个类型共用同一个图标，这与 VS Code 一致：由「符号种类」决定图标。
 * 与 graphTypes.ts 的 NodeKind 一一对应；新增类型时必须在这里补上。
 */
export const KIND_TO_ICON: Record<string, string> = {
${Object.entries(KIND_TO_CODICON)
  .map(([kind, name]) => `  ${kind}: '${name}',`)
  .join('\n')}
};

/** codicon 名 → 路径。键名与 VS Code 的 \`.codicon-<name>\` 类名一致。 */
export const ICON_BY_CODICON: Record<string, SymbolIcon> = {
${entries
  .map((entry) => `  '${entry.name}': {\n    path: '${entry.path}',\n    codicon: '${entry.name}',\n  },`)
  .join('\n')}
};
`;

const target = path.join(__dirname, '..', 'src', 'webview', 'symbolIcons.ts');

if (process.argv.includes('--verify')) {
  // 校验模式：不写文件，只比对生成结果与磁盘内容是否一致，
  // 用来防止「改了生成器却没重新生成」或「手改了生成文件」。
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (current !== out) {
    console.error('校验失败：src/webview/symbolIcons.ts 与 codicon.ttf 提取结果不一致。');
    console.error('请运行：node scripts/genSymbolIcons.js');
    process.exit(1);
  }
  console.log(`校验通过：symbolIcons.ts 与字体提取结果一致（${entries.length} 个图标）`);
  process.exit(0);
}

fs.writeFileSync(target, out, 'utf8');
console.log(`\n已生成 ${target}（${entries.length} 个图标）`);
