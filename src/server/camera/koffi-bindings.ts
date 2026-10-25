import koffi from 'koffi';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from '../logger.js';

const log = createLogger('asi-sdk');

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

function normalizeAsiCandidates(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    candidates.push(trimmed);
  }

  return candidates;
}

function findLibraryInDirectory(dir: string, names: string[]): string | null {
  if (!dir || !fs.existsSync(dir)) return null;

  for (const name of names) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

export function resolveSdkLibraryPath(): string {
  const libraryNames = process.platform === 'win32'
    ? ['ASICamera2.dll', 'ASICamera2_x64.dll']
    : process.platform === 'darwin'
      ? ['libASICamera2.dylib']
      : ['libASICamera2.so'];

  const projectBinDir = path.resolve(process.cwd(), 'bin');
  const envDirs = normalizeAsiCandidates([
    process.env.ASTROSCOPE_ASI_SDK_PATH,
    process.env.ASI_SDK_PATH,
    process.env.ASICAMERA2_PATH,
    process.env.ASI_CAMERA2_PATH
  ]);

  const baseSearchDirs = [
    ...envDirs,
    projectBinDir,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles ?? '', 'ASIStudio') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles ?? '', 'ASI Studio') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'] ?? '', 'ASIStudio') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'] ?? '', 'ASI Studio') : '',
    'C:\\Program Files\\ASIStudio',
    'C:\\Program Files\\ASI Studio',
    'C:\\Program Files\\ZWO\\ASI Studio',
    'C:\\Program Files (x86)\\ASI Studio',
    'C:\\Program Files (x86)\\ZWO\\ASI Studio'
  ].filter(Boolean);

  const searchDirs = Array.from(new Set(
    baseSearchDirs.flatMap((dir) => [dir, path.join(dir, 'x64'), path.join(dir, 'bin'), path.join(dir, 'lib')])
  ));

  const searchFiles = normalizeAsiCandidates([
    ...envDirs.map((entry) => {
      const normalized = path.normalize(entry);
      return fs.existsSync(normalized) && fs.statSync(normalized).isDirectory() ? undefined : normalized;
    }),
    ...searchDirs.map((dir) => findLibraryInDirectory(dir, libraryNames) ?? undefined)
  ]);

  for (const candidate of searchFiles) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  for (const dir of searchDirs) {
    const found = findLibraryInDirectory(dir, libraryNames);
    if (found) return found;
  }

  return path.join(projectBinDir, libraryNames[0]);
}

let cachedSdk: ReturnType<typeof loadAsiSdkUncached> = null;

// koffi throws "Duplicate type name" if ASI_CAMERA_INFO is registered twice,
// so the SDK must be loaded only once per thread.
export function loadAsiSdk() {
  if (!cachedSdk) cachedSdk = loadAsiSdkUncached();
  return cachedSdk;
}

function loadAsiSdkUncached() {
  const libPath = resolveSdkLibraryPath();
  if (!fs.existsSync(libPath)) {
    log.warn(`ASI SDK library not found (last candidate: ${libPath})`);
    return null;
  }

  try {
    log.info(`Loading ASI SDK from ${libPath}`);
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
  } catch (err) {
    log.error(`Failed to load ASI SDK from ${libPath}`, err);
    return null;
  }
}
