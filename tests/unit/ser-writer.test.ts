import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SerWriter } from '../../src/server/camera/ser-writer.js';

describe('SerWriter (UT-01)', () => {
  let tmpFile = '';

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it('writes a compliant 178-byte SER v3 header, frames, and 8-byte timestamp trailer', () => {
    tmpFile = path.join(os.tmpdir(), `test_${Date.now()}.ser`);
    const width = 64;
    const height = 48;
    const writer = new SerWriter(tmpFile, width, height, false, {
      observer: 'Bob Cook',
      instrument: 'ZWO ASI678MC',
      telescope: 'EdgeHD 8'
    });

    writer.open();

    const frame = Buffer.alloc(width * height, 128);
    writer.writeFrame(frame);
    writer.writeFrame(frame);
    writer.writeFrame(frame);
    writer.close();

    const fileBuf = fs.readFileSync(tmpFile);
    const expectedSize = 178 + 3 * (width * height) + 3 * 8;
    expect(fileBuf.length).toBe(expectedSize);

    // Check FileID
    expect(fileBuf.toString('ascii', 0, 14)).toBe('LUCAM-RECORDER');
    // Check ColorID = 8 (RGGB)
    expect(fileBuf.readInt32LE(18)).toBe(8);
    // Check ImageWidth & ImageHeight
    expect(fileBuf.readInt32LE(26)).toBe(width);
    expect(fileBuf.readInt32LE(30)).toBe(height);
    // Check PixelDepthPerPlane = 8
    expect(fileBuf.readInt32LE(34)).toBe(8);
    // Check FrameCount at offset 38 = 3
    expect(fileBuf.readInt32LE(38)).toBe(3);
    // Check timestamps > 0
    expect(fileBuf.readBigInt64LE(162)).toBeGreaterThan(600000000000000000n);
  });
});
