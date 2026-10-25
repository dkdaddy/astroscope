/**
 * Rolling-window live stack: averages the raw Bayer frames captured in the last `windowMs`.
 *
 * Frames are stored as 8-bit Bayer in a ring buffer with a running per-pixel sum, so each
 * new frame costs one subtract + one add pass. To bound memory at full 4K resolution, frames
 * are sampled at most every `windowMs / maxFrames` ms, where maxFrames is derived from a
 * memory budget (e.g. 30 frames at 3840x2160, up to 90 for smaller ROIs).
 * No alignment is performed: intended for a fixed (non-tracking) terrestrial target or a
 * tracked object where drift over the window is below a pixel or two.
 */
export class LiveStacker {
  private width = 0;
  private height = 0;
  private maxFrames = 0;
  private slots: Uint8Array[] = [];
  private slotTimes: number[] = [];
  private head = 0; // index of oldest frame
  private count = 0;
  private sum: Uint32Array | null = null;
  private avg: Buffer | null = null;
  private lastAddMs = 0;

  constructor(
    private readonly windowMs = 3000,
    private readonly memoryBudgetBytes = 256 * 1024 * 1024,
    private readonly maxFramesCap = 90
  ) {}

  get frameCount(): number {
    return this.count;
  }

  reset(): void {
    this.width = 0;
    this.height = 0;
    this.slots = [];
    this.slotTimes = [];
    this.head = 0;
    this.count = 0;
    this.sum = null;
    this.avg = null;
    this.lastAddMs = 0;
  }

  /**
   * Adds a frame (subject to sampling interval) and returns the current 8-bit averaged frame,
   * or null if the stack is empty.
   */
  push(frame: Buffer, width: number, height: number, is16Bit: boolean, nowMs: number): Buffer | null {
    const pixels = width * height;
    if (width !== this.width || height !== this.height || !this.sum || !this.avg) {
      this.reset();
      this.width = width;
      this.height = height;
      this.maxFrames = Math.max(4, Math.min(this.maxFramesCap, Math.floor(this.memoryBudgetBytes / pixels)));
      this.sum = new Uint32Array(pixels);
      this.avg = Buffer.alloc(pixels);
    }
    const sum = this.sum;
    const avg = this.avg;

    const minIntervalMs = this.windowMs / this.maxFrames;
    if (this.count > 0 && nowMs - this.lastAddMs < minIntervalMs) {
      return avg;
    }
    this.lastAddMs = nowMs;

    // Drop frames that have aged out of the window (keep room for the new one)
    while (
      this.count > 0 &&
      (this.count >= this.maxFrames || nowMs - this.slotTimes[this.head] > this.windowMs)
    ) {
      const old = this.slots[this.head];
      for (let i = 0; i < pixels; i++) sum[i] -= old[i];
      this.head = (this.head + 1) % this.maxFrames;
      this.count--;
    }

    const tail = (this.head + this.count) % this.maxFrames;
    let slot = this.slots[tail];
    if (!slot) {
      slot = new Uint8Array(pixels);
      this.slots[tail] = slot;
    }
    this.slotTimes[tail] = nowMs;
    this.count++;

    const inv = 1 / this.count;
    if (is16Bit) {
      for (let i = 0; i < pixels; i++) {
        const v = frame.readUInt16LE(i * 2) >> 8;
        slot[i] = v;
        const s = sum[i] + v;
        sum[i] = s;
        avg[i] = s * inv + 0.5;
      }
    } else {
      for (let i = 0; i < pixels; i++) {
        const v = frame[i];
        slot[i] = v;
        const s = sum[i] + v;
        sum[i] = s;
        avg[i] = s * inv + 0.5;
      }
    }

    return avg;
  }
}
