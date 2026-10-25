import type {
  CameraProperties,
  CameraROI,
  ICameraDriver
} from '../../common/camera-interface.js';
import {
  ASI_CONTROL_TYPE,
  ASI_ERROR_CODE,
  ASI_IMG_TYPE,
  loadAsiSdk
} from './koffi-bindings.js';
import { dateToSerTicks } from './ser-writer.js';

export class ZwoKoffiDriver implements ICameraDriver {
  private sdk = loadAsiSdk();
  private cameraId = 0;
  private roi: CameraROI = { x: 0, y: 0, width: 3840, height: 2160, bin: 1 };
  private bitDepth: 8 | 16 = 8;
  private capturing = false;
  private captureTimer: NodeJS.Timeout | null = null;
  private frameCounter = 0;

  isAvailable(): boolean {
    if (!this.sdk) return false;
    try {
      return this.sdk.ASIGetNumOfConnectedCameras() > 0;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<CameraProperties> {
    if (!this.sdk) {
      throw new Error('ZWO ASICamera2 SDK library not found in bin/');
    }
    const count = this.sdk.ASIGetNumOfConnectedCameras();
    if (count <= 0) {
      throw new Error('No ZWO ASI cameras connected');
    }

    const info: Record<string, any> = {};
    const propErr = this.sdk.ASIGetCameraProperty(info, 0);
    if (propErr !== ASI_ERROR_CODE.SUCCESS) {
      throw new Error(`ASIGetCameraProperty failed with code ${propErr}`);
    }

    this.cameraId = info.CameraID ?? 0;
    const openErr = this.sdk.ASIOpenCamera(this.cameraId);
    if (openErr !== ASI_ERROR_CODE.SUCCESS) {
      throw new Error(`ASIOpenCamera failed with code ${openErr}`);
    }

    const initErr = this.sdk.ASIInitCamera(this.cameraId);
    if (initErr !== ASI_ERROR_CODE.SUCCESS) {
      throw new Error(`ASIInitCamera failed with code ${initErr}`);
    }

    const maxWidth = Number(info.MaxWidth) || 3840;
    const maxHeight = Number(info.MaxHeight) || 2160;
    this.roi = { x: 0, y: 0, width: maxWidth, height: maxHeight, bin: 1 };

    const rawName = Array.isArray(info.Name)
      ? Buffer.from(info.Name).toString('ascii').replace(/\0.*$/, '')
      : 'ZWO ASI678MC';

    return {
      cameraId: this.cameraId,
      name: rawName || 'ZWO ASI678MC',
      maxWidth,
      maxHeight,
      pixelSizeUm: Number(info.PixelSize) || 2.0,
      isColor: Boolean(info.IsColorCam),
      bayerPattern: 'RGGB',
      bitDepth: Number(info.BitDepth) || 12,
      isMock: false
    };
  }

  async setExposure(microseconds: number): Promise<void> {
    if (!this.sdk) return;
    this.sdk.ASISetControlValue(
      this.cameraId,
      ASI_CONTROL_TYPE.EXPOSURE,
      Math.max(10, Math.round(microseconds)),
      0
    );
  }

  async setGain(gain: number): Promise<void> {
    if (!this.sdk) return;
    this.sdk.ASISetControlValue(
      this.cameraId,
      ASI_CONTROL_TYPE.GAIN,
      Math.max(0, Math.min(500, Math.round(gain))),
      0
    );
  }

  async setBitDepth(bitDepth: 8 | 16): Promise<void> {
    this.bitDepth = bitDepth;
    await this.setROI(this.roi);
  }

  async setBandwidth(bandwidth: number): Promise<void> {
    if (!this.sdk) return;
    this.sdk.ASISetControlValue(
      this.cameraId,
      ASI_CONTROL_TYPE.BANDWIDTHOVERLOAD,
      Math.max(40, Math.min(100, Math.round(bandwidth))),
      0
    );
  }

  async setHighSpeedMode(enabled: boolean): Promise<void> {
    if (!this.sdk) return;
    this.sdk.ASISetControlValue(
      this.cameraId,
      ASI_CONTROL_TYPE.HIGH_SPEED_MODE,
      enabled ? 1 : 0,
      0
    );
  }

  async setROI(roi: CameraROI): Promise<CameraROI> {
    if (!this.sdk) return this.roi;
    const width = Math.max(64, Math.floor(roi.width / 8) * 8);
    const height = Math.max(64, Math.floor(roi.height / 2) * 2);
    const x = Math.max(0, Math.floor(roi.x / 2) * 2);
    const y = Math.max(0, Math.floor(roi.y / 2) * 2);
    const bin = roi.bin === 2 ? 2 : 1;
    const imgType = this.bitDepth === 16 ? ASI_IMG_TYPE.RAW16 : ASI_IMG_TYPE.RAW8;

    const wasCapturing = this.capturing;
    if (wasCapturing) {
      this.sdk.ASIStopVideoCapture(this.cameraId);
    }

    const err = this.sdk.ASISetROIFormat(this.cameraId, width, height, bin, imgType);
    if (err !== ASI_ERROR_CODE.SUCCESS) {
      throw new Error(`ASISetROIFormat failed with code ${err}`);
    }
    this.sdk.ASISetStartPos(this.cameraId, x, y);

    if (wasCapturing) {
      this.sdk.ASIStartVideoCapture(this.cameraId);
    }

    this.roi = { x, y, width, height, bin };
    return this.roi;
  }

  async getTemperature(): Promise<number> {
    if (!this.sdk) return 20.0;
    const valOut = [0];
    const autoOut = [0];
    const err = this.sdk.ASIGetControlValue(
      this.cameraId,
      ASI_CONTROL_TYPE.TEMPERATURE,
      valOut,
      autoOut
    );
    if (err !== ASI_ERROR_CODE.SUCCESS) return 20.0;
    return valOut[0] / 10.0;
  }

  async startCapture(
    onFrame: (frame: Buffer, frameNumber: number, timestampUs: bigint) => void
  ): Promise<void> {
    if (!this.sdk || this.capturing) return;
    const err = this.sdk.ASIStartVideoCapture(this.cameraId);
    if (err !== ASI_ERROR_CODE.SUCCESS) {
      throw new Error(`ASIStartVideoCapture failed with code ${err}`);
    }
    this.capturing = true;

    const poll = () => {
      if (!this.capturing || !this.sdk) return;
      const bytesPerPixel = this.bitDepth === 16 ? 2 : 1;
      const bufSize = this.roi.width * this.roi.height * bytesPerPixel;
      const frameBuf = Buffer.allocUnsafe(bufSize);

      const res = this.sdk.ASIGetVideoData(this.cameraId, frameBuf, bufSize, 200);
      if (res === ASI_ERROR_CODE.SUCCESS) {
        this.frameCounter++;
        onFrame(frameBuf, this.frameCounter, dateToSerTicks(Date.now(), 0));
      } else if (res === ASI_ERROR_CODE.CAMERA_REMOVED) {
        this.capturing = false;
        return;
      }

      if (this.capturing) {
        this.captureTimer = setImmediate(poll) as unknown as NodeJS.Timeout;
      }
    };

    this.captureTimer = setImmediate(poll) as unknown as NodeJS.Timeout;
  }

  async stopCapture(): Promise<void> {
    this.capturing = false;
    if (this.captureTimer) {
      clearImmediate(this.captureTimer as unknown as NodeJS.Immediate);
      this.captureTimer = null;
    }
    if (this.sdk) {
      this.sdk.ASIStopVideoCapture(this.cameraId);
    }
  }

  async close(): Promise<void> {
    await this.stopCapture();
    if (this.sdk) {
      this.sdk.ASICloseCamera(this.cameraId);
    }
  }
}
