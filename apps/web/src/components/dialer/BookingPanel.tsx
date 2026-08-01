'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  operatorLocalToUtc,
  operatorZoneLabel,
  formatOperatorDateTime,
} from '@/lib/operator-time';

/**
 * The booking panel on the Active Lead Card (§3.1, §2.4).
 *
 * An AI booking proposal populates it but never books. §5.6 is explicit: a
 * booking is never auto-written to Google. The verified proposal fills in the
 * date, time and timezone, shows the evidence quote, and the operator confirms
 * with one action.
 */
export function BookingPanel({
  contactId,
  proposal,
  onBooked,
}: {
  contactId: string | null;
  /// Set when an AI booking suggestion was accepted: an ISO datetime plus the
  /// prospect's own words that justified it.
  proposal: { iso: string; evidence: string | null } | null;
  onBooked?: () => void;
}) {
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState(30);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A proposal fills the fields; it does not submit them.
  useEffect(() => {
    if (!proposal) return;
    const d = new Date(proposal.iso);
    if (Number.isNaN(d.getTime())) return;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Vancouver',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)!.value;
    setDate(`${g('year')}-${g('month')}-${g('day')}`);
    setTime(`${g('hour')}:${g('minute')}`);
    setResult(null);
    setError(null);
  }, [proposal]);

  // Clear when the dialer advances to a different lead.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [contactId]);

  async function book() {
    if (!contactId || !date || !time) return;
    setBusy(true);
    setError(null);
    try {
      const [y, m, d] = date.split('-').map(Number);
      const [hh, mm] = time.split(':').map(Number);
      const startsAt = operatorLocalToUtc(y, m, d, hh, mm);

      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId,
          startsAt: startsAt.toISOString(),
          durationMinutes: duration,
          createdByAi: Boolean(proposal),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not book.');

      setResult(
        `Booked ${formatOperatorDateTime(startsAt)}${
          json.inviteSent ? '' : ' — no invite sent, no email on file'
        }`,
      );
      onBooked?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not book.');
    } finally {
      setBusy(false);
    }
  }

  if (!contactId) return null;

  return (
    <div
      className={cn(
        'mt-2 rounded-lg border px-2.5 py-2',
        proposal ? 'border-violet-800 bg-violet-500/5' : 'border-ink-800 bg-ink-950',
      )}
    >
      {proposal && (
        <p className="mb-1.5 text-[11px] text-violet-200">
          AI proposed this time
          {proposal.evidence ? ` — they said “${proposal.evidence}”` : ''}. Nothing
          is on the calendar until you press Book.
        </p>
      )}

      <div className="flex items-end gap-1.5">
        <div className="min-w-0">
          <label className="mb-0.5 block text-[9px] uppercase tracking-wide text-ink-500">
            Date
          </label>
          <input
            type="date"
            className="input py-1 text-xs"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="min-w-0">
          <label className="mb-0.5 block text-[9px] uppercase tracking-wide text-ink-500">
            Time
          </label>
          <input
            type="time"
            className="input py-1 text-xs"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
        <div className="min-w-0">
          <label className="mb-0.5 block text-[9px] uppercase tracking-wide text-ink-500">
            Mins
          </label>
          <select
            className="input w-auto py-1 text-xs"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            {[15, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <span className="pb-1.5 text-[10px] text-ink-500">{operatorZoneLabel()}</span>
        <button
          className="btn-primary ml-auto shrink-0 py-1 text-xs"
          onClick={book}
          disabled={busy || !date || !time}
        >
          {busy ? 'Booking…' : 'Book'}
        </button>
      </div>

      {result && <p className="mt-1 text-[11px] text-green-300">{result}</p>}
      {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
