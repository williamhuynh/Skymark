import { useState } from 'react';

type Props = {
  onKeySaved: () => void;
};

export function Onboarding({ onKeySaved }: Props) {
  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function saveKey() {
    if (!keyInput.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await window.skymark.deepgramKey.set(keyInput.trim());
      onKeySaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="onboarding">
      <div className="onboarding-card">
        <h2>Welcome to Skymark</h2>
        <p className="onboarding-lead">
          Skymark streams your meeting audio to Deepgram for transcription, then whispers
          context from your specialist agents (naa-project, aid-coo) during calls.
        </p>

        <ol className="onboarding-steps">
          <li>
            Grab a Deepgram API key from{' '}
            <a
              href="https://console.deepgram.com/"
              onClick={(e) => {
                e.preventDefault();
                window.open('https://console.deepgram.com/', '_blank', 'noopener');
              }}
            >
              console.deepgram.com
            </a>{' '}
            (free tier is fine; ~$200 prepaid covers months of real use).
          </li>
          <li>Paste it below. We validate it with Deepgram before saving.</li>
          <li>
            Once saved, it's encrypted in Windows Credential Manager — never written to disk in
            plaintext, never sent anywhere except Deepgram.
          </li>
        </ol>

        <div className="onboarding-row">
          <input
            type="password"
            placeholder="40-character Deepgram API key"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            spellCheck={false}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey();
            }}
          />
          <button onClick={saveKey} disabled={saving || !keyInput.trim()}>
            {saving ? 'Validating…' : 'Save'}
          </button>
        </div>
        {error && <p className="status error">{error}</p>}

        <details className="onboarding-what-next">
          <summary>What happens after I save?</summary>
          <p>
            Skymark opens the Meeting view. When you press <strong>Start</strong>, Chromium asks
            for two permissions:
          </p>
          <ul>
            <li>
              <strong>Screen share</strong> — used for *system audio loopback* only. Pick any
              screen when prompted; Skymark ignores the video.
            </li>
            <li>
              <strong>Microphone</strong> — so your own voice is captured too, mixed with the
              other participants.
            </li>
          </ul>
          <p>
            These are one-time prompts per origin. After approving once, subsequent meetings just
            pick up where they left off.
          </p>
        </details>
      </div>
    </section>
  );
}
