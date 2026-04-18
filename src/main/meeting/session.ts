import { EventEmitter } from 'node:events';
import { safeStorage } from 'electron';
import type Store from 'electron-store';
import { DeepgramClient } from '../deepgram/client';
import type { SessionState, StartSessionArgs, TranscriptEvent } from '../../shared/types';

export class MeetingSession extends EventEmitter {
  private state: SessionState = { phase: 'idle' };
  private deepgram: DeepgramClient | null = null;

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

  async start(args: StartSessionArgs): Promise<{ ok: true } | { ok: false; error: string }> {
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

    const client = new DeepgramClient({ apiKey, keyterms: args.keyterms });
    client.on('transcript', (ev: TranscriptEvent) => this.emit('transcript', ev));
    client.on('close', () => {
      if (this.state.phase === 'listening' || this.state.phase === 'connecting') {
        this.setState({ phase: 'idle' });
      }
      this.deepgram = null;
    });

    try {
      await client.connect();
    } catch (err) {
      this.setState({
        phase: 'error',
        message: 'Deepgram connect failed: ' + (err instanceof Error ? err.message : String(err)),
      });
      return { ok: false, error: this.state.phase === 'error' ? this.state.message : 'connect failed' };
    }

    this.deepgram = client;
    this.setState({ phase: 'listening', startedAt: Date.now() });
    return { ok: true };
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (!this.deepgram || this.state.phase !== 'listening') return;
    this.deepgram.sendAudio(Buffer.from(chunk));
  }

  async stop(): Promise<void> {
    if (this.deepgram) {
      await this.deepgram.close();
      this.deepgram = null;
    }
    this.setState({ phase: 'idle' });
  }
}
