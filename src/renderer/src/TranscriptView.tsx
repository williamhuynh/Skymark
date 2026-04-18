import { useEffect, useRef, useState } from 'react';
import type { TranscriptEvent } from '../../shared/types';

type Props = {
  events: TranscriptEvent[];
  interim: TranscriptEvent | null;
  compact?: boolean;
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

export function TranscriptView({ events, interim, compact = false }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);

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

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={scroller} onScroll={handleScroll}>
        {events.length === 0 && !interim && (
          <p className="transcript-empty">Waiting for audio…</p>
        )}
        {events.map((ev) => (
          <div key={`${ev.startMs}-${ev.speaker ?? 'unk'}-${ev.text.length}`} className="bubble">
            <div className="bubble-header">
              <span className="speaker" style={{ color: speakerColour(ev.speaker) }}>
                {ev.speaker ?? 'Speaker'}
              </span>
              {!compact && <span className="timestamp">{formatTimestamp(ev.startMs)}</span>}
            </div>
            <span className="text">{ev.text}</span>
          </div>
        ))}
        {interim && (
          <div className="bubble interim">
            <div className="bubble-header">
              <span className="speaker" style={{ color: speakerColour(interim.speaker) }}>
                {interim.speaker ?? 'Speaker'}
              </span>
              {!compact && <span className="timestamp">{formatTimestamp(interim.startMs)}</span>}
            </div>
            <span className="text">{interim.text}</span>
          </div>
        )}
      </div>
      {showJumpLatest && (
        <button className="jump-latest" onClick={jumpToLatest} aria-label="Scroll to latest">
          ↓ Latest
        </button>
      )}
    </div>
  );
}
