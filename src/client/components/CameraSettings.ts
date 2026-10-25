import type { ClientCommand, TelemetryMessage } from '../../common/protocol.js';

export class CameraSettings {
  constructor(
    private container: HTMLElement,
    private sendCommand: (cmd: ClientCommand) => void,
    private onStretchChange: (stretch: number) => void
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
            <label for="exp-slider">Exposure (ms)</label>
            <span id="exp-val" class="mono-val">15.0 ms</span>
          </div>
          <input id="exp-slider" type="range" min="1" max="200" step="1" value="15" />
          <div class="preset-row">
            <button type="button" class="btn-chip exp-preset" data-exp="5000">5ms (200fps)</button>
            <button type="button" class="btn-chip exp-preset" data-exp="10000">10ms (100fps)</button>
            <button type="button" class="btn-chip exp-preset" data-exp="15000">15ms (66fps)</button>
            <button type="button" class="btn-chip exp-preset" data-exp="30000">30ms (33fps)</button>
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

        <div class="control-row-split">
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
            <label for="stretch-slider">Display Stretch</label>
            <input id="stretch-slider" type="range" min="0.5" max="4.0" step="0.1" value="1.35" />
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
    const stretchSlider = this.container.querySelector('#stretch-slider') as HTMLInputElement;

    expSlider.addEventListener('input', () => {
      const ms = Number(expSlider.value);
      expVal.textContent = `${ms.toFixed(1)} ms`;
      this.sendCommand({
        action: 'SET_CONFIG',
        payload: { exposureUs: ms * 1000 }
      });
    });

    this.container.querySelectorAll('.exp-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const us = Number((btn as HTMLElement).dataset.exp);
        expSlider.value = String(Math.round(us / 1000));
        expVal.textContent = `${(us / 1000).toFixed(1)} ms`;
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

    stretchSlider.addEventListener('input', () => {
      this.onStretchChange(Number(stretchSlider.value));
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
