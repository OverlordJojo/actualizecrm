'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { cn } from '@/lib/cn';

interface Connection {
  connected: boolean;
  configured: boolean;
  accountEmail: string;
  calendarId: string;
  calendarName: string;
  connectedAt: string;
  timezone: string;
  needsReconnect: boolean;
  reconnectReason: string;
}

export function CalendarSettings() {
  const params = useSearchParams();
  const [conn, setConn] = useState<Connection | null>(null);
  const [calendars, setCalendars] = useState<
    { id: string; name: string; primary: boolean }[] | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/calendar/status');
    if (res.ok) setConn(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Surface the outcome of the OAuth round trip.
  useEffect(() => {
    if (params.get('calendar') === 'connected') {
      setNotice(
        `Google Calendar connected${params.get('as') ? ` as ${params.get('as')}` : ''}.`,
      );
      load();
    }
    const err = params.get('calendar_error');
    if (err) setError(err);
  }, [params, load]);

  async function loadCalendars() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/calendar/calendars');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not read your calendars.');
      setCalendars(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read your calendars.');
    } finally {
      setLoading(false);
    }
  }

  async function pick(c: { id: string; name: string }) {
    await fetch('/api/calendar/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
    setNotice(`Bookings will be written to "${c.name}".`);
    load();
  }

  async function disconnect() {
    await fetch('/api/calendar/status', { method: 'DELETE' });
    setNotice('Google Calendar disconnected.');
    setCalendars(null);
    load();
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">Calendar</h2>
        <p className="text-xs text-ink-400">
          Where bookings go. Times resolve in{' '}
          <span className="text-ink-300">{conn?.timezone ?? 'America/Vancouver'}</span> —
          the same zone the analytics and the worker&rsquo;s schedules use.
        </p>
      </div>

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

      <div className="panel p-3">
        {conn && !conn.configured && (
          <p className="text-xs text-amber-200">
            Google credentials or <code className="font-mono">CALENDAR_ENCRYPTION_KEY</code>{' '}
            are missing, so the calendar cannot be connected.
          </p>
        )}

        {conn?.configured && !conn.connected && (
          <div className="flex items-center gap-3">
            <a className="btn-primary py-1.5 text-xs" href="/api/calendar/connect">
              Connect Google Calendar
            </a>
            <span className="text-xs text-ink-500">
              Asks for <code className="font-mono">calendar.events</code> only — enough to
              create and edit meetings, and nothing else.
            </span>
          </div>
        )}

        {conn?.needsReconnect && (
          <div className="mb-3 rounded-lg border border-amber-800 bg-amber-950/50 p-3">
            <p className="text-xs font-semibold text-amber-200">
              Google has stopped accepting this connection.
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-100/90">
              {conn.reconnectReason} Bookings and the 15-minute sync will fail
              until you reconnect.
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-amber-100/80">
              If this keeps happening every week, the cause is the OAuth app&rsquo;s
              publishing status. Google expires refresh tokens after{' '}
              <strong>seven days</strong> while an app is in{' '}
              <strong>Testing</strong>. Setting it to <strong>In production</strong>{' '}
              in the Google Cloud console stops that, even without completing
              verification.
            </p>
            <a className="btn-primary mt-2 inline-block py-1.5 text-xs" href="/api/calendar/connect">
              Reconnect Google Calendar
            </a>
          </div>
        )}

        {conn?.connected && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={`h-2 w-2 rounded-full ${
                  conn.needsReconnect ? 'bg-amber-500' : 'bg-green-500'
                }`}
              />
              <span className="text-ink-200">
                {conn.accountEmail || 'Connected'}
              </span>
              <button
                className="ml-auto text-xs text-red-400 hover:underline"
                onClick={disconnect}
              >
                Disconnect
              </button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-400">
                Booking into:{' '}
                <span className="text-ink-200">{conn.calendarName}</span>
              </span>
              <button
                className="btn-ghost ml-auto py-1 text-xs"
                onClick={loadCalendars}
                disabled={loading}
              >
                {loading ? 'Loading…' : 'Choose calendar'}
              </button>
            </div>

            {calendars && (
              <div className="scroll-thin max-h-48 overflow-y-auto rounded-lg border border-ink-800">
                {calendars.length === 0 && (
                  <p className="p-3 text-center text-xs text-ink-500">
                    No calendars you can write to.
                  </p>
                )}
                {calendars.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => pick(c)}
                    className={cn(
                      'flex w-full items-center gap-2 border-b border-ink-800 px-3 py-2 text-left last:border-0 hover:bg-ink-850',
                      c.id === conn.calendarId && 'bg-ink-850',
                    )}
                  >
                    <span className="flex-1 truncate text-xs text-ink-200">{c.name}</span>
                    {c.primary && (
                      <span className="text-[10px] text-ink-500">primary</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <p className="text-[11px] text-ink-500">
              Events edited or deleted in Google reconcile back every 15 minutes
              through the worker.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
