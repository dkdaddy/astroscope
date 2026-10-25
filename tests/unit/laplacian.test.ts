import { describe, it, expect } from 'vitest';
import {
  computeBayerFocusScore,
  computeLaplacianScore
} from '../../src/client/components/FocusAnalyzer.js';
import { MockCameraDriver } from '../../src/server/camera/mock-camera.js';

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
