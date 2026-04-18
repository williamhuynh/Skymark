export type Specialist = 'naa-project' | 'aid-coo' | 'none';

export const SPECIALIST_LABELS: Record<Specialist, string> = {
  'naa-project': 'NAA Project',
  'aid-coo': 'AiD COO',
  none: 'None (transcript only)',
};

export type Settings = {
  mcUrl: string;
  defaultSpecialist: Specialist;
  autoDetect: boolean;
  autostart: boolean;
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
  | { phase: 'reconnecting'; source: 'deepgram' | 'mc-stream' | 'mc-subscribe'; attempt: number }
  | { phase: 'error'; message: string };

export type MeetingPlatform = 'teams' | 'meet' | 'skymark';

export type StartSessionArgs = {
  specialist: Specialist;
  keyterms?: string[];
  title?: string;
  platform?: MeetingPlatform;
};

export type DetectedMeeting = {
  platform: 'teams' | 'meet';
  detectedAt: number;
  evidence: string;
};

export type MeetingInfo = {
  id: string;
  specialist: Specialist;
  startedAt: number;
};

export type Nudge = {
  nudgeId: string;
  reason: string;
  triggerText: string;
  nudgeText: string | null;
  resolvedAt?: number;
};

export type QuestionAnswer = {
  questionId: string;
  question: string;
  answer: string;
  answeredAt: number;
};

export type AskResult =
  | { ok: true; questionId: string }
  | { ok: false; error: string };

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
    start: (args: StartSessionArgs) => Promise<{ ok: true; meeting?: MeetingInfo } | { ok: false; error: string }>;
    stop: () => Promise<void>;
    sendAudio: (chunk: ArrayBuffer) => void;
    getState: () => Promise<SessionState>;
    ask: (question: string) => Promise<AskResult>;
    onState: (cb: (state: SessionState) => void) => () => void;
    onTranscript: (cb: (ev: TranscriptEvent) => void) => () => void;
    onNudge: (cb: (n: Nudge) => void) => () => void;
    onAnswer: (cb: (a: QuestionAnswer) => void) => () => void;
  };
  window: {
    toggleSidebar: () => Promise<void>;
  };
};
