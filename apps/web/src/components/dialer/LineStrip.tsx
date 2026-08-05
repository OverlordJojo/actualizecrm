'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';
import type { ActiveLead } from './ActiveLeadCard';

/**
 * Every line the session is holding, and what the operator can do with each.
 *
 * The spec's model is one conversation with everyone else parked, and the audio
 * still works that way — two prospects able to hear each other would be a
 * disaster. What this adds is *choice*: which parked caller becomes the live
 * one, and the ability to drop a line without touching the conversation in
 * progress.
 *
 * It exists because the burst was previously invisible. The operator could hear
 * one person and had no idea whether two others were ringing, parked, or gone —
 * which made a three-line dialer feel like a one-line dialer with unexplained
 * pauses.
 *
 * Left and right arrows move between lines, because during a call the operator
 * has one hand on the phone and no attention to spare for aiming a mouse.
 */

export interface Line {
  callId: string;
  contactId: string;
  toE164: string;
  state: 'ringing' | 'active' | 'held';
  heldSeconds: number;
}

const STATE_LABEL: Record<Line['state'], string> = {
  ringing: 'Ringing',
  active: 'On the line',
  held: 'Holding',
};

export function LineStrip({
  lines,
  leads,
  onSwitch,
  onHangup,
}: {
  lines: Line[];
  /// The dial queue, so a line can be shown by name rather than by number.
  leads: ActiveLead[];
  onSwitch: (callId: string) => void;
  onHangup: (callId: string) => void;
}) {
  // Arrow keys move between lines. Ignored while typing, like every other
  // hotkey here — the notes box must never lose a keystroke to navigation.
  useEffect(() => {
    if (lines.length < 2) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      e.preventDefault();
      const current = lines.findIndex((l) => l.state === 'active');
      const from = current === -1 ? 0 : current;
      const next =
        e.key === 'ArrowRight'
          ? (from + 1) % lines.length
          : (from - 1 + lines.length) % lines.length;
      const target = lines[next];
      if (target && target.state !== 'active') onSwitch(target.callId);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lines, onSwitch]);

  if (lines.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
          Lines ({lines.length})
        </span>
        {lines.length > 1 && (
          <span className="text-[10px] text-ink-600">← → to switch</span>
        )}
      </div>

      <div className="flex gap-1.5">
        {lines.map((line) => {
          const lead = leads.find((l) => l.id === line.contactId);
          const name =
            [lead?.firstName, lead?.lastName].filter(Boolean).join(' ') ||
            formatPhone(line.toE164);

          return (
            <div
              key={line.callId}
              className={cn(
                'group relative min-w-0 flex-1 rounded-lg border px-2 py-1.5 transition-colors',
                line.state === 'active'
                  ? 'border-green-600 bg-green-950/40'
                  : line.state === 'held'
                    ? 'border-amber-800 bg-amber-950/30'
                    : 'border-ink-700 bg-ink-900/60',
              )}
            >
              <button
                className="block w-full min-w-0 text-left"
                onClick={() => line.state !== 'active' && onSwitch(line.callId)}
                disabled={line.state === 'active'}
                title={
                  line.state === 'active'
                    ? 'You are on this call'
                    : `Switch to ${name}`
                }
              >
                <span className="flex items-center gap-1">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      line.state === 'active'
                        ? 'bg-green-400'
                        : line.state === 'held'
                          ? 'bg-amber-400'
                          : 'animate-pulse bg-brand-500',
                    )}
                  />
                  <span className="truncate text-[11px] font-medium text-ink-100">
                    {name}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[9px] text-ink-500">
                  {STATE_LABEL[line.state]}
                  {line.state === 'held' && line.heldSeconds > 0
                    ? ` ${line.heldSeconds}s`
                    : ''}
                </span>
              </button>

              {/* Per-line hang up. Drops this leg only — the conversation in
                  progress is untouched unless it is this one. */}
              <button
                className="absolute right-0.5 top-0.5 rounded px-1 text-[10px] text-ink-600 opacity-0 transition-opacity hover:bg-red-950/60 hover:text-red-300 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onHangup(line.callId);
                }}
                title={`Hang up ${name}`}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
