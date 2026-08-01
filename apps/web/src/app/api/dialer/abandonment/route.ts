import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  abandonmentState,
  setLinesPerBurst,
  MAX_LINES_PER_BURST,
} from '@/integrations/telnyx/governor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Live governor state for the dialer's session stats bar and Settings.
export async function GET(request: Request) {
  const state = await abandonmentState();

  // §4.4 requires the abandoned-call log to be exportable.
  if (new URL(request.url).searchParams.get('export') === 'csv') {
    const rows = await db.call.findMany({
      where: { status: 'abandoned' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, toE164: true, fromE164: true, heldSeconds: true, burstId: true },
    });

    const csv = [
      'timestamp,number_dialed,called_from,hold_seconds,burst_id',
      ...rows.map((r) =>
        [
          r.startedAt.toISOString(),
          r.toE164,
          r.fromE164 ?? '',
          r.heldSeconds,
          r.burstId ?? '',
        ].join(','),
      ),
    ].join('\n');

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="abandoned-calls.csv"',
      },
    });
  }

  return NextResponse.json({ ...state, maxLines: MAX_LINES_PER_BURST });
}

const patchSchema = z.object({ linesPerBurst: z.number().int().min(1).max(MAX_LINES_PER_BURST) });

/// The operator sets a preference; the governor still clamps it at dial time.
export async function PATCH(request: Request) {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Lines per burst must be between 1 and ${MAX_LINES_PER_BURST}.` },
      { status: 400 },
    );
  }
  const saved = await setLinesPerBurst(parsed.data.linesPerBurst);
  return NextResponse.json(await abandonmentState().then((s) => ({ ...s, saved })));
}
