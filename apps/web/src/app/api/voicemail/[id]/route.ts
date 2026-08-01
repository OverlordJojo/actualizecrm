import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  deleteRecording,
  setDefaultRecording,
  playbackUrl,
} from '@/integrations/audio/voicemail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// A presigned URL so the operator can listen to a recording before making it
/// the default. Short-lived; the browser uses it immediately.
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const rec = await db.voicemailRecording.findUnique({
    where: { id: params.id },
  });
  if (!rec) {
    return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
  }

  try {
    return NextResponse.json({ url: await playbackUrl(rec) });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach storage: ${String(err).slice(0, 200)}` },
      { status: 502 },
    );
  }
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  isDefault: z.literal(true).optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid update.' }, { status: 400 });
  }

  const exists = await db.voicemailRecording.findUnique({
    where: { id: params.id },
  });
  if (!exists) {
    return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
  }

  if (parsed.data.name) {
    await db.voicemailRecording.update({
      where: { id: params.id },
      data: { name: parsed.data.name },
    });
  }

  // Only ever set, never unset: clearing the default from here would leave the
  // library with recordings but no drop target.
  if (parsed.data.isDefault) await setDefaultRecording(params.id);

  return NextResponse.json(
    await db.voicemailRecording.findUnique({ where: { id: params.id } }),
  );
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  await deleteRecording(params.id);
  return NextResponse.json({ deleted: true });
}
