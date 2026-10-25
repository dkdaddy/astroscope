import { EventEmitter } from 'node:events';
import type { TelemetryMessage } from '../../common/protocol.js';

export class AppState extends EventEmitter {
  private lastTelemetry: TelemetryMessage = {
    type: 'TELEMETRY',
    timestamp: Date.now(),
    camera: {
      connected: true,
      isMock: true,
      name: 'ZWO ASI678MC (Simulated)',
      fps: 0,
      temperatureC: 21.4,
      gain: 182,
      hcgActive: true,
      readNoiseElec: 0.85,
      exposureUs: 15_000,
      bitDepth: 8,
      roi: { x: 0, y: 0, width: 1920, height: 1080, bin: 1 },
      focusRoi: { x: 760, y: 340, width: 400, height: 400 },
      focusScore: 0,
      isRecording: false,
      recordedFrames: 0,
      mock: {
        scene: 'JUPITER',
        focuserPosition: 465,
        optimalFocusPosition: 500,
        seeingArcsec: 1.0,
        vibrationShake: false
      }
    },
    mount: {
      connected: true,
      isSimulated: true,
      driver: 'INDI Simulated EQMount',
      ra: 5.5755,
      dec: 23.2145,
      tracking: true,
      trackRate: 'SIDEREAL'
    },
    system: {
      cpuTempC: 44.2,
      diskFreeGb: 256.4,
      eventLoopLagMs: 0.5
    }
  };

  updateCamera(camera: TelemetryMessage['camera']): void {
    this.lastTelemetry.camera = camera;
    this.lastTelemetry.timestamp = Date.now();
  }

  updateMount(mount: TelemetryMessage['mount']): void {
    this.lastTelemetry.mount = mount;
    this.lastTelemetry.timestamp = Date.now();
  }

  updateSystem(system: Partial<TelemetryMessage['system']>): void {
    this.lastTelemetry.system = { ...this.lastTelemetry.system, ...system };
  }

  getTelemetry(): TelemetryMessage {
    return {
      ...this.lastTelemetry,
      timestamp: Date.now()
    };
  }
}
