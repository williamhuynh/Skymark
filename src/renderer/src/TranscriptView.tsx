import { useEffect, useRef } from 'react';
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
  '#ffd166',
  '#06d6a0',
  '#118ab2',
  '#ef476f',
  '#8338ec',
  '#fb5607',
];

function speakerColour(speaker: string | null): string {
  if (!speaker) return '#8b95a4';
  if (speaker === 'Multiple') return '#8b95a4';
  const match = /Speaker (\d+)/.exec(speaker);
  if (!match) return '#8b95a4';
  const idx = parseInt(match[1], 10) % SPEAKER_COLOURS.length;
  return SPEAKER_COLOURS[idx];
}

export function TranscriptView({ events, interim, compact = false }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

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
  }

  return (
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
  );
}
