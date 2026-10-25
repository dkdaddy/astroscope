import { describe, it, expect } from 'vitest';
import {
  FRAME_HEADER_BYTES,
  FRAME_HEADER_MAGIC,
  FRAME_TYPE,
  PIXEL_FORMAT,
  packBinaryFrame,
  unpackBinaryFrame
} from '../../src/common/protocol.js';

describe('WebSocket Binary Frame Protocol (IT-01)', () => {
  it('packs and unpacks the 24-byte aligned ASTR header losslessly', () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const packed = packBinaryFrame(
      {
        frameNumber: 42,
        width: 400,
        height: 400,
        pixelFormat: PIXEL_FORMAT.RAW8_RGGB,
        frameType: FRAME_TYPE.FOCUS_ROI_CROP,
        binFactor: 1,
        serverScore: 123.45
      },
      payload
    );

    expect(packed.byteLength).toBe(FRAME_HEADER_BYTES + payload.byteLength);

    const arrayBuf = packed.buffer.slice(
      packed.byteOffset,
      packed.byteOffset + packed.byteLength
    );
    const decoded = unpackBinaryFrame(arrayBuf);

    expect(decoded.header.magic).toBe(FRAME_HEADER_MAGIC);
    expect(decoded.header.frameNumber).toBe(42);
    expect(decoded.header.width).toBe(400);
    expect(decoded.header.height).toBe(400);
    expect(decoded.header.pixelFormat).toBe(PIXEL_FORMAT.RAW8_RGGB);
    expect(decoded.header.frameType).toBe(FRAME_TYPE.FOCUS_ROI_CROP);
    expect(decoded.header.binFactor).toBe(1);
    expect(decoded.header.serverScore).toBeCloseTo(123.45, 2);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });
});
