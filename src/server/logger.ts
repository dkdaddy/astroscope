import fs from 'node:fs';
import path from 'node:path';
import { isMainThread, threadId } from 'node:worker_threads';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'astroscope.log');

type Level = 'INFO' | 'WARN' | 'ERROR';

function write(level: Level, scope: string, message: string, detail?: unknown): void {
  const thread = isMainThread ? 'main' : `worker-${threadId}`;
  let line = `${new Date().toISOString()} ${level} [${thread}] [${scope}] ${message}`;
  if (detail !== undefined) {
    line += ' ' + (detail instanceof Error ? detail.stack ?? detail.message : JSON.stringify(detail));
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Logging must never crash the app
  }
  if (level === 'ERROR') console.error(line);
}

export function createLogger(scope: string) {
  return {
    info: (msg: string, detail?: unknown) => write('INFO', scope, msg, detail),
    warn: (msg: string, detail?: unknown) => write('WARN', scope, msg, detail),
    error: (msg: string, detail?: unknown) => write('ERROR', scope, msg, detail)
  };
}

export const LOG_FILE_PATH = LOG_FILE;
