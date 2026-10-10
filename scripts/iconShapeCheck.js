/**
 * 图标形状校验：把生成的 SVG 路径栅格化，检查它们确实是「空心轮廓」而不是实心块。
 *
 * 做法：SVG 的 nonzero 填充规则 = 环绕数不为 0；
 * 对每个采样点统计与路径各条边的上下交叉，按方向累加环绕数。
 * 轮廓图标的覆盖率通常 15%~45%，实心块会 >65%。
 *
 * 运行：node scripts/iconShapeCheck.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'symbolIcons.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

/** 把 path 解析成子路径数组（只处理 M/L/Q/Z，正好是本生成器输出的指令集）。 */
function parsePath(d) {
  const tokens = d.match(/[MLQZ]|-?\d*\.?\d+/g) ?? [];
  const contours = [];
  let current = null;
  let cursor = { x: 0, y: 0 };
  let index = 0;
  const nextNumber = () => Number(tokens[index++]);
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token === 'M') {
      current = [];
      contours.push(current);
      cursor = { x: nextNumber(), y: nextNumber() };
      current.push({ ...cursor });
    } else if (token === 'L') {
      cursor = { x: nextNumber(), y: nextNumber() };
      current.push({ ...cursor });
    } else if (token === 'Q') {
      const control = { x: nextNumber(), y: nextNumber() };
      const end = { x: nextNumber(), y: nextNumber() };
      // 用 8 段折线近似二次贝塞尔
      const steps = 8;
      for (let s = 1; s <= steps; s += 1) {
        const t = s / steps;
        const mt = 1 - t;
        current.push({
          x: mt * mt * cursor.x + 2 * mt * t * control.x + t * t * end.x,
          y: mt * mt * cursor.y + 2 * mt * t * control.y + t * t * end.y,
        });
      }
      cursor = end;
    } else if (token === 'Z') {
      // 闭合由栅格化时处理（按首尾相连）
    } else {
      throw new Error(`未预期的 path 指令：${token}`);
    }
  }
  return contours.filter((contour) => contour.length >= 3);
}

/** 计算 nonzero 填充下，路径覆盖采样点的比例。 */
function coverage(contours, samples = 96) {
  let inside = 0;
  let total = 0;
  for (let iy = 0; iy < samples; iy += 1) {
    const y = ((iy + 0.5) / samples) * 16;
    for (let ix = 0; ix < samples; ix += 1) {
      const x = ((ix + 0.5) / samples) * 16;
      let winding = 0;
      for (const contour of contours) {
        for (let i = 0; i < contour.length; i += 1) {
          const a = contour[i];
          const b = contour[(i + 1) % contour.length];
          if (a.y <= y) {
            if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) {
              winding += 1;
            }
          } else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) {
            winding -= 1;
          }
        }
      }
      total += 1;
      if (winding !== 0) {
        inside += 1;
      }
    }
  }
  return inside / total;
}

const re = /'([^']+)':\s*\{\s*path:\s*'([^']+)',\s*codicon:\s*'([^']+)',/g;
const results = [];
let match;
while ((match = re.exec(source)) !== null) {
  const [, codicon, d, declared] = match;
  const contours = parsePath(d);
  const ratio = coverage(contours);
  results.push({ codicon: declared || codicon, contours: contours.length, ratio });
}

if (results.length === 0) {
  throw new Error('没从 symbolIcons.ts 解析出任何图标（检查 ICON_BY_CODICON 的结构）');
}

console.log('图标形状覆盖率（空心轮廓应明显低于实心块）：');
for (const item of results) {
  console.log(
    `  ${item.codicon.padEnd(22)} 子路径=${String(item.contours).padStart(2)} 覆盖率=${(item.ratio * 100).toFixed(1)}%`
  );
}

// 等值断言（不是下限）：合规声明里写死了 21 条符号图标轮廓，
// 少解析出几个也必须失败，否则署名数量与实际不符。
assert(results.length === 21, `符号图标数量应为 21（与署名声明一致），实际 ${results.length}`);

// 关键断言：这些必须是空心轮廓，不能是实心块
for (const item of results) {
  assert(
    item.ratio > 0.05,
    `${item.codicon} 覆盖率只有 ${(item.ratio * 100).toFixed(1)}%，几乎是空白`
  );
  assert(
    item.ratio < 0.6,
    `${item.codicon} 覆盖率 ${(item.ratio * 100).toFixed(1)}%，看起来是实心块而不是轮廓`
  );
}

// 函数图标必须有「外框 + 内部凹槽」多个子路径，说明是轮廓而非实心
const fn = results.find((item) => item.codicon === 'symbol-method');
assert(fn !== undefined, '没有函数图标（symbol-method）');
assert(
  fn.contours >= 2,
  `函数图标应有外轮廓 + 内部形状（≥2 个子路径），实际 ${fn.contours}`
);

// 枚举图标必须是方括号样式（子路径多，且覆盖率偏低）
const en = results.find((item) => item.codicon === 'symbol-enum');
assert(en !== undefined, '没有枚举图标（symbol-enum）');
assert(en.ratio < 0.4, `枚举图标覆盖率 ${(en.ratio * 100).toFixed(1)}%，不像轮廓方括号`);

const solidLike = results.filter((item) => item.ratio > 0.6).length;
assert(solidLike === 0, `有 ${solidLike} 个图标像实心块`);

console.log(
  `\nOK: ${results.length} 个符号图标都是空心轮廓（覆盖率 5%~60%），与 VS Code 大纲图标一致`
);
