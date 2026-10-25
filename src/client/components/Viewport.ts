import type { FocusROI } from '../../common/protocol.js';

/** Display levels on 8-bit data: values <= black map to 0, >= white to 255, gamma > 1 lifts midtones. */
export interface StretchParams {
  black: number;
  white: number;
  gamma: number;
}

export const DEFAULT_STRETCH: StretchParams = { black: 0, white: 189, gamma: 1 };

export class Viewport {
  private mainCtx: CanvasRenderingContext2D;
  private pipCtx: CanvasRenderingContext2D;
  private mainImgData: ImageData | null = null;
  private pipImgData: ImageData | null = null;

  private sensorWidth = 1920;
  private sensorHeight = 1080;
  private focusRoi: FocusROI = { x: 760, y: 340, width: 400, height: 400 };
  private stretch: StretchParams = { ...DEFAULT_STRETCH };
  private lut = new Uint8Array(256);
  private lastMainRaw: Uint8Array | null = null;
  private showReticle = true;

  private isDragging = false;

  constructor(
    private mainCanvas: HTMLCanvasElement,
    private pipCanvas: HTMLCanvasElement,
    private onRoiChange: (roi: FocusROI) => void
  ) {
    const mCtx = mainCanvas.getContext('2d');
    const pCtx = pipCanvas.getContext('2d');
    if (!mCtx || !pCtx) throw new Error('Canvas 2D context unavailable');
    this.mainCtx = mCtx;
    this.pipCtx = pCtx;

    this.rebuildLut();
    this.bindPointerEvents();
  }

  setStretch(params: StretchParams): void {
    this.stretch = { ...params };
    this.rebuildLut();
  }

  private rebuildLut(): void {
    const black = Math.max(0, Math.min(254, this.stretch.black));
    const white = Math.max(black + 1, Math.min(255, this.stretch.white));
    const invGamma = 1 / Math.max(0.1, this.stretch.gamma);
    for (let v = 0; v < 256; v++) {
      const t = Math.min(1, Math.max(0, (v - black) / (white - black)));
      this.lut[v] = Math.round(255 * Math.pow(t, invGamma));
    }
  }

  /**
   * Picks black/white points from the latest viewport frame histogram
   * (0.5% darkest pixels clipped to black, 0.1% brightest to white). Keeps the current gamma.
   */
  computeAutoStretch(): StretchParams | null {
    const raw = this.lastMainRaw;
    if (!raw || raw.length === 0) return null;
    const hist = new Uint32Array(256);
    for (let i = 0; i < raw.length; i++) hist[raw[i]]++;

    const lowTarget = raw.length * 0.005;
    const highTarget = raw.length * 0.999;
    let black = 0;
    let white = 255;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= lowTarget) {
        black = v;
        break;
      }
    }
    acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= highTarget) {
        white = v;
        break;
      }
    }
    if (white - black < 8) white = Math.min(255, black + 8);
    return { black, white, gamma: this.stretch.gamma };
  }

  setSensorDimensions(width: number, height: number, focusRoi: FocusROI): void {
    this.sensorWidth = width;
    this.sensorHeight = height;
    this.focusRoi = focusRoi;
  }

  private bindPointerEvents(): void {
    const moveRoiToEvent = (e: MouseEvent) => {
      const rect = this.mainCanvas.getBoundingClientRect();
      const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

      const rawX = Math.round(normX * this.sensorWidth - this.focusRoi.width / 2);
      const rawY = Math.round(normY * this.sensorHeight - this.focusRoi.height / 2);

      const x = Math.max(0, Math.min(this.sensorWidth - this.focusRoi.width, Math.floor(rawX / 2) * 2));
      const y = Math.max(0, Math.min(this.sensorHeight - this.focusRoi.height, Math.floor(rawY / 2) * 2));

      this.focusRoi = { ...this.focusRoi, x, y };
      this.onRoiChange(this.focusRoi);
    };

    this.mainCanvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      moveRoiToEvent(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        moveRoiToEvent(e);
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });
  }

  /**
   * Fast bilinear RGGB debayering into RGBA ImageData for live canvas rendering.
   */
  private debayerRggbToImageData(
    raw: Uint8Array,
    width: number,
    height: number,
    imgData: ImageData
  ): void {
    const dst = imgData.data;
    const lut = this.lut;

    for (let y = 0; y < height; y++) {
      const yPrev = y > 0 ? y - 1 : y + 1;
      const yNext = y < height - 1 ? y + 1 : y - 1;
      const row = y * width;
      const rowPrev = yPrev * width;
      const rowNext = yNext * width;
      const evenY = (y & 1) === 0;

      for (let x = 0; x < width; x++) {
        const xPrev = x > 0 ? x - 1 : x + 1;
        const xNext = x < width - 1 ? x + 1 : x - 1;
        const evenX = (x & 1) === 0;
        const idx = row + x;

        let r = 0;
        let g = 0;
        let b = 0;

        if (evenY) {
          if (evenX) {
            // R pixel
            r = raw[idx];
            g = (raw[row + xPrev] + raw[row + xNext] + raw[rowPrev + x] + raw[rowNext + x]) >> 2;
            b = (raw[rowPrev + xPrev] + raw[rowPrev + xNext] + raw[rowNext + xPrev] + raw[rowNext + xNext]) >> 2;
          } else {
            // G1 pixel (on R row)
            r = (raw[row + xPrev] + raw[row + xNext]) >> 1;
            g = raw[idx];
            b = (raw[rowPrev + x] + raw[rowNext + x]) >> 1;
          }
        } else {
          if (evenX) {
            // G2 pixel (on B row)
            r = (raw[rowPrev + x] + raw[rowNext + x]) >> 1;
            g = raw[idx];
            b = (raw[row + xPrev] + raw[row + xNext]) >> 1;
          } else {
            // B pixel
            r = (raw[rowPrev + xPrev] + raw[rowPrev + xNext] + raw[rowNext + xPrev] + raw[rowNext + xNext]) >> 2;
            g = (raw[row + xPrev] + raw[row + xNext] + raw[rowPrev + x] + raw[rowNext + x]) >> 2;
            b = raw[idx];
          }
        }

        const outOffset = idx << 2;
        dst[outOffset] = lut[r];
        dst[outOffset + 1] = lut[g];
        dst[outOffset + 2] = lut[b];
        dst[outOffset + 3] = 255;
      }
    }
  }

  renderMainViewport(raw: Uint8Array, width: number, height: number): void {
    if (this.mainCanvas.width !== width || this.mainCanvas.height !== height || !this.mainImgData) {
      this.mainCanvas.width = width;
      this.mainCanvas.height = height;
      this.mainImgData = this.mainCtx.createImageData(width, height);
    }

    this.lastMainRaw = raw;
    this.debayerRggbToImageData(raw, width, height, this.mainImgData);
    this.mainCtx.putImageData(this.mainImgData, 0, 0);

    // Draw interactive Focus ROI box overlay
    if (this.showReticle && this.sensorWidth > 0 && this.sensorHeight > 0) {
      const scaleX = width / this.sensorWidth;
      const scaleY = height / this.sensorHeight;
      const rx = this.focusRoi.x * scaleX;
      const ry = this.focusRoi.y * scaleY;
      const rw = this.focusRoi.width * scaleX;
      const rh = this.focusRoi.height * scaleY;

      this.mainCtx.save();
      this.mainCtx.strokeStyle = '#22d3ee';
      this.mainCtx.lineWidth = 2;
      this.mainCtx.setLineDash([6, 4]);
      this.mainCtx.strokeRect(rx, ry, rw, rh);

      this.mainCtx.setLineDash([]);
      this.mainCtx.fillStyle = 'rgba(34, 211, 238, 0.9)';
      this.mainCtx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      this.mainCtx.fillText(
        `FOCUS ROI (${this.focusRoi.width}x${this.focusRoi.height})`,
        rx + 4,
        Math.max(14, ry - 6)
      );
      this.mainCtx.restore();
    }
  }

  /**
   * Debayers a full-resolution RAW8 frame (with the current display stretch) and encodes it as JPEG.
   */
  exportJpeg(raw: Uint8Array, width: number, height: number): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('Canvas 2D context unavailable'));
    const imgData = ctx.createImageData(width, height);
    this.debayerRggbToImageData(raw, width, height, imgData);
    ctx.putImageData(imgData, 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding failed'))),
        'image/jpeg',
        0.92
      );
    });
  }

  renderPipRoi(raw: Uint8Array, width: number, height: number): void {
    if (this.pipCanvas.width !== width || this.pipCanvas.height !== height || !this.pipImgData) {
      this.pipCanvas.width = width;
      this.pipCanvas.height = height;
      this.pipImgData = this.pipCtx.createImageData(width, height);
    }

    this.debayerRggbToImageData(raw, width, height, this.pipImgData);
    this.pipCtx.putImageData(this.pipImgData, 0, 0);
  }
}
