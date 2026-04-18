import { useEffect, useRef } from 'react';
import type { TranscriptEvent } from '../../shared/types';

type Props = {
  events: TranscriptEvent[];
  interim: TranscriptEvent | null;
};

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

export function TranscriptView({ events, interim }: Props) {
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
          <span className="speaker" style={{ color: speakerColour(ev.speaker) }}>
            {ev.speaker ?? 'Speaker'}
          </span>
          <span className="text">{ev.text}</span>
        </div>
      ))}
      {interim && (
        <div className="bubble interim">
          <span className="speaker" style={{ color: speakerColour(interim.speaker) }}>
            {interim.speaker ?? 'Speaker'}
          </span>
          <span className="text">{interim.text}</span>
        </div>
      )}
    </div>
  );
}
