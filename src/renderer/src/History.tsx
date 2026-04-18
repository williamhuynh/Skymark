import { useEffect, useState } from 'react';
import { RefreshCw, ExternalLink, History as HistoryIcon } from 'lucide-react';
import type { MeetingRow, Specialist } from '../../shared/types';
import { SPECIALIST_LABELS } from '../../shared/types';

function specialistLabel(key: string | null): string {
  if (!key) return 'None';
  return SPECIALIST_LABELS[key as Specialist] ?? key;
}

function platformLabel(p: string | null): string {
  if (p === 'teams') return 'Teams';
  if (p === 'meet') return 'Google Meet';
  if (p === 'skymark') return 'Skymark';
  return p ?? 'Unknown';
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return '';
  const mins = Math.round((b - a) / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem}m`;
}

export function History({ mcUrl }: { mcUrl: string }) {
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MeetingRow | null>(null);

  async function load() {
    setStatus('loading');
    setError(null);
    const res = await window.skymark.mc.listMeetings(30);
    if (res.ok) {
      setMeetings(res.meetings);
      setStatus('idle');
      if (res.meetings.length > 0 && !selected) {
        setSelected(res.meetings[0]);
      }
    } else {
      setError(res.error);
      setStatus('error');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="history">
      <div className="history-toolbar">
        <h2>Past meetings</h2>
        <button className="ghost" onClick={() => void load()} disabled={status === 'loading'}>
          <RefreshCw size={13} className={status === 'loading' ? 'spinning' : ''} />
          <span>{status === 'loading' ? 'Loading…' : 'Refresh'}</span>
        </button>
      </div>

      {status === 'error' && (
        <div className="card">
          <p className="status error">Couldn't reach MC: {error}</p>
          <p className="help">Check your MC URL in Settings.</p>
        </div>
      )}

      {status !== 'error' && (
        <div className="history-layout">
          <ol className="history-list">
            {meetings.length === 0 && status !== 'loading' && (
              <div className="feed-empty">
                <HistoryIcon size={20} strokeWidth={1.5} />
                <span>No meetings yet. Start one from the Meeting tab.</span>
              </div>
            )}
            {meetings.map((m) => (
              <li
                key={m.id}
                className={selected?.id === m.id ? 'history-item selected' : 'history-item'}
                onClick={() => setSelected(m)}
              >
                <div className="history-item-title">{m.title || 'Untitled meeting'}</div>
                <div className="history-item-meta">
                  <span>{platformLabel(m.platform)}</span>
                  <span>·</span>
                  <span>{specialistLabel(m.specialist)}</span>
                  <span>·</span>
                  <span>{formatWhen(m.startedAt)}</span>
                </div>
              </li>
            ))}
          </ol>

          <aside className="history-detail">
            {selected ? (
              <>
                <h3>{selected.title || 'Untitled meeting'}</h3>
                <dl className="history-facts">
                  <div><dt>Started</dt><dd>{formatWhen(selected.startedAt)}</dd></div>
                  <div><dt>Ended</dt><dd>{formatWhen(selected.endedAt)}</dd></div>
                  <div><dt>Duration</dt><dd>{formatDuration(selected.startedAt, selected.endedAt) || '—'}</dd></div>
                  <div><dt>Platform</dt><dd>{platformLabel(selected.platform)}</dd></div>
                  <div><dt>Specialist</dt><dd>{specialistLabel(selected.specialist)}</dd></div>
                  <div><dt>Status</dt><dd>{selected.status ?? '—'}</dd></div>
                </dl>
                {selected.summary ? (
                  <div className="history-summary">
                    <h4>Summary</h4>
                    <p>{selected.summary}</p>
                  </div>
                ) : (
                  <p className="help">No summary yet.</p>
                )}
                <button
                  className="ghost"
                  onClick={() =>
                    void window.skymark.shell.openExternal(
                      `${mcUrl.replace(/\/$/, '')}/meetings`,
                    )
                  }
                >
                  <ExternalLink size={13} />
                  <span>Open in Mission Control</span>
                </button>
              </>
            ) : (
              <p className="feed-empty">Select a meeting on the left.</p>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
