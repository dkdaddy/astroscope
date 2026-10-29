import type { LiveStackMode } from '../../common/protocol.js';

/**
 * Rolling-window live stack over raw 8-bit Bayer frames, with two modes:
 *
 * - `lucky` (planets, Moon): frames are sampled at most every `windowMs / maxSlots` ms,
 *   aligned to a reference frame by matching a high-contrast luma patch, and only the
 *   sharpest `keepPercent` of the frames in the window (ranked by the caller-supplied
 *   quality score) are averaged.
 * - `dso` (deep sky): every frame (at most one per DSO_MIN_INTERVAL_MS) is aligned to the
 *   reference by star matching (translation + rotation). Frames with too few matched stars
 *   (clouds, trailing, bumps) are rejected. Accepted frames are summed into time blocks so
 *   long windows don't need one buffer per frame.
 *
 * Alignment works on 2x2 RGGB super-pixels and moves whole super-pixels (nearest neighbour),
 * which preserves the Bayer pattern. A running per-pixel sum of the selected slots keeps each
 * update to a few full-frame passes; memory is bounded by `memoryBudgetBytes`.
 */

export interface LiveStackOptions {
  mode: LiveStackMode;
  windowMs: number;
  keepPercent: number;
}

export const DEFAULT_STACK_WINDOW_SEC: Record<LiveStackMode, number> = { lucky: 3, dso: 60 };

const MIN_WINDOW_MS = 500;
const MAX_WINDOW_MS = 3_600_000;
const DSO_MIN_INTERVAL_MS = 100;
const DSO_MAX_FRAMES_PER_BLOCK = 257; // 257 * 255 still fits a Uint16 block sum
const DSO_MAX_ALIGN_FAILURES = 5; // consecutive failures before re-referencing (e.g. after a slew)
const LUCKY_SEARCH_RADIUS = 32; // super-pixels, multiple of 4

/** Maps reference super-pixel coords to coords in the new frame: p' = R(theta) * p + t. */
interface Transform {
  cos: number;
  sin: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { cos: 1, sin: 0, tx: 0, ty: 0 };

export interface Star {
  x: number;
  y: number;
  peak: number;
}

interface PatchRef {
  px: number;
  py: number;
  size: number;
  patch: Uint16Array;
  coarse: Uint16Array;
  ox: number;
  oy: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function isIdentity(t: Transform): boolean {
  return t.cos === 1 && t.sin === 0 && Math.round(t.tx) === 0 && Math.round(t.ty) === 0;
}

/** Sums each 2x2 RGGB super-pixel (0..1020) in a super-pixel rectangle; coords outside are clamped. */
function superPixelLuma(
  bayer: Uint8Array,
  width: number,
  height: number,
  sx0: number,
  sy0: number,
  sw: number,
  sh: number
): Uint16Array {
  const lw = width >> 1;
  const lh = height >> 1;
  const out = new Uint16Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const r0 = clamp(sy0 + y, 0, lh - 1) * 2 * width;
    const r1 = r0 + width;
    const o = y * sw;
    for (let x = 0; x < sw; x++) {
      const c = clamp(sx0 + x, 0, lw - 1) * 2;
      out[o + x] = bayer[r0 + c] + bayer[r0 + c + 1] + bayer[r1 + c] + bayer[r1 + c + 1];
    }
  }
  return out;
}

/** 4x4 box-sum downsample (w and h must be multiples of 4). */
function box4(src: Uint16Array, w: number, h: number): Uint16Array {
  const ow = w >> 2;
  const oh = h >> 2;
  const out = new Uint16Array(ow * oh);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const orow = (y >> 2) * ow;
    for (let x = 0; x < w; x++) out[orow + (x >> 2)] += src[row + x];
  }
  return out;
}

/** Sum of absolute differences of an n x n patch against `b` at (bx, by); stops early past `limit`. */
function sad(a: Uint16Array, n: number, b: Uint16Array, bw: number, bx: number, by: number, limit: number): number {
  let s = 0;
  for (let y = 0; y < n; y++) {
    const ar = y * n;
    const br = (by + y) * bw + bx;
    for (let x = 0; x < n; x++) s += Math.abs(a[ar + x] - b[br + x]);
    if (s >= limit) return s;
  }
  return s;
}

/** Picks the highest-contrast square patch of the reference luma for lucky-mode alignment. */
function createPatchRef(luma: Uint16Array, lw: number, lh: number): PatchRef {
  const size = Math.max(8, Math.min(128, Math.floor(Math.min(lw, lh) / 12) * 4));
  const mx = Math.max(0, Math.min(LUCKY_SEARCH_RADIUS, Math.floor((lw - size) / 2)));
  const my = Math.max(0, Math.min(LUCKY_SEARCH_RADIUS, Math.floor((lh - size) / 2)));
  const step = Math.max(4, size >> 1);
  let best = -1;
  let px = mx;
  let py = my;
  for (let y = my; y <= lh - size - my; y += step) {
    for (let x = mx; x <= lw - size - mx; x += step) {
      let e = 0;
      for (let yy = y; yy < y + size - 1; yy += 2) {
        const row = yy * lw;
        for (let xx = x; xx < x + size - 1; xx += 2) {
          const i = row + xx;
          e += Math.abs(luma[i + 1] - luma[i]) + Math.abs(luma[i + lw] - luma[i]);
        }
      }
      if (e > best) {
        best = e;
        px = x;
        py = y;
      }
    }
  }
  const patch = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) {
    patch.set(luma.subarray((py + y) * lw + px, (py + y) * lw + px + size), y * size);
  }
  return { px, py, size, patch, coarse: box4(patch, size, size), ox: 0, oy: 0 };
}

/**
 * Finds the reference patch in a new frame (coarse 4x search, then full-res refinement) within
 * LUCKY_SEARCH_RADIUS of the previous offset. Returns null if the patch has left the frame.
 */
function findPatchOffset(
  bayer: Uint8Array,
  width: number,
  height: number,
  ref: PatchRef
): { dx: number; dy: number } | null {
  const R = LUCKY_SEARCH_RADIUS;
  const n = ref.size;
  const span = n + 2 * R;
  const rx0 = ref.px + ref.ox - R;
  const ry0 = ref.py + ref.oy - R;
  const region = superPixelLuma(bayer, width, height, rx0, ry0, span, span);

  const coarse = box4(region, span, span);
  const cw = span >> 2;
  const cn = n >> 2;
  let bx = R >> 2;
  let by = R >> 2;
  let best = sad(ref.coarse, cn, coarse, cw, bx, by, Infinity);
  for (let y = 0; y <= (2 * R) >> 2; y++) {
    for (let x = 0; x <= (2 * R) >> 2; x++) {
      const s = sad(ref.coarse, cn, coarse, cw, x, y, best);
      if (s < best) {
        best = s;
        bx = x;
        by = y;
      }
    }
  }

  const cx = bx * 4;
  const cy = by * 4;
  let fx = cx;
  let fy = cy;
  best = sad(ref.patch, n, region, span, fx, fy, Infinity);
  for (let y = Math.max(0, cy - 3); y <= Math.min(2 * R, cy + 3); y++) {
    for (let x = Math.max(0, cx - 3); x <= Math.min(2 * R, cx + 3); x++) {
      const s = sad(ref.patch, n, region, span, x, y, best);
      if (s < best) {
        best = s;
        fx = x;
        fy = y;
      }
    }
  }

  const dx = rx0 + fx - ref.px;
  const dy = ry0 + fy - ref.py;
  const lw = width >> 1;
  const lh = height >> 1;
  if (ref.px + dx < 0 || ref.py + dy < 0 || ref.px + dx + n > lw || ref.py + dy + n > lh) return null;
  return { dx, dy };
}

/** Detects up to `maxStars` stars (brightest first) in a super-pixel luma image. */
export function detectStars(luma: Uint16Array, w: number, h: number, maxStars = 40): Star[] {
  const hist = new Uint32Array(1021);
  for (let i = 0; i < luma.length; i++) hist[luma[i]]++;
  const half = luma.length / 2;
  let median = 0;
  for (let acc = 0; median < 1020; median++) {
    acc += hist[median];
    if (acc >= half) break;
  }
  let mad = 0;
  for (let acc = hist[median]; acc < half && mad < 1020; ) {
    mad++;
    if (median - mad >= 0) acc += hist[median - mad];
    if (median + mad <= 1020) acc += hist[median + mad];
  }
  const sigma = Math.max(1, 1.4826 * mad);
  const thresh = median + Math.max(5 * sigma, 8);

  const candidates: Star[] = [];
  for (let y = 3; y < h - 3; y++) {
    const row = y * w;
    for (let x = 3; x < w - 3; x++) {
      const i = row + x;
      const v = luma[i];
      if (v <= thresh) continue;
      // Strict on one side, non-strict on the other so flat (saturated) tops yield one maximum
      if (
        v <= luma[i - 1] || v <= luma[i - w] || v <= luma[i - w - 1] || v <= luma[i - w + 1] ||
        v < luma[i + 1] || v < luma[i + w] || v < luma[i + w - 1] || v < luma[i + w + 1]
      ) {
        continue;
      }
      // Hot pixels have no PSF wings
      const n4 = (luma[i - 1] + luma[i + 1] + luma[i - w] + luma[i + w]) / 4;
      if (n4 - median < 0.1 * (v - median)) continue;
      candidates.push({ x, y, peak: v - median });
    }
  }
  candidates.sort((a, b) => b.peak - a.peak);

  const stars: Star[] = [];
  for (const c of candidates) {
    if (stars.length >= maxStars) break;
    if (stars.some((s) => (s.x - c.x) ** 2 + (s.y - c.y) ** 2 < 16)) continue;
    let ws = 0;
    let xs = 0;
    let ys = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const v = luma[(c.y + dy) * w + c.x + dx] - median;
        if (v <= 0) continue;
        ws += v;
        xs += v * (c.x + dx);
        ys += v * (c.y + dy);
      }
    }
    stars.push({ x: xs / ws, y: ys / ws, peak: c.peak });
  }
  return stars;
}

function applyTransform(t: Transform, s: { x: number; y: number }): { x: number; y: number } {
  return { x: t.cos * s.x - t.sin * s.y + t.tx, y: t.sin * s.x + t.cos * s.y + t.ty };
}

/**
 * Estimates the rigid transform mapping reference stars onto current stars. Translation is
 * found by pair voting (with the prior rotation applied), then refined by least squares on
 * nearest-neighbour matches. Returns null if fewer than 3 stars agree.
 */
export function estimateRigid(
  ref: Star[],
  cur: Star[],
  prior: Transform = IDENTITY
): { transform: Transform; matches: number } | null {
  if (ref.length < 3 || cur.length < 3) return null;
  const VOTE_TOL = 2;
  const rotated = ref.slice(0, 20).map((s) => applyTransform({ ...prior, tx: 0, ty: 0 }, s));
  const cs = cur.slice(0, 20);
  let bestVotes = 0;
  let tx = prior.tx;
  let ty = prior.ty;
  for (const r of rotated) {
    for (const c of cs) {
      const dx = c.x - r.x;
      const dy = c.y - r.y;
      let votes = 0;
      for (const r2 of rotated) {
        if (cs.some((c2) => Math.abs(c2.x - r2.x - dx) < VOTE_TOL && Math.abs(c2.y - r2.y - dy) < VOTE_TOL)) votes++;
      }
      if (votes > bestVotes) {
        bestVotes = votes;
        tx = dx;
        ty = dy;
      }
    }
  }
  if (bestVotes < 3) return null;

  let t: Transform = { cos: prior.cos, sin: prior.sin, tx, ty };
  let matches = 0;
  for (const tol of [2, 1.5]) {
    const pairs: { r: Star; c: Star }[] = [];
    for (const r of ref) {
      const p = applyTransform(t, r);
      let bestD = tol * tol;
      let match: Star | null = null;
      for (const c of cur) {
        const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          match = c;
        }
      }
      if (match) pairs.push({ r, c: match });
    }
    if (pairs.length < 3) return null;

    let mrx = 0, mry = 0, mcx = 0, mcy = 0;
    for (const { r, c } of pairs) {
      mrx += r.x; mry += r.y; mcx += c.x; mcy += c.y;
    }
    mrx /= pairs.length; mry /= pairs.length; mcx /= pairs.length; mcy /= pairs.length;
    let sxx = 0;
    let sxy = 0;
    for (const { r, c } of pairs) {
      const rx = r.x - mrx, ry = r.y - mry, cx = c.x - mcx, cy = c.y - mcy;
      sxx += rx * cx + ry * cy;
      sxy += rx * cy - ry * cx;
    }
    const theta = Math.atan2(sxy, sxx);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    t = { cos, sin, tx: mcx - (cos * mrx - sin * mry), ty: mcy - (sin * mrx + cos * mry) };
    matches = pairs.length;
  }
  return { transform: t, matches };
}

/** Resamples `src` into reference geometry, moving whole 2x2 super-pixels (edges clamped). */
function warpBayer(src: Uint8Array, dst: Uint8Array, width: number, height: number, t: Transform): void {
  const lw = width >> 1;
  const lh = height >> 1;
  for (let sy = 0; sy < lh; sy++) {
    let ux = -t.sin * sy + t.tx;
    let uy = t.cos * sy + t.ty;
    const d0 = sy * 2 * width;
    const d1 = d0 + width;
    for (let sx = 0; sx < lw; sx++) {
      const ix = clamp(Math.round(ux), 0, lw - 1);
      const iy = clamp(Math.round(uy), 0, lh - 1);
      const s0 = iy * 2 * width + ix * 2;
      const s1 = s0 + width;
      const dc = sx * 2;
      dst[d0 + dc] = src[s0];
      dst[d0 + dc + 1] = src[s0 + 1];
      dst[d1 + dc] = src[s1];
      dst[d1 + dc + 1] = src[s1 + 1];
      ux += t.cos;
      uy += t.sin;
    }
  }
}

export class LiveStacker {
  private opts: LiveStackOptions = {
    mode: 'lucky',
    windowMs: DEFAULT_STACK_WINDOW_SEC.lucky * 1000,
    keepPercent: 25
  };
  private width = 0;
  private height = 0;
  private maxSlots = 0;
  private slots: (Uint8Array | Uint16Array)[] = [];
  private slotStart: number[] = [];
  private slotFrames: number[] = [];
  private slotScore: number[] = [];
  private slotSelected: boolean[] = [];
  private head = 0; // index of oldest slot
  private count = 0;
  private sum: Uint32Array | null = null;
  private avg: Buffer | null = null;
  private scratch8: Uint8Array | null = null;
  private warped: Uint8Array | null = null;
  private selectedFrames = 0;
  private pooledFrames = 0;
  private rejected = 0;
  private lastProcessedMs = -Infinity;
  private luckyRef: PatchRef | null = null;
  private dsoRef: Star[] | null = null;
  private dsoTransform: Transform = IDENTITY;
  private alignFailures = 0;

  constructor(
    options: Partial<LiveStackOptions> = {},
    private readonly memoryBudgetBytes = 256 * 1024 * 1024,
    private readonly maxSlotsCap = 90
  ) {
    this.configure(options);
  }

  get options(): Readonly<LiveStackOptions> {
    return this.opts;
  }

  /** Frames contributing to the current output. */
  get frameCount(): number {
    return this.selectedFrames;
  }

  /** Frames held in the window (lucky mode picks the best of these). */
  get poolFrameCount(): number {
    return this.pooledFrames;
  }

  /** Frames that failed alignment since the stack was (re)started. */
  get rejectedCount(): number {
    return this.rejected;
  }

  /** Updates mode / window / keep percentage (clamped) and restarts the stack. */
  configure(options: Partial<LiveStackOptions>): void {
    const next = { ...this.opts };
    if (options.mode === 'lucky' || options.mode === 'dso') next.mode = options.mode;
    if (Number.isFinite(options.windowMs)) next.windowMs = clamp(options.windowMs!, MIN_WINDOW_MS, MAX_WINDOW_MS);
    if (Number.isFinite(options.keepPercent)) next.keepPercent = clamp(Math.round(options.keepPercent!), 1, 100);
    this.opts = next;
    this.reset();
  }

  reset(): void {
    this.width = 0;
    this.height = 0;
    this.maxSlots = 0;
    this.slots = [];
    this.sum = null;
    this.avg = null;
    this.scratch8 = null;
    this.warped = null;
    this.lastProcessedMs = -Infinity;
    this.clearStack();
  }

  /** Drops all stacked data and the alignment reference, keeping buffers. */
  private clearStack(): void {
    this.slotStart = [];
    this.slotFrames = [];
    this.slotScore = [];
    this.slotSelected = [];
    this.head = 0;
    this.count = 0;
    this.selectedFrames = 0;
    this.pooledFrames = 0;
    this.rejected = 0;
    this.sum?.fill(0);
    this.luckyRef = null;
    this.dsoRef = null;
    this.dsoTransform = IDENTITY;
    this.alignFailures = 0;
  }

  /**
   * Adds a frame (subject to sampling interval and alignment) and returns the current 8-bit
   * stacked frame, or null if nothing is stacked yet. `quality` ranks frames in lucky mode.
   */
  push(
    frame: Buffer,
    width: number,
    height: number,
    is16Bit: boolean,
    nowMs: number,
    quality = 0
  ): Buffer | null {
    if (width !== this.width || height !== this.height || !this.sum) this.allocate(width, height);
    const lucky = this.opts.mode === 'lucky';

    const minIntervalMs = lucky ? this.opts.windowMs / this.maxSlots : DSO_MIN_INTERVAL_MS;
    if (nowMs - this.lastProcessedMs < minIntervalMs) return this.output();
    this.lastProcessedMs = nowMs;

    const src = this.to8Bit(frame, is16Bit);
    const t = lucky ? this.alignLucky(src) : this.alignDso(src);
    if (!t) {
      this.rejected++;
      return this.output();
    }
    const aligned = isIdentity(t) ? src : this.warp(src, t);

    while (this.count > 0 && nowMs - this.slotStart[this.head] > this.opts.windowMs) {
      this.dropOldest();
    }
    if (lucky) {
      this.addLucky(aligned, nowMs, quality);
    } else {
      this.addDso(aligned, nowMs);
    }
    this.updateAverage();
    return this.avg;
  }

  private output(): Buffer | null {
    return this.selectedFrames > 0 ? this.avg : null;
  }

  private allocate(width: number, height: number): void {
    this.reset();
    this.width = width;
    this.height = height;
    const pixels = width * height;
    const bytesPerPixel = this.opts.mode === 'lucky' ? 1 : 2;
    this.maxSlots = Math.max(
      4,
      Math.min(this.maxSlotsCap, Math.floor(this.memoryBudgetBytes / (pixels * bytesPerPixel)))
    );
    this.sum = new Uint32Array(pixels);
    this.avg = Buffer.alloc(pixels);
  }

  private to8Bit(frame: Buffer, is16Bit: boolean): Uint8Array {
    const pixels = this.width * this.height;
    if (!is16Bit) return new Uint8Array(frame.buffer, frame.byteOffset, pixels);
    if (!this.scratch8) this.scratch8 = new Uint8Array(pixels);
    const out = this.scratch8;
    for (let i = 0; i < pixels; i++) out[i] = frame.readUInt16LE(i * 2) >> 8;
    return out;
  }

  private warp(src: Uint8Array, t: Transform): Uint8Array {
    if (!this.warped) this.warped = new Uint8Array(this.width * this.height);
    warpBayer(src, this.warped, this.width, this.height, t);
    return this.warped;
  }

  private alignLucky(src: Uint8Array): Transform {
    if (this.luckyRef) {
      const off = findPatchOffset(src, this.width, this.height, this.luckyRef);
      if (off) {
        this.luckyRef.ox = off.dx;
        this.luckyRef.oy = off.dy;
        return { cos: 1, sin: 0, tx: off.dx, ty: off.dy };
      }
      // Target drifted out of the frame: restart with this frame as the reference
      this.clearStack();
    }
    const lw = this.width >> 1;
    const lh = this.height >> 1;
    this.luckyRef = createPatchRef(superPixelLuma(src, this.width, this.height, 0, 0, lw, lh), lw, lh);
    return IDENTITY;
  }

  private alignDso(src: Uint8Array): Transform | null {
    const lw = this.width >> 1;
    const lh = this.height >> 1;
    const stars = detectStars(superPixelLuma(src, this.width, this.height, 0, 0, lw, lh), lw, lh);
    if (this.dsoRef) {
      const fit = estimateRigid(this.dsoRef, stars, this.dsoTransform);
      if (fit && fit.matches >= Math.max(3, Math.ceil(0.3 * this.dsoRef.length))) {
        this.alignFailures = 0;
        this.dsoTransform = fit.transform;
        return fit.transform;
      }
      if (++this.alignFailures < DSO_MAX_ALIGN_FAILURES) return null;
      // Persistent failure (slew, new target): restart with this frame as the reference
      this.clearStack();
    }
    if (stars.length < 3) return null;
    this.dsoRef = stars;
    return IDENTITY;
  }

  private addLucky(frame: Uint8Array, nowMs: number, quality: number): void {
    if (this.count === this.maxSlots) this.dropOldest();
    const idx = (this.head + this.count) % this.maxSlots;
    let slot = this.slots[idx];
    if (!slot) {
      slot = new Uint8Array(frame.length);
      this.slots[idx] = slot;
    }
    slot.set(frame);
    this.slotStart[idx] = nowMs;
    this.slotFrames[idx] = 1;
    this.slotScore[idx] = quality;
    this.slotSelected[idx] = false;
    this.count++;
    this.pooledFrames++;

    // Keep only the best `keepPercent` of the window, updating the sum incrementally
    const order: number[] = [];
    for (let k = 0; k < this.count; k++) order.push((this.head + k) % this.maxSlots);
    order.sort((a, b) => this.slotScore[b] - this.slotScore[a]);
    const keep = Math.max(1, Math.round((this.count * this.opts.keepPercent) / 100));
    order.forEach((i, rank) => {
      const want = rank < keep;
      if (want === this.slotSelected[i]) return;
      if (want) this.addToSum(this.slots[i]);
      else this.subtractFromSum(this.slots[i]);
      this.slotSelected[i] = want;
      this.selectedFrames += want ? 1 : -1;
    });
  }

  private addDso(frame: Uint8Array, nowMs: number): void {
    const blockMs = this.opts.windowMs / this.maxSlots;
    let idx = (this.head + this.count - 1 + this.maxSlots) % this.maxSlots;
    const reuseLast =
      this.count > 0 &&
      nowMs - this.slotStart[idx] < blockMs &&
      this.slotFrames[idx] < DSO_MAX_FRAMES_PER_BLOCK;
    if (!reuseLast) {
      if (this.count === this.maxSlots) this.dropOldest();
      idx = (this.head + this.count) % this.maxSlots;
      const existing = this.slots[idx];
      if (existing) existing.fill(0);
      else this.slots[idx] = new Uint16Array(frame.length);
      this.slotStart[idx] = nowMs;
      this.slotFrames[idx] = 0;
      this.slotScore[idx] = 0;
      this.slotSelected[idx] = true;
      this.count++;
    }
    const slot = this.slots[idx];
    const sum = this.sum!;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      slot[i] += v;
      sum[i] += v;
    }
    this.slotFrames[idx]++;
    this.selectedFrames++;
    this.pooledFrames++;
  }

  private dropOldest(): void {
    const idx = this.head;
    if (this.slotSelected[idx]) {
      this.subtractFromSum(this.slots[idx]);
      this.selectedFrames -= this.slotFrames[idx];
      this.slotSelected[idx] = false;
    }
    this.pooledFrames -= this.slotFrames[idx];
    this.head = (this.head + 1) % this.maxSlots;
    this.count--;
  }

  private addToSum(slot: Uint8Array | Uint16Array): void {
    const sum = this.sum!;
    for (let i = 0; i < sum.length; i++) sum[i] += slot[i];
  }

  private subtractFromSum(slot: Uint8Array | Uint16Array): void {
    const sum = this.sum!;
    for (let i = 0; i < sum.length; i++) sum[i] -= slot[i];
  }

  private updateAverage(): void {
    const sum = this.sum!;
    const avg = this.avg!;
    const inv = 1 / this.selectedFrames;
    for (let i = 0; i < sum.length; i++) avg[i] = sum[i] * inv + 0.5;
  }
}
