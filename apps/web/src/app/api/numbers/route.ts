import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  orderNumber,
  listOwnedNumbers,
  assignNumberToConnection,
  areaCodeOfE164,
  TelnyxError,
} from '@/integrations/telnyx/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Numbers this instance owns, with the local dial counts.
export async function GET() {
  const numbers = await db.phoneNumber.findMany({
    orderBy: { purchasedAt: 'desc' },
  });
  return NextResponse.json(numbers);
}

const buySchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Not a valid number.'),
  locality: z.string().optional(),
  region: z.string().optional(),
  monthlyCost: z.number().optional(),
});

/**
 * Buys a number. **This spends money.**
 *
 * The UI confirms with the operator before calling this; there is no
 * additional guard here, because a purchase the operator explicitly clicked
 * should not then be second-guessed by a dialog they cannot dismiss.
 */
export async function POST(request: Request) {
  const parsed = buySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid number.' },
      { status: 400 },
    );
  }

  const { phoneNumber, locality, region, monthlyCost } = parsed.data;
  const connectionId = process.env.TELNYX_CONNECTION_ID;

  try {
    await orderNumber(phoneNumber, connectionId);

    // The order is async on Telnyx's side; re-read the owned list to get the
    // real number id rather than trusting the order payload.
    const owned = await listOwnedNumbers();
    const match = owned.find((n) => n.phone_number === phoneNumber);

    // Make sure call events for this number reach our webhook.
    if (match && connectionId && match.connection_id !== connectionId) {
      await assignNumberToConnection(match.id, connectionId).catch(() => {
        // Non-fatal: the number is bought either way, and Settings shows the
        // connection state so the operator can fix it.
      });
    }

    const saved = await db.phoneNumber.upsert({
      where: { e164: phoneNumber },
      create: {
        e164: phoneNumber,
        telnyxId: match?.id,
        locality: locality ?? null,
        region: region ?? null,
        areaCode: areaCodeOfE164(phoneNumber) ?? null,
        monthlyCost: monthlyCost ?? null,
      },
      update: { telnyxId: match?.id, active: true },
    });

    return NextResponse.json(saved, { status: 201 });
  } catch (err) {
    if (err instanceof TelnyxError) {
      // The most common real-world failure is an unfunded account, and
      // Telnyx's own wording for it is not obvious.
      const hint = /balance|fund|credit|payment/i.test(err.message)
        ? ' Add funds to your Telnyx account under Billing, then try again.'
        : '';
      return NextResponse.json(
        { error: err.message + hint },
        { status: err.status },
      );
    }
    return NextResponse.json({ error: 'Could not buy that number.' }, { status: 500 });
  }
}
