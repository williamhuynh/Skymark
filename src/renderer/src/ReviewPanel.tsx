import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, ListTodo, Loader2, X } from 'lucide-react';
import type { SuggestedTodo, SuggestedTodoCategory } from '../../shared/types';

type Props = {
  meetingId: string;
  meetingTitle: string;
  onClose: () => void;
};

const CATEGORY_LABEL: Record<SuggestedTodoCategory, string> = {
  'my-action': 'My action',
  'follow-up': 'Follow-up',
  'context-only': 'Context only',
};

const CATEGORY_ORDER: SuggestedTodoCategory[] = ['my-action', 'follow-up', 'context-only'];

type SelectionState = Record<string, { selected: boolean; editingText?: string }>;

export function ReviewPanel({ meetingId, meetingTitle, onClose }: Props) {
  const [todos, setTodos] = useState<SuggestedTodo[]>([]);
  const [selection, setSelection] = useState<SelectionState>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    approved: number;
    dismissed: number;
    failures: Array<{ text: string; error: string }>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await window.skymark.mc.getSuggestedTodos(meetingId);
      if (cancelled) return;
      if (res.ok) {
        setTodos(res.todos);
        // Default selection: my-action + follow-up checked; context-only unchecked.
        const next: SelectionState = {};
        for (const t of res.todos) {
          if (t.status !== 'suggested') continue;
          next[t.id] = { selected: t.category !== 'context-only' };
        }
        setSelection(next);
      } else {
        setLoadError(res.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const pending = todos.filter((t) => t.status === 'suggested');
  const alreadyProcessed = todos.filter((t) => t.status !== 'suggested');
  const selectedCount = pending.filter((t) => selection[t.id]?.selected).length;

  function toggle(id: string) {
    setSelection((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { selected: false }), selected: !prev[id]?.selected },
    }));
  }

  function editText(id: string, text: string) {
    setSelection((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { selected: true }), editingText: text },
    }));
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setResult(null);
    let approved = 0;
    let dismissed = 0;
    const failures: Array<{ text: string; error: string }> = [];
    for (const t of pending) {
      const sel = selection[t.id];
      if (sel?.selected) {
        const override =
          sel.editingText && sel.editingText.trim() !== t.text
            ? { text: sel.editingText.trim() }
            : undefined;
        const r = await window.skymark.mc.approveSuggestedTodo(meetingId, t.id, override);
        if (r.ok) approved++;
        else failures.push({ text: t.text, error: r.error ?? 'approve failed' });
      } else {
        const r = await window.skymark.mc.dismissSuggestedTodo(meetingId, t.id);
        if (r.ok) dismissed++;
        else failures.push({ text: t.text, error: r.error ?? 'dismiss failed' });
      }
    }
    setResult({ approved, dismissed, failures });
    setSubmitting(false);
  }

  if (loadError) {
    return (
      <div className="review-panel error">
        <div className="review-header">
          <CircleAlert size={14} />
          <span>Couldn't load post-meeting suggestions</span>
          <button className="ghost review-close" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
        <p className="status error">{loadError}</p>
      </div>
    );
  }

  if (result) {
    const hasFailures = result.failures.length > 0;
    return (
      <div className={`review-panel ${hasFailures ? 'error' : 'success'}`}>
        <div className="review-header">
          {hasFailures ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}
          <span>{hasFailures ? 'Review finished with errors' : 'Review complete'}</span>
          <button className="ghost review-close" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
        <p className="help">
          {result.approved > 0 && (
            <>
              <strong>{result.approved}</strong> created
              {(result.dismissed > 0 || hasFailures) ? ' · ' : '.'}
            </>
          )}
          {result.dismissed > 0 && (
            <>
              <strong>{result.dismissed}</strong> dismissed
              {hasFailures ? ' · ' : '.'}
            </>
          )}
          {hasFailures && (
            <>
              <strong>{result.failures.length}</strong> failed.
            </>
          )}
        </p>
        {hasFailures && (
          <ul className="review-failures">
            {result.failures.map((f, i) => (
              <li key={i}>
                <span className="review-failure-text">{f.text}</span>
                <span className="review-failure-err">{f.error}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (pending.length === 0 && alreadyProcessed.length > 0) {
    return (
      <div className="review-panel">
        <div className="review-header">
          <CheckCircle2 size={14} />
          <span>Already reviewed</span>
          <button className="ghost review-close" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
        <p className="help">
          All suggestions from “{meetingTitle}” have been handled.
        </p>
      </div>
    );
  }

  if (todos.length === 0) {
    return null;
  }

  return (
    <div className="review-panel">
      <div className="review-header">
        <ListTodo size={14} />
        <span>Post-meeting review · {meetingTitle}</span>
        <button className="ghost review-close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <p className="help">
        {pending.length} suggested todo{pending.length === 1 ? '' : 's'}. Approved items become MC todos.
        Context-only items are unchecked by default — tick them if you want a mental bookmark.
      </p>
      <div className="review-list">
        {CATEGORY_ORDER.map((cat) => {
          const items = pending.filter((t) => t.category === cat);
          if (items.length === 0) return null;
          return items.map((t) => {
            const sel = selection[t.id];
            const checked = sel?.selected ?? false;
            return (
              <div key={t.id} className={`review-item cat-${cat}`}>
                <label className="review-check">
                  <input type="checkbox" checked={checked} onChange={() => toggle(t.id)} />
                </label>
                <div className="review-body">
                  <input
                    type="text"
                    className="review-text"
                    value={sel?.editingText ?? t.text}
                    onChange={(e) => editText(t.id, e.target.value)}
                  />
                  <div className="review-meta">
                    <span className={`review-cat review-cat-${cat}`}>{CATEGORY_LABEL[cat]}</span>
                    {t.dueHint && <span className="review-due">· {t.dueHint}</span>}
                    {t.owner && <span className="review-owner">· owner: {t.owner}</span>}
                  </div>
                  {t.rationale && (
                    <p className="review-rationale">{t.rationale}</p>
                  )}
                </div>
              </div>
            );
          });
        })}
      </div>
      <div className="review-footer">
        <button className="ghost" onClick={onClose} disabled={submitting}>
          Close
        </button>
        <button onClick={submit} disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 size={13} className="spinning" />
              <span>Saving…</span>
            </>
          ) : (
            <>
              <CheckCircle2 size={13} />
              <span>
                {selectedCount > 0
                  ? `Create ${selectedCount} todo${selectedCount === 1 ? '' : 's'}`
                  : 'Dismiss all'}
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
