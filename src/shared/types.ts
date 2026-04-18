export type Specialist = 'naa-project' | 'aid-coo' | 'none';

export type Settings = {
  mcUrl: string;
  defaultSpecialist: Specialist;
  autoDetect: boolean;
};

export type TranscriptEvent = {
  speaker: string | null;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
};

export type SessionState =
  | { phase: 'idle' }
  | { phase: 'connecting' }
  | { phase: 'listening'; startedAt: number }
  | { phase: 'error'; message: string };

export type StartSessionArgs = {
  specialist: Specialist;
  keyterms?: string[];
};

export type SkymarkApi = {
  settings: {
    get: () => Promise<Settings>;
    set: (patch: Partial<Settings>) => Promise<Settings>;
  };
  deepgramKey: {
    set: (key: string) => Promise<boolean>;
    has: () => Promise<boolean>;
    clear: () => Promise<boolean>;
  };
  session: {
    start: (args: StartSessionArgs) => Promise<{ ok: true } | { ok: false; error: string }>;
    stop: () => Promise<void>;
    sendAudio: (chunk: ArrayBuffer) => void;
    getState: () => Promise<SessionState>;
    onState: (cb: (state: SessionState) => void) => () => void;
    onTranscript: (cb: (ev: TranscriptEvent) => void) => () => void;
  };
};
