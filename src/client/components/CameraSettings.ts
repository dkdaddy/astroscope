import type { ClientCommand, TelemetryMessage } from '../../common/protocol.js';
import { DEFAULT_STRETCH, type StretchParams } from './Viewport.js';

// Logarithmic exposure slider: 0.05 ms .. 10 s over 2000 steps.
// ~0.6% per step everywhere, so the 0.05-5 ms band still gets ~750 fine steps.
const EXP_MIN_MS = 0.05;
const EXP_MAX_MS = 10_000;
const EXP_STEPS = 2000;

function sliderToExposureUs(pos: number): number {
  const ms = EXP_MIN_MS * Math.pow(EXP_MAX_MS / EXP_MIN_MS, pos / EXP_STEPS);
  return Math.round(ms * 1000);
}

function exposureUsToSlider(us: number): number {
  const ms = Math.min(EXP_MAX_MS, Math.max(EXP_MIN_MS, us / 1000));
  return Math.round((EXP_STEPS * Math.log(ms / EXP_MIN_MS)) / Math.log(EXP_MAX_MS / EXP_MIN_MS));
}

function formatExposure(us: number): string {
  const ms = us / 1000;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
}

export class CameraSettings {
  constructor(
    private container: HTMLElement,
    private sendCommand: (cmd: ClientCommand) => void,
    private onStretchChange: (stretch: StretchParams) => void,
    private onAutoStretch: () => StretchParams | null
  ) {
    this.render();
    this.bindEvents();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="panel-card">
        <div class="panel-header">
          <h3>CAMERA &amp; EXPOSURE</h3>
          <span id="hcg-badge" class="badge badge-emerald">HCG ACTIVE (0.85e-)</span>
        </div>

        <div class="control-group">
          <div class="control-label-row">
            <label for="exp-slider">Exposure</label>
            <span id="exp-val" class="mono-val">15.0 ms</span>
          </div>
          <input id="exp-slider" type="range" min="0" max="${EXP_STEPS}" step="1" value="${exposureUsToSlider(15000)}" />
          <div class="preset-row">
            <button type="button" class="btn-chip exp-preset" data-exp="1000">1ms</button>
            <button type="button" class="btn-chip exp-preset" data-exp="2000">2ms</button>
            <button type="button" class="btn-chip exp-preset" data-exp="5000">5ms (200fps)</button>
            <button type="button" class="btn-chip exp-preset" data-exp="10000">10ms (100fps)</button>
            <button type="button" class="btn-chip exp-preset" data-exp="15000">15ms (66fps)</button>
            <button type="button" class="btn-chip exp-preset" data-exp="30000">30ms (33fps)</button>
          </div>
          <div class="preset-row">
            <button type="button" class="btn-chip exp-preset" data-exp="100000">100ms</button>
            <button type="button" class="btn-chip exp-preset" data-exp="250000">250ms</button>
            <button type="button" class="btn-chip exp-preset" data-exp="500000">500ms</button>
            <button type="button" class="btn-chip exp-preset" data-exp="1000000">1s</button>
            <button type="button" class="btn-chip exp-preset" data-exp="2000000">2s</button>
            <button type="button" class="btn-chip exp-preset" data-exp="5000000">5s</button>
            <button type="button" class="btn-chip exp-preset" data-exp="10000000">10s</button>
          </div>
        </div>

        <div class="control-group">
          <div class="control-label-row">
            <label for="gain-slider">Sensor Gain (0–500)</label>
            <span id="gain-val" class="mono-val">182</span>
          </div>
          <input id="gain-slider" type="range" min="0" max="500" step="1" value="182" />
          <div class="preset-row">
            <button type="button" class="btn-chip gain-preset" data-gain="0">Gain 0 (Max FWC)</button>
            <button type="button" class="btn-chip gain-preset btn-accent" data-gain="182">★ Gain 182 (HCG Switch)</button>
            <button type="button" class="btn-chip gain-preset" data-gain="300">Gain 300 (Planetary)</button>
          </div>
        </div>

        <div class="control-group">
          <label for="roi-select">Hardware ROI (Speed)</label>
          <select id="roi-select">
            <option value="3840x2160">3840 × 2160 (4K Max)</option>
            <option value="1920x1080" selected>1920 × 1080 (FHD)</option>
            <option value="1024x768">1024 × 768 (Fast)</option>
            <option value="640x480">640 × 480 (Planetary High-FPS)</option>
          </select>
        </div>

        <div class="control-group">
          <div class="control-label-row">
            <span>Display Stretch</span>
            <span class="preset-row">
              <button type="button" id="btn-stretch-auto" class="btn-chip btn-accent">Auto</button>
              <button type="button" id="btn-stretch-reset" class="btn-chip">Reset</button>
            </span>
          </div>
          <div class="control-label-row">
            <label for="stretch-black">Black point</label>
            <span id="stretch-black-val" class="mono-val">${DEFAULT_STRETCH.black}</span>
          </div>
          <input id="stretch-black" type="range" min="0" max="250" step="1" value="${DEFAULT_STRETCH.black}" />
          <div class="control-label-row">
            <label for="stretch-white">White point</label>
            <span id="stretch-white-val" class="mono-val">${DEFAULT_STRETCH.white}</span>
          </div>
          <input id="stretch-white" type="range" min="5" max="255" step="1" value="${DEFAULT_STRETCH.white}" />
          <div class="control-label-row">
            <label for="stretch-gamma">Gamma (midtones)</label>
            <span id="stretch-gamma-val" class="mono-val">${DEFAULT_STRETCH.gamma.toFixed(2)}</span>
          </div>
          <input id="stretch-gamma" type="range" min="0.3" max="3.0" step="0.05" value="${DEFAULT_STRETCH.gamma}" />
        </div>

        <div class="control-group">
          <div class="control-label-row">
            <span>Live Stack (3 s rolling average)</span>
            <span id="stack-status" class="mono-val">OFF</span>
          </div>
          <div class="preset-row">
            <button type="button" id="btn-live-stack" class="btn-chip">Enable Live Stack</button>
          </div>
        </div>

        <div class="ser-box">
          <div class="control-label-row">
            <span>SER Lucky Imaging Capture</span>
            <span id="rec-status" class="mono-val">IDLE</span>
          </div>
          <div class="preset-row">
            <input id="rec-frames" type="number" value="500" min="10" max="50000" style="width: 85px;" />
            <span class="unit-label">frames</span>
            <button type="button" id="btn-rec-start" class="btn-primary">● Record .SER</button>
            <button type="button" id="btn-rec-stop" class="btn-danger" disabled>■ Stop</button>
          </div>
          <div class="preset-row">
            <button type="button" id="btn-snapshot" class="btn-chip">Save Frame (.JPG)</button>
          </div>
        </div>
      </div>
    `;
  }

  private bindEvents(): void {
    const expSlider = this.container.querySelector('#exp-slider') as HTMLInputElement;
    const expVal = this.container.querySelector('#exp-val') as HTMLElement;
    const gainSlider = this.container.querySelector('#gain-slider') as HTMLInputElement;
    const gainVal = this.container.querySelector('#gain-val') as HTMLElement;
    const roiSelect = this.container.querySelector('#roi-select') as HTMLSelectElement;
    const stretchBlack = this.container.querySelector('#stretch-black') as HTMLInputElement;
    const stretchWhite = this.container.querySelector('#stretch-white') as HTMLInputElement;
    const stretchGamma = this.container.querySelector('#stretch-gamma') as HTMLInputElement;

    expSlider.addEventListener('input', () => {
      const us = sliderToExposureUs(Number(expSlider.value));
      expVal.textContent = formatExposure(us);
      this.sendCommand({
        action: 'SET_CONFIG',
        payload: { exposureUs: us }
      });
    });

    this.container.querySelectorAll('.exp-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const us = Number((btn as HTMLElement).dataset.exp);
        expSlider.value = String(exposureUsToSlider(us));
        expVal.textContent = formatExposure(us);
        this.sendCommand({
          action: 'SET_CONFIG',
          payload: { exposureUs: us }
        });
      });
    });

    gainSlider.addEventListener('input', () => {
      const g = Number(gainSlider.value);
      gainVal.textContent = String(g);
      this.sendCommand({
        action: 'SET_CONFIG',
        payload: { gain: g }
      });
    });

    this.container.querySelectorAll('.gain-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const g = Number((btn as HTMLElement).dataset.gain);
        gainSlider.value = String(g);
        gainVal.textContent = String(g);
        this.sendCommand({
          action: 'SET_CONFIG',
          payload: { gain: g }
        });
      });
    });

    roiSelect.addEventListener('change', () => {
      const [w, h] = roiSelect.value.split('x').map(Number);
      const x = Math.floor((3840 - w) / 4) * 2;
      const y = Math.floor((2160 - h) / 4) * 2;
      this.sendCommand({
        action: 'SET_CONFIG',
        payload: { roi: { x, y, width: w, height: h, bin: 1 } }
      });
    });

    const blackVal = this.container.querySelector('#stretch-black-val') as HTMLElement;
    const whiteVal = this.container.querySelector('#stretch-white-val') as HTMLElement;
    const gammaVal = this.container.querySelector('#stretch-gamma-val') as HTMLElement;

    const setStretchControls = (p: StretchParams) => {
      stretchBlack.value = String(p.black);
      stretchWhite.value = String(p.white);
      stretchGamma.value = String(p.gamma);
    };

    const applyStretch = (changed?: 'black' | 'white') => {
      let black = Number(stretchBlack.value);
      let white = Number(stretchWhite.value);
      // Keep black below white, moving whichever slider the user didn't touch
      if (white - black < 5) {
        if (changed === 'white') black = Math.max(0, white - 5);
        else white = Math.min(255, black + 5);
        stretchBlack.value = String(black);
        stretchWhite.value = String(white);
      }
      const gamma = Number(stretchGamma.value);
      blackVal.textContent = String(black);
      whiteVal.textContent = String(white);
      gammaVal.textContent = gamma.toFixed(2);
      this.onStretchChange({ black, white, gamma });
    };

    stretchBlack.addEventListener('input', () => applyStretch('black'));
    stretchWhite.addEventListener('input', () => applyStretch('white'));
    stretchGamma.addEventListener('input', () => applyStretch());

    (this.container.querySelector('#btn-stretch-auto') as HTMLButtonElement).addEventListener('click', () => {
      const auto = this.onAutoStretch();
      if (!auto) return;
      setStretchControls(auto);
      applyStretch();
    });

    (this.container.querySelector('#btn-stretch-reset') as HTMLButtonElement).addEventListener('click', () => {
      setStretchControls(DEFAULT_STRETCH);
      applyStretch();
    });

    const btnLiveStack = this.container.querySelector('#btn-live-stack') as HTMLButtonElement;
    btnLiveStack.addEventListener('click', () => {
      this.sendCommand({
        action: 'SET_LIVE_STACK',
        payload: { enabled: btnLiveStack.dataset.enabled !== 'true' }
      });
    });

    const btnRecStart = this.container.querySelector('#btn-rec-start') as HTMLButtonElement;
    const btnRecStop = this.container.querySelector('#btn-rec-stop') as HTMLButtonElement;
    const recFrames = this.container.querySelector('#rec-frames') as HTMLInputElement;

    btnRecStart.addEventListener('click', () => {
      this.sendCommand({
        action: 'START_RECORDING',
        payload: {
          limitType: 'FRAMES',
          limitValue: Number(recFrames.value) || 500
        }
      });
    });

    btnRecStop.addEventListener('click', () => {
      this.sendCommand({ action: 'STOP_RECORDING' });
    });

    const btnSnapshot = this.container.querySelector('#btn-snapshot') as HTMLButtonElement;
    btnSnapshot.addEventListener('click', () => {
      this.setSnapshotBusy(true);
      this.sendCommand({ action: 'GRAB_SNAPSHOT' });
      // Fallback in case no frame arrives (e.g. camera stalled or disconnected)
      setTimeout(() => this.setSnapshotBusy(false), 15000);
    });
  }

  setSnapshotBusy(busy: boolean): void {
    const btn = this.container.querySelector('#btn-snapshot') as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? 'Saving...' : 'Save Frame (.JPG)';
  }

  updateFromTelemetry(tel: TelemetryMessage): void {
    const hcgBadge = this.container.querySelector('#hcg-badge') as HTMLElement;
    if (hcgBadge) {
      if (tel.camera.hcgActive) {
        hcgBadge.textContent = `HCG ACTIVE (${tel.camera.readNoiseElec}e-)`;
        hcgBadge.className = 'badge badge-emerald';
      } else {
        hcgBadge.textContent = `LCG MODE (${tel.camera.readNoiseElec}e-)`;
        hcgBadge.className = 'badge badge-amber';
      }
    }

    const recStatus = this.container.querySelector('#rec-status') as HTMLElement;

    const btnLiveStack = this.container.querySelector('#btn-live-stack') as HTMLButtonElement | null;
    const stackStatus = this.container.querySelector('#stack-status') as HTMLElement | null;
    if (btnLiveStack && stackStatus) {
      const stack = tel.camera.liveStack;
      const enabled = Boolean(stack?.enabled);
      btnLiveStack.dataset.enabled = String(enabled);
      btnLiveStack.textContent = enabled ? 'Disable Live Stack' : 'Enable Live Stack';
      btnLiveStack.classList.toggle('btn-accent', enabled);
      stackStatus.textContent = enabled ? `ON (${stack?.frames ?? 0} frames)` : 'OFF';
      stackStatus.style.color = enabled ? '#34d399' : '#94a3b8';
    }

    const roiSelect = this.container.querySelector('#roi-select') as HTMLSelectElement;
    const roiValue = `${tel.camera.roi.width}x${tel.camera.roi.height}`;
    if (roiSelect && document.activeElement !== roiSelect && roiSelect.value !== roiValue) {
      if (Array.from(roiSelect.options).some((o) => o.value === roiValue)) {
        roiSelect.value = roiValue;
      }
    }
    const btnStart = this.container.querySelector('#btn-rec-start') as HTMLButtonElement;
    const btnStop = this.container.querySelector('#btn-rec-stop') as HTMLButtonElement;

    if (recStatus && btnStart && btnStop) {
      if (tel.camera.isRecording) {
        recStatus.textContent = `REC (${tel.camera.recordedFrames} frames)`;
        recStatus.style.color = '#f87171';
        btnStart.disabled = true;
        btnStop.disabled = false;
      } else {
        recStatus.textContent = 'READY';
        recStatus.style.color = '#94a3b8';
        btnStart.disabled = false;
        btnStop.disabled = true;
      }
    }
  }
}
