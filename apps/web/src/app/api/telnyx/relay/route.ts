import { NextResponse } from 'next/server';
import { handleTelnyxEvent } from '@/integrations/telnyx/handle-event';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Call events the worker cannot finish on its own (§1.2).
 *
 * Telnyx no longer posts here. It posts to the worker, which verifies the
 * signature, deduplicates on the event id and processes off a queue — then
 * hands over the events that need R2 presigning or the extraction pipeline,
 * because those credentials live in the app.
 *
 * Secret-authenticated rather than session-authenticated: there is no operator
 * at a browser when a call event arrives, by definition. Unlike the endpoint
 * this replaces, it is **not** reachable by an unauthenticated caller.
 *
 * Errors return 5xx on purpose. The worker retries, and a failure that reports
 * success is a call record silently lost.
 */
export async function POST(request: Request) {
  const secret = request.headers.get('x-worker-secret');
  if (!secret || secret !== process.env.WORKER_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Malformed input will be malformed on the retry too, so take it rather
    // than making the worker try three times to find that out.
    return NextResponse.json({ handled: false, note: 'unparseable body' });
  }

  try {
    const result = await handleTelnyxEvent(body as never);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
