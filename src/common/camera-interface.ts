export interface CameraProperties {
  cameraId: number;
  name: string;
  maxWidth: number;
  maxHeight: number;
  pixelSizeUm: number;
  isColor: boolean;
  bayerPattern: 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG';
  bitDepth: number;
  isMock: boolean;
}

export interface CameraROI {
  x: number;
  y: number;
  width: number;
  height: number;
  bin: number;
}

export type MockSceneType = 'JUPITER' | 'SATURN' | 'MOON' | 'STARFIELD';

export interface MockCameraParams {
  scene: MockSceneType;
  focuserPosition: number;       // 0..1000 (500 = optimal focus)
  seeingArcsec: number;          // e.g. 0.4..4.0 arcsec
  cloudCover: number;            // 0.0..1.0
  vibrationShake: boolean;       // Simulates hand-on-focuser telescope shake when turning knob
  skyOffsetPx: { dx: number; dy: number };
}

export interface ICameraDriver {
  initialize(): Promise<CameraProperties>;
  setExposure(microseconds: number): Promise<void>;
  setGain(gain: number): Promise<void>;
  setBitDepth(bitDepth: 8 | 16): Promise<void>;
  setBandwidth(bandwidth: number): Promise<void>;
  setHighSpeedMode(enabled: boolean): Promise<void>;
  setROI(roi: CameraROI): Promise<CameraROI>;
  getTemperature(): Promise<number>;
  startCapture(onFrame: (frame: Buffer, frameNumber: number, timestampUs: bigint) => void): Promise<void>;
  stopCapture(): Promise<void>;
  close(): Promise<void>;
  setMockParams?(params: Partial<MockCameraParams>): void;
  getMockParams?(): MockCameraParams;
}
