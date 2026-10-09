/**
 * 标签上的方向图标：VS Code 自带的 call-incoming / call-outgoing。
 *
 * 路径由 codicon.ttf 提取（`scripts` 里的提取脚本，码点来自 VS Code 的
 * `codicon.css`：\eb92 = call-incoming，\eb93 = call-outgoing）。
 * 用内联 SVG 而不是图标字体：webview 是否注入 codicon 样式无法保证，
 * 内联 SVG 零依赖、不受 CSP 影响。
 *
 * ---------------------------------------------------------------------------
 * 许可说明（重要）
 *
 * 下面两个 path 数据**派生自** @vscode/codicons 的图标字形：
 *   Copyright (c) Microsoft Corporation
 *   许可：Creative Commons Attribution 4.0 International (CC BY 4.0)
 *   https://creativecommons.org/licenses/by/4.0/
 *
 * 本项目做了修改：从字体 glyf 表提取轮廓、转为 SVG path、y 轴翻转并缩放到 16×16。
 * 因此**这部分数据不适用本项目的 MIT 许可**，完整署名与免责声明见仓库根目录的
 * THIRD-PARTY-NOTICES.txt（该文件随扩展一起分发）。
 * ---------------------------------------------------------------------------
 *
 * 语义：
 *   callers（被调用关系）→ 箭头**进来**：谁调用了它
 *   callees（调用关系）  → 箭头**出去**：它调用了谁
 */
export type CallDirectionLike = 'callers' | 'callees';

/** 仅用于新加的行内图标。 */
const CALL_INCOMING_PATH =
  'M13.87 2.13 Q14.03 2.29 14.03 2.51 L13.87 2.88 L10.72 6.03 L12.48 6.03 Q12.69 6.03 12.85 6.16 Q13.01 6.72 12.85 6.85 L12.48 6.99 L9.49 6.99 Q9.28 6.99 9.15 6.85 L9.01 6.51 L9.01 3.52 Q9.01 3.31 9.15 3.15 Q9.71 2.99 9.84 3.15 L10.03 3.52 L10.03 5.28 L13.12 2.13 Q13.28 2.03 13.49 2.03 L13.87 2.13 Z M4.37 2.13 Q5.01 1.87 5.65 2.13 L6.56 2.99 L7.15 4.21 Q7.36 4.64 7.31 5.07 L6.99 5.81 L6.03 6.99 L6.08 7.25 Q6.24 7.79 6.51 8.27 L7.2 9.12 L7.36 9.28 L8.85 9.01 Q9.23 8.96 9.6 9.07 L10.24 9.44 L11.04 10.29 Q11.52 10.83 11.52 11.55 L10.99 12.8 L10.67 13.07 Q9.81 13.87 8.64 13.97 L6.56 13.33 Q4.69 11.79 3.63 10.08 L3.63 10.08 Q2.45 8.27 2.03 5.55 L2.03 5.55 Q1.87 4.48 2.45 3.55 L4.11 2.24 L4.37 2.13 Z M7.25 9.81 Q7.09 10.03 6.93 10.24 L6.93 10.24 L6.51 9.87 Q5.97 9.33 5.63 8.77 L5.12 7.52 L5.01 6.93 L5.49 6.83 L5.01 6.88 Q4.96 6.67 5.12 6.51 L5.12 6.51 L6.19 5.17 Q6.4 4.96 6.24 4.64 L6.24 4.64 L5.65 3.41 Q5.55 3.15 5.28 3.04 L4.75 3.04 L4.48 3.15 Q3.73 3.41 3.33 4.05 L3.04 5.39 Q3.41 7.95 4.43 9.52 L7.2 12.53 Q7.79 13.07 8.59 12.99 L9.97 12.32 L10.29 12.05 Q10.51 11.84 10.51 11.52 L10.29 10.99 L9.49 10.13 Q9.33 9.97 9.07 10.03 L9.07 10.03 L7.31 10.35 Q7.09 10.35 6.93 10.24 L6.93 10.24 L7.25 9.81 Z';

const CALL_OUTGOING_PATH =
  'M10.03 2.51 Q10.03 2.29 10.16 2.13 L10.51 1.97 L13.49 1.97 Q13.71 1.97 13.87 2.13 L14.03 2.51 L14.03 5.49 Q14.03 5.71 13.87 5.84 Q13.28 6.03 13.15 5.87 L13.01 5.49 L13.01 3.73 L9.87 6.88 Q9.71 6.99 9.49 6.99 Q9.01 6.72 9.01 6.51 L9.12 6.13 L12.27 2.99 L10.51 2.99 Q10.29 2.99 10.16 2.85 L10.03 2.51 Z M4.37 2.13 Q5.01 1.87 5.65 2.13 L6.56 2.99 L7.15 4.21 Q7.36 4.64 7.31 5.07 L6.99 5.81 L6.03 6.99 L6.08 7.25 Q6.24 7.79 6.51 8.27 L7.2 9.12 L7.36 9.28 L8.85 9.01 Q9.23 8.96 9.6 9.07 L10.24 9.44 L11.04 10.29 Q11.52 10.83 11.52 11.55 L10.99 12.8 L10.67 13.07 Q9.81 13.87 8.64 13.97 L6.56 13.33 Q4.69 11.79 3.63 10.08 L3.63 10.08 Q2.45 8.27 2.03 5.55 L2.03 5.55 Q1.87 4.48 2.45 3.55 L4.11 2.24 L4.37 2.13 Z M7.25 9.81 Q6.93 10.24 6.93 10.24 L6.93 10.24 L6.51 9.87 Q5.97 9.33 5.63 8.77 L5.12 7.52 L5.01 6.93 L5.49 6.83 L5.01 6.88 Q4.96 6.67 5.12 6.51 L5.12 6.51 L6.19 5.17 Q6.4 4.96 6.24 4.64 L6.24 4.64 L5.65 3.41 Q5.55 3.15 5.28 3.04 L4.75 3.04 L4.48 3.15 Q3.73 3.41 3.33 4.05 L3.04 5.39 Q3.41 7.95 4.43 9.52 L7.2 12.53 Q7.79 13.07 8.59 12.99 L9.97 12.32 L10.29 12.05 Q10.51 11.84 10.51 11.52 L10.29 10.99 L9.49 10.13 Q9.33 9.97 9.07 10.03 L9.07 10.03 L7.31 10.35 Q7.09 10.35 6.93 10.24 L6.93 10.24 L7.25 9.81 Z';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 方向对应的 codicon 名称（也用于断言与排查）。 */
export function directionCodicon(direction: CallDirectionLike): string {
  return direction === 'callers' ? 'call-incoming' : 'call-outgoing';
}

/** 方向对应的悬停文案。 */
export function directionTitle(direction: CallDirectionLike): string {
  return direction === 'callers' ? '被调用关系（谁调用了它）' : '调用关系（它调用了谁）';
}

/**
 * 造一个方向图标（16×16 的 SVG，尺寸与颜色由 CSS 控制）。
 * 调用方负责放进标签里。
 */
export function createDirectionIcon(direction: CallDirectionLike): SVGSVGElement {
  const ns = SVG_NS;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `tab-direction ${direction}`);
  svg.setAttribute('data-codicon', directionCodicon(direction));
  const path = document.createElementNS(ns, 'path');
  path.setAttribute(
    'd',
    direction === 'callers' ? CALL_INCOMING_PATH : CALL_OUTGOING_PATH
  );
  svg.appendChild(path);
  return svg;
}
