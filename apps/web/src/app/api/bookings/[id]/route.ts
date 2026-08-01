import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { updateEvent, cancelEvent } from '@/integrations/calendar/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  startsAt: z.string().min(1).optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
});

/// Reschedules a booking in both places. Google first, for the same reason as
/// creation: a local row that disagrees with the calendar is the worst outcome.
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid change.' }, { status: 400 });
  }

  const booking = await db.booking.findUnique({ where: { id: params.id } });
  if (!booking) {
    return NextResponse.json({ error: 'Booking not found.' }, { status: 404 });
  }

  const startsAt = parsed.data.startsAt ? new Date(parsed.data.startsAt) : booking.startsAt;
  const durationMinutes = parsed.data.durationMinutes ?? booking.durationMinutes;

  if (Number.isNaN(startsAt.getTime())) {
    return NextResponse.json({ error: 'That is not a valid date and time.' }, { status: 400 });
  }

  if (booking.googleEventId && booking.googleCalendarId) {
    try {
      await updateEvent(booking.googleEventId, booking.googleCalendarId, startsAt, durationMinutes);
    } catch (err) {
      return NextResponse.json(
        { error: `Google refused the change: ${String(err).slice(0, 200)}` },
        { status: 502 },
      );
    }
  }

  const updated = await db.booking.update({
    where: { id: params.id },
    data: { startsAt, durationMinutes, lastSyncedAt: new Date() },
  });

  await db.activity.create({
    data: {
      contactId: booking.contactId,
      type: 'note',
      summary: `Booking moved to ${startsAt.toLocaleString('en-CA')}`,
      meta: { bookingId: booking.id, startsAt: startsAt.toISOString() },
    },
  });

  return NextResponse.json(updated);
}

/// Cancels in Google and marks the row cancelled. The row is kept rather than
/// deleted: a cancelled meeting is history worth having, and the retention
/// sweep already treats a booking as a reason to keep a lead's records.
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const booking = await db.booking.findUnique({ where: { id: params.id } });
  if (!booking) {
    return NextResponse.json({ error: 'Booking not found.' }, { status: 404 });
  }

  if (booking.googleEventId && booking.googleCalendarId) {
    await cancelEvent(booking.googleEventId, booking.googleCalendarId).catch(() => {
      // Already gone in Google; still mark it cancelled here.
    });
  }

  const updated = await db.booking.update({
    where: { id: params.id },
    data: { status: 'cancelled', lastSyncedAt: new Date() },
  });

  await db.activity.create({
    data: {
      contactId: booking.contactId,
      type: 'note',
      summary: 'Booking cancelled',
      meta: { bookingId: booking.id },
    },
  });

  return NextResponse.json(updated);
}
