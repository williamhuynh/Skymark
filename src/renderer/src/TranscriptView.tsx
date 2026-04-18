import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Headphones, Pencil } from 'lucide-react';
import type { TranscriptEvent } from '../../shared/types';

type Props = {
  events: TranscriptEvent[];
  interim: TranscriptEvent | null;
  compact?: boolean;
  speakerNames?: Record<string, string>;
  onRenameSpeaker?: (rawSpeaker: string, name: string) => void;
};

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

const SPEAKER_COLOURS = [
  'var(--speaker-0)',
  'var(--speaker-1)',
  'var(--speaker-2)',
  'var(--speaker-3)',
  'var(--speaker-4)',
  'var(--speaker-5)',
];

function speakerColour(speaker: string | null): string {
  if (!speaker) return 'var(--text-muted)';
  if (speaker === 'Multiple') return 'var(--text-muted)';
  const match = /Speaker (\d+)/.exec(speaker);
  if (!match) return 'var(--text-muted)';
  const idx = parseInt(match[1], 10) % SPEAKER_COLOURS.length;
  return SPEAKER_COLOURS[idx];
}

function displaySpeaker(raw: string | null, names: Record<string, string> | undefined): string {
  if (!raw) return 'Speaker';
  return names?.[raw] ?? raw;
}

export function TranscriptView({ events, interim, compact = false, speakerNames, onRenameSpeaker }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const [editingRaw, setEditingRaw] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events, interim]);

  function handleScroll() {
    const el = scroller.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distanceFromBottom < 40;
    setShowJumpLatest(!atBottom.current);
  }

  function jumpToLatest() {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setShowJumpLatest(false);
  }

  function startEdit(raw: string | null) {
    if (!raw || !onRenameSpeaker || raw === 'Multiple') return;
    setEditingRaw(raw);
    setEditValue(speakerNames?.[raw] ?? '');
  }

  function commitEdit() {
    if (!editingRaw || !onRenameSpeaker) return;
    const trimmed = editValue.trim();
    onRenameSpeaker(editingRaw, trimmed);
    setEditingRaw(null);
  }

  function cancelEdit() {
    setEditingRaw(null);
  }

  function renderSpeakerLabel(raw: string | null, isInterim: boolean) {
    const display = displaySpeaker(raw, speakerNames);
    const editable = !!onRenameSpeaker && !!raw && raw !== 'Multiple' && !isInterim;
    if (editingRaw === raw && !isInterim) {
      return (
        <input
          className="speaker-edit"
          value={editValue}
          autoFocus
          placeholder={raw ?? ''}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            else if (e.key === 'Escape') cancelEdit();
          }}
          style={{ color: speakerColour(raw) }}
        />
      );
    }
    return (
      <span
        className={editable ? 'speaker speaker-editable' : 'speaker'}
        style={{ color: speakerColour(raw) }}
        onClick={editable ? () => startEdit(raw) : undefined}
        title={editable ? 'Click to rename this speaker for this meeting' : undefined}
      >
        {display}
        {editable && <Pencil size={10} className="speaker-edit-icon" aria-hidden />}
      </span>
    );
  }

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={scroller} onScroll={handleScroll}>
        {events.length === 0 && !interim && (
          <div className="transcript-empty">
            <Headphones size={24} strokeWidth={1.5} />
            <span>Waiting for audio…</span>
          </div>
        )}
        {events.map((ev) => (
          <div key={`${ev.startMs}-${ev.speaker ?? 'unk'}-${ev.text.length}`} className="bubble">
            <div className="bubble-header">
              {renderSpeakerLabel(ev.speaker, false)}
              {!compact && <span className="timestamp">{formatTimestamp(ev.startMs)}</span>}
            </div>
            <span className="text">{ev.text}</span>
          </div>
        ))}
        {interim && (
          <div className="bubble interim">
            <div className="bubble-header">
              {renderSpeakerLabel(interim.speaker, true)}
              {!compact && <span className="timestamp">{formatTimestamp(interim.startMs)}</span>}
            </div>
            <span className="text">{interim.text}</span>
          </div>
        )}
      </div>
      {showJumpLatest && (
        <button className="jump-latest" onClick={jumpToLatest} aria-label="Scroll to latest">
          <ArrowDown size={14} />
          <span>Latest</span>
        </button>
      )}
    </div>
  );
}
