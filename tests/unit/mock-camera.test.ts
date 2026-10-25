import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { MockCameraDriver } from '../../src/server/camera/mock-camera.js';
import { resolveSdkLibraryPath } from '../../src/server/camera/koffi-bindings.js';

const originalSdkEnv = process.env.ASTROSCOPE_ASI_SDK_PATH;

afterEach(() => {
  if (originalSdkEnv === undefined) {
    delete process.env.ASTROSCOPE_ASI_SDK_PATH;
  } else {
    process.env.ASTROSCOPE_ASI_SDK_PATH = originalSdkEnv;
  }
});

describe('MockCameraDriver Physics & ZWO SDK Emulation (UT-03)', () => {
  it('models the IMX678 HCG read-noise drop at Gain 182', () => {
    const cam = new MockCameraDriver();
    const noiseGain0 = cam.getReadNoiseElectrons(0);
    const noiseGain180 = cam.getReadNoiseElectrons(180);
    const noiseGain182 = cam.getReadNoiseElectrons(182);

    expect(noiseGain0).toBeCloseTo(2.7, 1);
    expect(noiseGain180).toBeGreaterThan(1.7);
    expect(noiseGain182).toBeLessThanOrEqual(0.86);
    expect(cam.isHcgActive(181)).toBe(false);
    expect(cam.isHcgActive(182)).toBe(true);
  });

  it('enforces ZWO SDK ROI width%8 and height%2 hardware rules', async () => {
    const cam = new MockCameraDriver();
    await cam.initialize();

    await expect(
      cam.setROI({ x: 0, y: 0, width: 644, height: 480, bin: 1 })
    ).rejects.toThrow(/multiple of 8/);

    await expect(
      cam.setROI({ x: 0, y: 0, width: 640, height: 481, bin: 1 })
    ).rejects.toThrow(/multiple of 2/);

    const valid = await cam.setROI({ x: 100, y: 100, width: 640, height: 480, bin: 1 });
    expect(valid.width).toBe(640);
    expect(valid.height).toBe(480);
  });

  it('prefers an explicit ASI SDK path over the project-local bin folder', () => {
    const sdkDir = path.join(process.cwd(), 'tmp-asi-sdk');
    const dllName = process.platform === 'win32' ? 'ASICamera2.dll' : process.platform === 'darwin' ? 'libASICamera2.dylib' : 'libASICamera2.so';
    const fullPath = path.join(sdkDir, dllName);

    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(fullPath, 'fake-library');
    process.env.ASTROSCOPE_ASI_SDK_PATH = sdkDir;

    expect(resolveSdkLibraryPath()).toBe(fullPath);

    fs.rmSync(sdkDir, { recursive: true, force: true });
  });
});
