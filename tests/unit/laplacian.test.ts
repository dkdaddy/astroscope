import { describe, it, expect } from 'vitest';
import {
  computeBayerFocusScore,
  computeLaplacianScore
} from '../../src/client/components/FocusAnalyzer.js';
import { MockCameraDriver } from '../../src/server/camera/mock-camera.js';
import { computeBayerRoiFocusScore } from '../../src/server/camera/camera-worker.js';

describe('FocusAnalyzer & Bayer Laplacian Score (UT-02)', () => {
  it('returns 0.0 for a uniform flat Bayer RGGB image (no false CFA checkerboard score)', () => {
    const w = 128;
    const h = 128;
    const flatBayer = new Uint8Array(w * h);
    // Even if R, G, B channels have different uniform levels, super-pixel luminance is constant!
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const evenY = (y & 1) === 0;
        const evenX = (x & 1) === 0;
        flatBayer[y * w + x] = evenY ? (evenX ? 180 : 120) : evenX ? 120 : 80;
      }
    }
    const score = computeBayerFocusScore(flatBayer, w, h);
    expect(score).toBeCloseTo(0, 5);
  });

  it('produces a monotonically peaking focus score at optimal focuserPosition = 500', async () => {
    const mock = new MockCameraDriver();
    await mock.initialize();
    await mock.setROI({ x: 1600, y: 760, width: 640, height: 640, bin: 1 });
    await mock.setGain(182);

    const scoreAt = (focusPos: number) => {
      mock.setMockParams({
        scene: 'JUPITER',
        focuserPosition: focusPos,
        seeingArcsec: 0.4,
        vibrationShake: false
      });
      const buf = mock.generateFrameBuffer(1000);
      return computeBayerFocusScore(
        new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        640,
        640
      );
    };

    const scoreFarOut = scoreAt(400);
    const scoreMidOut = scoreAt(460);
    const scoreOptimal = scoreAt(500);
    const scoreMidIn = scoreAt(540);

    expect(scoreOptimal).toBeGreaterThan(scoreMidOut);
    expect(scoreMidOut).toBeGreaterThan(scoreFarOut);
    expect(scoreOptimal).toBeGreaterThan(scoreMidIn);
  });

  it('computes high Laplacian variance on a sharp edge', () => {
    const w = 32;
    const h = 32;
    const img = new Uint8Array(w * h);
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        img[y * w + x] = 250;
      }
    }
    expect(computeLaplacianScore(img, w, h)).toBeGreaterThan(500);
  });
});

describe('Worker ROI focus score (real-camera path)', () => {
  const focusRoi = { x: 760, y: 340, width: 400, height: 400 };

  const makeCam = async (exposureUs: number) => {
    const cam = new MockCameraDriver();
    await cam.initialize();
    await cam.setGain(182);
    await cam.setExposure(exposureUs);
    await cam.setROI({ x: 960, y: 540, width: 1920, height: 1080, bin: 1 });
    cam.setMockParams({ scene: 'MOON', seeingArcsec: 1.0, vibrationShake: false });
    return cam;
  };

  const scoreAt = (cam: MockCameraDriver, focuserPosition: number) => {
    cam.setMockParams({ focuserPosition });
    return computeBayerRoiFocusScore(cam.generateFrameBuffer(1000), 1920, 1080, focusRoi);
  };

  it('does not change with scene brightness (exposure +40%) at a fixed focus', async () => {
    const normal = scoreAt(await makeCam(15_000), 470);
    const brighter = scoreAt(await makeCam(21_000), 470);
    expect(brighter / normal).toBeGreaterThan(0.85);
    expect(brighter / normal).toBeLessThan(1.15);
  });

  it('peaks at best focus with a low out-of-focus floor', async () => {
    const cam = await makeCam(15_000);
    const far = scoreAt(cam, 380);
    const near = scoreAt(cam, 485);
    const best = scoreAt(cam, 500);
    expect(best).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(far);
    expect(far / best).toBeLessThan(0.2);
    expect(best).toBeGreaterThan(5);
  });
});
