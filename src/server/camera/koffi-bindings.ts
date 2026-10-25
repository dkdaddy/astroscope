import koffi from 'koffi';
import path from 'node:path';
import fs from 'node:fs';

export const ASI_ERROR_CODE = {
  SUCCESS: 0,
  INVALID_INDEX: 1,
  INVALID_ID: 2,
  INVALID_CONTROL_TYPE: 3,
  CAMERA_CLOSED: 4,
  CAMERA_REMOVED: 5,
  INVALID_PATH: 6,
  OUTOF_RESOURCE: 7,
  INVALID_SIZE: 8,
  TIMEOUT: 9,
  INVALID_FRAME_FORMAT: 10,
  SYSTEM_RESOURCE_ERROR: 11
} as const;

export const ASI_CONTROL_TYPE = {
  GAIN: 0,
  EXPOSURE: 1,
  GAMMA: 2,
  WB_R: 3,
  WB_B: 4,
  OFFSET: 5,
  BANDWIDTHOVERLOAD: 6,
  OVERCLOCK: 7,
  TEMPERATURE: 8,
  FLIP: 9,
  AUTO_MAX_GAIN: 10,
  AUTO_MAX_EXP: 11,
  AUTO_TARGET_BRIGHTNESS: 12,
  HARDWARE_BIN: 13,
  HIGH_SPEED_MODE: 14,
  COOLER_POWER_PERC: 15,
  TARGET_TEMP: 16,
  COOLER_ON: 17,
  FAN_ON: 19
} as const;

export const ASI_IMG_TYPE = {
  RAW8: 0,
  RGB24: 1,
  RAW16: 2,
  Y8: 3,
  END: -1
} as const;

export const ASI_BAYER_PATTERN = {
  RG: 0,
  BG: 1,
  GR: 2,
  GB: 3
} as const;

export function resolveSdkLibraryPath(): string {
  const binDir = path.resolve(process.cwd(), 'bin');
  if (process.platform === 'win32') return path.join(binDir, 'ASICamera2.dll');
  if (process.platform === 'darwin') return path.join(binDir, 'libASICamera2.dylib');
  return path.join(binDir, 'libASICamera2.so');
}

export function loadAsiSdk() {
  const libPath = resolveSdkLibraryPath();
  if (!fs.existsSync(libPath)) {
    return null;
  }

  try {
    const lib = koffi.load(libPath);

    const ASI_CAMERA_INFO = koffi.struct('ASI_CAMERA_INFO', {
      Name: koffi.array('char', 64),
      CameraID: 'int',
      MaxHeight: 'long',
      MaxWidth: 'long',
      IsColorCam: 'int',
      BayerPattern: 'int',
      SupportedBins: koffi.array('int', 16),
      SupportedVideoFormat: koffi.array('int', 8),
      PixelSize: 'double',
      MechanicalShutter: 'int',
      ST4Port: 'int',
      IsCoolerCam: 'int',
      IsUSB3Host: 'int',
      IsUSB3Camera: 'int',
      ElecPerADU: 'float',
      BitDepth: 'int',
      IsTriggerCam: 'int',
      Unused: koffi.array('char', 16)
    });

    return {
      ASI_CAMERA_INFO,
      ASIGetNumOfConnectedCameras: lib.func('int ASIGetNumOfConnectedCameras()'),
      ASIGetCameraProperty: lib.func('int ASIGetCameraProperty(_Out_ ASI_CAMERA_INFO *pCameraInfo, int iCameraIndex)'),
      ASIOpenCamera: lib.func('int ASIOpenCamera(int iCameraID)'),
      ASIInitCamera: lib.func('int ASIInitCamera(int iCameraID)'),
      ASICloseCamera: lib.func('int ASICloseCamera(int iCameraID)'),
      ASISetControlValue: lib.func('int ASISetControlValue(int iCameraID, int ControlType, long lValue, int bAuto)'),
      ASIGetControlValue: lib.func('int ASIGetControlValue(int iCameraID, int ControlType, _Out_ long *plValue, _Out_ int *pbAuto)'),
      ASISetROIFormat: lib.func('int ASISetROIFormat(int iCameraID, int iWidth, int iHeight, int iBin, int Img_type)'),
      ASIGetROIFormat: lib.func('int ASIGetROIFormat(int iCameraID, _Out_ int *piWidth, _Out_ int *piHeight, _Out_ int *piBin, _Out_ int *pImg_type)'),
      ASISetStartPos: lib.func('int ASISetStartPos(int iCameraID, int iStartX, int iStartY)'),
      ASIGetStartPos: lib.func('int ASIGetStartPos(int iCameraID, _Out_ int *piStartX, _Out_ int *piStartY)'),
      ASIStartVideoCapture: lib.func('int ASIStartVideoCapture(int iCameraID)'),
      ASIStopVideoCapture: lib.func('int ASIStopVideoCapture(int iCameraID)'),
      ASIGetVideoData: lib.func('int ASIGetVideoData(int iCameraID, _Out_ uint8_t *pBuffer, long lBuffSize, int iWaitms)')
    };
  } catch {
    return null;
  }
}
