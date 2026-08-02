import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// The running transcript for the live pane. Polled during a call, so it is
/// deliberately a small, cheap read.
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const call = await db.call.findUnique({
    where: { id: params.id },
    select: { transcriptSegments: true, transcriptStatus: true },
  });

  if (!call) {
    return NextResponse.json({ error: 'Call not found.' }, { status: 404 });
  }

  return NextResponse.json({
    segments: Array.isArray(call.transcriptSegments) ? call.transcriptSegments : [],
    status: call.transcriptStatus,
  });
}
