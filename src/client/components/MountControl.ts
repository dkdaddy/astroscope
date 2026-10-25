import type { MockSceneType } from '../../common/camera-interface.js';
import type { ClientCommand, TelemetryMessage } from '../../common/protocol.js';

export class MountControl {
  private currentFocusPos = 465;

  constructor(
    private container: HTMLElement,
    private sendCommand: (cmd: ClientCommand) => void
  ) {
    this.render();
    this.bindEvents();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="panel-card">
        <div class="panel-header">
          <h3>SIMULATED FOCUSER &amp; SKY TARGET</h3>
          <span class="badge badge-cyan">SIMULATOR</span>
        </div>

        <div class="control-group">
          <div class="control-label-row">
            <label for="focus-knob-slider">Manual Focuser Knob Position (0–1000)</label>
            <span id="focus-pos-val" class="mono-val">465</span>
          </div>
          <input id="focus-knob-slider" type="range" min="380" max="620" step="1" value="465" />
          <div class="preset-row">
            <button type="button" class="btn-chip focus-step" data-delta="-15">-15 Coarse</button>
            <button type="button" class="btn-chip focus-step" data-delta="-3">-3 Fine</button>
            <button type="button" class="btn-chip focus-step btn-accent" data-abs="500">★ Best (500)</button>
            <button type="button" class="btn-chip focus-step" data-delta="3">+3 Fine</button>
            <button type="button" class="btn-chip focus-step" data-delta="15">+15 Coarse</button>
          </div>
        </div>

        <div class="control-row-split">
          <div class="control-group">
            <label for="scene-select">Target Object</label>
            <select id="scene-select">
              <option value="JUPITER" selected>Jupiter + 4 Galilean Moons</option>
              <option value="SATURN">Saturn + Cassini Division</option>
              <option value="MOON">Lunar Crater Terminator</option>
              <option value="STARFIELD">Globular Starfield (PSF)</option>
            </select>
          </div>
          <div class="control-group">
            <label for="seeing-slider">Seeing (<span id="seeing-val">1.0</span>")</label>
            <input id="seeing-slider" type="range" min="0.3" max="3.5" step="0.1" value="1.0" />
          </div>
        </div>

        <div class="checkbox-row">
          <input id="shake-toggle" type="checkbox" />
          <label for="shake-toggle">Simulate Telescope Tube Shake When Turning Focuser</label>
        </div>
      </div>

      <div class="panel-card">
        <div class="panel-header">
          <h3>TELESCOPE MOUNT (INDI)</h3>
          <span id="mount-coords" class="mono-val">RA 5.575h | DEC +23.21°</span>
        </div>

        <div class="mount-grid-layout">
          <div class="dpad">
            <div></div>
            <button type="button" class="btn-dpad" data-dir="NORTH">▲ N</button>
            <div></div>
            <button type="button" class="btn-dpad" data-dir="WEST">◀ W</button>
            <button type="button" id="btn-track-toggle" class="btn-dpad btn-track-on">TRK</button>
            <button type="button" class="btn-dpad" data-dir="EAST">E ▶</button>
            <div></div>
            <button type="button" class="btn-dpad" data-dir="SOUTH">▼ S</button>
            <div></div>
          </div>

          <div class="slew-controls">
            <label for="slew-speed">Slew Rate</label>
            <select id="slew-speed">
              <option value="GUIDE">GUIDE (0.5x)</option>
              <option value="CENTER" selected>CENTER (4x)</option>
              <option value="FIND">FIND (32x)</option>
              <option value="MAX">MAX (800x)</option>
            </select>
            <div class="hint-text">Use Arrow Keys [← ↑ ↓ →] to nudge focuser, or click N/S/E/W to slew mount.</div>
          </div>
        </div>
      </div>
    `;
  }

  private bindEvents(): void {
    const focusSlider = this.container.querySelector('#focus-knob-slider') as HTMLInputElement;
    const focusVal = this.container.querySelector('#focus-pos-val') as HTMLElement;
    const sceneSelect = this.container.querySelector('#scene-select') as HTMLSelectElement;
    const seeingSlider = this.container.querySelector('#seeing-slider') as HTMLInputElement;
    const seeingVal = this.container.querySelector('#seeing-val') as HTMLElement;
    const shakeToggle = this.container.querySelector('#shake-toggle') as HTMLInputElement;

    const setFocusPosition = (pos: number) => {
      this.currentFocusPos = Math.max(0, Math.min(1000, Math.round(pos)));
      focusSlider.value = String(this.currentFocusPos);
      focusVal.textContent = String(this.currentFocusPos);
      this.sendCommand({
        action: 'SET_MOCK_PARAMS',
        payload: { focuserPosition: this.currentFocusPos }
      });
    };

    focusSlider.addEventListener('input', () => {
      setFocusPosition(Number(focusSlider.value));
    });

    this.container.querySelectorAll('.focus-step').forEach((btn) => {
      btn.addEventListener('click', () => {
        const el = btn as HTMLElement;
        if (el.dataset.abs !== undefined) {
          setFocusPosition(Number(el.dataset.abs));
        } else if (el.dataset.delta !== undefined) {
          setFocusPosition(this.currentFocusPos + Number(el.dataset.delta));
        }
      });
    });

    // Allow keyboard Left/Right arrow keys for eyes-free focusing while watching the score!
    window.addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setFocusPosition(this.currentFocusPos - (e.shiftKey ? 10 : 2));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setFocusPosition(this.currentFocusPos + (e.shiftKey ? 10 : 2));
      }
    });

    sceneSelect.addEventListener('change', () => {
      this.sendCommand({
        action: 'SET_MOCK_PARAMS',
        payload: { scene: sceneSelect.value as MockSceneType }
      });
    });

    seeingSlider.addEventListener('input', () => {
      const v = Number(seeingSlider.value);
      seeingVal.textContent = v.toFixed(1);
      this.sendCommand({
        action: 'SET_MOCK_PARAMS',
        payload: { seeingArcsec: v }
      });
    });

    shakeToggle.addEventListener('change', () => {
      this.sendCommand({
        action: 'SET_MOCK_PARAMS',
        payload: { vibrationShake: shakeToggle.checked }
      });
    });

    const slewSpeed = this.container.querySelector('#slew-speed') as HTMLSelectElement;
    this.container.querySelectorAll('.btn-dpad[data-dir]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dir = (btn as HTMLElement).dataset.dir as 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';
        this.sendCommand({
          action: 'MOUNT_JOG',
          payload: {
            direction: dir,
            speed: slewSpeed.value as 'GUIDE' | 'CENTER' | 'FIND' | 'MAX',
            durationMs: 350
          }
        });
      });
    });

    const trackBtn = this.container.querySelector('#btn-track-toggle') as HTMLButtonElement;
    let tracking = true;
    trackBtn.addEventListener('click', () => {
      tracking = !tracking;
      trackBtn.className = tracking ? 'btn-dpad btn-track-on' : 'btn-dpad btn-track-off';
      this.sendCommand({
        action: 'MOUNT_TRACKING',
        payload: { tracking, trackRate: 'SIDEREAL' }
      });
    });
  }

  updateFromTelemetry(tel: TelemetryMessage): void {
    const coords = this.container.querySelector('#mount-coords') as HTMLElement;
    if (coords) {
      const sign = tel.mount.dec >= 0 ? '+' : '';
      coords.textContent = `RA ${tel.mount.ra.toFixed(3)}h | DEC ${sign}${tel.mount.dec.toFixed(2)}°`;
    }
  }
}
