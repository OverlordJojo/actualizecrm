'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * AI suggestion chips (§5.6).
 *
 * Above 0.85 confidence a chip is offered plainly. Below it the chip is greyed
 * and the evidence quote is on hover, because a low-confidence extraction shown
 * with the same weight as a high-confidence one trains the operator to accept
 * everything — which is the failure mode that costs a deal when the model
 * mishears an email address.
 *
 * Nothing is ever applied without a click unless the operator has explicitly
 * opted that field type into auto-apply in Settings. That is a correctness
 * requirement, not a preference: a wrong auto-write is invisible until it
 * matters.
 */

export const CONFIDENCE_THRESHOLD = 0.85;

export interface Suggestion {
  id: string;
  fieldType: string;
  value: string | null;
  evidence: string | null;
  confidence: number;
  verified: boolean | null;
  verifyReason: string | null;
  outcome: string;
}

const FIELD_LABEL: Record<string, string> = {
  email: 'email',
  first_name: 'first name',
  last_name: 'last name',
  company: 'company',
  address: 'address',
  booking: 'booking',
  stage: 'stage',
};

export function SuggestionChips({
  callId,
  contactId,
  onApplied,
  onBookingProposed,
}: {
  callId: string | null;
  contactId: string | null;
  onApplied?: () => void;
  /// Bookings are never written straight to Google — the proposal populates the
  /// booking panel and the operator confirms (§5.6).
  onBookingProposed?: (isoDatetime: string, evidence: string | null) => void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!callId && !contactId) {
      setSuggestions([]);
      return;
    }
    const q = callId ? `callId=${callId}` : `contactId=${contactId}`;
    const res = await fetch(`/api/ai/suggestions?${q}`);
    if (res.ok) setSuggestions(await res.json());
  }, [callId, contactId]);

  useEffect(() => {
    load();
    // The post-call pipeline finishes seconds to a minute after hangup, so the
    // chips appear on their own rather than requiring a refresh.
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function decide(s: Suggestion, decision: 'accepted' | 'dismissed') {
    setBusy(s.id);
    try {
      await fetch('/api/ai/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId: s.id, decision }),
      });
      if (decision === 'accepted' && s.fieldType === 'booking' && s.value) {
        onBookingProposed?.(s.value, s.evidence);
      }
      setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
      onApplied?.();
    } finally {
      setBusy(null);
    }
  }

  if (suggestions.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {suggestions.map((s) => {
        const confident = s.confidence >= CONFIDENCE_THRESHOLD;
        const isBooking = s.fieldType === 'booking';

        return (
          <div
            key={s.id}
            title={
              s.evidence
                ? `They said: “${s.evidence}”${
                    isBooking && s.verifyReason ? `\n\nVerification: ${s.verifyReason}` : ''
                  }`
                : undefined
            }
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]',
              confident
                ? 'border-violet-700 bg-violet-500/10 text-violet-100'
                : 'border-ink-700 bg-ink-850 text-ink-400',
            )}
          >
            <span className="opacity-70">AI heard</span>
            <span className="font-medium">
              {FIELD_LABEL[s.fieldType] ?? s.fieldType}:
            </span>
            <span className="max-w-[220px] truncate">{s.value}</span>

            {isBooking && s.verified === false && (
              <span className="rounded bg-amber-500/20 px-1 text-[9px] text-amber-300">
                unverified
              </span>
            )}
            {!confident && (
              <span className="text-[9px] opacity-70">
                {Math.round(s.confidence * 100)}% — hover for the quote
              </span>
            )}

            <button
              className="ml-1 rounded px-1 text-green-400 hover:bg-green-500/10 disabled:opacity-40"
              onClick={() => decide(s, 'accepted')}
              disabled={busy === s.id}
            >
              Accept
            </button>
            <button
              className="rounded px-1 text-ink-400 hover:bg-ink-800 disabled:opacity-40"
              onClick={() => decide(s, 'dismissed')}
              disabled={busy === s.id}
            >
              Dismiss
            </button>
          </div>
        );
      })}
    </div>
  );
}
