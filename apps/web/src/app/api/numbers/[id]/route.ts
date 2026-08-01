import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { releaseNumber, TelnyxError } from '@/integrations/telnyx/client';

export const runtime = 'nodejs';

/// Releases a number back to Telnyx and stops the monthly charge.
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const number = await db.phoneNumber.findUnique({ where: { id: params.id } });
  if (!number) {
    return NextResponse.json({ error: 'Number not found.' }, { status: 404 });
  }

  try {
    if (number.telnyxId) await releaseNumber(number.telnyxId);
  } catch (err) {
    if (err instanceof TelnyxError && err.status !== 404) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // A 404 from Telnyx means it is already gone; fall through and clean up
    // our own row so the two stay in sync.
  }

  // Calls reference the number, so keep the row for history and just mark it
  // inactive rather than deleting call records along with it.
  const updated = await db.phoneNumber.update({
    where: { id: params.id },
    data: { active: false },
  });

  return NextResponse.json({ released: true, number: updated });
}

const patchSchema = z.object({
  routeInboundToBrowser: z.boolean(),
});

/// Per-number inbound routing (add-on A). Switching it off does not stop the
/// call being logged or a missed-call task being created — it only stops the
/// browser ringing, which is what an operator means by "don't route this one
/// to me".
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid update.' }, { status: 400 });
  }

  const updated = await db.phoneNumber.update({
    where: { id: params.id },
    data: { routeInboundToBrowser: parsed.data.routeInboundToBrowser },
  });

  return NextResponse.json(updated);
}
