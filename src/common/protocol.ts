import type { CameraROI, MockCameraParams } from './camera-interface.js';

export const FRAME_HEADER_MAGIC = 0x41535452; // "ASTR" in Little-Endian
export const FRAME_HEADER_BYTES = 24;

export const PIXEL_FORMAT = {
  RAW8_RGGB: 0,
  JPEG: 1,
  RAW16_RGGB: 2,
  RGB24: 3
} as const;

export const FRAME_TYPE = {
  VIEWPORT_PREVIEW: 0,
  FOCUS_ROI_CROP: 1,
  SNAPSHOT: 2
} as const;

export interface BinaryFrameHeader {
  magic: number;
  frameNumber: number;
  width: number;
  height: number;
  pixelFormat: number;
  frameType: number;
  binFactor: number;
  serverScore: number;
  payloadSize: number;
}

/**
 * Packs a 24-byte aligned Little-Endian header + payload into a single Uint8Array / Buffer.
 */
export function packBinaryFrame(
  header: Omit<BinaryFrameHeader, 'magic' | 'payloadSize'>,
  payload: Uint8Array
): Buffer {
  const buf = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  buf.writeUInt32LE(FRAME_HEADER_MAGIC, 0);
  buf.writeUInt32LE(header.frameNumber >>> 0, 4);
  buf.writeUInt16LE(header.width & 0xffff, 8);
  buf.writeUInt16LE(header.height & 0xffff, 10);
  buf.writeUInt8(header.pixelFormat & 0xff, 12);
  buf.writeUInt8(header.frameType & 0xff, 13);
  buf.writeUInt16LE(header.binFactor & 0xffff, 14);
  buf.writeFloatLE(header.serverScore, 16);
  buf.writeUInt32LE(payload.byteLength >>> 0, 20);
  buf.set(payload, FRAME_HEADER_BYTES);
  return buf;
}

/**
 * Unpacks a 24-byte Little-Endian binary frame buffer (works in both Node & Browser ArrayBuffer).
 */
export function unpackBinaryFrame(buffer: ArrayBuffer): {
  header: BinaryFrameHeader;
  payload: Uint8Array;
} {
  if (buffer.byteLength < FRAME_HEADER_BYTES) {
    throw new Error(`Invalid binary frame: length ${buffer.byteLength} < ${FRAME_HEADER_BYTES}`);
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== FRAME_HEADER_MAGIC) {
    throw new Error(`Invalid binary frame magic: 0x${magic.toString(16)}`);
  }
  const frameNumber = view.getUint32(4, true);
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const pixelFormat = view.getUint8(12);
  const frameType = view.getUint8(13);
  const binFactor = view.getUint16(14, true);
  const serverScore = view.getFloat32(16, true);
  const payloadSize = view.getUint32(20, true);

  const payload = new Uint8Array(buffer, FRAME_HEADER_BYTES, payloadSize);
  return {
    header: {
      magic,
      frameNumber,
      width,
      height,
      pixelFormat,
      frameType,
      binFactor,
      serverScore,
      payloadSize
    },
    payload
  };
}

export interface FocusROI {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ClientCommand =
  | {
      action: 'SET_CONFIG';
      payload: {
        gain?: number;
        exposureUs?: number;
        bandwidth?: number;
        highSpeed?: number;
        bitDepth?: 8 | 16;
        focusFastMode?: boolean;
        roi?: CameraROI;
      };
    }
  | {
      action: 'SET_FOCUS_ROI';
      payload: FocusROI;
    }
  | {
      action: 'SET_MOCK_PARAMS';
      payload: Partial<MockCameraParams>;
    }
  | {
      action: 'SET_CAMERA_MODE';
      payload: {
        useMock: boolean;
      };
    }
  | {
      action: 'START_RECORDING';
      payload: {
        filename?: string;
        limitType: 'FRAMES' | 'SECONDS' | 'NONE';
        limitValue: number;
      };
    }
  | {
      action: 'STOP_RECORDING';
    }
  | {
      action: 'GRAB_SNAPSHOT';
    }
  | {
      action: 'SET_LIVE_STACK';
      payload: {
        enabled: boolean;
      };
    }
  | {
      action: 'MOUNT_JOG';
      payload: {
        direction: 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';
        speed: 'GUIDE' | 'CENTER' | 'FIND' | 'MAX';
        durationMs: number;
      };
    }
  | {
      action: 'MOUNT_TRACKING';
      payload: {
        tracking: boolean;
        trackRate?: 'SIDEREAL' | 'LUNAR' | 'SOLAR';
      };
    };

export interface TelemetryMessage {
  type: 'TELEMETRY';
  timestamp: number;
  camera: {
    connected: boolean;
    isMock: boolean;
    name: string;
    fps: number;
    temperatureC: number;
    gain: number;
    hcgActive: boolean;
    readNoiseElec: number;
    exposureUs: number;
    bitDepth: 8 | 16;
    roi: CameraROI;
    focusRoi: FocusROI;
    focusScore: number;
    isRecording: boolean;
    recordedFrames: number;
    recordingFile?: string;
    liveStack?: {
      enabled: boolean;
      frames: number;
      windowSec: number;
    };
    mock?: {
      scene: string;
      focuserPosition: number;
      optimalFocusPosition: number;
      seeingArcsec: number;
      vibrationShake: boolean;
    };
  };
  mount: {
    connected: boolean;
    isSimulated: boolean;
    driver: string;
    ra: number;
    dec: number;
    tracking: boolean;
    trackRate: 'SIDEREAL' | 'LUNAR' | 'SOLAR' | 'OFF';
  };
  system: {
    cpuTempC: number;
    diskFreeGb: number;
    eventLoopLagMs: number;
  };
}
