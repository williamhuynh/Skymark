import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import type { TranscriptEvent } from '../../shared/types';

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
      ws.once('open', () => {
        this.emit('open');
        resolve();
      });

      ws.once('error', (err) => {
        if (this.ws === ws) {
          this.ws = null;
        }
        reject(err);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as DeepgramResult;
          this.handleMessage(msg);
        } catch {
          // Ignore non-JSON messages.
        }
      });

      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        this.emit('close');
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

  async close(): Promise<void> {
    this.closed = true;
    if (!this.ws) return;
    try {
      // Deepgram close-stream message flushes pending results.
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
