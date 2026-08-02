import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  getEvent,
  connection,
  isAuthFailure,
  noteTokenRejected,
} from '@/integrations/calendar/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Two-way sync: pulls edits and cancellations made in Google back into the app.
 *
 * Called by the worker's `calendar.reconcile` job every 15 minutes rather than
 * being implemented on the worker, because all the Google plumbing — the
 * encrypted refresh token, the client, the booking format — already lives here.
 * Teaching the worker to do it as well would mean two copies of the token
 * handling and two places for them to disagree.
 *
 * Authenticated by the shared secret rather than the session cookie: there is
 * no operator sitting at a browser when this runs at 3am.
 */

/// Reconciling every booking ever made would grow without bound. Anything from
/// a week back onward covers "the operator moved next Tuesday's meeting", which
/// is the case this exists for.
const WINDOW_DAYS_BACK = 7;
const WINDOW_DAYS_FORWARD = 120;
const MAX_PER_RUN = 200;

export async function POST(request: Request) {
  const secret = request.headers.get('x-worker-secret');
  if (!secret || secret !== process.env.WORKER_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const conn = await connection();
  if (!conn.connected) {
    return NextResponse.json({ skipped: 'calendar not connected' });
  }

  const now = Date.now();
  const bookings = await db.booking.findMany({
    where: {
      status: 'confirmed',
      googleEventId: { not: null },
      startsAt: {
        gte: new Date(now - WINDOW_DAYS_BACK * 86_400_000),
        lte: new Date(now + WINDOW_DAYS_FORWARD * 86_400_000),
      },
    },
    orderBy: { startsAt: 'asc' },
    take: MAX_PER_RUN,
  });

  let moved = 0;
  let cancelled = 0;
  let checked = 0;
  const errors: string[] = [];

  for (const booking of bookings) {
    checked++;
    try {
      const remote = await getEvent(
        booking.googleEventId!,
        booking.googleCalendarId ?? 'primary',
      );
      if (!remote) continue;

      if (remote.status === 'cancelled') {
        await db.booking.update({
          where: { id: booking.id },
          data: { status: 'cancelled', lastSyncedAt: new Date() },
        });
        await db.activity.create({
          data: {
            contactId: booking.contactId,
            type: 'note',
            summary: 'Booking cancelled in Google Calendar',
            meta: { bookingId: booking.id, source: 'reconcile' },
          },
        });
        cancelled++;
        continue;
      }

      const changed =
        remote.startsAt &&
        (remote.startsAt.getTime() !== booking.startsAt.getTime() ||
          remote.durationMinutes !== booking.durationMinutes);

      if (changed && remote.startsAt) {
        await db.booking.update({
          where: { id: booking.id },
          data: {
            startsAt: remote.startsAt,
            durationMinutes: remote.durationMinutes,
            lastSyncedAt: new Date(),
          },
        });
        await db.activity.create({
          data: {
            contactId: booking.contactId,
            type: 'note',
            summary: `Booking moved in Google to ${remote.startsAt.toLocaleString('en-CA')}`,
            meta: {
              bookingId: booking.id,
              startsAt: remote.startsAt.toISOString(),
              source: 'reconcile',
            },
          },
        });
        moved++;
      } else {
        await db.booking.update({
          where: { id: booking.id },
          data: { lastSyncedAt: new Date() },
        });
      }
    } catch (err) {
      // A rejected token will reject every remaining booking too, so stop and
      // say so once rather than logging the same failure two hundred times.
      if (isAuthFailure(err)) {
        await noteTokenRejected(
          'Google rejected the saved authorisation during the 15-minute reconcile.',
        );
        return NextResponse.json({
          checked,
          moved,
          cancelled,
          stopped: 'authorisation rejected — reconnect in Settings → Calendar',
        });
      }
      // One bad event must not abandon the rest of the window.
      errors.push(`${booking.id}: ${String(err).slice(0, 120)}`);
    }
  }

  return NextResponse.json({ checked, moved, cancelled, errors: errors.slice(0, 5) });
}
