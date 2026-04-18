import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Settings,
  SessionState,
  TranscriptEvent,
  Specialist,
  Nudge,
  QuestionAnswer,
} from '../../shared/types';
import { SPECIALIST_LABELS } from '../../shared/types';
import { startAudioCapture, type AudioCaptureHandle } from './audio/capture';
import { TranscriptView } from './TranscriptView';
import { Onboarding } from './Onboarding';
import { useDebouncedCallback } from './hooks/useDebouncedCallback';
import { Logo } from './Logo';
import { History } from './History';
import {
  Play,
  Square,
  PanelRight,
  CircleAlert,
  MessageSquareQuote,
  Sparkles,
  Clock,
  CheckCircle2,
  Download,
  RefreshCw,
} from 'lucide-react';
import type { UpdateState } from '../../shared/types';

type Tab = 'meeting' | 'history' | 'settings';

const MAX_TRANSCRIPT_EVENTS = 500;
const MAX_FEED_ITEMS = 100;

function capped<T>(arr: T[], max: number): T[] {
  return arr.length > max ? arr.slice(-max) : arr;
}

type FeedItem =
  | { kind: 'nudge'; id: string; at: number; reason: string; text: string }
  | { kind: 'question'; id: string; at: number; question: string; answer: string };

export function App() {
  const [tab, setTab] = useState<Tab>('meeting');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);

  const [sessionState, setSessionState] = useState<SessionState>({ phase: 'idle' });
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [interim, setInterim] = useState<TranscriptEvent | null>(null);
  const [pickedSpecialist, setPickedSpecialist] = useState<Specialist>('naa-project');
  const [meetingTitle, setMeetingTitle] = useState<string>('');
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [askInput, setAskInput] = useState('');
  const [askPending, setAskPending] = useState<string | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const captureRef = useRef<AudioCaptureHandle | null>(null);
  const pendingQuestions = useRef<Map<string, string>>(new Map());

  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [meetingNotes, setMeetingNotes] = useState<string>('');
  const activeMeetingIdRef = useRef<string | null>(null);

  const saveNotes = useDebouncedCallback((value: string, meetingId: string) => {
    void window.skymark.mc.patchMetadata(meetingId, { notes: value });
  }, 700);

  const [mcUrlDraft, setMcUrlDraft] = useState<string>('');
  const [savedField, setSavedField] = useState<string | null>(null);
  const [mcTest, setMcTest] = useState<'idle' | 'testing' | 'ok' | string>('idle');

  const flashSaved = (field: string) => {
    setSavedField(field);
    setTimeout(() => setSavedField((s) => (s === field ? null : s)), 1500);
  };

  const saveMcUrl = useDebouncedCallback(async (url: string) => {
    await window.skymark.settings.set({ mcUrl: url });
    setSettings((prev) => (prev ? { ...prev, mcUrl: url } : prev));
    flashSaved('mcUrl');
  }, 500);

  const [appVersion, setAppVersion] = useState<string>('');
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: 'idle' });

  useEffect(() => {
    void (async () => {
      const [s, has, st] = await Promise.all([
        window.skymark.settings.get(),
        window.skymark.deepgramKey.has(),
        window.skymark.session.getState(),
      ]);
      setSettings(s);
      setHasKey(has);
      setSessionState(st);
      setPickedSpecialist(s.defaultSpecialist === 'none' ? 'naa-project' : s.defaultSpecialist);
      setMcUrlDraft(s.mcUrl);
      const [version, us] = await Promise.all([
        window.skymark.updater.getVersion(),
        window.skymark.updater.getState(),
      ]);
      setAppVersion(version);
      setUpdateState(us);
    })();

    const offUpdate = window.skymark.updater.onState((s) => setUpdateState(s));

    const offState = window.skymark.session.onState((next) => setSessionState(next));
    const offTranscript = window.skymark.session.onTranscript((ev) => {
      if (ev.isFinal) {
        setEvents((prev) => capped([...prev, ev], MAX_TRANSCRIPT_EVENTS));
        setInterim(null);
      } else {
        setInterim(ev);
      }
    });
    const offNudge = window.skymark.session.onNudge((n: Nudge) => {
      setFeed((prev) =>
        capped(
          [
            ...prev,
            {
              kind: 'nudge',
              id: n.nudgeId,
              at: n.resolvedAt ?? Date.now(),
              reason: n.reason,
              text: n.nudgeText ?? '',
            } as FeedItem,
          ],
          MAX_FEED_ITEMS,
        ),
      );
    });
    const offAnswer = window.skymark.session.onAnswer((a: QuestionAnswer) => {
      const q = pendingQuestions.current.get(a.questionId) ?? a.question ?? '';
      pendingQuestions.current.delete(a.questionId);
      setFeed((prev) =>
        capped(
          [
            ...prev,
            {
              kind: 'question',
              id: a.questionId,
              at: a.answeredAt,
              question: q,
              answer: a.answer,
            } as FeedItem,
          ],
          MAX_FEED_ITEMS,
        ),
      );
      setAskPending((pending) => (pending === a.questionId ? null : pending));
    });

    return () => {
      offState();
      offTranscript();
      offNudge();
      offAnswer();
      offUpdate();
    };
  }, []);

  async function save(patch: Partial<Settings>, field?: string) {
    const next = await window.skymark.settings.set(patch);
    setSettings(next);
    if (field) flashSaved(field);
  }

  async function testMc() {
    setMcTest('testing');
    const res = await window.skymark.mc.testConnection(mcUrlDraft);
    setMcTest(res.ok ? 'ok' : res.error);
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    setKeyError(null);
    try {
      await window.skymark.deepgramKey.set(keyInput.trim());
      setHasKey(true);
      setKeyInput('');
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    }
  }

  async function clearKey() {
    await window.skymark.deepgramKey.clear();
    setHasKey(false);
  }

  async function startMeeting() {
    if (!hasKey) {
      setKeyError('Set your Deepgram API key first.');
      setTab('settings');
      return;
    }

    setEvents([]);
    setInterim(null);
    setFeed([]);

    const trimmedTitle = meetingTitle.trim();
    const defaultTitle = `Meeting ${new Date().toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
    const result = await window.skymark.session.start({
      specialist: pickedSpecialist,
      title: trimmedTitle || defaultTitle,
    });
    if (!result.ok) {
      setSessionState({ phase: 'error', message: result.error });
      return;
    }
    activeMeetingIdRef.current = result.meeting?.id ?? null;
    setSpeakerNames({});
    setMeetingNotes('');

    try {
      const handle = await startAudioCapture({
        onChunk: (pcm) => window.skymark.session.sendAudio(pcm),
        onError: (err) => {
          console.error('[audio] error:', err);
        },
      });
      captureRef.current = handle;
    } catch (err) {
      await window.skymark.session.stop();
      setSessionState({
        phase: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function stopMeeting() {
    // Flush any pending notes before tearing down.
    const meetingId = activeMeetingIdRef.current;
    if (meetingId && meetingNotes) {
      await window.skymark.mc.patchMetadata(meetingId, { notes: meetingNotes });
    }
    if (captureRef.current) {
      await captureRef.current.stop();
      captureRef.current = null;
    }
    await window.skymark.session.stop();
    activeMeetingIdRef.current = null;
  }

  function renameSpeaker(rawSpeaker: string, name: string) {
    setSpeakerNames((prev) => {
      const next = { ...prev };
      if (name) {
        next[rawSpeaker] = name;
      } else {
        delete next[rawSpeaker];
      }
      return next;
    });
    const meetingId = activeMeetingIdRef.current;
    if (meetingId) {
      const nextMap = { ...speakerNames };
      if (name) nextMap[rawSpeaker] = name;
      else delete nextMap[rawSpeaker];
      void window.skymark.mc.patchMetadata(meetingId, { speakerNames: nextMap });
    }
  }

  async function submitAsk() {
    const q = askInput.trim();
    if (!q) return;
    setAskError(null);
    const res = await window.skymark.session.ask(q);
    if (!res.ok) {
      setAskError(res.error);
      return;
    }
    pendingQuestions.current.set(res.questionId, q);
    setAskPending(res.questionId);
    setAskInput('');
  }

  if (!settings) {
    return <main className="app"><p>Loading…</p></main>;
  }

  if (!hasKey) {
    return (
      <main className="app">
        <Onboarding onKeySaved={() => setHasKey(true)} />
      </main>
    );
  }

  const isActive =
    sessionState.phase === 'listening' ||
    sessionState.phase === 'connecting' ||
    sessionState.phase === 'reconnecting';
  const mcLinked = pickedSpecialist !== 'none';

  return (
    <main className="app">
      <header className="app-header">
        <div className="brand">
          <Logo />
          <h1>Skymark</h1>
        </div>
        <nav className="tabs" role="tablist" aria-label="Views">
          <button
            role="tab"
            aria-selected={tab === 'meeting'}
            className={tab === 'meeting' ? 'tab active' : 'tab'}
            onClick={() => setTab('meeting')}
          >
            Meeting
          </button>
          <button
            role="tab"
            aria-selected={tab === 'history'}
            className={tab === 'history' ? 'tab active' : 'tab'}
            onClick={() => setTab('history')}
          >
            History
          </button>
          <button
            role="tab"
            aria-selected={tab === 'settings'}
            className={tab === 'settings' ? 'tab active' : 'tab'}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </nav>
      </header>

      {tab === 'history' ? (
        <History mcUrl={settings.mcUrl} />
      ) : tab === 'meeting' ? (
        <section className="meeting">
          <input
            type="text"
            className="meeting-title-input"
            placeholder="Meeting title (optional — used for filename slug)"
            value={meetingTitle}
            onChange={(e) => setMeetingTitle(e.target.value)}
            disabled={isActive}
            maxLength={80}
            aria-label="Meeting title"
          />
          <div className="meeting-controls">
            <select
              value={pickedSpecialist}
              onChange={(e) => setPickedSpecialist(e.target.value as Specialist)}
              disabled={isActive}
              aria-label="Specialist"
            >
              <option value="naa-project">{SPECIALIST_LABELS['naa-project']}</option>
              <option value="aid-coo">{SPECIALIST_LABELS['aid-coo']}</option>
              <option value="none">{SPECIALIST_LABELS['none']}</option>
            </select>
            {isActive ? (
              <button className="danger" onClick={stopMeeting}>
                <Square size={14} strokeWidth={2.5} fill="currentColor" />
                <span>Stop</span>
              </button>
            ) : (
              <button onClick={startMeeting}>
                <Play size={14} strokeWidth={2.5} fill="currentColor" />
                <span>Start</span>
              </button>
            )}
            <button
              className="ghost"
              onClick={() => void window.skymark.window.toggleSidebar()}
              title="Open the always-on-top sidebar"
              aria-label="Toggle sidebar"
            >
              <PanelRight size={14} />
              <span>Sidebar</span>
            </button>
          </div>

          <StatusBar state={sessionState} linked={mcLinked && isActive} />

          <div className="two-col">
            <TranscriptView
              events={events}
              interim={interim}
              speakerNames={speakerNames}
              onRenameSpeaker={renameSpeaker}
            />
            <aside className="feed">
              <h3>Nudges & Answers</h3>
              {feed.length === 0 && (
                <p className="feed-empty">
                  {mcLinked
                    ? 'Sky watches for triggers and answers questions here.'
                    : 'Pick a specialist to enable MC features.'}
                </p>
              )}
              {feed.map((item) => (
                <FeedCard key={`${item.kind}-${item.id}`} item={item} />
              ))}
            </aside>
          </div>

          {isActive && (
            <details className="meeting-notes" open>
              <summary>
                Notes <span className="notes-hint">— typed during the meeting, saved with the archive</span>
              </summary>
              <textarea
                className="meeting-notes-input"
                value={meetingNotes}
                onChange={(e) => {
                  setMeetingNotes(e.target.value);
                  if (activeMeetingIdRef.current) {
                    saveNotes(e.target.value, activeMeetingIdRef.current);
                  }
                }}
                placeholder="Your live notes. Specialist reads these alongside the transcript for the post-meeting summary."
                rows={4}
              />
            </details>
          )}

          {mcLinked && isActive && (
            <>
              <form
                className="ask"
                onSubmit={(e) => { e.preventDefault(); void submitAsk(); }}
              >
                <input
                  type="text"
                  placeholder="Ask Sky about what's being discussed…"
                  value={askInput}
                  onChange={(e) => setAskInput(e.target.value)}
                  aria-label="Ask Sky a question"
                />
                <button type="submit" disabled={!askInput.trim() || !!askPending}>
                  {askPending ? 'Thinking…' : 'Ask'}
                </button>
              </form>
              <p className="ask-hint">Enter to ask · answer appears in the feed</p>
            </>
          )}
          {askError && <p className="status error">{askError}</p>}
        </section>
      ) : (
        <section className="settings">
          <div className="card">
            <h2>Deepgram API key</h2>
            <p className="help">Stored encrypted via the OS credential store. Never written to disk in plaintext.</p>
            {hasKey ? (
              <div className="row">
                <span className="status ok">Key configured</span>
                <button onClick={clearKey}>Clear</button>
              </div>
            ) : (
              <div className="row">
                <input
                  type="password"
                  placeholder="40-character Deepgram API key"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  spellCheck={false}
                />
                <button onClick={saveKey}>Save</button>
              </div>
            )}
            {keyError && <p className="status error">{keyError}</p>}
          </div>

          <div className="card">
            <h2>
              Mission Control URL
              {savedField === 'mcUrl' && <span className="saved-flag">Saved</span>}
            </h2>
            <p className="help">Your MC instance. Use the host's Tailscale IP for cross-machine access.</p>
            <div className="row">
              <input
                type="text"
                value={mcUrlDraft}
                onChange={(e) => {
                  setMcUrlDraft(e.target.value);
                  setMcTest('idle');
                  saveMcUrl(e.target.value);
                }}
                spellCheck={false}
              />
              <button className="ghost" onClick={() => void testMc()} disabled={mcTest === 'testing'}>
                {mcTest === 'testing' ? 'Testing…' : 'Test'}
              </button>
            </div>
            {mcTest === 'ok' && <p className="status ok">Reachable.</p>}
            {mcTest !== 'idle' && mcTest !== 'testing' && mcTest !== 'ok' && (
              <p className="status error">{mcTest}</p>
            )}
          </div>

          <div className="card">
            <h2>
              Default specialist
              {savedField === 'defaultSpecialist' && <span className="saved-flag">Saved</span>}
            </h2>
            <select
              value={settings.defaultSpecialist}
              onChange={(e) =>
                void save({ defaultSpecialist: e.target.value as Specialist }, 'defaultSpecialist')
              }
            >
              <option value="none">None (ask each time)</option>
              <option value="naa-project">{SPECIALIST_LABELS['naa-project']}</option>
              <option value="aid-coo">{SPECIALIST_LABELS['aid-coo']}</option>
            </select>
          </div>

          <div className="card">
            <h2>
              Auto-detect meetings
              {savedField === 'autoDetect' && <span className="saved-flag">Saved</span>}
            </h2>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.autoDetect}
                onChange={(e) => void save({ autoDetect: e.target.checked }, 'autoDetect')}
              />
              <span>Watch Teams / Meet, show toast on call start</span>
            </label>
          </div>

          <div className="card">
            <h2>
              Start on login
              {savedField === 'autostart' && <span className="saved-flag">Saved</span>}
            </h2>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.autostart}
                onChange={(e) => void save({ autostart: e.target.checked }, 'autostart')}
              />
              <span>Launch Skymark automatically (minimised to tray) when Windows starts</span>
            </label>
          </div>

          <UpdateCard version={appVersion} state={updateState} />
        </section>
      )}

      <footer>
        <p className="version">skymark · v0.0.1 · audio + MC</p>
      </footer>
    </main>
  );
}

function UpdateCard({ version, state }: { version: string; state: UpdateState }) {
  let content: ReactNode;
  switch (state.phase) {
    case 'idle':
      content = (
        <button className="ghost" onClick={() => void window.skymark.updater.check()}>
          <RefreshCw size={13} />
          <span>Check for updates</span>
        </button>
      );
      break;
    case 'checking':
      content = (
        <button className="ghost" disabled>
          <RefreshCw size={13} className="spinning" />
          <span>Checking…</span>
        </button>
      );
      break;
    case 'downloading':
      content = (
        <div className="update-progress">
          <div className="update-progress-label">
            <Download size={13} />
            <span>Downloading v{state.version} — {state.progress}%</span>
          </div>
          <div className="update-progress-bar">
            <div className="update-progress-fill" style={{ width: `${state.progress}%` }} />
          </div>
        </div>
      );
      break;
    case 'ready':
      content = (
        <button onClick={() => void window.skymark.updater.install()}>
          <Download size={13} />
          <span>Restart + install v{state.version}</span>
        </button>
      );
      break;
    case 'up-to-date':
      content = (
        <div className="row">
          <span className="status ok">You're on the latest version.</span>
          <button className="ghost" onClick={() => void window.skymark.updater.check()}>
            <RefreshCw size={13} />
            <span>Check again</span>
          </button>
        </div>
      );
      break;
    case 'error':
      content = (
        <>
          <p className="status error">{state.message}</p>
          <button className="ghost" onClick={() => void window.skymark.updater.check()}>
            <RefreshCw size={13} />
            <span>Retry</span>
          </button>
        </>
      );
      break;
  }

  return (
    <div className="card">
      <h2>About</h2>
      <p className="help">Skymark {version ? `v${version}` : ''} · auto-updates check every 4 hours</p>
      {content}
    </div>
  );
}

function FeedCard({ item }: { item: FeedItem }) {
  const time = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (item.kind === 'nudge') {
    return (
      <div className="feed-card nudge">
        <div className="feed-meta">
          <span className="feed-tag">
            <Sparkles size={12} /> Nudge · {item.reason}
          </span>
          <span className="feed-time">{time}</span>
        </div>
        <p>{item.text}</p>
      </div>
    );
  }
  return (
    <div className="feed-card answer">
      <div className="feed-meta">
        <span className="feed-tag">
          <MessageSquareQuote size={12} /> Answer
        </span>
        <span className="feed-time">{time}</span>
      </div>
      <p className="feed-question">Q: {item.question}</p>
      <p>{item.answer}</p>
    </div>
  );
}

function StatusBar({ state, linked }: { state: SessionState; linked: boolean }) {
  let text = '';
  let cls = '';
  switch (state.phase) {
    case 'idle':
      text = 'Idle';
      cls = 'idle';
      break;
    case 'connecting':
      text = 'Connecting to Deepgram…';
      cls = 'connecting';
      break;
    case 'listening':
      text = `Listening since ${new Date(state.startedAt).toLocaleTimeString()}`;
      cls = 'live';
      break;
    case 'reconnecting':
      text = `Reconnecting ${state.source} (attempt ${state.attempt})…`;
      cls = 'connecting';
      break;
    case 'error':
      text = `Error: ${state.message}`;
      cls = 'error';
      break;
  }
  const Icon =
    state.phase === 'error'
      ? CircleAlert
      : state.phase === 'listening'
      ? CheckCircle2
      : Clock;

  return (
    <div className={`statusbar ${cls}`} role="status">
      {state.phase === 'error' || state.phase === 'listening' ? (
        <Icon size={14} className="statusbar-icon" aria-hidden />
      ) : (
        <span className="dot" aria-hidden />
      )}
      <span>{text}</span>
      {linked && <span className="link-tag">MC linked</span>}
    </div>
  );
}
