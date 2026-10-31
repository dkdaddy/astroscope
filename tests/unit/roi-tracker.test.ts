import { describe, it, expect } from 'vitest';
import { RoiTracker, detectBrightObject } from '../../src/server/camera/roi-tracker.js';

const W = 640;
const H = 480;

function makeFrame(
  opts: { cx?: number; cy?: number; radius?: number; level?: number; bg?: number; noise?: number; seed?: number } = {}
): Uint8Array {
  const { cx, cy, radius = 40, level = 200, bg = 4, noise = 2 } = opts;
  let s = opts.seed ?? 1;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const f = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = bg + (rand() - 0.5) * 2 * noise;
      if (cx !== undefined && cy !== undefined && Math.hypot(x - cx, y - cy) <= radius) v = level;
      f[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return f;
}

describe('detectBrightObject', () => {
  it('finds the centroid of a bright disc on a black background', () => {
    const det = detectBrightObject(makeFrame({ cx: 420, cy: 150 }), W, H)!;
    expect(det.confident).toBe(true);
    expect(Math.abs(det.x - 420)).toBeLessThan(10);
    expect(Math.abs(det.y - 150)).toBeLessThan(10);
  });

  it('works on 16-bit frames', () => {
    const f8 = makeFrame({ cx: 200, cy: 300 });
    const f16 = Buffer.alloc(W * H * 2);
    for (let i = 0; i < f8.length; i++) f16.writeUInt16LE(f8[i] << 8, i * 2);
    const det = detectBrightObject(f16, W, H, true)!;
    expect(det.confident).toBe(true);
    expect(Math.abs(det.x - 200)).toBeLessThan(10);
    expect(Math.abs(det.y - 300)).toBeLessThan(10);
  });

  it('is not confident on pure noise or a single hot pixel', () => {
    const f = makeFrame({ noise: 3 });
    f[200 * W + 300] = 255;
    expect(detectBrightObject(f, W, H)!.confident).toBe(false);
  });

  it('is not confident when the frame is mostly bright (no black background)', () => {
    const det = detectBrightObject(makeFrame({ cx: 320, cy: 240, radius: 400 }), W, H);
    expect(det?.confident ?? false).toBe(false);
  });
});

describe('RoiTracker', () => {
  const roi = { x: 0, y: 0, width: 128, height: 128 };

  it('does nothing while disabled', () => {
    const t = new RoiTracker();
    expect(t.update(makeFrame({ cx: 400, cy: 300 }), W, H, false, roi, 1000)).toBeNull();
    expect(t.status).toBe('off');
  });

  it('moves the ROI onto the object after two agreeing confident detections', () => {
    const t = new RoiTracker();
    t.configure({ enabled: true, tolerancePx: 16 });
    const frame = makeFrame({ cx: 400, cy: 300 });
    expect(t.update(frame, W, H, false, roi, 1000)).toBeNull();
    const moved = t.update(frame, W, H, false, roi, 1300)!;
    expect(moved).not.toBeNull();
    expect(Math.abs(moved.x + moved.width / 2 - 400)).toBeLessThan(12);
    expect(Math.abs(moved.y + moved.height / 2 - 300)).toBeLessThan(12);
    expect(moved.x % 2).toBe(0);
    expect(moved.y % 2).toBe(0);
    expect(t.status).toBe('tracking');

    // Already centred within tolerance: stays put
    expect(t.update(frame, W, H, false, moved, 1600)).toBeNull();
    expect(t.update(frame, W, H, false, moved, 1900)).toBeNull();
  });

  it('holds position when not confident', () => {
    const t = new RoiTracker();
    t.configure({ enabled: true });
    const frame = makeFrame({ noise: 3 });
    expect(t.update(frame, W, H, false, roi, 1000)).toBeNull();
    expect(t.update(frame, W, H, false, roi, 1300)).toBeNull();
    expect(t.status).toBe('searching');
  });

  it('respects the tolerance deadband', () => {
    const t = new RoiTracker();
    t.configure({ enabled: true, tolerancePx: 64 });
    const centred = { x: 400 - 64, y: 300 - 64, width: 128, height: 128 };
    const frame = makeFrame({ cx: 440, cy: 330 });
    expect(t.update(frame, W, H, false, centred, 1000)).toBeNull();
    expect(t.update(frame, W, H, false, centred, 1300)).toBeNull();
    expect(t.status).toBe('tracking');
  });
});
