import { useEffect, useRef, useState } from 'react';
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

type Tab = 'meeting' | 'settings';

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
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [askInput, setAskInput] = useState('');
  const [askPending, setAskPending] = useState<string | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const captureRef = useRef<AudioCaptureHandle | null>(null);
  const pendingQuestions = useRef<Map<string, string>>(new Map());

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
    })();

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

    const result = await window.skymark.session.start({ specialist: pickedSpecialist });
    if (!result.ok) {
      setSessionState({ phase: 'error', message: result.error });
      return;
    }

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
    if (captureRef.current) {
      await captureRef.current.stop();
      captureRef.current = null;
    }
    await window.skymark.session.stop();
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
        <h1>Skymark</h1>
        <nav className="tabs">
          <button className={tab === 'meeting' ? 'tab active' : 'tab'} onClick={() => setTab('meeting')}>
            Meeting
          </button>
          <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>
            Settings
          </button>
        </nav>
      </header>

      {tab === 'meeting' ? (
        <section className="meeting">
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
              <button className="danger" onClick={stopMeeting}>Stop</button>
            ) : (
              <button onClick={startMeeting}>Start</button>
            )}
            <button
              className="ghost"
              onClick={() => void window.skymark.window.toggleSidebar()}
              title="Open the always-on-top sidebar"
            >
              Sidebar
            </button>
          </div>

          <StatusBar state={sessionState} linked={mcLinked && isActive} />

          <div className="two-col">
            <TranscriptView events={events} interim={interim} />
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

          {mcLinked && isActive && (
            <form
              className="ask"
              onSubmit={(e) => { e.preventDefault(); void submitAsk(); }}
            >
              <input
                type="text"
                placeholder="Ask Sky about what's being discussed…"
                value={askInput}
                onChange={(e) => setAskInput(e.target.value)}
              />
              <button type="submit" disabled={!askInput.trim() || !!askPending}>
                {askPending ? 'Thinking…' : 'Ask'}
              </button>
            </form>
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
        </section>
      )}

      <footer>
        <p className="version">skymark · v0.0.1 · audio + MC</p>
      </footer>
    </main>
  );
}

function FeedCard({ item }: { item: FeedItem }) {
  const time = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (item.kind === 'nudge') {
    return (
      <div className="feed-card nudge">
        <div className="feed-meta">
          <span className="feed-tag">Nudge · {item.reason}</span>
          <span className="feed-time">{time}</span>
        </div>
        <p>{item.text}</p>
      </div>
    );
  }
  return (
    <div className="feed-card answer">
      <div className="feed-meta">
        <span className="feed-tag">Answer</span>
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
  return (
    <div className={`statusbar ${cls}`}>
      <span className="dot" />
      <span>{text}</span>
      {linked && <span className="link-tag">MC linked</span>}
    </div>
  );
}
