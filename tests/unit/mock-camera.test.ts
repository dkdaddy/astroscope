import { describe, it, expect } from 'vitest';
import { MockCameraDriver } from '../../src/server/camera/mock-camera.js';

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
});
