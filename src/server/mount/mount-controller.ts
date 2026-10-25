import { EventEmitter } from 'node:events';
import { IndiClient } from './indi-client.js';

export interface MountState {
  connected: boolean;
  isSimulated: boolean;
  driver: string;
  ra: number;
  dec: number;
  tracking: boolean;
  trackRate: 'SIDEREAL' | 'LUNAR' | 'SOLAR' | 'OFF';
  skyOffsetPx: { dx: number; dy: number };
}

export class MountController extends EventEmitter {
  private indi = new IndiClient();
  private state: MountState = {
    connected: true,
    isSimulated: true,
    driver: 'INDI Simulated EQMount',
    ra: 5.5755,   // Jupiter RA (hours)
    dec: 23.2145, // Jupiter Dec (degrees)
    tracking: true,
    trackRate: 'SIDEREAL',
    skyOffsetPx: { dx: 0, dy: 0 }
  };
  private driftTimer: NodeJS.Timeout | null = null;

  async initialize(): Promise<void> {
    const ok = await this.indi.connect();
    if (ok) {
      this.state.isSimulated = false;
      this.state.driver = 'INDI EQMod Mount';
      this.indi.on('coords', ({ ra, dec }) => {
        this.state.ra = ra;
        this.state.dec = dec;
      });
    } else {
      this.state.isSimulated = true;
      this.state.driver = 'INDI Simulated EQMount';
    }

    // Simulate sidereal drift when tracking is turned OFF
    this.driftTimer = setInterval(() => {
      if (!this.state.tracking) {
        this.state.skyOffsetPx.dx += 2.2;
        this.state.ra = Number((this.state.ra + 0.0002).toFixed(4));
        this.emit('skyOffsetChanged', { ...this.state.skyOffsetPx });
      }
    }, 250);
  }

  jog(
    direction: 'NORTH' | 'SOUTH' | 'EAST' | 'WEST',
    speed: 'GUIDE' | 'CENTER' | 'FIND' | 'MAX',
    durationMs = 300
  ): void {
    const speedPxPerSec: Record<typeof speed, number> = {
      GUIDE: 14,
      CENTER: 48,
      FIND: 140,
      MAX: 360
    };
    const stepPx = speedPxPerSec[speed] * (durationMs / 1000);
    const degStep = stepPx * 0.0005;

    if (direction === 'NORTH') {
      this.state.dec = Number(Math.min(90, this.state.dec + degStep).toFixed(4));
      this.state.skyOffsetPx.dy -= stepPx;
    } else if (direction === 'SOUTH') {
      this.state.dec = Number(Math.max(-90, this.state.dec - degStep).toFixed(4));
      this.state.skyOffsetPx.dy += stepPx;
    } else if (direction === 'EAST') {
      this.state.ra = Number(((this.state.ra + degStep * 0.1 + 24) % 24).toFixed(4));
      this.state.skyOffsetPx.dx += stepPx;
    } else if (direction === 'WEST') {
      this.state.ra = Number(((this.state.ra - degStep * 0.1 + 24) % 24).toFixed(4));
      this.state.skyOffsetPx.dx -= stepPx;
    }

    this.emit('skyOffsetChanged', { ...this.state.skyOffsetPx });
  }

  recenterTarget(): void {
    this.state.skyOffsetPx = { dx: 0, dy: 0 };
    this.emit('skyOffsetChanged', { dx: 0, dy: 0 });
  }

  setTracking(tracking: boolean, rate: 'SIDEREAL' | 'LUNAR' | 'SOLAR' = 'SIDEREAL'): void {
    this.state.tracking = tracking;
    this.state.trackRate = tracking ? rate : 'OFF';
  }

  getState(): MountState {
    return {
      ...this.state,
      skyOffsetPx: { ...this.state.skyOffsetPx }
    };
  }

  close(): void {
    if (this.driftTimer) {
      clearInterval(this.driftTimer);
      this.driftTimer = null;
    }
    this.indi.close();
  }
}
