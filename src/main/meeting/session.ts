import { EventEmitter } from 'node:events';
import { safeStorage } from 'electron';
import type Store from 'electron-store';
import { DeepgramClient } from '../deepgram/client';
import { MCClient } from '../mc/client';
import { log } from '../log';
import type {
  AskResult,
  MeetingInfo,
  Nudge,
  QuestionAnswer,
  SessionState,
  StartSessionArgs,
  TranscriptEvent,
} from '../../shared/types';

const BACKOFFS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

export class MeetingSession extends EventEmitter {
  private state: SessionState = { phase: 'idle' };
  private deepgram: DeepgramClient | null = null;
  private mc: MCClient | null = null;
  private meeting: MeetingInfo | null = null;

  private wantsActive = false;
  private apiKey: string | null = null;
  private keyterms: string[] | null = null;
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly store: Store<any>) {
    super();
  }

  getState(): SessionState {
    return this.state;
  }

  private setState(next: SessionState): void {
    this.state = next;
    this.emit('state', next);
  }

  async start(args: StartSessionArgs): Promise<{ ok: true; meeting?: MeetingInfo } | { ok: false; error: string }> {
    if (this.state.phase === 'listening' || this.state.phase === 'connecting' || this.state.phase === 'reconnecting') {
      return { ok: false, error: 'Session already active' };
    }

    const encrypted = this.store.get('deepgramKeyEncrypted') as string | undefined;
    if (!encrypted) {
      return { ok: false, error: 'Deepgram API key not configured' };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS-level encryption unavailable' };
    }

    let apiKey: string;
    try {
      apiKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (err) {
      return { ok: false, error: 'Failed to decrypt Deepgram key: ' + (err instanceof Error ? err.message : String(err)) };
    }

    this.setState({ phase: 'connecting' });
    this.wantsActive = true;
    this.apiKey = apiKey;
    this.keyterms = null; // Set after MC load below (if specialist != 'none').

    // Create MC meeting first (so transcripts can stream into it) unless specialist is 'none'.
    let meetingId: string | null = null;
    let mc: MCClient | null = null;
    let mcKeyterms: string[] = [];
    if (args.specialist !== 'none') {
      const mcUrl = this.store.get('mcUrl') as string | undefined;
      if (!mcUrl) {
        this.wantsActive = false;
        this.setState({ phase: 'error', message: 'MC URL not configured' });
        return { ok: false, error: 'MC URL not configured' };
      }
      mc = new MCClient({ baseUrl: mcUrl });
      try {
        const created = await mc.createMeeting({
          title: args.title ?? `Meeting ${new Date().toISOString()}`,
          platform: args.platform ?? 'skymark',
          specialist: args.specialist,
        });
        meetingId = created.id;
        mcKeyterms = created.keyterms;
        log.info(`[session] loaded ${mcKeyterms.length} keyterms from specialist wiki`);
      } catch (err) {
        this.wantsActive = false;
        this.setState({
          phase: 'error',
          message: 'MC createMeeting failed: ' + (err instanceof Error ? err.message : String(err)),
        });
        return { ok: false, error: this.state.phase === 'error' ? this.state.message : 'createMeeting failed' };
      }
      this.wireMC(mc, meetingId);
      mc.openStream(meetingId);
      mc.openSubscribe(meetingId);
    }

    // Caller-provided keyterms take precedence (so tests can override).
    this.keyterms = args.keyterms ?? mcKeyterms;

    const client = this.newDeepgramClient();
    try {
      await client.connect();
    } catch (err) {
      this.wantsActive = false;
      if (mc && meetingId) {
        await mc.endMeeting(meetingId).catch(() => undefined);
        mc.close();
      }
      this.setState({
        phase: 'error',
        message: 'Deepgram connect failed: ' + (err instanceof Error ? err.message : String(err)),
      });
      return { ok: false, error: this.state.phase === 'error' ? this.state.message : 'connect failed' };
    }

    this.deepgram = client;
    this.mc = mc;
    this.meeting =
      meetingId && args.specialist !== 'none'
        ? { id: meetingId, specialist: args.specialist, startedAt: Date.now() }
        : null;
    this.setState({ phase: 'listening', startedAt: Date.now() });
    return { ok: true, meeting: this.meeting ?? undefined };
  }

  private newDeepgramClient(): DeepgramClient {
    const client = new DeepgramClient({
      apiKey: this.apiKey ?? '',
      keyterms: this.keyterms ?? [],
    });
    client.on('transcript', (ev: TranscriptEvent) => {
      this.emit('transcript', ev);
      if (ev.isFinal && this.mc) this.mc.sendTranscript(ev);
    });
    client.on('ws-error', (err: Error) => {
      log.warn('[deepgram] post-connect error:', err);
    });
    client.on('close', () => {
      if (this.deepgram === client) this.deepgram = null;
      if (this.wantsActive) {
        this.scheduleReconnect('deepgram');
      } else if (this.state.phase === 'listening' || this.state.phase === 'reconnecting') {
        this.setState({ phase: 'idle' });
      }
    });
    return client;
  }

  private wireMC(mc: MCClient, meetingId: string): void {
    mc.on('nudge', (n: Nudge) => this.emit('nudge', n));
    mc.on('answer', (a: QuestionAnswer) => this.emit('answer', a));
    mc.on('error', (err) => log.warn('[mc] error:', err));
    mc.on('stream-closed', () => {
      if (this.wantsActive) this.scheduleReconnect('mc-stream', meetingId);
    });
    mc.on('subscribe-closed', () => {
      if (this.wantsActive) this.scheduleReconnect('mc-subscribe', meetingId);
    });
  }

  private scheduleReconnect(source: 'deepgram' | 'mc-stream' | 'mc-subscribe', meetingId?: string): void {
    if (!this.wantsActive) return;
    if (this.reconnectTimers.has(source)) return; // already scheduled

    const attempt = (this.reconnectAttempts.get(source) ?? 0) + 1;
    this.reconnectAttempts.set(source, attempt);
    if (attempt > BACKOFFS_MS.length) {
      log.error(`[session] ${source} reconnect exhausted after ${attempt - 1} attempts`);
      this.wantsActive = false;
      void this.stop();
      this.setState({ phase: 'error', message: `Lost ${source} connection — press Start to try again.` });
      return;
    }

    const delay = BACKOFFS_MS[attempt - 1];
    log.warn(`[session] scheduling ${source} reconnect attempt ${attempt} in ${delay}ms`);
    this.setState({ phase: 'reconnecting', source, attempt });

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(source);
      void this.performReconnect(source, meetingId);
    }, delay);
    this.reconnectTimers.set(source, timer);
  }

  private async performReconnect(
    source: 'deepgram' | 'mc-stream' | 'mc-subscribe',
    meetingId?: string,
  ): Promise<void> {
    if (!this.wantsActive) return;

    try {
      if (source === 'deepgram') {
        const client = this.newDeepgramClient();
        await client.connect();
        this.deepgram = client;
      } else if (source === 'mc-stream' && this.mc && meetingId) {
        this.mc.openStream(meetingId);
      } else if (source === 'mc-subscribe' && this.mc && meetingId) {
        this.mc.openSubscribe(meetingId);
      }

      this.reconnectAttempts.delete(source);
      // Clear to listening only if no other reconnect is pending.
      if (this.reconnectTimers.size === 0 && this.wantsActive) {
        this.setState({ phase: 'listening', startedAt: Date.now() });
      }
    } catch (err) {
      log.warn(`[session] ${source} reconnect attempt failed:`, err);
      if (this.wantsActive) this.scheduleReconnect(source, meetingId);
    }
  }

  private ipcChunkCount = 0;

  sendAudio(chunk: ArrayBuffer): void {
    this.ipcChunkCount++;
    if (this.ipcChunkCount === 1) {
      const view = new Int16Array(chunk);
      let min = 0, max = 0, absSum = 0;
      for (let i = 0; i < view.length; i++) {
        if (view[i] < min) min = view[i];
        if (view[i] > max) max = view[i];
        absSum += Math.abs(view[i]);
      }
      const avg = Math.round(absSum / view.length);
      log.info(
        `[session] first IPC audio chunk: ${chunk.byteLength}B, samples=${view.length}, ` +
          `min=${min}, max=${max}, avgAbs=${avg} (${avg < 50 ? 'SILENT' : 'has signal'})`,
      );
    } else if (this.ipcChunkCount % 100 === 0) {
      log.info(`[session] forwarded ${this.ipcChunkCount} IPC chunks to Deepgram`);
    }
    if (!this.deepgram) {
      log.warn('[session] received audio chunk but Deepgram client is null');
      return;
    }
    this.deepgram.sendAudio(Buffer.from(chunk));
  }

  async ask(question: string): Promise<AskResult> {
    if (!this.mc || !this.meeting) {
      return { ok: false, error: 'Ask requires an active MC meeting (specialist must not be "none")' };
    }
    try {
      const questionId = await this.mc.ask(this.meeting.id, question);
      return { ok: true, questionId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {
    log.info(`[session] stopping; saw ${this.ipcChunkCount} IPC audio chunks total`);
    this.ipcChunkCount = 0;
    this.wantsActive = false;
    for (const [, timer] of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();

    if (this.deepgram) {
      await this.deepgram.close();
      this.deepgram = null;
    }
    if (this.mc && this.meeting) {
      await this.mc.endMeeting(this.meeting.id);
      this.mc.close();
      this.mc = null;
    } else if (this.mc) {
      this.mc.close();
      this.mc = null;
    }
    this.meeting = null;
    this.apiKey = null;
    this.keyterms = null;
    this.setState({ phase: 'idle' });
  }
}
