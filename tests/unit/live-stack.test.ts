import { describe, expect, it } from 'vitest';
import { LiveStacker } from '../../src/server/camera/live-stack.js';

function frame8(w: number, h: number, value: number): Buffer {
  return Buffer.alloc(w * h, value);
}

function frame16(w: number, h: number, value: number): Buffer {
  const buf = Buffer.alloc(w * h * 2);
  for (let i = 0; i < w * h; i++) buf.writeUInt16LE(value, i * 2);
  return buf;
}

describe('LiveStacker', () => {
  it('averages frames within the window', () => {
    const s = new LiveStacker(3000, 64 * 64 * 10, 10); // 10 frames -> 300 ms interval
    s.push(frame8(64, 64, 100), 64, 64, false, 0);
    s.push(frame8(64, 64, 200), 64, 64, false, 300);
    const out = s.push(frame8(64, 64, 0), 64, 64, false, 600)!;
    expect(s.frameCount).toBe(3);
    expect(out[0]).toBe(100);
  });

  it('skips frames arriving faster than the sampling interval', () => {
    const s = new LiveStacker(3000, 64 * 64 * 10, 10);
    s.push(frame8(64, 64, 100), 64, 64, false, 0);
    const out = s.push(frame8(64, 64, 0), 64, 64, false, 50)!;
    expect(s.frameCount).toBe(1);
    expect(out[0]).toBe(100);
  });

  it('drops frames older than the window and caps frame count', () => {
    const s = new LiveStacker(3000, 64 * 64 * 10, 10);
    for (let t = 0; t <= 6000; t += 300) {
      s.push(frame8(64, 64, t < 3000 ? 0 : 250), 64, 64, false, t);
    }
    expect(s.frameCount).toBeLessThanOrEqual(10);
    // Only the 250-valued frames remain in the last 3 s
    const out = s.push(frame8(64, 64, 250), 64, 64, false, 6300)!;
    expect(out[0]).toBe(250);
  });

  it('converts 16-bit frames to 8-bit and resets on size change', () => {
    const s = new LiveStacker(3000);
    const out = s.push(frame16(32, 32, 0x8000), 32, 32, true, 0)!;
    expect(out[0]).toBe(0x80);
    s.push(frame8(64, 64, 10), 64, 64, false, 1000);
    expect(s.frameCount).toBe(1);
  });
});
