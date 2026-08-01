import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  BULK_VOICEMAIL_ACK_KIND,
  BULK_VOICEMAIL_ACK_TEXT,
  recordBulkAcknowledgement,
} from '@/integrations/audio/voicemail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Timestamped record that the operator accepted a legal exposure.
 *
 * Append-only on purpose: there is no route to delete one. The value of an
 * audit trail is entirely in not being able to tidy it up afterwards.
 */

const KNOWN_TEXT: Record<string, string> = {
  [BULK_VOICEMAIL_ACK_KIND]: BULK_VOICEMAIL_ACK_TEXT,
};

export async function GET(request: Request) {
  const kind = new URL(request.url).searchParams.get('kind');

  const rows = await db.acknowledgement.findMany({
    where: kind ? { kind } : undefined,
    orderBy: { acceptedAt: 'desc' },
    take: 50,
  });

  return NextResponse.json(rows);
}

const bodySchema = z.object({
  kind: z.enum([BULK_VOICEMAIL_ACK_KIND]),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Unknown acknowledgement.' },
      { status: 400 },
    );
  }

  const acceptedAt = await recordBulkAcknowledgement();

  return NextResponse.json({
    kind: parsed.data.kind,
    acceptedAt,
    text: KNOWN_TEXT[parsed.data.kind],
  });
}
