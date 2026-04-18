import { useEffect, useRef, useState } from 'react';
import type {
  Nudge,
  QuestionAnswer,
  SessionState,
  TranscriptEvent,
} from '../../shared/types';
import { TranscriptView } from './TranscriptView';

const MAX_TRANSCRIPT_EVENTS = 200;
const MAX_FEED_ITEMS = 40;

function capped<T>(arr: T[], max: number): T[] {
  return arr.length > max ? arr.slice(-max) : arr;
}

type FeedItem =
  | { kind: 'nudge'; id: string; at: number; reason: string; text: string }
  | { kind: 'question'; id: string; at: number; question: string; answer: string };

export function Sidebar() {
  const [sessionState, setSessionState] = useState<SessionState>({ phase: 'idle' });
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [interim, setInterim] = useState<TranscriptEvent | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [askInput, setAskInput] = useState('');
  const [askPending, setAskPending] = useState<string | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const pendingQuestions = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    void window.skymark.session.getState().then(setSessionState);

    const offState = window.skymark.session.onState(setSessionState);
    const offTranscript = window.skymark.session.onTranscript((ev) => {
      if (ev.isFinal) {
        setEvents((prev) => capped([...prev, ev], MAX_TRANSCRIPT_EVENTS));
        setInterim(null);
      } else {
        setInterim(ev);
      }
    });
    const offNudge = window.skymark.session.onNudge((n: Nudge) => {
      const text = n.nudgeText;
      if (!text) return;
      setFeed((prev) =>
        capped(
          [
            ...prev,
            {
              kind: 'nudge',
              id: n.nudgeId,
              at: n.resolvedAt ?? Date.now(),
              reason: n.reason,
              text,
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
      setAskPending((p) => (p === a.questionId ? null : p));
    });

    return () => {
      offState();
      offTranscript();
      offNudge();
      offAnswer();
    };
  }, []);

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

  const active = sessionState.phase === 'listening' || sessionState.phase === 'connecting';

  return (
    <main className="sidebar">
      <SidebarStatus state={sessionState} />
      {!active ? (
        <div className="sidebar-empty">
          <p>No active meeting.</p>
          <p className="sidebar-empty-hint">Start one from the main window.</p>
        </div>
      ) : (
        <>
          <TranscriptView events={events} interim={interim} />
          <div className="feed sidebar-feed">
            {feed.length === 0 ? (
              <p className="feed-empty">Nudges and answers appear here.</p>
            ) : (
              feed
                .slice(-6)
                .map((item) => <FeedCard key={`${item.kind}-${item.id}`} item={item} />)
            )}
          </div>
          <form
            className="ask"
            onSubmit={(e) => { e.preventDefault(); void submitAsk(); }}
          >
            <input
              type="text"
              placeholder="Ask Sky…"
              value={askInput}
              onChange={(e) => setAskInput(e.target.value)}
            />
            <button type="submit" disabled={!askInput.trim() || !!askPending}>
              {askPending ? '…' : 'Ask'}
            </button>
          </form>
          {askError && <p className="status error">{askError}</p>}
        </>
      )}
    </main>
  );
}

function SidebarStatus({ state }: { state: SessionState }) {
  let text = '';
  let cls = '';
  switch (state.phase) {
    case 'idle':
      text = 'Idle';
      cls = 'idle';
      break;
    case 'connecting':
      text = 'Connecting…';
      cls = 'connecting';
      break;
    case 'listening':
      text = `Live · ${new Date(state.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      cls = 'live';
      break;
    case 'error':
      text = state.message;
      cls = 'error';
      break;
  }
  return (
    <div className={`statusbar sidebar-status ${cls}`}>
      <span className="dot" />
      <span>{text}</span>
    </div>
  );
}

function FeedCard({ item }: { item: FeedItem }) {
  const time = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (item.kind === 'nudge') {
    return (
      <div className="feed-card nudge">
        <div className="feed-meta">
          <span className="feed-tag">Nudge</span>
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
