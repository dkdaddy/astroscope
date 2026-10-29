import { parentPort } from 'node:worker_threads';
import path from 'node:path';
import type {
  CameraROI,
  ICameraDriver,
  MockCameraParams
} from '../../common/camera-interface.js';
import {
  FRAME_TYPE,
  PIXEL_FORMAT,
  packBinaryFrame,
  type FocusROI,
  type LiveStackMode
} from '../../common/protocol.js';
import { MockCameraDriver } from './mock-camera.js';
import { ZwoKoffiDriver } from './camera-driver.js';
import { SerWriter } from './ser-writer.js';
import { DEFAULT_STACK_WINDOW_SEC, LiveStacker } from './live-stack.js';
import { createLogger } from '../logger.js';

const log = createLogger('camera-worker');

/**
 * Computes Bayer super-pixel (2x2 RGGB -> luminance) Laplacian variance on a sub-ROI
 * directly inside the worker thread at full capture FPS so focus score updates remain
 * instantaneous even when the viewport preview stream is downsampled.
 */
export function computeBayerRoiFocusScore(
  frame: Buffer,
  frameWidth: number,
  frameHeight: number,
  roi: FocusROI,
  is16Bit = false
): number {
  const x0 = Math.max(0, Math.min(frameWidth - 16, Math.floor(roi.x / 2) * 2));
  const y0 = Math.max(0, Math.min(frameHeight - 16, Math.floor(roi.y / 2) * 2));
  const w = Math.max(16, Math.min(frameWidth - x0, Math.floor(roi.width / 2) * 2));
  const h = Math.max(16, Math.min(frameHeight - y0, Math.floor(roi.height / 2) * 2));

  const lumaW = w >> 1;
  const lumaH = h >> 1;
  if (lumaW < 4 || lumaH < 4) return 0;

  const luma = new Float32Array(lumaW * lumaH);

  for (let sy = 0; sy < lumaH; sy++) {
    const r0 = (y0 + sy * 2) * frameWidth + x0;
    const r1 = (y0 + sy * 2 + 1) * frameWidth + x0;
    const outRow = sy * lumaW;
    for (let sx = 0; sx < lumaW; sx++) {
      const c = sx * 2;
      if (is16Bit) {
        const vR = frame.readUInt16LE((r0 + c) * 2);
        const vG1 = frame.readUInt16LE((r0 + c + 1) * 2);
        const vG2 = frame.readUInt16LE((r1 + c) * 2);
        const vB = frame.readUInt16LE((r1 + c + 1) * 2);
        luma[outRow + sx] = 0.25 * (vR + vG1 + vG2 + vB);
      } else {
        const vR = frame[r0 + c];
        const vG1 = frame[r0 + c + 1];
        const vG2 = frame[r1 + c];
        const vB = frame[r1 + c + 1];
        luma[outRow + sx] = 0.25 * (vR + vG1 + vG2 + vB);
      }
    }
  }

  // Light 3x3 binomial smoothing suppresses per-pixel sensor noise, which otherwise
  // dominates the Laplacian and gives a high score floor even when badly defocused.
  const tmp = new Float32Array(lumaW * lumaH);
  for (let y = 0; y < lumaH; y++) {
    const row = y * lumaW;
    for (let x = 1; x < lumaW - 1; x++) {
      const i = row + x;
      tmp[i] = 0.25 * luma[i - 1] + 0.5 * luma[i] + 0.25 * luma[i + 1];
    }
  }
  const smooth = new Float32Array(lumaW * lumaH);
  for (let y = 1; y < lumaH - 1; y++) {
    const row = y * lumaW;
    for (let x = 0; x < lumaW; x++) {
      const i = row + x;
      smooth[i] = 0.25 * tmp[i - lumaW] + 0.5 * tmp[i] + 0.25 * tmp[i + lumaW];
    }
  }

  // Laplacian variance normalized by mean brightness^2, so changes in light level
  // (clouds, sun, exposure, gain) don't move the score; only sharpness does.
  let sum = 0;
  let sumSq = 0;
  let lumaSum = 0;
  const count = (lumaW - 4) * (lumaH - 4);

  for (let y = 2; y < lumaH - 2; y++) {
    const row = y * lumaW;
    const prev = (y - 1) * lumaW;
    const next = (y + 1) * lumaW;
    for (let x = 2; x < lumaW - 2; x++) {
      lumaSum += luma[row + x];
      const lap =
        smooth[prev + x] +
        smooth[row + x - 1] -
        4 * smooth[row + x] +
        smooth[row + x + 1] +
        smooth[next + x];
      sum += lap;
      sumSq += lap * lap;
    }
  }

  const meanLap = sum / count;
  const variance = Math.max(0, sumSq / count - meanLap * meanLap);
  const meanLuma = Math.max(1, lumaSum / count);
  // Scaled so real terrestrial/lunar frames land roughly in the 1-100+ range used by the HUD.
  return Number(((100000 * variance) / (meanLuma * meanLuma)).toFixed(2));
}

/**
 * Extracts a 1:1 native-resolution RAW8 Bayer RGGB sub-rectangle for the Focus Zoom PIP window.
 */
function cropRaw8Subframe(
  frame: Buffer,
  frameWidth: number,
  frameHeight: number,
  roi: FocusROI,
  is16Bit = false
): { crop: Uint8Array; width: number; height: number } {
  const x0 = Math.max(0, Math.min(frameWidth - 16, Math.floor(roi.x / 2) * 2));
  const y0 = Math.max(0, Math.min(frameHeight - 16, Math.floor(roi.y / 2) * 2));
  const w = Math.max(16, Math.min(frameWidth - x0, Math.floor(roi.width / 2) * 2));
  const h = Math.max(16, Math.min(frameHeight - y0, Math.floor(roi.height / 2) * 2));

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const srcRow = (y0 + y) * frameWidth + x0;
    const dstRow = y * w;
    if (is16Bit) {
      for (let x = 0; x < w; x++) {
        out[dstRow + x] = frame.readUInt16LE((srcRow + x) * 2) >> 8;
      }
    } else {
      frame.copy(out, dstRow, srcRow, srcRow + w);
    }
  }

  return { crop: out, width: w, height: h };
}

/**
 * Downsamples a large Bayer RGGB frame by factor of 2 (preserving RGGB Bayer pattern via 2x2 step)
 * so network preview stays < 5 Mbps while full resolution is used for SER recording and 1:1 ROI focus.
 */
function downsampleBayerFrame(
  frame: Buffer,
  width: number,
  height: number,
  is16Bit: boolean
): { data: Uint8Array; outWidth: number; outHeight: number; binFactor: number } {
  if (width <= 1280 && !is16Bit) {
    return {
      data: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
      outWidth: width,
      outHeight: height,
      binFactor: 1
    };
  }

  // Step by 2 super-pixels (4 sensor pixels) when > 2560 wide, or 1 super-pixel (2 sensor pixels)
  const binFactor = width > 2560 ? 2 : width > 1280 ? 2 : 1;
  if (binFactor === 1) {
    const out = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      out[i] = frame.readUInt16LE(i * 2) >> 8;
    }
    return { data: out, outWidth: width, outHeight: height, binFactor: 1 };
  }

  const outSuperW = Math.floor(width / (2 * binFactor));
  const outSuperH = Math.floor(height / (2 * binFactor));
  const outWidth = outSuperW * 2;
  const outHeight = outSuperH * 2;
  const out = new Uint8Array(outWidth * outHeight);

  for (let sy = 0; sy < outSuperH; sy++) {
    const srcY = sy * 2 * binFactor;
    const dstY = sy * 2;
    const srcRow0 = srcY * width;
    const srcRow1 = (srcY + 1) * width;
    const dstRow0 = dstY * outWidth;
    const dstRow1 = (dstY + 1) * outWidth;

    for (let sx = 0; sx < outSuperW; sx++) {
      const srcX = sx * 2 * binFactor;
      const dstX = sx * 2;
      if (is16Bit) {
        out[dstRow0 + dstX] = frame.readUInt16LE((srcRow0 + srcX) * 2) >> 8;
        out[dstRow0 + dstX + 1] = frame.readUInt16LE((srcRow0 + srcX + 1) * 2) >> 8;
        out[dstRow1 + dstX] = frame.readUInt16LE((srcRow1 + srcX) * 2) >> 8;
        out[dstRow1 + dstX + 1] = frame.readUInt16LE((srcRow1 + srcX + 1) * 2) >> 8;
      } else {
        out[dstRow0 + dstX] = frame[srcRow0 + srcX];
        out[dstRow0 + dstX + 1] = frame[srcRow0 + srcX + 1];
        out[dstRow1 + dstX] = frame[srcRow1 + srcX];
        out[dstRow1 + dstX + 1] = frame[srcRow1 + srcX + 1];
      }
    }
  }

  return { data: out, outWidth, outHeight, binFactor };
}

// Worker runtime state when launched inside a worker_thread
if (parentPort) {
  let driver: ICameraDriver;
  let isMock = true;
  let currentRoi: CameraROI = { x: 0, y: 0, width: 1920, height: 1080, bin: 1 };
  let focusRoi: FocusROI = { x: 760, y: 340, width: 400, height: 400 };
  let gain = 182;
  let exposureUs = 15_000;
  let bitDepth: 8 | 16 = 8;
  let serWriter: SerWriter | null = null;
  let recordLimitType: 'FRAMES' | 'SECONDS' | 'NONE' = 'NONE';
  let recordLimitValue = 0;
  let recordStartMs = 0;
  let recordingFile = '';
  let snapshotRequested = false;
  // Each mode remembers its own window length (seconds)
  const stackWindowSec: Record<LiveStackMode, number> = { ...DEFAULT_STACK_WINDOW_SEC };
  const liveStack = new LiveStacker({ mode: 'lucky', windowMs: stackWindowSec.lucky * 1000 });
  let liveStackEnabled = false;

  // FPS tracking
  let fpsFrameCount = 0;
  let lastFpsCalcMs = Date.now();
  let measuredFps = 0;
  let lastPreviewSentMs = 0;
  let latestFocusScore = 0;

  const initWorker = async () => {
    const forceMock = process.env.ASTROSCOPE_MOCK === '1';
    const zwo = new ZwoKoffiDriver();

    if (!forceMock && zwo.isAvailable()) {
      driver = zwo;
      isMock = false;
    } else {
      driver = new MockCameraDriver();
      isMock = true;
    }
    log.info(`Startup driver: ${isMock ? 'simulator' : 'real camera'} (ASTROSCOPE_MOCK=${process.env.ASTROSCOPE_MOCK ?? 'unset'})`);

    const props = await driver.initialize();
    if (!isMock) {
      currentRoi = { x: 0, y: 0, width: props.maxWidth, height: props.maxHeight, bin: 1 };
    }
    await driver.setGain(gain);
    await driver.setExposure(exposureUs);
    currentRoi = await driver.setROI(currentRoi);
    focusRoi = {
      ...focusRoi,
      x: Math.floor((currentRoi.width - focusRoi.width) / 4) * 2,
      y: Math.floor((currentRoi.height - focusRoi.height) / 4) * 2
    };
    log.info('Hardware ROI set', { roi: currentRoi, focusRoi });

    parentPort?.postMessage({
      type: 'INITIALIZED',
      properties: props,
      roi: currentRoi,
      focusRoi
    });

    await driver.startCapture(handleFrame);
  };

  function handleFrame(frameBuf: Buffer, frameNumber: number, timestampTicks: bigint): void {
      const now = Date.now();
      fpsFrameCount++;
      if (now - lastFpsCalcMs >= 500) {
        measuredFps = Number(((fpsFrameCount * 1000) / (now - lastFpsCalcMs)).toFixed(1));
        fpsFrameCount = 0;
        lastFpsCalcMs = now;
      }

      // 1. Write to SER file if recording is active
      if (serWriter) {
        try {
          serWriter.writeFrame(frameBuf, timestampTicks);
          const count = serWriter.getRecordedFrames();
          const elapsedSec = (now - recordStartMs) / 1000;
          if (
            (recordLimitType === 'FRAMES' && count >= recordLimitValue) ||
            (recordLimitType === 'SECONDS' && elapsedSec >= recordLimitValue)
          ) {
            serWriter.close();
            serWriter = null;
          }
        } catch {
          serWriter?.close();
          serWriter = null;
        }
      }

      // 2. Always compute real-time focus score on the active focus ROI at full camera framerate!
      latestFocusScore = computeBayerRoiFocusScore(
        frameBuf,
        currentRoi.width,
        currentRoi.height,
        focusRoi,
        bitDepth === 16
      );

      // Emit high-rate focus telemetry packet every frame (up to 60Hz) for zero-lag manual focusing
      parentPort?.postMessage({
        type: 'FOCUS_SCORE',
        frameNumber,
        focusScore: latestFocusScore,
        fps: measuredFps
      });

      // Live stack: viewport, focus PIP and snapshots show the aligned rolling stack.
      // Focus score and SER recording always use the live frame; in lucky mode the focus
      // score is the per-frame quality used to pick the sharpest frames.
      let displayFrame: Buffer = frameBuf;
      let display16 = bitDepth === 16;
      if (liveStackEnabled) {
        const stacked = liveStack.push(
          frameBuf,
          currentRoi.width,
          currentRoi.height,
          display16,
          now,
          latestFocusScore
        );
        if (stacked) {
          displayFrame = stacked;
          display16 = false;
        }
      }

      // Full-resolution single frame for JPG snapshot (encoded in the browser)
      if (snapshotRequested) {
        snapshotRequested = false;
        const pixelCount = currentRoi.width * currentRoi.height;
        const raw8 = new Uint8Array(pixelCount);
        if (display16) {
          for (let i = 0; i < pixelCount; i++) raw8[i] = displayFrame.readUInt16LE(i * 2) >> 8;
        } else {
          displayFrame.copy(raw8, 0, 0, pixelCount);
        }
        const packet = packBinaryFrame(
          {
            frameNumber,
            width: currentRoi.width,
            height: currentRoi.height,
            pixelFormat: PIXEL_FORMAT.RAW8_RGGB,
            frameType: FRAME_TYPE.SNAPSHOT,
            binFactor: 1,
            serverScore: latestFocusScore
          },
          raw8
        );
        const snapshotBuffer = packet.buffer.slice(
          packet.byteOffset,
          packet.byteOffset + packet.byteLength
        ) as ArrayBuffer;
        parentPort?.postMessage({ type: 'SNAPSHOT', buffer: snapshotBuffer }, [snapshotBuffer]);
        log.info(`Snapshot grabbed (${currentRoi.width}x${currentRoi.height}, frame ${frameNumber}${liveStackEnabled ? `, stacked ${liveStack.frameCount}` : ''})`);
      }

      // 3. Throttle full binary viewport preview + 1:1 ROI crop to ~25 FPS max
      if (now - lastPreviewSentMs >= 38) {
        lastPreviewSentMs = now;

        // Send binned full viewport frame
        const { data, outWidth, outHeight, binFactor } = downsampleBayerFrame(
          displayFrame,
          currentRoi.width,
          currentRoi.height,
          display16
        );
        const viewportPacket = packBinaryFrame(
          {
            frameNumber,
            width: outWidth,
            height: outHeight,
            pixelFormat: PIXEL_FORMAT.RAW8_RGGB,
            frameType: FRAME_TYPE.VIEWPORT_PREVIEW,
            binFactor,
            serverScore: latestFocusScore
          },
          data
        );

        // Send 1:1 native resolution focus ROI crop for the zoom PIP window
        const { crop, width: cropW, height: cropH } = cropRaw8Subframe(
          displayFrame,
          currentRoi.width,
          currentRoi.height,
          focusRoi,
          display16
        );
        const roiPacket = packBinaryFrame(
          {
            frameNumber,
            width: cropW,
            height: cropH,
            pixelFormat: PIXEL_FORMAT.RAW8_RGGB,
            frameType: FRAME_TYPE.FOCUS_ROI_CROP,
            binFactor: 1,
            serverScore: latestFocusScore
          },
          crop
        );

        parentPort?.postMessage(
          {
            type: 'BINARY_FRAMES',
            viewportBuffer: viewportPacket.buffer.slice(
              viewportPacket.byteOffset,
              viewportPacket.byteOffset + viewportPacket.byteLength
            ),
            roiBuffer: roiPacket.buffer.slice(
              roiPacket.byteOffset,
              roiPacket.byteOffset + roiPacket.byteLength
            )
          },
          [
            viewportPacket.buffer.slice(
              viewportPacket.byteOffset,
              viewportPacket.byteOffset + viewportPacket.byteLength
            ) as ArrayBuffer,
            roiPacket.buffer.slice(
              roiPacket.byteOffset,
              roiPacket.byteOffset + roiPacket.byteLength
            ) as ArrayBuffer
          ]
        );
      }
  }

  const switchDriverMode = async (useMock: boolean) => {
    log.info(`Mode switch requested: ${useMock ? 'simulator' : 'real camera'}`);
    const zwo = new ZwoKoffiDriver();
    const realAvailable = !useMock && zwo.isAvailable();
    if (!useMock && !realAvailable) {
      log.warn('Real camera requested but not available; staying on simulator');
    }

    if (driver) {
      try { await driver.stopCapture(); } catch (err) { log.warn('stopCapture failed', err); }
      try { await driver.close(); } catch (err) { log.warn('close failed', err); }
    }

    let props;
    if (realAvailable) {
      driver = zwo;
      isMock = false;
      try {
        props = await driver.initialize();
      } catch (err) {
        log.error('Real camera initialize failed; falling back to simulator', err);
        driver = new MockCameraDriver();
        isMock = true;
        props = await driver.initialize();
      }
    } else {
      driver = new MockCameraDriver();
      isMock = true;
      props = await driver.initialize();
    }
    log.info(`Active driver: ${isMock ? 'simulator' : 'real camera'}`, { name: props.name });
    if (!isMock) {
      currentRoi = { x: 0, y: 0, width: props.maxWidth, height: props.maxHeight, bin: 1 };
    }

    await driver.setGain(gain);
    await driver.setExposure(exposureUs);
    currentRoi = await driver.setROI(currentRoi);
    focusRoi = {
      x: Math.max(0, Math.min(currentRoi.width - focusRoi.width, Math.floor((currentRoi.width - focusRoi.width) / 4) * 2)),
      y: Math.max(0, Math.min(currentRoi.height - focusRoi.height, Math.floor((currentRoi.height - focusRoi.height) / 4) * 2)),
      width: Math.min(focusRoi.width, currentRoi.width),
      height: Math.min(focusRoi.height, currentRoi.height)
    };
    log.info('Hardware ROI set', { roi: currentRoi, focusRoi });

    parentPort?.postMessage({
      type: 'INITIALIZED',
      properties: props,
      roi: currentRoi,
      focusRoi
    });

    liveStack.reset();
    await driver.startCapture(handleFrame);
  };

  parentPort.on('message', async (msg: any) => {
    try {
      if (msg.type === 'SET_CAMERA_MODE') {
        await switchDriverMode(Boolean(msg.payload?.useMock));
      } else if (msg.type === 'SET_CONFIG') {
        const p = msg.payload;
        // Any change to brightness, bit depth or framing invalidates the stacked frames
        liveStack.reset();
        if (typeof p.gain === 'number') {
          gain = p.gain;
          await driver.setGain(gain);
        }
        if (typeof p.exposureUs === 'number') {
          exposureUs = p.exposureUs;
          await driver.setExposure(exposureUs);
        }
        if (typeof p.bandwidth === 'number') {
          await driver.setBandwidth(p.bandwidth);
        }
        if (typeof p.highSpeed === 'number') {
          await driver.setHighSpeedMode(Boolean(p.highSpeed));
        }
        if (p.bitDepth === 8 || p.bitDepth === 16) {
          bitDepth = p.bitDepth;
          await driver.setBitDepth(bitDepth);
        }
        if (p.roi) {
          currentRoi = await driver.setROI(p.roi);
          // Re-center focus ROI inside new sensor ROI if needed
          focusRoi = {
            x: Math.max(0, Math.min(currentRoi.width - focusRoi.width, Math.floor((currentRoi.width - focusRoi.width) / 4) * 2)),
            y: Math.max(0, Math.min(currentRoi.height - focusRoi.height, Math.floor((currentRoi.height - focusRoi.height) / 4) * 2)),
            width: Math.min(focusRoi.width, currentRoi.width),
            height: Math.min(focusRoi.height, currentRoi.height)
          };
        }
      } else if (msg.type === 'SET_FOCUS_ROI') {
        const r = msg.payload as FocusROI;
        const w = Math.max(64, Math.min(currentRoi.width, Math.floor(r.width / 2) * 2));
        const h = Math.max(64, Math.min(currentRoi.height, Math.floor(r.height / 2) * 2));
        const x = Math.max(0, Math.min(currentRoi.width - w, Math.floor(r.x / 2) * 2));
        const y = Math.max(0, Math.min(currentRoi.height - h, Math.floor(r.y / 2) * 2));
        focusRoi = { x, y, width: w, height: h };
      } else if (msg.type === 'SET_MOCK_PARAMS' && driver.setMockParams) {
        driver.setMockParams(msg.payload as Partial<MockCameraParams>);
      } else if (msg.type === 'START_RECORDING') {
        if (serWriter) serWriter.close();
        const filename =
          msg.payload.filename ||
          `AstroScope_${new Date().toISOString().replace(/[:.]/g, '-')}.ser`;
        recordingFile = path.resolve(process.cwd(), 'recordings', path.basename(filename));
        serWriter = new SerWriter(
          recordingFile,
          currentRoi.width,
          currentRoi.height,
          bitDepth === 16
        );
        serWriter.open();
        recordLimitType = msg.payload.limitType || 'FRAMES';
        recordLimitValue = msg.payload.limitValue || 500;
        recordStartMs = Date.now();
      } else if (msg.type === 'GRAB_SNAPSHOT') {
        snapshotRequested = true;
      } else if (msg.type === 'SET_LIVE_STACK') {
        const p = msg.payload ?? {};
        if (typeof p.enabled === 'boolean') liveStackEnabled = p.enabled;
        const mode: LiveStackMode = p.mode === 'lucky' || p.mode === 'dso' ? p.mode : liveStack.options.mode;
        if (Number.isFinite(p.windowSec)) stackWindowSec[mode] = p.windowSec;
        liveStack.configure({ mode, windowMs: stackWindowSec[mode] * 1000, keepPercent: p.keepPercent });
        stackWindowSec[mode] = liveStack.options.windowMs / 1000; // clamped
        const o = liveStack.options;
        log.info(
          `Live stack ${liveStackEnabled ? 'enabled' : 'disabled'} (${o.mode}, ${o.windowMs / 1000} s window` +
            `${o.mode === 'lucky' ? `, best ${o.keepPercent}%` : ''})`
        );
      } else if (msg.type === 'STOP_RECORDING') {
        if (serWriter) {
          serWriter.close();
          serWriter = null;
        }
      } else if (msg.type === 'GET_STATUS') {
        const tempC = await driver.getTemperature();
        const mockDriver = driver instanceof MockCameraDriver ? driver : null;
        const mockParams = driver.getMockParams ? driver.getMockParams() : undefined;
        parentPort?.postMessage({
          type: 'STATUS',
          camera: {
            connected: true,
            isMock,
            name: isMock ? 'ZWO ASI678MC (Simulated)' : 'ZWO ASI678MC',
            fps: measuredFps,
            temperatureC: tempC,
            gain,
            hcgActive: gain >= 182,
            readNoiseElec: mockDriver
              ? Number(mockDriver.getReadNoiseElectrons(gain).toFixed(2))
              : gain >= 182
                ? 0.85
                : 2.4,
            exposureUs,
            bitDepth,
            roi: currentRoi,
            focusRoi,
            focusScore: latestFocusScore,
            isRecording: serWriter !== null,
            recordedFrames: serWriter ? serWriter.getRecordedFrames() : 0,
            recordingFile: serWriter ? path.basename(recordingFile) : undefined,
            liveStack: {
              enabled: liveStackEnabled,
              mode: liveStack.options.mode,
              frames: liveStackEnabled ? liveStack.frameCount : 0,
              pool: liveStackEnabled ? liveStack.poolFrameCount : 0,
              rejected: liveStackEnabled ? liveStack.rejectedCount : 0,
              windowSec: liveStack.options.windowMs / 1000,
              keepPercent: liveStack.options.keepPercent
            },
            mock: mockParams
              ? {
                  scene: mockParams.scene,
                  focuserPosition: mockParams.focuserPosition,
                  optimalFocusPosition: MockCameraDriver.OPTIMAL_FOCUS,
                  seeingArcsec: mockParams.seeingArcsec,
                  vibrationShake: mockParams.vibrationShake
                }
              : undefined
          }
        });
      }
    } catch (err: any) {
      log.error(`Error handling worker message ${msg?.type}`, err);
      parentPort?.postMessage({
        type: 'ERROR',
        message: err?.message ?? String(err)
      });
    }
  });

  initWorker().catch((err) => {
    log.error('initWorker failed', err);
    parentPort?.postMessage({
      type: 'ERROR',
      message: err?.message ?? String(err)
    });
  });
}
