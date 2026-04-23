import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import log from 'electron-log/main.js';
import type {
  TranscriptEntity,
  TranscriptEvent,
  TranscriptRecord,
  TranscriptWord,
} from '../../shared/types';

const CONNECT_TIMEOUT_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 5_000;

export type DeepgramClientOptions = {
  apiKey: string;
  keyterms?: string[];
  sampleRate?: number;
};

type DeepgramAlternative = {
  transcript: string;
  confidence?: number;
  words?: TranscriptWord[];
  entities?: TranscriptEntity[];
  paragraphs?: unknown;
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
      language: 'en-AU',
      diarize: 'true',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      // 1000ms: longer context window → better word accuracy, punctuation,
      // and diarization confidence. Finals arrive ~500ms later than at 500ms
      // but live latency isn't a concern; archives are the consumer.
      endpointing: '1000',
      numerals: 'true',
      // Extraction-oriented enrichments. All computed server-side by Deepgram
      // and returned in the Results payload — no extra local cost.
      paragraphs: 'true',
      detect_entities: 'true',
      measurements: 'true',
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

      let firstTranscript = true;
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as DeepgramResult;
          if (firstTranscript && msg.type === 'Results') {
            firstTranscript = false;
            log.info(
              '[deepgram] first Results received; has_transcript=' +
                Boolean(msg.channel?.alternatives?.[0]?.transcript),
            );
          }
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
    const isFinal = Boolean(msg.is_final);
    const ev: TranscriptEvent = {
      speaker,
      text: alt.transcript,
      startMs,
      endMs: startMs + durationMs,
      isFinal,
    };
    // Light event for IPC → renderer (minimal payload).
    this.emit('transcript', ev);

    // Rich record for on-disk persistence. Only emit on finals so we don't
    // flood the disk with every interim refinement. Contains per-word data,
    // entities, paragraphs, confidence — whatever Deepgram returned.
    if (isFinal) {
      const record: TranscriptRecord = {
        ...ev,
        words: alt.words,
        entities: alt.entities,
        paragraphs: alt.paragraphs,
        confidence: alt.confidence,
      };
      this.emit('record', record);
    }
  }

  private wsSendCount = 0;
  private wsSendBytes = 0;

  sendAudio(buf: Buffer | ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.wsSendCount === 0) {
        log.warn('[deepgram] sendAudio called but ws not open, state:', this.ws?.readyState);
      }
      return;
    }
    this.ws.send(buf);
    this.wsSendCount++;
    const byteLen = (buf as Buffer).byteLength ?? (buf as ArrayBuffer).byteLength;
    this.wsSendBytes += byteLen;
    if (this.wsSendCount === 1) {
      log.info(`[deepgram] first audio frame sent, ${byteLen}B`);
    }
  }

  getStats(): { sent: number; bytes: number } {
    return { sent: this.wsSendCount, bytes: this.wsSendBytes };
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
    log.info(
      `[deepgram] closing; sent ${this.wsSendCount} frames / ${this.wsSendBytes} bytes total`,
    );
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
}
