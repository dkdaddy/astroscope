import type { FocusROI, RoiTrackingStatus } from '../../common/protocol.js';

/** Sensor pixels per detection block side (even, so blocks stay aligned to the RGGB pattern). */
const BLOCK = 16;
/** Super-pixel sampling stride inside a block (multiple of 2 keeps RGGB alignment). */
const SAMPLE_STRIDE = 4;
/** Peak must exceed background by at least this many 8-bit levels... */
const MIN_CONTRAST = 12;
/** ...and by this many background noise sigmas. */
const MIN_SNR = 8;
/** If the bright region covers more of the frame than this, the "black background" assumption fails. */
const MAX_AREA_FRACTION = 0.4;

export const DEFAULT_TRACKING_TOLERANCE_PX = 32;

export interface BrightObjectDetection {
  /** Intensity-weighted centroid in sensor pixels */
  x: number;
  y: number;
  /** 8-bit scaled block levels */
  peak: number;
  background: number;
  noise: number;
  /** Number of blocks in the detected object */
  areaBlocks: number;
  confident: boolean;
}

/**
 * Finds the brightest extended object on a mostly black background in a Bayer RGGB frame.
 * The frame is reduced to BLOCKxBLOCK mean-luminance blocks (sparse super-pixel sampling),
 * the brightest 3x3-smoothed block seeds a flood fill of blocks above half the peak contrast,
 * and the intensity-weighted centroid of that region is returned. Block averaging + smoothing
 * keeps hot pixels and noise from winning over a real planet/Moon.
 */
export function detectBrightObject(
  frame: Buffer | Uint8Array,
  width: number,
  height: number,
  is16Bit = false
): BrightObjectDetection | null {
  const bw = Math.floor(width / BLOCK);
  const bh = Math.floor(height / BLOCK);
  if (bw < 3 || bh < 3) return null;

  const view = is16Bit ? new DataView(frame.buffer, frame.byteOffset, frame.byteLength) : null;
  const blocks = new Float32Array(bw * bh);

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      let n = 0;
      for (let sy = 0; sy < BLOCK; sy += SAMPLE_STRIDE) {
        const r0 = (by * BLOCK + sy) * width + bx * BLOCK;
        const r1 = r0 + width;
        for (let sx = 0; sx < BLOCK; sx += SAMPLE_STRIDE) {
          if (view) {
            sum +=
              view.getUint16((r0 + sx) * 2, true) +
              view.getUint16((r0 + sx + 1) * 2, true) +
              view.getUint16((r1 + sx) * 2, true) +
              view.getUint16((r1 + sx + 1) * 2, true);
          } else {
            sum += frame[r0 + sx] + frame[r0 + sx + 1] + frame[r1 + sx] + frame[r1 + sx + 1];
          }
          n += 4;
        }
      }
      blocks[by * bw + bx] = view ? sum / n / 256 : sum / n;
    }
  }

  // Background = median block level, noise = robust sigma (MAD)
  const sorted = Float32Array.from(blocks).sort();
  const background = sorted[sorted.length >> 1];
  const deviations = new Float32Array(blocks.length);
  for (let i = 0; i < blocks.length; i++) deviations[i] = Math.abs(blocks[i] - background);
  deviations.sort();
  const noise = Math.max(0.5, 1.4826 * deviations[deviations.length >> 1]);

  // Peak search on 3x3 box-smoothed blocks so a single hot block can't win
  let peakIdx = -1;
  let peakSmooth = -Infinity;
  for (let by = 1; by < bh - 1; by++) {
    for (let bx = 1; bx < bw - 1; bx++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (by + dy) * bw + bx;
        s += blocks[row - 1] + blocks[row] + blocks[row + 1];
      }
      if (s > peakSmooth) {
        peakSmooth = s;
        peakIdx = by * bw + bx;
      }
    }
  }
  if (peakIdx < 0) return null;

  // Seed from the brightest raw block within the winning 3x3 neighbourhood
  const pbx = peakIdx % bw;
  const pby = (peakIdx - pbx) / bw;
  let seed = peakIdx;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const i = (pby + dy) * bw + pbx + dx;
      if (blocks[i] > blocks[seed]) seed = i;
    }
  }
  const peak = blocks[seed];
  const contrast = peak - background;
  const threshold = background + 0.5 * contrast;

  // 8-connected flood fill of the object around the seed; weighted centroid
  const visited = new Uint8Array(bw * bh);
  const stack = [seed];
  visited[seed] = 1;
  let wSum = 0;
  let xSum = 0;
  let ySum = 0;
  let area = 0;
  while (stack.length) {
    const i = stack.pop()!;
    const bx = i % bw;
    const by = (i - bx) / bw;
    const w = blocks[i] - background;
    wSum += w;
    xSum += w * (bx + 0.5);
    ySum += w * (by + 0.5);
    area++;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = by + dy;
      if (ny < 0 || ny >= bh) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx;
        if (nx < 0 || nx >= bw) continue;
        const ni = ny * bw + nx;
        if (!visited[ni] && blocks[ni] >= threshold) {
          visited[ni] = 1;
          stack.push(ni);
        }
      }
    }
  }
  if (wSum <= 0) return null;

  const confident =
    contrast >= MIN_CONTRAST &&
    contrast >= MIN_SNR * noise &&
    area / (bw * bh) <= MAX_AREA_FRACTION;

  return {
    x: (xSum / wSum) * BLOCK,
    y: (ySum / wSum) * BLOCK,
    peak,
    background,
    noise,
    areaBlocks: area,
    confident
  };
}

/**
 * Keeps the focus ROI centred on the brightest object. The ROI only moves when the detection
 * is confident, the object is off-centre by more than `tolerancePx`, and two consecutive
 * detections agree, so noise, passing clouds or a hot pixel can't make it jump around.
 */
export class RoiTracker {
  enabled = false;
  tolerancePx = DEFAULT_TRACKING_TOLERANCE_PX;
  status: RoiTrackingStatus = 'off';
  /** Minimum time between detections; tracking at a few Hz is plenty and keeps CPU low. */
  intervalMs = 200;
  requiredHits = 2;

  private lastRunMs = 0;
  private pending: { x: number; y: number; hits: number } | null = null;

  configure(opts: { enabled?: boolean; tolerancePx?: number }): void {
    if (typeof opts.enabled === 'boolean') {
      this.enabled = opts.enabled;
      this.status = opts.enabled ? 'searching' : 'off';
      this.reset();
    }
    if (typeof opts.tolerancePx === 'number' && Number.isFinite(opts.tolerancePx)) {
      this.tolerancePx = Math.max(4, Math.min(1000, Math.round(opts.tolerancePx)));
    }
  }

  reset(): void {
    this.pending = null;
    this.lastRunMs = 0;
  }

  /** Returns a new ROI when it should move, otherwise null. */
  update(
    frame: Buffer | Uint8Array,
    width: number,
    height: number,
    is16Bit: boolean,
    roi: FocusROI,
    nowMs: number
  ): FocusROI | null {
    if (!this.enabled) return null;
    if (nowMs - this.lastRunMs < this.intervalMs) return null;
    this.lastRunMs = nowMs;

    const det = detectBrightObject(frame, width, height, is16Bit);
    if (!det || !det.confident) {
      this.status = 'searching';
      this.pending = null;
      return null;
    }

    const dx = det.x - (roi.x + roi.width / 2);
    const dy = det.y - (roi.y + roi.height / 2);
    if (Math.abs(dx) <= this.tolerancePx && Math.abs(dy) <= this.tolerancePx) {
      this.status = 'tracking';
      this.pending = null;
      return null;
    }

    const agreeRadius = Math.max(this.tolerancePx, 2 * BLOCK);
    if (this.pending && Math.hypot(det.x - this.pending.x, det.y - this.pending.y) <= agreeRadius) {
      this.pending = { x: det.x, y: det.y, hits: this.pending.hits + 1 };
    } else {
      this.pending = { x: det.x, y: det.y, hits: 1 };
    }
    if (this.pending.hits < this.requiredHits) return null;

    this.pending = null;
    this.status = 'tracking';
    const x = Math.max(0, Math.min(width - roi.width, Math.floor((det.x - roi.width / 2) / 2) * 2));
    const y = Math.max(0, Math.min(height - roi.height, Math.floor((det.y - roi.height / 2) / 2) * 2));
    if (x === roi.x && y === roi.y) return null;
    return { ...roi, x, y };
  }
}
