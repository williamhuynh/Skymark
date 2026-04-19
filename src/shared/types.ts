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

export type MeetingRow = {
  id: string;
  title: string | null;
  platform: MeetingPlatform | string | null;
  specialist: Specialist | string | null;
  startedAt: string | null;
  endedAt: string | null;
  status: string | null;
  summary: string | null;
};

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

export type SuggestedTodoCategory = 'my-action' | 'follow-up' | 'context-only';
export type SuggestedTodoStatus = 'suggested' | 'approved' | 'dismissed' | 'created';

export type SuggestedTodo = {
  id: string;
  text: string;
  owner: string | null;
  category: SuggestedTodoCategory;
  rationale: string | null;
  dueHint: string | null;
  status: SuggestedTodoStatus;
  todoId: string | null;
  createdAt: string | null;
};

export type PostMeetingReadyEvent = {
  meetingId: string;
  title: string;
  suggestedCount: number;
};

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'downloading'; version: string; progress: number }
  | { phase: 'ready'; version: string }
  | { phase: 'up-to-date' }
  | { phase: 'error'; message: string };

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
    onPostMeetingReady: (cb: (ev: PostMeetingReadyEvent) => void) => () => void;
  };
  window: {
    toggleSidebar: () => Promise<void>;
    showMain: () => Promise<void>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  mc: {
    testConnection: (url: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    listMeetings: (limit?: number) => Promise<{ ok: true; meetings: MeetingRow[] } | { ok: false; error: string }>;
    getArchive: (meetingId: string) => Promise<{ ok: true; markdown: string } | { ok: false; error: string }>;
    patchMetadata: (meetingId: string, patch: Record<string, unknown>) =>
      Promise<{ ok: true } | { ok: false; error: string }>;
    requestBrief: (args: { specialist: Specialist; title?: string }) =>
      Promise<{ ok: true; brief: string } | { ok: false; error: string }>;
    getSuggestedTodos: (meetingId: string) =>
      Promise<{ ok: true; todos: SuggestedTodo[] } | { ok: false; error: string }>;
    approveSuggestedTodo: (
      meetingId: string,
      actionId: string,
      overrides?: { text?: string; owner?: string | null },
    ) => Promise<{ ok: true; todoId: string } | { ok: false; error: string }>;
    dismissSuggestedTodo: (meetingId: string, actionId: string) =>
      Promise<{ ok: true } | { ok: false; error: string }>;
  };
  updater: {
    getVersion: () => Promise<string>;
    getState: () => Promise<UpdateState>;
    check: () => Promise<void>;
    install: () => Promise<void>;
    onState: (cb: (state: UpdateState) => void) => () => void;
  };
};
