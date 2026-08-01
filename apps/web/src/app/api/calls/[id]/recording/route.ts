import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import * as r2 from '@/integrations/storage/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A presigned URL for playing a call recording back in the slide-over.
 *
 * Minted per request rather than stored: the bucket holds recordings of real
 * conversations and is deliberately not public, so the only way to hear one is
 * a short-lived URL issued now.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const call = await db.call.findUnique({
    where: { id: params.id },
    select: { recordingPath: true },
  });

  if (!call?.recordingPath) {
    return NextResponse.json(
      { error: 'No recording was saved for that call.' },
      { status: 404 },
    );
  }

  if (!r2.isConfigured()) {
    return NextResponse.json(
      { error: 'Object storage is not configured.' },
      { status: 503 },
    );
  }

  try {
    return NextResponse.json({ url: await r2.signedUrl(call.recordingPath, 3600) });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach storage: ${String(err).slice(0, 200)}` },
      { status: 502 },
    );
  }
}
