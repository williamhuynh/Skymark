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

export class MeetingSession extends EventEmitter {
  private state: SessionState = { phase: 'idle' };
  private deepgram: DeepgramClient | null = null;
  private mc: MCClient | null = null;
  private meeting: MeetingInfo | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly store: Store<any>) {
    super();
  }

  getState(): SessionState {
    return this.state;
  }

  getMeeting(): MeetingInfo | null {
    return this.meeting;
  }

  private setState(next: SessionState): void {
    this.state = next;
    this.emit('state', next);
  }

  async start(args: StartSessionArgs): Promise<{ ok: true; meeting?: MeetingInfo } | { ok: false; error: string }> {
    if (this.state.phase === 'listening' || this.state.phase === 'connecting') {
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

    // Create MC meeting first (so transcripts can stream into it) unless specialist is 'none'.
    let meetingId: string | null = null;
    let mc: MCClient | null = null;
    if (args.specialist !== 'none') {
      const mcUrl = this.store.get('mcUrl') as string | undefined;
      if (!mcUrl) {
        this.setState({ phase: 'error', message: 'MC URL not configured' });
        return { ok: false, error: 'MC URL not configured' };
      }
      mc = new MCClient({ baseUrl: mcUrl });
      try {
        meetingId = await mc.createMeeting({
          title: args.title ?? `Meeting ${new Date().toISOString()}`,
          platform: args.platform ?? 'skymark',
          specialist: args.specialist,
        });
      } catch (err) {
        this.setState({
          phase: 'error',
          message: 'MC createMeeting failed: ' + (err instanceof Error ? err.message : String(err)),
        });
        return { ok: false, error: this.state.phase === 'error' ? this.state.message : 'createMeeting failed' };
      }
      mc.openStream(meetingId);
      mc.openSubscribe(meetingId);
      mc.on('nudge', (n: Nudge) => this.emit('nudge', n));
      mc.on('answer', (a: QuestionAnswer) => this.emit('answer', a));
      mc.on('error', (err) => log.warn('[mc] ws error:', err));
    }

    // Deepgram WS.
    const client = new DeepgramClient({ apiKey, keyterms: args.keyterms });
    client.on('transcript', (ev: TranscriptEvent) => {
      this.emit('transcript', ev);
      if (ev.isFinal && mc) mc.sendTranscript(ev);
    });
    client.on('close', () => {
      if (this.state.phase === 'listening' || this.state.phase === 'connecting') {
        this.setState({ phase: 'idle' });
      }
      this.deepgram = null;
    });

    try {
      await client.connect();
    } catch (err) {
      if (mc) mc.close();
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

  sendAudio(chunk: ArrayBuffer): void {
    if (!this.deepgram || this.state.phase !== 'listening') return;
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
    if (this.deepgram) {
      await this.deepgram.close();
      this.deepgram = null;
    }
    if (this.mc && this.meeting) {
      await this.mc.endMeeting(this.meeting.id);
      this.mc.close();
      this.mc = null;
    }
    this.meeting = null;
    this.setState({ phase: 'idle' });
  }
}
