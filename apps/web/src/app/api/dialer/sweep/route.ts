import { NextResponse } from 'next/server';
import { sweepExpiredHolds, heldQueue } from '@/integrations/telnyx/burst';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Retires held callers who have waited past the limit.
 *
 * The dialer sweeps on every advance, which covers the operator sitting at the
 * desk. This exists for the case that actually strands people: the browser is
 * closed, crashes, or loses its network mid-burst, and somebody is left
 * listening to hold music with nothing left to hang up on them.
 *
 * Secret-authenticated rather than session-authenticated — there is no
 * operator at a browser when this matters, by definition.
 */
export async function POST(request: Request) {
  const secret = request.headers.get('x-worker-secret');
  if (!secret || secret !== process.env.WORKER_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const before = await heldQueue();
  if (before.length === 0) return NextResponse.json({ held: 0, abandoned: 0 });

  const abandoned = await sweepExpiredHolds();
  return NextResponse.json({ held: before.length, abandoned });
}
