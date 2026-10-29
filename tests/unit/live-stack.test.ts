import { describe, expect, it } from 'vitest';
import { LiveStacker, estimateRigid, type Star } from '../../src/server/camera/live-stack.js';

function frame8(w: number, h: number, value: number): Buffer {
  return Buffer.alloc(w * h, value);
}

function frame16(w: number, h: number, value: number): Buffer {
  const buf = Buffer.alloc(w * h * 2);
  for (let i = 0; i < w * h; i++) buf.writeUInt16LE(value, i * 2);
  return buf;
}

/** Frame with gaussian spots of the given sigma (sensor px) on a flat background. */
function spotsFrame(w: number, h: number, spots: { x: number; y: number; amp: number }[], sigma: number, bg = 10): Buffer {
  const buf = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = bg;
      for (const s of spots) v += s.amp * Math.exp(-((x - s.x) ** 2 + (y - s.y) ** 2) / (2 * sigma * sigma));
      buf[y * w + x] = Math.min(255, Math.round(v));
    }
  }
  return buf;
}

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('LiveStacker (lucky)', () => {
  const lucky = (keepPercent = 100) =>
    new LiveStacker({ mode: 'lucky', windowMs: 3000, keepPercent }, 64 * 64 * 10, 10); // 10 slots -> 300 ms

  it('averages frames within the window', () => {
    const s = lucky();
    s.push(frame8(64, 64, 100), 64, 64, false, 0);
    s.push(frame8(64, 64, 200), 64, 64, false, 300);
    const out = s.push(frame8(64, 64, 0), 64, 64, false, 600)!;
    expect(s.frameCount).toBe(3);
    expect(out[0]).toBe(100);
  });

  it('skips frames arriving faster than the sampling interval', () => {
    const s = lucky();
    s.push(frame8(64, 64, 100), 64, 64, false, 0);
    const out = s.push(frame8(64, 64, 0), 64, 64, false, 50)!;
    expect(s.frameCount).toBe(1);
    expect(out[0]).toBe(100);
  });

  it('drops frames older than the window and caps frame count', () => {
    const s = lucky();
    for (let t = 0; t <= 6000; t += 300) {
      s.push(frame8(64, 64, t < 3000 ? 0 : 250), 64, 64, false, t);
    }
    expect(s.frameCount).toBeLessThanOrEqual(10);
    // Only the 250-valued frames remain in the last 3 s
    const out = s.push(frame8(64, 64, 250), 64, 64, false, 6300)!;
    expect(out[0]).toBe(250);
  });

  it('converts 16-bit frames to 8-bit and resets on size change', () => {
    const s = new LiveStacker();
    const out = s.push(frame16(32, 32, 0x8000), 32, 32, true, 0)!;
    expect(out[0]).toBe(0x80);
    s.push(frame8(64, 64, 10), 64, 64, false, 1000);
    expect(s.frameCount).toBe(1);
  });

  it('keeps only the best percentage of frames by quality', () => {
    const s = lucky(50);
    s.push(frame8(64, 64, 10), 64, 64, false, 0, 1);
    s.push(frame8(64, 64, 200), 64, 64, false, 300, 9);
    s.push(frame8(64, 64, 20), 64, 64, false, 600, 2);
    const out = s.push(frame8(64, 64, 220), 64, 64, false, 900, 8)!;
    expect(s.poolFrameCount).toBe(4);
    expect(s.frameCount).toBe(2);
    expect(out[0]).toBe(210);
  });

  it('aligns a drifting target before averaging', () => {
    const s = lucky(); // 128x128 under this budget -> 4 slots, 750 ms interval
    s.push(spotsFrame(128, 128, [{ x: 64, y: 64, amp: 200 }], 8), 128, 128, false, 0);
    const out = s.push(spotsFrame(128, 128, [{ x: 72, y: 60, amp: 200 }], 8), 128, 128, false, 750)!;
    expect(s.frameCount).toBe(2);
    // Unaligned, the peak would drop to ~170
    expect(out[64 * 128 + 64]).toBeGreaterThan(205);
  });
});

describe('LiveStacker (dso)', () => {
  const W = 256;
  const H = 256;
  const rand = rng(42);
  const stars = Array.from({ length: 15 }, () => ({
    x: 30 + rand() * (W - 60),
    y: 30 + rand() * (H - 60),
    amp: 120 + rand() * 110
  }));
  const shifted = (dx: number, dy: number) => stars.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy }));

  it('aligns star fields and rejects frames without stars', () => {
    const s = new LiveStacker({ mode: 'dso', windowMs: 60_000 });
    s.push(spotsFrame(W, H, stars, 2), W, H, false, 0);
    s.push(spotsFrame(W, H, shifted(6, -4), 2), W, H, false, 1000);
    const out = s.push(frame8(W, H, 10), W, H, false, 2000)!;
    expect(s.frameCount).toBe(2);
    expect(s.rejectedCount).toBe(1);

    const ref = spotsFrame(W, H, stars, 2);
    const i = Math.round(stars[0].y) * W + Math.round(stars[0].x);
    expect(out[i]).toBeGreaterThan(ref[i] * 0.9);
  });

  it('estimates rotation and translation from star lists', () => {
    const r = rng(7);
    const ref: Star[] = Array.from({ length: 30 }, () => ({ x: r() * 1000, y: r() * 600, peak: 100 + r() * 500 }))
      .sort((a, b) => b.peak - a.peak);
    const theta = (0.1 * Math.PI) / 180;
    const cur = ref.map((s) => ({
      x: Math.cos(theta) * s.x - Math.sin(theta) * s.y + 40,
      y: Math.sin(theta) * s.x + Math.cos(theta) * s.y - 25,
      peak: s.peak
    }));
    const fit = estimateRigid(ref, cur)!;
    expect(fit.matches).toBe(30);
    expect(Math.atan2(fit.transform.sin, fit.transform.cos)).toBeCloseTo(theta, 5);
    expect(fit.transform.tx).toBeCloseTo(40, 3);
    expect(fit.transform.ty).toBeCloseTo(-25, 3);
  });
});
