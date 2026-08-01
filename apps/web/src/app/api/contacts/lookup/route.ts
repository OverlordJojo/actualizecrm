import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toE164 } from '@/lib/phone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ phone: z.string().min(1) });

/**
 * Finds the lead behind a ringing inbound call, creating one if the number is
 * unknown (add-on A).
 *
 * Creating on the fly rather than showing "unknown caller" is the whole point:
 * the operator answers a callback from a number they dialled last week and the
 * card is already on screen. A stranger becomes a lead marked `inbound`, which
 * is also how the analytics tell bought-list leads from inbound interest.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Pass a phone number.' }, { status: 400 });
  }

  const e164 = toE164(parsed.data.phone);
  if (!e164) {
    return NextResponse.json(
      { error: 'That caller ID is not a number we can match.' },
      { status: 400 },
    );
  }

  const existing = await db.contact.findUnique({
    where: { phone: e164 },
    include: { stage: { select: { id: true, name: true } } },
  });
  if (existing) return NextResponse.json({ contact: existing, created: false });

  const created = await db.contact.create({
    data: { phone: e164, source: 'inbound' },
    include: { stage: { select: { id: true, name: true } } },
  });

  await db.activity.create({
    data: {
      contactId: created.id,
      type: 'note',
      direction: 'inbound',
      summary: 'Created by an inbound call',
      meta: { source: 'inbound' },
    },
  });

  return NextResponse.json({ contact: created, created: true });
}
