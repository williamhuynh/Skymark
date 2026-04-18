import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [s, has] = await Promise.all([
        window.skymark.settings.get(),
        window.skymark.deepgramKey.has(),
      ]);
      setSettings(s);
      setHasKey(has);
    })();
  }, []);

  async function save(patch: Partial<Settings>) {
    const next = await window.skymark.settings.set(patch);
    setSettings(next);
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    setSaveState('saving');
    setSaveError(null);
    try {
      await window.skymark.deepgramKey.set(keyInput.trim());
      setHasKey(true);
      setKeyInput('');
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaveState('error');
    }
  }

  async function clearKey() {
    await window.skymark.deepgramKey.clear();
    setHasKey(false);
  }

  if (!settings) {
    return <main className="app"><p>Loading…</p></main>;
  }

  return (
    <main className="app">
      <header>
        <h1>Skymark</h1>
        <p className="tagline">Meeting sidecar for Sky.</p>
      </header>

      <section>
        <h2>Deepgram API key</h2>
        <p className="help">
          Stored encrypted in Windows Credential Manager. Never written to disk in plaintext.
        </p>
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
            <button onClick={saveKey} disabled={saveState === 'saving'}>
              {saveState === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
        {saveState === 'saved' && <p className="status ok">Saved.</p>}
        {saveState === 'error' && <p className="status error">{saveError}</p>}
      </section>

      <section>
        <h2>Mission Control URL</h2>
        <p className="help">Your MC instance. Use the host's Tailscale IP for cross-machine access.</p>
        <input
          type="text"
          value={settings.mcUrl}
          onChange={(e) => void save({ mcUrl: e.target.value })}
          spellCheck={false}
        />
      </section>

      <section>
        <h2>Default specialist</h2>
        <p className="help">Pre-selection in the meeting-detect toast. "None" asks every time.</p>
        <select
          value={settings.defaultSpecialist}
          onChange={(e) => void save({ defaultSpecialist: e.target.value as Settings['defaultSpecialist'] })}
        >
          <option value="none">None (ask each time)</option>
          <option value="naa-project">naa-project</option>
          <option value="aid-coo">aid-coo</option>
        </select>
      </section>

      <section>
        <h2>Auto-detect meetings</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.autoDetect}
            onChange={(e) => void save({ autoDetect: e.target.checked })}
          />
          <span>Watch for Teams and Google Meet, show toast when a call starts</span>
        </label>
      </section>

      <footer>
        <p className="version">skymark · v0.0.1 · scaffold</p>
      </footer>
    </main>
  );
}
