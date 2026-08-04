import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applyOutcome, undoTrash } from '@actualizecrm/dialer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Records an outcome and moves the lead in one step (§3.5).
 *
 * One endpoint rather than "set the disposition, then move the card", because
 * two calls can half-fail and leave the board disagreeing with the call
 * history — and because a second step is a step the operator will forget under
 * pressure.
 */
const applySchema = z.object({
  callId: z.string().min(1),
  disposition: z.string().min(1),
});

const undoSchema = z.object({
  action: z.literal('undo'),
  contactId: z.string().min(1),
  stageId: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const undo = undoSchema.safeParse(body);
  if (undo.success) {
    await undoTrash({
      contactId: undo.data.contactId,
      stageId: undo.data.stageId ?? null,
    });
    return NextResponse.json({ ok: true });
  }

  const parsed = applySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid outcome.' }, { status: 400 });
  }

  return NextResponse.json(await applyOutcome(parsed.data));
}
