import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import log from 'electron-log/main.js';
import type { Nudge, QuestionAnswer, Specialist, TranscriptEvent } from '../../shared/types';

const HTTP_TIMEOUT_MS = 10_000;
const WS_PING_INTERVAL_MS = 30_000;
// Cap the replay queue so a long MC outage can't eat renderer memory.
// At ~5 final events/sec worst case, 2000 ≈ 6–7 minutes of buffered transcript.
const MAX_QUEUE = 2000;

export type MCClientOptions = {
  baseUrl: string;
};

type CreateMeetingResponse = { id: string; keyterms?: string[] };
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
  // Transcript frames that arrived while the stream WS was offline. Flushed
  // in FIFO order once the next WS opens. Bounded at MAX_QUEUE; oldest drops.
  private pendingTranscripts: TranscriptEvent[] = [];
  private droppedTranscripts = 0;

  constructor(opts: MCClientOptions) {
    super();
    this.baseUrl = opts.baseUrl;
  }

  async createMeeting(
    args: { title: string; platform: string; specialist: Specialist },
  ): Promise<{ id: string; keyterms: string[] }> {
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
    return { id: body.id, keyterms: body.keyterms ?? [] };
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
      this.flushPendingTranscripts();
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
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Buffer for replay when the stream WS reopens. Reconciliation on
      // meeting stop is the backstop if we exceed MAX_QUEUE or never reconnect.
      if (this.pendingTranscripts.length >= MAX_QUEUE) {
        this.pendingTranscripts.shift();
        this.droppedTranscripts++;
      }
      this.pendingTranscripts.push(ev);
      return;
    }
    const frame = { type: 'transcript', ...ev };
    ws.send(JSON.stringify(frame));
  }

  private flushPendingTranscripts(): void {
    const ws = this.streamWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.pendingTranscripts.length === 0) return;
    const count = this.pendingTranscripts.length;
    log.info(
      `[mc] flushing ${count} queued transcript frame(s)` +
        (this.droppedTranscripts > 0 ? ` (lost ${this.droppedTranscripts} to queue cap)` : ''),
    );
    const queued = this.pendingTranscripts;
    this.pendingTranscripts = [];
    this.droppedTranscripts = 0;
    for (const ev of queued) {
      try {
        ws.send(JSON.stringify({ type: 'transcript', ...ev }));
      } catch (err) {
        log.warn('[mc] flush send failed, re-queueing:', err);
        this.pendingTranscripts.push(ev);
      }
    }
  }

  /**
   * End-of-meeting safety net. Diffs the caller-supplied local transcript
   * against what MC currently has and POSTs any missing events via the REST
   * backup endpoint. Dedupe key is (startMs, text) — Deepgram's startMs is
   * derived from the audio clock so the value is stable end-to-end.
   *
   * Best-effort: failures are reported in the return value, not thrown, so
   * a flaky network at Stop doesn't break session shutdown.
   */
  async reconcileTranscript(
    meetingId: string,
    local: TranscriptEvent[],
  ): Promise<{ sent: number; failed: number; gap: number; mcHad: number }> {
    if (local.length === 0) return { sent: 0, failed: 0, gap: 0, mcHad: 0 };

    const base = httpBase(this.baseUrl);
    const mcRows: Array<{ id: number; start_ms: number | null; text: string }> = [];
    // Paginate through the full MC transcript. Server caps at limit=2000 per
    // call; we use the ascending row id as a cursor (MC's GET supports
    // `?after=<id>`). Without this, long meetings (>2000 events) would
    // silently dedupe against only the first page and we'd re-POST the tail.
    const PAGE_LIMIT = 2000;
    const MAX_PAGES = 20; // 40k events — far beyond any realistic meeting
    let after = 0;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await fetch(
          `${base}/api/meetings/${meetingId}/transcript?limit=${PAGE_LIMIT}&after=${after}`,
          { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
        );
        if (!res.ok) {
          log.warn(`[mc] reconcile GET page ${page} failed: HTTP ${res.status}`);
          return { sent: 0, failed: local.length, gap: local.length, mcHad: 0 };
        }
        const rows = (await res.json()) as typeof mcRows;
        mcRows.push(...rows);
        if (rows.length < PAGE_LIMIT) break;
        after = rows[rows.length - 1].id;
      }
    } catch (err) {
      log.warn('[mc] reconcile GET threw:', err);
      return { sent: 0, failed: local.length, gap: local.length, mcHad: 0 };
    }

    const seen = new Set<string>();
    for (const row of mcRows) seen.add(`${row.start_ms ?? 0}:${row.text}`);

    const missing = local.filter(
      (ev) => !seen.has(`${ev.startMs}:${ev.text}`),
    );
    if (missing.length === 0) {
      return { sent: 0, failed: 0, gap: 0, mcHad: mcRows.length };
    }

    log.info(
      `[mc] reconciling ${missing.length} event(s) missing on MC (mcHad=${mcRows.length}, local=${local.length})`,
    );

    let sent = 0;
    let failed = 0;
    for (const ev of missing) {
      try {
        const res = await fetch(`${base}/api/meetings/${meetingId}/transcript`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            speaker: ev.speaker,
            text: ev.text,
            startMs: ev.startMs,
            endMs: ev.endMs,
            isFinal: ev.isFinal,
          }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (res.ok) sent++;
        else failed++;
      } catch {
        failed++;
      }
    }
    log.info(`[mc] reconcile complete: sent=${sent} failed=${failed} gap=${missing.length}`);
    return { sent, failed, gap: missing.length, mcHad: mcRows.length };
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

