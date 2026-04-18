import { useEffect, useRef, useState } from 'react';
import type { Settings, SessionState, TranscriptEvent, Specialist } from '../../shared/types';
import { startAudioCapture, type AudioCaptureHandle } from './audio/capture';
import { TranscriptView } from './TranscriptView';

type Tab = 'meeting' | 'settings';

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

  const captureRef = useRef<AudioCaptureHandle | null>(null);

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
    })();

    const offState = window.skymark.session.onState((next) => setSessionState(next));
    const offTranscript = window.skymark.session.onTranscript((ev) => {
      if (ev.isFinal) {
        setEvents((prev) => [...prev, ev]);
        setInterim(null);
      } else {
        setInterim(ev);
      }
    });

    return () => {
      offState();
      offTranscript();
    };
  }, []);

  async function save(patch: Partial<Settings>) {
    const next = await window.skymark.settings.set(patch);
    setSettings(next);
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

  if (!settings) {
    return <main className="app"><p>Loading…</p></main>;
  }

  const isActive = sessionState.phase === 'listening' || sessionState.phase === 'connecting';

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
            >
              <option value="naa-project">naa-project</option>
              <option value="aid-coo">aid-coo</option>
              <option value="none">none (transcript only)</option>
            </select>
            {isActive ? (
              <button className="danger" onClick={stopMeeting}>Stop</button>
            ) : (
              <button onClick={startMeeting}>Start</button>
            )}
          </div>

          <StatusBar state={sessionState} />

          <TranscriptView events={events} interim={interim} />
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
                  placeholder="dg_…"
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
            <h2>Mission Control URL</h2>
            <p className="help">Your MC instance. Use the host's Tailscale IP for cross-machine access.</p>
            <input
              type="text"
              value={settings.mcUrl}
              onChange={(e) => void save({ mcUrl: e.target.value })}
              spellCheck={false}
            />
          </div>

          <div className="card">
            <h2>Default specialist</h2>
            <select
              value={settings.defaultSpecialist}
              onChange={(e) => void save({ defaultSpecialist: e.target.value as Specialist })}
            >
              <option value="none">None (ask each time)</option>
              <option value="naa-project">naa-project</option>
              <option value="aid-coo">aid-coo</option>
            </select>
          </div>

          <div className="card">
            <h2>Auto-detect meetings</h2>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.autoDetect}
                onChange={(e) => void save({ autoDetect: e.target.checked })}
              />
              <span>Watch Teams / Meet, show toast on call start</span>
            </label>
          </div>
        </section>
      )}

      <footer>
        <p className="version">skymark · v0.0.1 · audio pipeline</p>
      </footer>
    </main>
  );
}

function StatusBar({ state }: { state: SessionState }) {
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
    case 'error':
      text = `Error: ${state.message}`;
      cls = 'error';
      break;
  }
  return (
    <div className={`statusbar ${cls}`}>
      <span className="dot" />
      <span>{text}</span>
    </div>
  );
}
