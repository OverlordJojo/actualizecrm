import { NextResponse } from 'next/server';
import { testWebhookDelivery } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/// The probe itself is capped at ten seconds and the hop to the worker sits on
/// top; the platform default would cut the request off before the answer.
export const maxDuration = 30;

/**
 * "Test webhook delivery" (§1.2).
 *
 * Asks the worker to have Telnyx originate a real leg and waits for the
 * resulting event to arrive back through the signature-verifying receiver.
 * Green means an event was received. Nothing else counts — the check this
 * replaced went green on a non-empty environment variable, which stayed
 * non-empty long after the tunnel behind it had died.
 *
 * The call is placed between the operator's own Telnyx numbers and hung up on
 * first event. It never dials a person.
 */
export async function POST() {
  const result = await testWebhookDelivery();
  return NextResponse.json(result);
}
