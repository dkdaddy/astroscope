import {
  FRAME_TYPE,
  unpackBinaryFrame,
  type ClientCommand,
  type TelemetryMessage
} from '../common/protocol.js';
import { Viewport } from './components/Viewport.js';
import { FocusGraph } from './components/FocusGraph.js';
import { CameraSettings } from './components/CameraSettings.js';
import { MountControl } from './components/MountControl.js';
import { computeBayerFocusScore } from './components/FocusAnalyzer.js';

const mainCanvas = document.getElementById('main-viewport-canvas') as HTMLCanvasElement;
const pipCanvas = document.getElementById('pip-canvas') as HTMLCanvasElement;
const focusGraphCanvas = document.getElementById('focus-graph-canvas') as HTMLCanvasElement;

const scoreBigEl = document.getElementById('focus-score-big') as HTMLElement;
const peakValEl = document.getElementById('focus-peak-val') as HTMLElement;
const pctValEl = document.getElementById('focus-pct-val') as HTMLElement;
const meterFillEl = document.getElementById('focus-meter-fill') as HTMLElement;
const lockPillEl = document.getElementById('focus-lock-pill') as HTMLElement;
const resetPeakBtn = document.getElementById('btn-reset-peak') as HTMLButtonElement;

const statFpsEl = document.getElementById('stat-fps') as HTMLElement;
const statTempEl = document.getElementById('stat-temp') as HTMLElement;
const statNoiseEl = document.getElementById('stat-noise') as HTMLElement;
const wsStatusEl = document.getElementById('ws-status') as HTMLElement;
const cameraModelEl = document.getElementById('camera-model') as HTMLElement;

let ws: WebSocket | null = null;

function sendCommand(cmd: ClientCommand): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(cmd));
  }
}

const focusGraph = new FocusGraph(focusGraphCanvas);

const viewport = new Viewport(mainCanvas, pipCanvas, (newFocusRoi) => {
  sendCommand({
    action: 'SET_FOCUS_ROI',
    payload: newFocusRoi
  });
  focusGraph.resetPeak();
});

const cameraSettings = new CameraSettings(
  document.getElementById('camera-settings-mount') as HTMLElement,
  sendCommand,
  (stretch) => viewport.setStretchGain(stretch)
);

const mountControl = new MountControl(
  document.getElementById('mount-control-mount') as HTMLElement,
  sendCommand
);

resetPeakBtn.addEventListener('click', () => {
  focusGraph.resetPeak();
});

function updateFocusHud(rawScore: number): void {
  const { smoothed, peak, percentOfPeak } = focusGraph.pushScore(rawScore);
  scoreBigEl.textContent = smoothed.toFixed(1);
  peakValEl.textContent = peak.toFixed(1);
  pctValEl.textContent = `${Math.round(percentOfPeak)}%`;
  meterFillEl.style.width = `${percentOfPeak.toFixed(1)}%`;

  if (percentOfPeak >= 95 && peak > 5) {
    lockPillEl.textContent = '★ OPTIMAL FOCUS LOCK';
    lockPillEl.className = 'badge badge-emerald';
    scoreBigEl.style.color = '#10b981';
  } else if (percentOfPeak >= 78 && peak > 5) {
    lockPillEl.textContent = 'NEAR FOCUS PEAK';
    lockPillEl.className = 'badge badge-cyan';
    scoreBigEl.style.color = '#22d3ee';
  } else {
    lockPillEl.textContent = 'DEFOCUSED';
    lockPillEl.className = 'badge badge-amber';
    scoreBigEl.style.color = '#f59e0b';
  }
}

function connectWebSocket(): void {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${window.location.host}/ws/live`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    wsStatusEl.textContent = 'CONNECTED';
    wsStatusEl.className = 'stat-value status-online';
  };

  ws.onclose = () => {
    wsStatusEl.textContent = 'RECONNECTING...';
    wsStatusEl.className = 'stat-value';
    setTimeout(connectWebSocket, 1000);
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      const { header, payload } = unpackBinaryFrame(event.data);
      if (header.frameType === FRAME_TYPE.VIEWPORT_PREVIEW) {
        viewport.renderMainViewport(payload, header.width, header.height);
      } else if (header.frameType === FRAME_TYPE.FOCUS_ROI_CROP) {
        viewport.renderPipRoi(payload, header.width, header.height);
        // Client-side Bayer-aware Laplacian verification on 1:1 native ROI crop
        const clientScore = computeBayerFocusScore(payload, header.width, header.height);
        updateFocusHud(header.serverScore > 0 ? header.serverScore : clientScore);
      }
    } else if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'FOCUS_TICK') {
        // High-FPS focus score tick directly from camera worker thread
        updateFocusHud(msg.focusScore);
        if (typeof msg.fps === 'number') {
          statFpsEl.textContent = `${msg.fps.toFixed(1)}`;
        }
      } else if (msg.type === 'TELEMETRY') {
        const tel = msg as TelemetryMessage;
        cameraModelEl.textContent = tel.camera.name;
        statFpsEl.textContent = `${tel.camera.fps.toFixed(1)}`;
        statTempEl.textContent = `${tel.camera.temperatureC.toFixed(1)} °C`;
        statNoiseEl.textContent = `${tel.camera.readNoiseElec.toFixed(2)} e-`;
        viewport.setSensorDimensions(
          tel.camera.roi.width,
          tel.camera.roi.height,
          tel.camera.focusRoi
        );
        cameraSettings.updateFromTelemetry(tel);
        mountControl.updateFromTelemetry(tel);
      }
    }
  };
}

connectWebSocket();
