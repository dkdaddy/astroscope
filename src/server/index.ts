import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import type { ClientCommand } from '../common/protocol.js';
import { MountController } from './mount/mount-controller.js';
import { AppState } from './state/app-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createAstroScopeServer(port = 3000) {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  // Serve built client assets when available
  const distClient = path.resolve(process.cwd(), 'dist/client');
  if (fs.existsSync(distClient)) {
    await app.register(fastifyStatic, {
      root: distClient,
      prefix: '/'
    });
  }

  const state = new AppState();
  const mount = new MountController();
  await mount.initialize();

  // Spawn camera acquisition worker thread
  const distWorkerPath = path.resolve(process.cwd(), 'dist/server/camera/camera-worker.js');
  const localWorkerPath = path.resolve(__dirname, './camera/camera-worker.js');
  const workerPath = fs.existsSync(localWorkerPath) ? localWorkerPath : distWorkerPath;
  const worker = new Worker(workerPath);

  const clients = new Set<WebSocket>();

  // Forward mount sky offsets to Mock Camera
  mount.on('skyOffsetChanged', (skyOffsetPx) => {
    worker.postMessage({
      type: 'SET_MOCK_PARAMS',
      payload: { skyOffsetPx }
    });
  });

  const broadcastJson = (payload: unknown) => {
    const str = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(str);
      }
    }
  };

  const broadcastBinary = (buf: ArrayBuffer) => {
    const u8 = new Uint8Array(buf);
    for (const ws of clients) {
      if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) {
        ws.send(u8, { binary: true });
      }
    }
  };

  worker.on('message', (msg: any) => {
    if (msg.type === 'BINARY_FRAMES') {
      broadcastBinary(msg.viewportBuffer);
      broadcastBinary(msg.roiBuffer);
    } else if (msg.type === 'FOCUS_SCORE') {
      // High-rate lightweight JSON packet for instantaneous focus bar/graph updates
      broadcastJson({
        type: 'FOCUS_TICK',
        frameNumber: msg.frameNumber,
        focusScore: msg.focusScore,
        fps: msg.fps
      });
    } else if (msg.type === 'STATUS') {
      state.updateCamera(msg.camera);
      const m = mount.getState();
      state.updateMount({
        connected: m.connected,
        isSimulated: m.isSimulated,
        driver: m.driver,
        ra: m.ra,
        dec: m.dec,
        tracking: m.tracking,
        trackRate: m.trackRate
      });
      broadcastJson(state.getTelemetry());
    }
  });

  // Poll full system telemetry at 4 Hz
  let lastTick = performance.now();
  const telemetryInterval = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - lastTick - 250);
    lastTick = now;
    state.updateSystem({ eventLoopLagMs: Number(lag.toFixed(2)) });
    worker.postMessage({ type: 'GET_STATUS' });
  }, 250);

  app.get('/api/status', async () => {
    return state.getTelemetry();
  });

  app.register(async (fastify) => {
    fastify.get('/ws/live', { websocket: true }, (socket) => {
      clients.add(socket);
      socket.send(JSON.stringify(state.getTelemetry()));

      socket.on('message', (raw) => {
        try {
          const cmd = JSON.parse(raw.toString()) as ClientCommand;
          if (cmd.action === 'SET_CONFIG') {
            worker.postMessage({ type: 'SET_CONFIG', payload: cmd.payload });
          } else if (cmd.action === 'SET_FOCUS_ROI') {
            worker.postMessage({ type: 'SET_FOCUS_ROI', payload: cmd.payload });
          } else if (cmd.action === 'SET_MOCK_PARAMS') {
            worker.postMessage({ type: 'SET_MOCK_PARAMS', payload: cmd.payload });
          } else if (cmd.action === 'START_RECORDING') {
            worker.postMessage({ type: 'START_RECORDING', payload: cmd.payload });
          } else if (cmd.action === 'STOP_RECORDING') {
            worker.postMessage({ type: 'STOP_RECORDING' });
          } else if (cmd.action === 'MOUNT_JOG') {
            mount.jog(cmd.payload.direction, cmd.payload.speed, cmd.payload.durationMs);
          } else if (cmd.action === 'MOUNT_TRACKING') {
            mount.setTracking(cmd.payload.tracking, cmd.payload.trackRate);
          }
          worker.postMessage({ type: 'GET_STATUS' });
        } catch {
          // Ignore malformed messages
        }
      });

      socket.on('close', () => {
        clients.delete(socket);
      });
    });
  });

  const closeServer = async () => {
    clearInterval(telemetryInterval);
    mount.close();
    await worker.terminate();
    await app.close();
  };

  await app.listen({ port, host: '0.0.0.0' });
  return { app, closeServer, port };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3000);
  createAstroScopeServer(port).then(() => {
    console.log(`[AstroScope] Server listening on http://localhost:${port}`);
  });
}
