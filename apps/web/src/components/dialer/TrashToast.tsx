'use client';

import { useEffect, useState } from 'react';

/**
 * The undo window for a trashed lead (§3.3, §3.4).
 *
 * Ten seconds, with the remaining time visible. The countdown is not decoration
 * — the next burst is held until it expires, so the operator needs to know how
 * long they have and that waiting is deliberate rather than the dialer having
 * stalled.
 *
 * Trashing keeps the contact and its entire conversation history; only the
 * board placement goes. The copy says "Removed", never "Deleted", because the
 * difference matters and the operator should not have to remember which one
 * this is.
 */
export function TrashToast({
  name,
  expiresAt,
  onUndo,
}: {
  name: string;
  expiresAt: number;
  onUndo: () => void;
}) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
  );

  useEffect(() => {
    const t = setInterval(
      () => setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))),
      250,
    );
    return () => clearInterval(t);
  }, [expiresAt]);

  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900 px-4 py-2.5 shadow-lg">
        <div>
          <p className="text-xs font-medium text-ink-100">
            Removed {name} from the pipeline
          </p>
          <p className="text-[10px] text-ink-400">
            Their conversation history is kept. Next call in {remaining}s.
          </p>
        </div>
        <button
          className="btn-primary shrink-0 px-3 py-1 text-xs"
          onClick={onUndo}
          autoFocus
        >
          Undo
        </button>
      </div>
    </div>
  );
}

/**
 * The drop target that animates in while a card is being dragged (§3.3).
 *
 * Only rendered mid-drag. A permanent trash can invites accidental drops, and
 * one that appears with the drag makes the gesture's destination obvious at the
 * moment the operator is looking for it.
 */
export function TrashZone({ active, over }: { active: boolean; over: boolean }) {
  if (!active) return null;

  return (
    <div className="pointer-events-none fixed bottom-8 left-1/2 z-40 -translate-x-1/2">
      <div
        className={
          over
            ? 'flex items-center gap-2 rounded-xl border-2 border-red-500 bg-red-950/80 px-6 py-3 transition-all'
            : 'flex items-center gap-2 rounded-xl border-2 border-dashed border-ink-600 bg-ink-900/90 px-6 py-3 transition-all'
        }
      >
        <span className={over ? 'text-sm text-red-200' : 'text-sm text-ink-300'}>
          {over ? 'Release to remove' : 'Drag here to remove'}
        </span>
      </div>
    </div>
  );
}
