import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runLiveExtraction } from '@/integrations/ai/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/// Two model calls on a slow day; the platform default would cut it off.
export const maxDuration = 60;

/**
 * Runs extraction against a live call's transcript so far (§5.3).
 *
 * Called by the worker when a prospect turn lands. Secret-authenticated rather
 * than session-authenticated: the transcript arrives on a webhook and there is
 * no browser anywhere in that path.
 */
const schema = z.object({
  callId: z.string().min(1),
  contactId: z.string().min(1),
});

export async function POST(request: Request) {
  const secret = request.headers.get('x-worker-secret');
  if (!secret || secret !== process.env.WORKER_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  return NextResponse.json(await runLiveExtraction(parsed.data));
}
