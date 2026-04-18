import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import type { Nudge, QuestionAnswer, Specialist, TranscriptEvent } from '../../shared/types';

const HTTP_TIMEOUT_MS = 10_000;
const WS_PING_INTERVAL_MS = 30_000;

export type MCClientOptions = {
  baseUrl: string;
};

type CreateMeetingResponse = { id: string };
type AskResponse = { questionId: string };

function httpBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

function wsBase(baseUrl: string): string {
  const trimmed = httpBase(baseUrl);
  if (trimmed.startsWith('https://')) return 'wss://' + trimmed.slice(8);
  if (trimmed.startsWith('http://')) return 'ws://' + trimmed.slice(7);
  return trimmed;
}

export class MCClient extends EventEmitter {
  private readonly baseUrl: string;
  private streamWs: WebSocket | null = null;
  private streamPing: NodeJS.Timeout | null = null;
  private subscribeWs: WebSocket | null = null;
  private subscribePing: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(opts: MCClientOptions) {
    super();
    this.baseUrl = opts.baseUrl;
  }

  async createMeeting(args: { title: string; platform: string; specialist: Specialist }): Promise<string> {
    const res = await fetch(`${httpBase(this.baseUrl)}/api/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`MC createMeeting failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as CreateMeetingResponse;
    return body.id;
  }

  async endMeeting(meetingId: string): Promise<void> {
    try {
      await fetch(`${httpBase(this.baseUrl)}/api/meetings/${meetingId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  async ask(meetingId: string, question: string): Promise<string> {
    const res = await fetch(`${httpBase(this.baseUrl)}/api/meetings/${meetingId}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`MC ask failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as AskResponse;
    return body.questionId;
  }

  openStream(meetingId: string): void {
    if (this.streamWs) return;
    const ws = new WebSocket(`${wsBase(this.baseUrl)}/ws/meetings/${meetingId}/stream`);
    this.streamWs = ws;

    ws.on('open', () => {
      this.streamPing = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch { /* ignore */ }
        }
      }, WS_PING_INTERVAL_MS);
    });
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', (code, reason) => {
      if (this.streamPing) {
        clearInterval(this.streamPing);
        this.streamPing = null;
      }
      if (this.streamWs === ws) this.streamWs = null;
      if (!this.closed) {
        this.emit('stream-closed', { code, reason: reason?.toString() ?? '' });
      }
    });
  }

  sendTranscript(ev: TranscriptEvent): void {
    const ws = this.streamWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = { type: 'transcript', ...ev };
    ws.send(JSON.stringify(frame));
  }

  openSubscribe(meetingId: string): void {
    if (this.subscribeWs) return;
    const ws = new WebSocket(`${wsBase(this.baseUrl)}/ws/meetings/${meetingId}/subscribe`);
    this.subscribeWs = ws;

    ws.on('open', () => {
      this.subscribePing = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch { /* ignore */ }
        }
      }, WS_PING_INTERVAL_MS);
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        this.handleSubscribeMessage(msg);
      } catch {
        // Ignore non-JSON frames.
      }
    });
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', (code, reason) => {
      if (this.subscribePing) {
        clearInterval(this.subscribePing);
        this.subscribePing = null;
      }
      if (this.subscribeWs === ws) this.subscribeWs = null;
      if (!this.closed) {
        this.emit('subscribe-closed', { code, reason: reason?.toString() ?? '' });
      }
    });
  }

  private handleSubscribeMessage(msg: Record<string, unknown>): void {
    if (typeof msg.type !== 'string') return;

    // MC wraps every subscribe-WS payload as { type, event: {...fields} }.
    // Unwrap to the inner event before reading fields. Fall back to the
    // top-level object for defensive compatibility in case MC ever changes shape.
    const ev = ((msg.event as Record<string, unknown>) ?? msg) as Record<string, unknown>;

    switch (msg.type) {
      case 'nudge': {
        if (ev.status !== 'resolved' || !ev.nudgeText) return;
        const nudge: Nudge = {
          nudgeId: String(ev.nudgeId),
          reason: String(ev.reason ?? 'unknown'),
          triggerText: String(ev.triggerText ?? ''),
          nudgeText: String(ev.nudgeText),
          resolvedAt: Date.now(),
        };
        this.emit('nudge', nudge);
        break;
      }
      case 'question': {
        if (ev.status !== 'answered' || !ev.answer) return;
        const ans: QuestionAnswer = {
          questionId: String(ev.questionId),
          question: String(ev.question ?? ''),
          answer: String(ev.answer),
          answeredAt: Date.now(),
        };
        this.emit('answer', ans);
        break;
      }
      default:
        break;
    }
  }

  close(): void {
    this.closed = true;
    if (this.streamPing) { clearInterval(this.streamPing); this.streamPing = null; }
    if (this.subscribePing) { clearInterval(this.subscribePing); this.subscribePing = null; }
    if (this.streamWs) {
      try { this.streamWs.close(); } catch { /* ignore */ }
      this.streamWs = null;
    }
    if (this.subscribeWs) {
      try { this.subscribeWs.close(); } catch { /* ignore */ }
      this.subscribeWs = null;
    }
  }
}

