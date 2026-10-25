import type {
  CameraProperties,
  CameraROI,
  ICameraDriver,
  MockCameraParams
} from '../../common/camera-interface.js';
import { dateToSerTicks } from './ser-writer.js';

interface StarObject {
  dx: number;      // offset from sensor center
  dy: number;
  flux: number;    // peak photon rate (e-/ms)
  rWeight: number;
  gWeight: number;
  bWeight: number;
}

interface CraterObject {
  dx: number;
  dy: number;
  radius: number;
  depth: number;
}

export class MockCameraDriver implements ICameraDriver {
  public static readonly MAX_WIDTH = 3840;
  public static readonly MAX_HEIGHT = 2160;
  public static readonly OPTIMAL_FOCUS = 500;

  private exposureUs = 15_000; // Default fast 15ms exposure (~66 FPS capable)
  private gain = 182;          // Default at IMX678 HCG sweet spot
  private bitDepth: 8 | 16 = 8;
  private bandwidth = 85;
  private highSpeed = true;
  private roi: CameraROI = {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    bin: 1
  };

  private params: MockCameraParams = {
    scene: 'JUPITER',
    focuserPosition: 465, // Start slightly defocused so user can immediately test focusing!
    seeingArcsec: 1.0,
    cloudCover: 0.0,
    vibrationShake: false,
    skyOffsetPx: { dx: 0, dy: 0 }
  };

  private capturing = false;
  private timer: NodeJS.Timeout | null = null;
  private frameCounter = 0;
  private startTimeMs = Date.now();
  private lastFocuserChangeMs = 0;
  private sensorTempC = 21.4;

  // Pre-generated synthetic sky catalog
  private stars: StarObject[] = [];
  private craters: CraterObject[] = [];

  // Precomputed high-res base scene cache (regenerated only when defocus changes)
  private patchSize = 512;
  private cachedDefocusKey = '';
  private patchR = new Float32Array(512 * 512);
  private patchG = new Float32Array(512 * 512);
  private patchB = new Float32Array(512 * 512);

  // Fast pseudo-random LUT for zero-allocation Gaussian noise in tight loop
  private noiseLut = new Float32Array(8192);
  private noiseIdx = 0;

  constructor() {
    this.initCatalogs();
    this.initNoiseLut();
    this.rebuildOpticalPatch();
  }

  private initNoiseLut(): void {
    // Box-Muller standard normal distribution N(0, 1)
    for (let i = 0; i < this.noiseLut.length; i += 2) {
      const u1 = Math.max(1e-7, Math.random());
      const u2 = Math.random();
      const mag = Math.sqrt(-2.0 * Math.log(u1));
      this.noiseLut[i] = mag * Math.cos(2.0 * Math.PI * u2);
      this.noiseLut[i + 1] = mag * Math.sin(2.0 * Math.PI * u2);
    }
  }

  private initCatalogs(): void {
    // Deterministic PRNG for reproducible tests and starfields
    let seed = 133742;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    // Bright central Bhatinov/Airy test star + rich star cluster
    this.stars.push({
      dx: 0,
      dy: 0,
      flux: 950,
      rWeight: 0.95,
      gWeight: 1.0,
      bWeight: 1.05
    });

    // Double star companion (great for testing focus resolution!)
    this.stars.push({
      dx: 14,
      dy: -9,
      flux: 520,
      rWeight: 1.15,
      gWeight: 0.9,
      bWeight: 0.65
    });

    for (let i = 0; i < 85; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = 18 + Math.pow(rand(), 0.85) * 210;
      const tempType = rand();
      // Planck color approximation
      const rWeight = tempType < 0.3 ? 1.25 : tempType < 0.7 ? 1.0 : 0.75;
      const gWeight = 1.0;
      const bWeight = tempType < 0.3 ? 0.65 : tempType < 0.7 ? 0.95 : 1.3;
      this.stars.push({
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist,
        flux: 60 + Math.pow(rand(), 3) * 650,
        rWeight,
        gWeight,
        bWeight
      });
    }

    // Lunar craters
    for (let i = 0; i < 36; i++) {
      this.craters.push({
        dx: (rand() - 0.5) * 400,
        dy: (rand() - 0.5) * 400,
        radius: 10 + rand() * 52,
        depth: 0.4 + rand() * 0.6
      });
    }
  }

  /**
   * Computes the IMX678 read noise in electrons RMS as a function of Gain (0..500).
   * Exhibits the physical High Conversion Gain (HCG) step at Gain = 182.
   */
  public getReadNoiseElectrons(gain: number = this.gain): number {
    if (gain < 182) {
      // Low Conversion Gain (LCG) mode: ~2.7e- down to ~1.79e-
      return Math.max(1.5, 2.7 - 0.005 * gain);
    }
    // High Conversion Gain (HCG) kicks in at Gain 182: drops sharply to ~0.85e-
    return 0.85 * Math.pow(10, -(gain - 182) / 1200);
  }

  public isHcgActive(gain: number = this.gain): boolean {
    return gain >= 182;
  }

  /**
   * Computes the optical Point Spread Function (PSF) blur sigma in pixels
   * from focuser position (500 = diffraction-limited best focus).
   */
  public getDefocusSigmaPx(): number {
    const deltaSteps = Math.abs(this.params.focuserPosition - MockCameraDriver.OPTIMAL_FOCUS);
    const airySigma = 0.65; // Diffraction-limited Airy core at f/8 on 2.0um pixels
    const defocusBlur = deltaSteps * 0.085; // ~8.5px blur at 100 steps off focus
    const seeingBlur = this.params.seeingArcsec * 0.35;
    return Math.sqrt(airySigma * airySigma + defocusBlur * defocusBlur + seeingBlur * seeingBlur);
  }

  /**
   * Rebuilds the 512x512 central target patch (unblurred base + separable Gaussian PSF blur)
   * whenever the scene or focuser position changes.
   */
  private rebuildOpticalPatch(): void {
    const sigma = this.getDefocusSigmaPx();
    const key = `${this.params.scene}:${sigma.toFixed(2)}`;
    if (key === this.cachedDefocusKey) return;
    this.cachedDefocusKey = key;

    const N = this.patchSize;
    const half = N / 2;
    const rawR = new Float32Array(N * N);
    const rawG = new Float32Array(N * N);
    const rawB = new Float32Array(N * N);

    if (this.params.scene === 'JUPITER') {
      const rx = 110; // Equatorial radius in pixels
      const ry = 102; // Polar radius (oblate planet)

      for (let y = 0; y < N; y++) {
        const dy = y - half;
        for (let x = 0; x < N; x++) {
          const dx = x - half;
          const idx = y * N + x;
          const normDistSq = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);

          if (normDistSq <= 1.0) {
            // 3D sphere normal z component for limb darkening
            const mu = Math.sqrt(Math.max(0, 1.0 - normDistSq));
            const limb = Math.pow(mu, 0.42);

            // Latitude bands + fine festoon turbulence (high spatial frequency for focus test!)
            const lat = dy / ry;
            const lon = dx / (rx * Math.sqrt(Math.max(0.05, 1.0 - lat * lat)));

            const beltPattern =
              Math.cos(lat * 15.0) * 0.22 +
              Math.sin(lat * 31.0 + Math.sin(lon * 6.0) * 0.4) * 0.12 +
              Math.cos(lat * 68.0 + lon * 14.0) * 0.06;

            // Great Red Spot at southern tropical zone
            const grsDx = (dx - 26) / 22;
            const grsDy = (dy - 34) / 14;
            const grsDistSq = grsDx * grsDx + grsDy * grsDy;
            const grsSwirl =
              grsDistSq < 1.3
                ? Math.exp(-grsDistSq * 1.8) * (0.45 + 0.12 * Math.cos(Math.atan2(grsDy, grsDx) * 4))
                : 0;

            const baseFlux = 420 * limb;
            rawR[idx] = baseFlux * (0.95 + beltPattern * 0.9 + grsSwirl * 0.75);
            rawG[idx] = baseFlux * (0.82 + beltPattern * 1.1 - grsSwirl * 0.35);
            rawB[idx] = baseFlux * (0.64 + beltPattern * 1.35 - grsSwirl * 0.5);
          }
        }
      }

      // Add 4 Galilean moons (Io, Europa, Ganymede, Callisto) as sharp point-like discs
      const moons = [
        { x: -195, y: -14, r: 2.2, flux: 620, cr: 1.15, cg: 0.95, cb: 0.65 }, // Io
        { x: -145, y: -8, r: 1.9, flux: 560, cr: 0.95, cg: 1.0, cb: 1.05 },  // Europa
        { x: 158, y: 11, r: 2.8, flux: 680, cr: 1.0, cg: 0.95, cb: 0.85 },   // Ganymede
        { x: 224, y: 19, r: 2.4, flux: 430, cr: 0.9, cg: 0.9, cb: 0.95 }     // Callisto
      ];

      for (const m of moons) {
        const cx = half + m.x;
        const cy = half + m.y;
        const box = 6;
        for (let py = Math.floor(cy - box); py <= Math.ceil(cy + box); py++) {
          for (let px = Math.floor(cx - box); px <= Math.ceil(cx + box); px++) {
            if (px >= 0 && px < N && py >= 0 && py < N) {
              const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
              if (d2 <= m.r * m.r) {
                const idx = py * N + px;
                rawR[idx] += m.flux * m.cr;
                rawG[idx] += m.flux * m.cg;
                rawB[idx] += m.flux * m.cb;
              }
            }
          }
        }
      }
    } else if (this.params.scene === 'SATURN') {
      const tilt = 0.42;
      for (let y = 0; y < N; y++) {
        const dy = y - half;
        for (let x = 0; x < N; x++) {
          const dx = x - half;
          const idx = y * N + x;
          // Rotate slightly
          const rx = dx * 0.96 - dy * 0.28;
          const ry = dx * 0.28 + dy * 0.96;

          // Ring plane radius
          const ringR = Math.sqrt(rx * rx + (ry / tilt) * (ry / tilt));
          const globeNorm = (rx * rx) / (68 * 68) + (ry * ry) / (60 * 60);

          // Rings with sharp Cassini Division (between r=118 and r=125)
          let ringFlux = 0;
          if (ringR >= 82 && ringR <= 165) {
            const inCassini = ringR >= 118 && ringR <= 125;
            if (!inCassini) {
              const ringBand = ringR < 118 ? 0.95 : 0.72;
              const fineGrooves = 0.88 + 0.12 * Math.sin(ringR * 1.9);
              ringFlux = 390 * ringBand * fineGrooves;
            }
          }

          if (globeNorm <= 1.0 && (ry < 0 || ringFlux === 0)) {
            const limb = Math.pow(Math.sqrt(1.0 - globeNorm), 0.45);
            const band = 0.9 + 0.1 * Math.cos((ry / 60) * 14.0);
            const f = 410 * limb * band;
            rawR[idx] = f * 1.08;
            rawG[idx] = f * 0.94;
            rawB[idx] = f * 0.68;
          } else if (ringFlux > 0) {
            rawR[idx] = ringFlux * 1.04;
            rawG[idx] = ringFlux * 0.96;
            rawB[idx] = ringFlux * 0.82;
          }
        }
      }
    } else if (this.params.scene === 'MOON') {
      for (let y = 0; y < N; y++) {
        const dy = y - half;
        for (let x = 0; x < N; x++) {
          const dx = x - half;
          const idx = y * N + x;
          // Terminator illumination gradient + fine regolith texture
          let lum = 260 + 80 * Math.sin(dx * 0.015) * Math.cos(dy * 0.015);
          lum += 35 * Math.sin(dx * 0.25 + dy * 0.18) + 22 * Math.cos(dx * 0.65 - dy * 0.52);

          for (const c of this.craters) {
            const cdx = dx - c.dx;
            const cdy = dy - c.dy;
            const dist = Math.sqrt(cdx * cdx + cdy * cdy);
            if (dist < c.radius * 1.25) {
              const norm = dist / c.radius;
              if (norm > 0.85 && norm < 1.15) {
                // Sharp crater rim highlight / shadow
                const sunShade = cdx / (dist + 0.1);
                lum += 210 * c.depth * sunShade;
              } else if (norm <= 0.85) {
                // Crater floor shadow + central peak
                lum -= 95 * c.depth;
                if (norm < 0.18) {
                  lum += 170 * c.depth;
                }
              }
            }
          }
          const clamped = Math.max(15, lum);
          rawR[idx] = clamped * 0.96;
          rawG[idx] = clamped * 0.95;
          rawB[idx] = clamped * 0.91;
        }
      }
    } else {
      // STARFIELD: Analytical stars rendered as delta/tight cores before PSF convolution
      for (const s of this.stars) {
        const cx = half + s.dx;
        const cy = half + s.dy;
        const ix = Math.round(cx);
        const iy = Math.round(cy);
        if (ix >= 2 && ix < N - 2 && iy >= 2 && iy < N - 2) {
          // Deposit total star integrated flux into 3x3 subpixel core
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const w = Math.exp(-((ox * ox + oy * oy) / 0.6));
              const idx = (iy + oy) * N + (ix + ox);
              rawR[idx] += s.flux * 8.0 * w * s.rWeight;
              rawG[idx] += s.flux * 8.0 * w * s.gWeight;
              rawB[idx] += s.flux * 8.0 * w * s.bWeight;
            }
          }
        }
      }
    }

    // Apply separable 2D Gaussian optical defocus + seeing PSF blur
    this.convolveSeparableGaussian(rawR, this.patchR, N, N, sigma);
    this.convolveSeparableGaussian(rawG, this.patchG, N, N, sigma);
    this.convolveSeparableGaussian(rawB, this.patchB, N, N, sigma);
  }

  private convolveSeparableGaussian(
    src: Float32Array,
    dst: Float32Array,
    width: number,
    height: number,
    sigma: number
  ): void {
    const radius = Math.min(28, Math.max(1, Math.ceil(sigma * 2.6)));
    const kernelSize = radius * 2 + 1;
    const kernel = new Float32Array(kernelSize);
    let sum = 0;
    const inv2SigmaSq = 1.0 / (2.0 * sigma * sigma);
    for (let i = -radius; i <= radius; i++) {
      const val = Math.exp(-(i * i) * inv2SigmaSq);
      kernel[i + radius] = val;
      sum += val;
    }
    for (let i = 0; i < kernelSize; i++) {
      kernel[i] /= sum;
    }

    const tmp = new Float32Array(width * height);

    // Horizontal pass
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = Math.min(width - 1, Math.max(0, x + k));
          acc += src[rowOffset + sx] * kernel[k + radius];
        }
        tmp[rowOffset + x] = acc;
      }
    }

    // Vertical pass
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const sy = Math.min(height - 1, Math.max(0, y + k));
          acc += tmp[sy * width + x] * kernel[k + radius];
        }
        dst[rowOffset + x] = acc;
      }
    }
  }

  async initialize(): Promise<CameraProperties> {
    return {
      cameraId: 0,
      name: 'ZWO ASI678MC (Simulated)',
      maxWidth: MockCameraDriver.MAX_WIDTH,
      maxHeight: MockCameraDriver.MAX_HEIGHT,
      pixelSizeUm: 2.0,
      isColor: true,
      bayerPattern: 'RGGB',
      bitDepth: 12,
      isMock: true
    };
  }

  async setExposure(microseconds: number): Promise<void> {
    if (microseconds < 10 || microseconds > 3_600_000_000) {
      throw new Error(`Invalid exposure ${microseconds} us`);
    }
    this.exposureUs = Math.round(microseconds);
  }

  async setGain(gain: number): Promise<void> {
    if (gain < 0 || gain > 500) {
      throw new Error(`Invalid gain ${gain}: must be between 0 and 500`);
    }
    this.gain = Math.round(gain);
  }

  async setBitDepth(bitDepth: 8 | 16): Promise<void> {
    this.bitDepth = bitDepth;
  }

  async setBandwidth(bandwidth: number): Promise<void> {
    this.bandwidth = Math.max(40, Math.min(100, Math.round(bandwidth)));
  }

  async setHighSpeedMode(enabled: boolean): Promise<void> {
    this.highSpeed = enabled;
  }

  async setROI(roi: CameraROI): Promise<CameraROI> {
    // Enforce ZWO SDK hardware alignment rules
    if (roi.width % 8 !== 0) {
      throw new Error(`ASI_ERROR_INVALID_SIZE: ROI width (${roi.width}) must be a multiple of 8`);
    }
    if (roi.height % 2 !== 0) {
      throw new Error(`ASI_ERROR_INVALID_SIZE: ROI height (${roi.height}) must be a multiple of 2`);
    }
    if (roi.width < 64 || roi.height < 64 || roi.width > MockCameraDriver.MAX_WIDTH || roi.height > MockCameraDriver.MAX_HEIGHT) {
      throw new Error(`ASI_ERROR_INVALID_SIZE: ROI (${roi.width}x${roi.height}) out of sensor bounds`);
    }
    const x = Math.max(0, Math.min(MockCameraDriver.MAX_WIDTH - roi.width, Math.floor(roi.x / 2) * 2));
    const y = Math.max(0, Math.min(MockCameraDriver.MAX_HEIGHT - roi.height, Math.floor(roi.y / 2) * 2));
    const bin = roi.bin === 2 ? 2 : 1;

    this.roi = { x, y, width: roi.width, height: roi.height, bin };
    return { ...this.roi };
  }

  async getTemperature(): Promise<number> {
    return Number(this.sensorTempC.toFixed(1));
  }

  setMockParams(params: Partial<MockCameraParams>): void {
    const focuserChanged =
      params.focuserPosition !== undefined &&
      params.focuserPosition !== this.params.focuserPosition;

    this.params = {
      ...this.params,
      ...params,
      skyOffsetPx: params.skyOffsetPx
        ? { ...params.skyOffsetPx }
        : this.params.skyOffsetPx
    };

    if (focuserChanged) {
      this.lastFocuserChangeMs = Date.now();
    }

    this.rebuildOpticalPatch();
  }

  getMockParams(): MockCameraParams {
    return {
      ...this.params,
      skyOffsetPx: { ...this.params.skyOffsetPx }
    };
  }

  /**
   * Generates a single synthetic frame matching the current ROI, Gain, Exposure,
   * Bayer RGGB CFA mosaic, defocus PSF, seeing jitter, and hand-focusing shake.
   */
  public generateFrameBuffer(nowMs: number = Date.now()): Buffer {
    this.rebuildOpticalPatch();

    const { width, height, x: roiX, y: roiY } = this.roi;
    const is16 = this.bitDepth === 16;
    const buf = Buffer.allocUnsafe(width * height * (is16 ? 2 : 1));

    // Time in seconds for atmospheric seeing and focuser hand-vibration simulation
    const tSec = (nowMs - this.startTimeMs) * 0.001;
    const timeSinceFocusTouchSec = (nowMs - this.lastFocuserChangeMs) * 0.001;

    // Atmospheric seeing wander (slow + fast harmonic components)
    const seeingAmp = this.params.seeingArcsec * 0.85;
    let jitterX =
      seeingAmp * (0.6 * Math.sin(tSec * 4.3) + 0.4 * Math.cos(tSec * 13.7));
    let jitterY =
      seeingAmp * (0.6 * Math.cos(tSec * 3.9) + 0.4 * Math.sin(tSec * 15.1));

    // Hand-on-focuser vibration shake! When turning the manual focuser knob (or within 0.6s of touching it),
    // the telescope mount oscillates at ~9 Hz, shaking the image position across the sensor—
    // demonstrating why tracking the high-FPS focus score is much easier than eyeballing a shaking planet!
    if (this.params.vibrationShake && timeSinceFocusTouchSec < 0.65) {
      const decay = Math.exp(-timeSinceFocusTouchSec * 4.5);
      jitterX += 14.0 * decay * Math.sin(tSec * 58.0);
      jitterY += 11.0 * decay * Math.cos(tSec * 67.0);
    }

    // Conversion gain & noise parameters
    const linearGain = Math.pow(10, this.gain / 200.0);
    const elecPerAdu12 = 2.752 / linearGain; // 11270 e- FWC / 4095 ADU at Gain 0
    const readNoiseElec = this.getReadNoiseElectrons(this.gain);
    const expMs = this.exposureUs / 1000.0;
    const expScale = Math.min(25.0, expMs / 15.0); // Normalized to 15ms reference exposure
    const biasOffset12 = 64; // Pedestal offset in 12-bit ADU
    const skyBgElec = 3.5 * expScale;

    // Center of the optical patch in current ROI coordinates
    const sensorCenterX = MockCameraDriver.MAX_WIDTH / 2 + this.params.skyOffsetPx.dx + jitterX;
    const sensorCenterY = MockCameraDriver.MAX_HEIGHT / 2 + this.params.skyOffsetPx.dy + jitterY;
    const patchOriginX = Math.round(sensorCenterX - roiX - this.patchSize / 2);
    const patchOriginY = Math.round(sensorCenterY - roiY - this.patchSize / 2);

    const N = this.patchSize;
    const pR = this.patchR;
    const pG = this.patchG;
    const pB = this.patchB;
    const lut = this.noiseLut;
    const lutMask = lut.length - 1;
    let nIdx = this.noiseIdx;

    for (let y = 0; y < height; y++) {
      const py = y - patchOriginY;
      const inPatchY = py >= 0 && py < N;
      const isEvenRow = (y & 1) === 0;
      const rowOffset = y * width;
      const patchRowOffset = py * N;

      for (let x = 0; x < width; x++) {
        const px = x - patchOriginX;
        const isEvenCol = (x & 1) === 0;

        // Sample true RGGB Bayer channel:
        // Even Row, Even Col = R
        // Even Row, Odd Col  = G1
        // Odd Row, Even Col  = G2
        // Odd Row, Odd Col   = B
        let signalRate = 0;
        if (inPatchY && px >= 0 && px < N) {
          const pIdx = patchRowOffset + px;
          if (isEvenRow) {
            signalRate = isEvenCol ? pR[pIdx] : pG[pIdx];
          } else {
            signalRate = isEvenCol ? pG[pIdx] : pB[pIdx];
          }
        }

        const meanElectrons = signalRate * expScale + skyBgElec;
        // Total noise variance in electrons: Poisson shot noise (meanElectrons) + Read Noise^2
        const noiseSigmaElec = Math.sqrt(meanElectrons + readNoiseElec * readNoiseElec);
        const z = lut[nIdx & lutMask];
        nIdx = (nIdx + 1) & lutMask;

        const totalElectrons = meanElectrons + z * noiseSigmaElec;
        const adu12 = Math.max(
          0,
          Math.min(4095, Math.round(biasOffset12 + totalElectrons / elecPerAdu12))
        );

        const outIdx = rowOffset + x;
        if (is16) {
          // ZWO RAW16 packs 12-bit ADC left-shifted by 4 bits into 16-bit LE
          buf.writeUInt16LE(adu12 << 4, outIdx * 2);
        } else {
          // ZWO RAW8 uses upper 8 bits of 12-bit ADC
          buf[outIdx] = adu12 >> 4;
        }
      }
    }

    this.noiseIdx = (nIdx + 17) & lutMask;
    return buf;
  }

  /**
   * Computes realistic frame interval in milliseconds based on exposure and ROI USB bandwidth limit.
   */
  public getFrameIntervalMs(): number {
    const pixelCount = this.roi.width * this.roi.height;
    const fullPixels = MockCameraDriver.MAX_WIDTH * MockCameraDriver.MAX_HEIGHT;
    const maxFpsFull = this.bitDepth === 16 ? 24.2 : 47.5;
    const roiMaxFps = Math.min(120, maxFpsFull * (fullPixels / Math.max(250_000, pixelCount)));
    const minIntervalMs = 1000 / roiMaxFps;
    const expMs = this.exposureUs / 1000;
    return Math.max(8, Math.max(expMs, minIntervalMs));
  }

  async startCapture(
    onFrame: (frame: Buffer, frameNumber: number, timestampUs: bigint) => void
  ): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;

    const tick = () => {
      if (!this.capturing) return;
      const t0 = Date.now();
      this.frameCounter++;
      // Gradual thermal stabilization toward 26.8C
      this.sensorTempC += (26.8 - this.sensorTempC) * 0.002;

      const frame = this.generateFrameBuffer(t0);
      onFrame(frame, this.frameCounter, dateToSerTicks(t0, 0));

      const elapsed = Date.now() - t0;
      const waitMs = Math.max(4, Math.round(this.getFrameIntervalMs() - elapsed));
      if (this.capturing) {
        this.timer = setTimeout(tick, waitMs);
      }
    };

    this.timer = setTimeout(tick, 5);
  }

  async stopCapture(): Promise<void> {
    this.capturing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async close(): Promise<void> {
    await this.stopCapture();
  }
}
