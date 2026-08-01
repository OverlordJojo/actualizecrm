'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { ContactSlideOver } from '@/components/contact/ContactSlideOver';
import { LeadPicker, type PickedLead } from './LeadPicker';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';
import {
  OPERATOR_TIMEZONE,
  addOperatorDays,
  addOperatorMonths,
  endOfOperatorDay,
  formatOperatorTime,
  operatorDateKey,
  operatorLocalToUtc,
  operatorZoneLabel,
  startOfOperatorDay,
  startOfOperatorMonth,
  startOfOperatorWeek,
} from '@/lib/operator-time';

interface Booking {
  id: string;
  startsAt: string;
  durationMinutes: number;
  title: string;
  status: string;
  inviteSent: boolean;
  createdByAi: boolean;
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    phone: string;
    email: string | null;
  };
}

type View = 'month' | 'week' | 'day';

/**
 * The Calendar page (§2).
 *
 * Everything renders in the operator's timezone, never the browser's. The two
 * are the same machine today, but the analytics, the worker's schedules and the
 * booking maths all resolve against `America/Vancouver`, and a calendar that
 * disagreed with them by an hour twice a year would be very hard to notice and
 * very expensive to discover.
 */
export function CalendarClient() {
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [calendarName, setCalendarName] = useState('');
  const [openContactId, setOpenContactId] = useState<string | null>(null);

  const [lead, setLead] = useState<PickedLead | null>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('10:00');
  const [duration, setDuration] = useState(30);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const range = useMemo(() => {
    if (view === 'day') {
      return { from: startOfOperatorDay(anchor), to: endOfOperatorDay(anchor) };
    }
    if (view === 'week') {
      const from = startOfOperatorWeek(anchor);
      return { from, to: endOfOperatorDay(addOperatorDays(from, 6)) };
    }
    const monthStart = startOfOperatorMonth(anchor);
    // Pad to whole weeks so the grid is rectangular.
    const from = startOfOperatorWeek(monthStart);
    return { from, to: endOfOperatorDay(addOperatorDays(from, 41)) };
  }, [view, anchor]);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/bookings?from=${range.from.toISOString()}&to=${range.to.toISOString()}`,
    );
    if (res.ok) setBookings(await res.json());
  }, [range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch('/api/calendar/status')
      .then((r) => r.json())
      .then((s) => {
        setConnected(s.connected);
        setCalendarName(s.calendarName);
      })
      .catch(() => setConnected(false));
  }, []);

  async function createBooking() {
    if (!lead || !date) return;
    setBooking(true);
    setError(null);
    setNotice(null);
    try {
      const [y, m, d] = date.split('-').map(Number);
      const [hh, mm] = time.split(':').map(Number);
      // The operator types a wall-clock time in their own zone; this is where
      // that becomes an absolute instant.
      const startsAt = operatorLocalToUtc(y, m, d, hh, mm);

      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: lead.id,
          startsAt: startsAt.toISOString(),
          durationMinutes: duration,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not create the booking.');

      setNotice(
        json.inviteSent
          ? `Booked. An invite went to ${lead.email}.`
          : 'Booked. No invite sent — this lead has no email on file.',
      );
      setLead(null);
      setDate('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the booking.');
    } finally {
      setBooking(false);
    }
  }

  async function cancel(b: Booking) {
    await fetch(`/api/bookings/${b.id}`, { method: 'DELETE' });
    load();
  }

  const byDay = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of bookings) {
      if (b.status === 'cancelled') continue;
      const key = operatorDateKey(new Date(b.startsAt));
      const list = map.get(key) ?? [];
      list.push(b);
      map.set(key, list);
    }
    return map;
  }, [bookings]);

  const days = useMemo(() => {
    const count = view === 'day' ? 1 : view === 'week' ? 7 : 42;
    return Array.from({ length: count }, (_, i) => addOperatorDays(range.from, i));
  }, [view, range.from]);

  const heading = useMemo(() => {
    const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: OPERATOR_TIMEZONE, ...opts }).format(d);
    if (view === 'day') return fmt(anchor, { weekday: 'long', month: 'long', day: 'numeric' });
    if (view === 'week') {
      return `${fmt(range.from, { month: 'short', day: 'numeric' })} – ${fmt(
        addOperatorDays(range.from, 6),
        { month: 'short', day: 'numeric' },
      )}`;
    }
    return fmt(startOfOperatorMonth(anchor), { month: 'long', year: 'numeric' });
  }, [view, anchor, range.from]);

  function step(delta: number) {
    setAnchor((a) =>
      view === 'month'
        ? addOperatorMonths(a, delta)
        : addOperatorDays(a, delta * (view === 'week' ? 7 : 1)),
    );
  }

  const todayKey = operatorDateKey(new Date());
  const monthOfAnchor = operatorDateKey(startOfOperatorMonth(anchor)).slice(0, 7);

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle={`${heading} · ${operatorZoneLabel()}${
          calendarName ? ` · ${calendarName}` : ''
        }`}
      >
        <button className="btn-ghost py-1.5 text-xs" onClick={() => step(-1)}>
          ←
        </button>
        <button className="btn-ghost py-1.5 text-xs" onClick={() => setAnchor(new Date())}>
          Today
        </button>
        <button className="btn-ghost py-1.5 text-xs" onClick={() => step(1)}>
          →
        </button>
        <div className="ml-2 flex items-center gap-0.5 rounded-lg bg-ink-850 p-0.5">
          {(['month', 'week', 'day'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                'rounded px-2 py-1 text-[11px] capitalize transition-colors',
                view === v ? 'bg-brand-500 text-ink-950' : 'text-ink-400 hover:text-ink-100',
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        {/* --- booking panel --- */}
        <aside className="w-[320px] shrink-0 space-y-3 overflow-y-auto border-r border-ink-800 p-4">
          <h2 className="text-sm font-semibold text-ink-100">Book a meeting</h2>

          {connected === false && (
            <div className="rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
              Google Calendar is not connected. Connect it in Settings →
              Calendar; bookings are written to Google, so there is nowhere to
              put one until then.
            </div>
          )}

          {notice && (
            <div className="rounded-lg border border-green-900 bg-green-950/50 px-3 py-2 text-xs text-green-200">
              {notice}
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          <div>
            <label className="label">Lead</label>
            <LeadPicker selected={lead} onSelect={setLead} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Date</label>
              <input
                type="date"
                className="input py-1.5 text-xs"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Time</label>
              <input
                type="time"
                className="input py-1.5 text-xs"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="label">Duration</label>
            <select
              className="input py-1.5 text-xs"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {[15, 30, 45, 60, 90].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </div>

          <p className="text-[11px] text-ink-500">
            Times are {operatorZoneLabel()} ({OPERATOR_TIMEZONE}).
          </p>

          <button
            className="btn-primary w-full py-1.5 text-xs"
            onClick={createBooking}
            disabled={booking || !lead || !date || connected === false}
          >
            {booking ? 'Booking…' : 'Book'}
          </button>
        </aside>

        {/* --- grid --- */}
        <div className="scroll-thin min-w-0 flex-1 overflow-auto p-4">
          <div
            className={cn(
              'grid gap-1.5',
              view === 'day' ? 'grid-cols-1' : 'grid-cols-7',
            )}
          >
            {view !== 'day' &&
              ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <div key={d} className="pb-1 text-center text-[10px] uppercase tracking-wide text-ink-500">
                  {d}
                </div>
              ))}

            {days.map((day) => {
              const key = operatorDateKey(day);
              const list = byDay.get(key) ?? [];
              const isToday = key === todayKey;
              const outsideMonth = view === 'month' && !key.startsWith(monthOfAnchor);

              return (
                <div
                  key={key}
                  className={cn(
                    'rounded-lg border p-1.5',
                    view === 'day' ? 'min-h-[60vh]' : view === 'week' ? 'min-h-[52vh]' : 'min-h-[92px]',
                    isToday ? 'border-brand-600 bg-brand-500/5' : 'border-ink-800 bg-ink-900',
                    outsideMonth && 'opacity-40',
                  )}
                >
                  <div className="mb-1 flex items-baseline justify-between">
                    <span
                      className={cn(
                        'text-[11px]',
                        isToday ? 'font-semibold text-brand-300' : 'text-ink-400',
                      )}
                    >
                      {Number(key.slice(8))}
                    </span>
                    {list.length > 0 && (
                      <span className="text-[9px] text-ink-600">{list.length}</span>
                    )}
                  </div>

                  <div className="space-y-1">
                    {list.map((b) => {
                      const name =
                        [b.contact.firstName, b.contact.lastName].filter(Boolean).join(' ') ||
                        b.contact.companyName ||
                        formatPhone(b.contact.phone);
                      return (
                        <div
                          key={b.id}
                          className="group rounded border border-brand-800 bg-brand-500/10 px-1.5 py-1"
                        >
                          <button
                            className="block w-full text-left"
                            onClick={() => setOpenContactId(b.contact.id)}
                          >
                            <span className="block text-[10px] font-medium text-brand-200">
                              {formatOperatorTime(new Date(b.startsAt))}
                            </span>
                            <span className="block truncate text-[11px] text-ink-100">
                              {name}
                            </span>
                            {b.contact.companyName && (
                              <span className="block truncate text-[10px] text-ink-400">
                                {b.contact.companyName}
                              </span>
                            )}
                            <span className="block truncate font-mono text-[10px] text-ink-500">
                              {formatPhone(b.contact.phone)}
                            </span>
                          </button>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            {!b.inviteSent && (
                              <span className="rounded bg-amber-500/15 px-1 text-[9px] text-amber-300">
                                no invite sent
                              </span>
                            )}
                            {b.createdByAi && (
                              <span className="rounded bg-violet-500/15 px-1 text-[9px] text-violet-300">
                                from AI
                              </span>
                            )}
                            <button
                              className="ml-auto text-[9px] text-red-500 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                              onClick={() => cancel(b)}
                            >
                              cancel
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <ContactSlideOver
        contactId={openContactId}
        onClose={() => setOpenContactId(null)}
        onChanged={load}
      />
    </>
  );
}
