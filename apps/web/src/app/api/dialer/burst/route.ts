import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { allowedLinesNow, abandonmentState } from '@/integrations/telnyx/governor';
import { pickCallerId } from '@/integrations/telnyx/caller-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Opens a multi-line burst (§4.3).
 *
 * Returns the leads and the caller ID to use for each, one per line, each from
 * a **different** owned number. The browser originates the first leg over
 * WebRTC and the server originates the rest through Call Control with premium
 * AMD, so the operator's audio path is the one the SDK already owns.
 *
 * The governor is consulted here, immediately before originating, and never
 * cached — the whole point is that the rate reacts inside the session causing
 * it. If it says one line, this returns one lead however many were asked for.
 */

const burstSchema = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(3),
});

export async function POST(request: Request) {
  const parsed = burstSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid burst request.' }, { status: 400 });
  }

  const state = await abandonmentState();
  const allowed = await allowedLinesNow();

  // Drain held callers before starting anything new (§4.4): somebody already
  // waiting on hold has a stronger claim on the operator than a fresh dial.
  const held = await db.call.findMany({
    where: { status: 'held' },
    orderBy: { startedAt: 'asc' },
    take: 1,
    include: { contact: true },
  });

  if (held.length > 0) {
    return NextResponse.json({
      bridgeHeld: {
        callId: held[0].id,
        contactId: held[0].contactId,
        heldSince: held[0].startedAt,
      },
      governor: state,
      legs: [],
    });
  }

  const wanted = parsed.data.contactIds.slice(0, allowed);
  const legs: {
    contactId: string;
    callId: string;
    to: string;
    from: string;
    primary: boolean;
  }[] = [];

  const burstId = crypto.randomUUID();
  const usedNumbers = new Set<string>();

  for (let index = 0; index < wanted.length; index++) {
    const contactId = wanted[index];
    const contact = await db.contact.findUnique({ where: { id: contactId } });
    if (!contact || contact.doNotContact) continue;

    // Each leg from a different owned number. Two simultaneous calls from one
    // number is the single most obvious pattern for carrier analytics to catch.
    let from = await pickCallerId(contact.phone);
    if (from && usedNumbers.has(from.id)) {
      const alternative = await db.phoneNumber.findFirst({
        where: { active: true, id: { notIn: Array.from(usedNumbers) } },
        orderBy: { dialsSent: 'asc' },
      });
      from = alternative ? { id: alternative.id, e164: alternative.e164 } : null;
    }
    if (!from) continue;
    usedNumbers.add(from.id);

    const call = await db.call.create({
      data: {
        contactId: contact.id,
        toE164: contact.phone,
        fromE164: from.e164,
        fromNumberId: from.id,
        status: 'ringing',
        burstId,
      },
    });

    await db.$transaction([
      db.phoneNumber.update({ where: { id: from.id }, data: { dialsSent: { increment: 1 } } }),
      db.contact.update({
        where: { id: contact.id },
        data: { dialCount: { increment: 1 }, lastDialedAt: new Date() },
      }),
    ]);

    legs.push({
      contactId: contact.id,
      callId: call.id,
      to: contact.phone,
      from: from.e164,
      // The first leg is the operator's own WebRTC call; the rest are
      // originated server-side and bridged only if a human answers.
      primary: index === 0,
    });
  }

  if (legs.length === 0) {
    return NextResponse.json(
      { error: 'No dialable leads, or no free numbers to dial from.' },
      { status: 400 },
    );
  }

  return NextResponse.json({ burstId, legs, governor: state, bridgeHeld: null });
}
