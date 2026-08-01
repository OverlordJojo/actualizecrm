import { NextResponse } from 'next/server';
import { z } from 'zod';
import { abandonmentState } from '@/integrations/telnyx/governor';
import {
  startBurst,
  bridgeOldestHeld,
  heldQueue,
  sweepExpiredHolds,
} from '@/integrations/telnyx/burst';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const burstSchema = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(3),
});

/**
 * Advances the multi-line dialer (§4.3).
 *
 * Draining the held queue takes priority over starting anything new: someone
 * already listening to hold music has a stronger claim on the operator than a
 * lead who has not been dialled yet, and it is what keeps the abandonment rate
 * under the cap. Only when nobody is held does this open a fresh burst.
 */
export async function POST(request: Request) {
  const parsed = burstSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid burst request.' }, { status: 400 });
  }

  // Retire anyone who has waited too long before deciding what to do next, so
  // a stale hold is never bridged to a prospect who has given up.
  await sweepExpiredHolds().catch(() => 0);

  const governor = await abandonmentState();

  const held = await heldQueue();
  if (held.length > 0) {
    const bridged = await bridgeOldestHeld();
    if (bridged) {
      return NextResponse.json({
        mode: 'bridged_held',
        bridged,
        remainingHeld: held.length - 1,
        governor,
      });
    }
  }

  try {
    const burst = await startBurst(parsed.data.contactIds, request);
    return NextResponse.json({ mode: 'burst', ...burst, governor });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not open the burst.' },
      { status: 502 },
    );
  }
}

/// Polled by the dialer while a burst is live: who is held, who won, and
/// whether the governor has clamped anything since the burst opened.
export async function GET() {
  await sweepExpiredHolds().catch(() => 0);
  const [held, governor] = await Promise.all([heldQueue(), abandonmentState()]);
  return NextResponse.json({ held, governor });
}
