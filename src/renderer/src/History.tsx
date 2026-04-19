import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RefreshCw, ExternalLink, History as HistoryIcon, FileText, ListTodo } from 'lucide-react';
import type { MeetingRow, Specialist, SuggestedTodo } from '../../shared/types';
import { SPECIALIST_LABELS } from '../../shared/types';
import { ReviewPanel } from './ReviewPanel';

function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\s*\n/, '');
}

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
  const [archiveMd, setArchiveMd] = useState<string | null>(null);
  const [archiveStatus, setArchiveStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestedTodo[]>([]);
  const [reviewing, setReviewing] = useState(false);

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

  useEffect(() => {
    if (!selected) {
      setArchiveMd(null);
      setArchiveStatus('idle');
      setSuggestions([]);
      setReviewing(false);
      return;
    }
    let cancelled = false;
    setArchiveStatus('loading');
    setArchiveError(null);
    setReviewing(false);
    void (async () => {
      const res = await window.skymark.mc.getArchive(selected.id);
      if (cancelled) return;
      if (res.ok) {
        setArchiveMd(stripFrontmatter(res.markdown));
        setArchiveStatus('idle');
      } else {
        setArchiveMd(null);
        setArchiveError(res.error);
        setArchiveStatus('error');
      }
      const sugg = await window.skymark.mc.getSuggestedTodos(selected.id);
      if (cancelled) return;
      if (sugg.ok) setSuggestions(sugg.todos);
      else setSuggestions([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

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

                {(() => {
                  const pendingCount = suggestions.filter((s) => s.status === 'suggested').length;
                  const createdCount = suggestions.filter((s) => s.status === 'created').length;
                  if (reviewing) {
                    return (
                      <ReviewPanel
                        meetingId={selected.id}
                        meetingTitle={selected.title || 'Meeting'}
                        onClose={() => {
                          setReviewing(false);
                          // Refresh to reflect changes.
                          void window.skymark.mc.getSuggestedTodos(selected.id).then((r) => {
                            if (r.ok) setSuggestions(r.todos);
                          });
                        }}
                      />
                    );
                  }
                  if (pendingCount === 0 && createdCount === 0) return null;
                  return (
                    <div className="history-review-cta">
                      {pendingCount > 0 && (
                        <button onClick={() => setReviewing(true)}>
                          <ListTodo size={13} />
                          <span>Review {pendingCount} pending action{pendingCount === 1 ? '' : 's'}</span>
                        </button>
                      )}
                      {createdCount > 0 && (
                        <span className="help">
                          {createdCount} todo{createdCount === 1 ? '' : 's'} already created.
                        </span>
                      )}
                    </div>
                  );
                })()}

                <div className="archive-section">
                  <div className="archive-header">
                    <FileText size={13} />
                    <span>Full transcript</span>
                    {archiveStatus === 'loading' && (
                      <span className="archive-status">loading…</span>
                    )}
                  </div>
                  {archiveStatus === 'error' && (
                    <p className="status error">Couldn't load archive: {archiveError}</p>
                  )}
                  {archiveMd && (
                    <div className="archive-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{archiveMd}</ReactMarkdown>
                    </div>
                  )}
                  {!archiveMd && archiveStatus === 'idle' && (
                    <p className="help">No transcript archived yet.</p>
                  )}
                </div>

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
