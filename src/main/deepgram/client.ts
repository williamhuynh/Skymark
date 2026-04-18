import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import type { TranscriptEvent } from '../../shared/types';

const CONNECT_TIMEOUT_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 5_000;

export type DeepgramClientOptions = {
  apiKey: string;
  keyterms?: string[];
  sampleRate?: number;
};

type DeepgramAlternative = {
  transcript: string;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    speaker?: number;
    punctuated_word?: string;
  }>;
};

type DeepgramResult = {
  type: 'Results' | 'SpeechStarted' | 'UtteranceEnd' | 'Metadata' | string;
  channel?: {
    alternatives?: DeepgramAlternative[];
  };
  is_final?: boolean;
  start?: number;
  duration?: number;
};

export class DeepgramClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private readonly sampleRate: number;
  private readonly keyterms: string[];
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(opts: DeepgramClientOptions) {
    super();
    this.apiKey = opts.apiKey;
    this.sampleRate = opts.sampleRate ?? 16000;
    this.keyterms = opts.keyterms ?? [];
  }

  async connect(): Promise<void> {
    const params = new URLSearchParams({
      model: 'nova-3',
      diarize: 'true',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '500',
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      channels: '1',
    });
    for (const term of this.keyterms) {
      params.append('keyterm', term);
    }

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        this.emit('open');
        this.startKeepAlive();
        resolve();
      };
      const settleErr = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        if (this.ws === ws) this.ws = null;
        reject(err);
      };

      const connectTimeout = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        settleErr(new Error(`Deepgram connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);

      ws.once('open', settleOk);

      ws.on('error', (err) => {
        if (!settled) {
          settleErr(err instanceof Error ? err : new Error(String(err)));
        } else {
          // Post-connect error — surface to the session, don't crash the EventEmitter.
          this.emit('ws-error', err instanceof Error ? err : new Error(String(err)));
        }
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as DeepgramResult;
          this.handleMessage(msg);
        } catch {
          // Ignore non-JSON messages.
        }
      });

      ws.on('close', (code, reason) => {
        this.stopKeepAlive();
        if (this.ws === ws) this.ws = null;
        this.emit('close', { code, reason: reason?.toString() ?? '' });
      });
    });
  }

  private handleMessage(msg: DeepgramResult): void {
    if (msg.type !== 'Results') return;
    const alt = msg.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;

    let speaker: string | null = null;
    if (alt.words && alt.words.length > 0) {
      const spkIds = new Set(alt.words.map((w) => w.speaker).filter((s): s is number => typeof s === 'number'));
      if (spkIds.size === 1) {
        speaker = `Speaker ${[...spkIds][0]}`;
      } else if (spkIds.size > 1) {
        speaker = 'Multiple';
      }
    }

    const startMs = Math.round((msg.start ?? 0) * 1000);
    const durationMs = Math.round((msg.duration ?? 0) * 1000);
    const ev: TranscriptEvent = {
      speaker,
      text: alt.transcript,
      startMs,
      endMs: startMs + durationMs,
      isFinal: Boolean(msg.is_final),
    };
    this.emit('transcript', ev);
  }

  sendAudio(buf: Buffer | ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(buf);
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        } catch {
          // If the send fails, the close handler will clean up.
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopKeepAlive();
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    } catch {
      // Socket may already be closed.
    }
    this.ws.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !this.closed;
  }
}
