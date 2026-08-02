import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  createEvent,
  connection,
  isAuthFailure,
  noteTokenRejected,
} from '@/integrations/calendar/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Bookings in a window, for the month/week/day views.
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const from = p.get('from');
  const to = p.get('to');

  const bookings = await db.booking.findMany({
    where: {
      ...(from || to
        ? {
            startsAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    },
    orderBy: { startsAt: 'asc' },
    include: {
      contact: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          companyName: true,
          phone: true,
          email: true,
        },
      },
    },
  });

  return NextResponse.json(bookings);
}

const createSchema = z.object({
  contactId: z.string().min(1),
  /// ISO 8601. The client sends an absolute instant; the operator's timezone
  /// is applied when rendering, never re-guessed here.
  startsAt: z.string().min(1),
  durationMinutes: z.number().int().min(5).max(480).default(30),
  /// Set when the booking came from an accepted AI suggestion (§5.6).
  createdByAi: z.boolean().default(false),
});

/**
 * Creates a booking and writes it to Google.
 *
 * The Google event is created first. If that fails there is no local row
 * either, which is the honest outcome: a booking the operator can see in the
 * app but that is not on the calendar they actually look at is worse than a
 * clear error.
 */
export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid booking.' },
      { status: 400 },
    );
  }

  const conn = await connection();
  if (!conn.connected) {
    return NextResponse.json(
      { error: 'Connect Google Calendar in Settings before booking.' },
      { status: 409 },
    );
  }

  const contact = await db.contact.findUnique({
    where: { id: parsed.data.contactId },
  });
  if (!contact) {
    return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
  }

  const startsAt = new Date(parsed.data.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    return NextResponse.json({ error: 'That is not a valid date and time.' }, { status: 400 });
  }

  // The most recent transcript gives the description its context tail (§2.4).
  const lastCall = await db.call.findFirst({
    where: { contactId: contact.id, transcript: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { transcript: true },
  });

  let event;
  try {
    event = await createEvent({
      contact,
      startsAt,
      durationMinutes: parsed.data.durationMinutes,
      transcript: lastCall?.transcript,
    });
  } catch (err) {
    if (isAuthFailure(err)) {
      await noteTokenRejected(
        'Google rejected the saved authorisation while creating a booking.',
      );
      return NextResponse.json(
        {
          error:
            'Google no longer accepts the saved calendar authorisation. Reconnect in Settings → Calendar.',
          needsReconnect: true,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: `Google refused the booking: ${String(err).slice(0, 200)}` },
      { status: 502 },
    );
  }

  const booking = await db.booking.create({
    data: {
      contactId: contact.id,
      startsAt,
      durationMinutes: parsed.data.durationMinutes,
      title: event.title,
      description: event.description,
      googleEventId: event.googleEventId,
      googleCalendarId: event.googleCalendarId,
      inviteSent: event.inviteSent,
      createdByAi: parsed.data.createdByAi,
      lastSyncedAt: new Date(),
    },
  });

  await db.activity.create({
    data: {
      contactId: contact.id,
      type: 'note',
      summary: `Booked for ${startsAt.toLocaleString('en-CA')}${
        event.inviteSent ? '' : ' — no invite sent, no email on file'
      }`,
      meta: {
        bookingId: booking.id,
        startsAt: startsAt.toISOString(),
        inviteSent: event.inviteSent,
      },
    },
  });

  return NextResponse.json(booking, { status: 201 });
}
