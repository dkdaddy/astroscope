import net from 'node:net';
import { EventEmitter } from 'node:events';

export interface IndiCoordEvent {
  ra: number;
  dec: number;
}

export class IndiClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private connected = false;
  private buffer = '';

  constructor(
    private host = '127.0.0.1',
    private port = 7624
  ) {
    super();
  }

  connect(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let settled = false;

      sock.setTimeout(1200);

      sock.on('connect', () => {
        this.socket = sock;
        this.connected = true;
        sock.write('<getProperties version="1.7"/>\n');
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });

      sock.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8');
        this.parseBuffer();
      });

      sock.on('error', () => {
        this.connected = false;
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });

      sock.on('timeout', () => {
        if (!this.connected) {
          sock.destroy();
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }
      });

      sock.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
      });

      sock.connect(this.port, this.host);
    });
  }

  private parseBuffer(): void {
    // Parse EQUATORIAL_EOD_COORD XML blocks from INDI stream
    const regex = /<setNumberVector[^>]*name="EQUATORIAL_EOD_COORD"[^>]*>([\s\S]*?)<\/setNumberVector>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(this.buffer)) !== null) {
      const inner = match[1];
      const raMatch = /<oneNumber[^>]*name="RA"[^>]*>\s*([+-]?\d+(?:\.\d+)?)\s*<\/oneNumber>/.exec(inner);
      const decMatch = /<oneNumber[^>]*name="DEC"[^>]*>\s*([+-]?\d+(?:\.\d+)?)\s*<\/oneNumber>/.exec(inner);
      if (raMatch && decMatch) {
        this.emit('coords', {
          ra: parseFloat(raMatch[1]),
          dec: parseFloat(decMatch[1])
        } satisfies IndiCoordEvent);
      }
    }
    if (this.buffer.length > 16384) {
      this.buffer = this.buffer.slice(-4096);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  sendRawXml(xml: string): void {
    if (this.socket && this.connected) {
      this.socket.write(xml + '\n');
    }
  }

  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }
}
