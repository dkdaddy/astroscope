/**
 * Extracts 2x2 Bayer RGGB super-pixel green-weighted luminance (R + G1 + G2 + B) / 4
 * so the Bayer CFA pattern does not introduce artificial pixel-to-pixel checkerboard variance.
 */
export function extractBayerSuperpixelLuminance(
  rawBayer: Uint8Array,
  width: number,
  height: number
): { luma: Float32Array; lumaWidth: number; lumaHeight: number } {
  const lumaWidth = Math.floor(width / 2);
  const lumaHeight = Math.floor(height / 2);
  const luma = new Float32Array(lumaWidth * lumaHeight);

  for (let sy = 0; sy < lumaHeight; sy++) {
    const r0 = sy * 2 * width;
    const r1 = (sy * 2 + 1) * width;
    const outRow = sy * lumaWidth;
    for (let sx = 0; sx < lumaWidth; sx++) {
      const c0 = sx * 2;
      const r = rawBayer[r0 + c0];
      const g1 = rawBayer[r0 + c0 + 1];
      const g2 = rawBayer[r1 + c0];
      const b = rawBayer[r1 + c0 + 1];
      luma[outRow + sx] = 0.25 * (r + g1 + g2 + b);
    }
  }

  return { luma, lumaWidth, lumaHeight };
}

/**
 * Evaluates the 3x3 Laplacian variance over a grayscale/luminance buffer.
 * High focus = steep optical gradients = high variance.
 */
export function computeLaplacianScore(
  grayPixels: Uint8Array | Uint8ClampedArray | Float32Array,
  roiWidth: number,
  roiHeight: number
): number {
  if (roiWidth < 3 || roiHeight < 3) return 0;

  let sum = 0;
  let sumSq = 0;
  const count = (roiWidth - 2) * (roiHeight - 2);

  for (let y = 1; y < roiHeight - 1; y++) {
    const rowOffset = y * roiWidth;
    const prevRow = (y - 1) * roiWidth;
    const nextRow = (y + 1) * roiWidth;

    for (let x = 1; x < roiWidth - 1; x++) {
      // 3x3 Laplacian operator: [ 0, 1, 0 ], [ 1, -4, 1 ], [ 0, 1, 0 ]
      const lap =
        grayPixels[prevRow + x] +
        grayPixels[rowOffset + (x - 1)] -
        4 * grayPixels[rowOffset + x] +
        grayPixels[rowOffset + (x + 1)] +
        grayPixels[nextRow + x];

      sum += lap;
      sumSq += lap * lap;
    }
  }

  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return Math.max(0, variance);
}

/**
 * End-to-end Bayer RGGB Focus Score helper.
 */
export function computeBayerFocusScore(
  rawBayer: Uint8Array,
  width: number,
  height: number
): number {
  const { luma, lumaWidth, lumaHeight } = extractBayerSuperpixelLuminance(
    rawBayer,
    width,
    height
  );
  return computeLaplacianScore(luma, lumaWidth, lumaHeight);
}
