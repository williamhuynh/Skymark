import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import type { Nudge, QuestionAnswer, Specialist, TranscriptEvent } from '../../shared/types';

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
  private subscribeWs: WebSocket | null = null;
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
    });
    if (!res.ok) {
      throw new Error(`MC createMeeting failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as CreateMeetingResponse;
    return body.id;
  }

  async endMeeting(meetingId: string): Promise<void> {
    await fetch(`${httpBase(this.baseUrl)}/api/meetings/${meetingId}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => {
      // Best-effort end; server may be unreachable at stop time.
    });
  }

  async ask(meetingId: string, question: string): Promise<string> {
    const res = await fetch(`${httpBase(this.baseUrl)}/api/meetings/${meetingId}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
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
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', () => {
      if (this.streamWs === ws) this.streamWs = null;
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

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleSubscribeMessage(msg);
      } catch {
        // Ignore non-JSON frames.
      }
    });
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', () => {
      if (this.subscribeWs === ws) this.subscribeWs = null;
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleSubscribeMessage(msg: any): void {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'nudge': {
        if (msg.status !== 'resolved' || !msg.nudgeText) return;
        const nudge: Nudge = {
          nudgeId: String(msg.nudgeId),
          reason: String(msg.reason ?? 'unknown'),
          triggerText: String(msg.triggerText ?? ''),
          nudgeText: String(msg.nudgeText),
          resolvedAt: Date.now(),
        };
        this.emit('nudge', nudge);
        break;
      }
      case 'question': {
        if (msg.status !== 'answered' || !msg.answer) return;
        const ans: QuestionAnswer = {
          questionId: String(msg.questionId),
          question: String(msg.question ?? ''),
          answer: String(msg.answer),
          answeredAt: Date.now(),
        };
        this.emit('answer', ans);
        break;
      }
      default:
        // transcript, status, etc. — ignore; Skymark is the source of those.
        break;
    }
  }

  close(): void {
    this.closed = true;
    if (this.streamWs) {
      try { this.streamWs.close(); } catch { /* ignore */ }
      this.streamWs = null;
    }
    if (this.subscribeWs) {
      try { this.subscribeWs.close(); } catch { /* ignore */ }
      this.subscribeWs = null;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
