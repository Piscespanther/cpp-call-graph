/**
 * 导出正文的**传输分块**与 **PNG 分辨率选择**（用户 2026-10-17 要求）。
 *
 * 为什么单独一个模块：这两件事各有两侧 —— 分块在面板侧切、在宿主侧拼；分辨率在面板侧算、
 * 但判定规则必须能被断言。放在一处纯函数里，两侧就不可能各写一份而慢慢分叉，
 * 而且不依赖 `vscode`，宿主/面板/测试脚本都能直接用。
 */

/**
 * 把一段长文本切成固定大小的块（按 UTF-16 码元计）。
 *
 * 为什么需要：超大关系图序列化后有几十 MB，塞进**一条** `postMessage` 会让结构化克隆
 * 长时间占住主线程，表现为「点了导出没反应」；分成若干条后每条都在可处理的量级内。
 *
 * ⚠️ 切分点可能落在代理对中间（一个字符由两个码元组成）。这不影响结果：分块只经由结构化克隆
 * 传递、在宿主侧原样拼回，从不单独做编码/解码（宿主是在 `join('')` 之后才转 UTF-8 字节的）。
 *
 * @param size 每块的字符数（下限 1；非有限值按 1 处理，避免死循环）。
 */
export function chunkText(text: string, size: number): string[] {
  const limit =
    Number.isFinite(size) && size >= 1 ? Math.max(1, Math.floor(size)) : 1;
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += limit) {
    chunks.push(text.slice(start, start + limit));
  }
  return chunks;
}

/** PNG 分辨率的选择结果。 */
export interface PngScaleChoice {
  /** 实际采用的倍数。 */
  readonly scale: number;
  /** 该倍数下的画布尺寸（像素，至少 1）。 */
  readonly width: number;
  readonly height: number;
  /** 是否比首选倍数低（低过才需要在输出通道里留一条说明，免得用户以为分辨率本来就这样）。 */
  readonly downgraded: boolean;
  /** 连最低倍数都放不下：只能报错并指向矢量导出。 */
  readonly tooLarge: boolean;
}

/**
 * 选一个能画出来的 PNG 分辨率。
 *
 * 规则（用户口径：超面积时**先自动降倍率再试**，仍超限才报错）：
 *   ① 首选倍数放得下 → 用它；
 *   ② 放不下 → 退到 1 倍，放得下就用 1 倍并记 `downgraded`；
 *   ③ 1 倍也放不下 → `tooLarge`（面板据此报错，并给出实际像素尺寸与「改用 SVG」的出路）。
 *
 * 为什么不直接失败：2 倍分辨率只是「更清晰」的偏好，图本身仍然是能画的 ——
 * 直接拒绝会让用户在完全可导出的图上看到失败。
 */
export function choosePngScale(
  width: number,
  height: number,
  options: { preferred: number; maxArea: number }
): PngScaleChoice {
  const sized = (scale: number): { width: number; height: number } => ({
    width: Math.max(1, Math.round(Math.max(0, width) * scale)),
    height: Math.max(1, Math.round(Math.max(0, height) * scale)),
  });
  const preferred = Number.isFinite(options.preferred) && options.preferred > 0 ? options.preferred : 1;
  // 候选从高到低、去重：首选倍数与 1 倍（首选本身就 ≤ 1 时不重复）
  const candidates = preferred > 1 ? [preferred, 1] : [preferred];
  for (const scale of candidates) {
    const size = sized(scale);
    if (size.width * size.height <= options.maxArea) {
      return {
        scale,
        width: size.width,
        height: size.height,
        downgraded: scale !== preferred,
        tooLarge: false,
      };
    }
  }
  const smallest = sized(Math.min(...candidates));
  return {
    scale: Math.min(...candidates),
    width: smallest.width,
    height: smallest.height,
    downgraded: false,
    tooLarge: true,
  };
}
