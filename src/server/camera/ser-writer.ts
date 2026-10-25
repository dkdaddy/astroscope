import fs from 'node:fs';
import path from 'node:path';

// Number of 100-ns ticks between 0001-01-01T00:00:00Z and 1970-01-01T00:00:00Z
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;

export function dateToSerTicks(unixMs: number = Date.now(), offsetMinutes = 0): bigint {
  const adjustedMs = BigInt(Math.round(unixMs + offsetMinutes * 60_000));
  return TICKS_AT_UNIX_EPOCH + adjustedMs * 10_000n;
}

export class SerWriter {
  private fd: number | null = null;
  private frameCount = 0;
  private bytesPerFrame: number;
  private frameTimestamps: bigint[] = [];

  constructor(
    private filePath: string,
    private width: number,
    private height: number,
    private is16Bit = false,
    private metadata: { observer?: string; instrument?: string; telescope?: string } = {}
  ) {
    this.bytesPerFrame = width * height * (is16Bit ? 2 : 1);
  }

  open(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fd = fs.openSync(this.filePath, 'w');
    this.frameCount = 0;
    this.frameTimestamps = [];

    const nowMs = Date.now();
    const localOffsetMin = -new Date(nowMs).getTimezoneOffset();
    const localTicks = dateToSerTicks(nowMs, localOffsetMin);
    const utcTicks = dateToSerTicks(nowMs, 0);

    // 178-Byte SER v3 Header specification
    const header = Buffer.alloc(178);
    header.write('LUCAM-RECORDER', 0, 14, 'ascii'); // FileID (14 bytes)
    header.writeInt32LE(0, 14);                      // LuID (0)
    header.writeInt32LE(8, 18);                      // ColorID (8 = Bayer RGGB)
    header.writeInt32LE(0, 22);                      // LittleEndian (0 = LittleEndian)
    header.writeInt32LE(this.width, 26);             // ImageWidth
    header.writeInt32LE(this.height, 30);            // ImageHeight
    header.writeInt32LE(this.is16Bit ? 16 : 8, 34);  // PixelDepthPerPlane
    header.writeInt32LE(0, 38);                      // FrameCount (placeholder)

    // Observer / Instrument / Telescope strings (40 bytes each)
    header.write((this.metadata.observer ?? 'AstroScope Observer').slice(0, 40), 42, 40, 'ascii');
    header.write((this.metadata.instrument ?? 'ZWO ASI678MC').slice(0, 40), 82, 40, 'ascii');
    header.write((this.metadata.telescope ?? 'AstroScope OTA').slice(0, 40), 122, 40, 'ascii');

    // DateTimes (64-bit local & UTC integers)
    header.writeBigInt64LE(localTicks, 162);
    header.writeBigInt64LE(utcTicks, 170);

    fs.writeSync(this.fd, header, 0, 178);
  }

  writeFrame(frameBuffer: Buffer, timestampTicks?: bigint): void {
    if (this.fd === null) throw new Error('SER file not open.');
    if (frameBuffer.length !== this.bytesPerFrame) {
      throw new Error(`Buffer mismatch: expected ${this.bytesPerFrame}, got ${frameBuffer.length}`);
    }
    fs.writeSync(this.fd, frameBuffer, 0, frameBuffer.length);
    this.frameTimestamps.push(timestampTicks ?? dateToSerTicks(Date.now(), 0));
    this.frameCount++;
  }

  getRecordedFrames(): number {
    return this.frameCount;
  }

  close(): void {
    if (this.fd === null) return;

    // 1. Append SER v3 Timestamp Trailer (8-byte 64-bit UTC timestamp per frame)
    if (this.frameTimestamps.length > 0) {
      const trailer = Buffer.alloc(this.frameTimestamps.length * 8);
      for (let i = 0; i < this.frameTimestamps.length; i++) {
        trailer.writeBigInt64LE(this.frameTimestamps[i], i * 8);
      }
      fs.writeSync(this.fd, trailer, 0, trailer.length);
    }

    // 2. Overwrite placeholder FrameCount at offset 38
    const countBuf = Buffer.alloc(4);
    countBuf.writeInt32LE(this.frameCount, 0);
    fs.writeSync(this.fd, countBuf, 0, 4, 38);

    fs.closeSync(this.fd);
    this.fd = null;
  }
}
