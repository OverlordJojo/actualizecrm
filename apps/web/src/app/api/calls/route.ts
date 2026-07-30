import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { pickCallerId } from '@/integrations/telnyx/caller-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const startSchema = z.object({
  /// Omitted for a manual dial-pad call to a number not in the CRM.
  contactId: z.string().optional(),
  /// Required for manual dials; ignored when contactId is given.
  phone: z.string().optional(),
});

/**
 * Opens a call record and tells the browser which number to dial from.
 *
 * The browser then places the actual call over WebRTC. We create the row up
 * front so that a call which never connects still lands in the timeline —
 * a dial that vanishes because it was never answered is exactly the dial an
 * operator later wants to find.
 */
export async function POST(request: Request) {
  const parsed = startSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid call request.' }, { status: 400 });
  }

  let { contactId } = parsed.data;
  let toE164Number: string | null = null;

  if (contactId) {
    const contact = await db.contact.findUnique({ where: { id: contactId } });
    if (!contact) {
      return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
    }
    if (contact.doNotContact) {
      return NextResponse.json(
        { error: 'This lead is marked do-not-contact.' },
        { status: 403 },
      );
    }
    toE164Number = contact.phone;
  } else {
    toE164Number = toE164(parsed.data.phone);
    if (!toE164Number) {
      return NextResponse.json(
        { error: 'That is not a number we can dial.' },
        { status: 400 },
      );
    }

    // A manual dial to a number already in the CRM should attach to that
    // lead rather than creating a duplicate contact.
    const existing = await db.contact.findUnique({
      where: { phone: toE164Number },
    });

    if (existing) {
      if (existing.doNotContact) {
        return NextResponse.json(
          { error: 'That number is marked do-not-contact.' },
          { status: 403 },
        );
      }
      contactId = existing.id;
    } else {
      const created = await db.contact.create({
        data: { phone: toE164Number },
      });
      await db.activity.create({
        data: {
          contactId: created.id,
          type: 'note',
          summary: 'Created by a manual dial',
        },
      });
      contactId = created.id;
    }
  }

  const from = await pickCallerId(toE164Number);
  if (!from) {
    return NextResponse.json(
      { error: 'Buy a phone number in Settings before dialing.' },
      { status: 400 },
    );
  }

  const call = await db.call.create({
    data: {
      contactId: contactId!,
      toE164: toE164Number,
      fromE164: from.e164,
      fromNumberId: from.id,
      status: 'ringing',
    },
  });

  await db.$transaction([
    db.phoneNumber.update({
      where: { id: from.id },
      data: { dialsSent: { increment: 1 } },
    }),
    db.contact.update({
      where: { id: contactId! },
      data: { dialCount: { increment: 1 }, lastDialedAt: new Date() },
    }),
  ]);

  return NextResponse.json({
    callId: call.id,
    contactId,
    to: toE164Number,
    from: from.e164,
  });
}
