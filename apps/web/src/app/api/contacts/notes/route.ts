import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

const bodySchema = z.object({
  contactId: z.string().min(1),
  notes: z.string(),
});

/**
 * Autosaved notes from the Active Lead Card.
 *
 * Each save replaces the single in-progress note activity for this contact
 * rather than appending one per keystroke burst — otherwise a two-minute call
 * would litter the timeline with a dozen partial notes.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid note.' }, { status: 400 });
  }

  const { contactId, notes } = parsed.data;
  const trimmed = notes.trim();

  // The most recent call for this contact is the one being taken notes on.
  const call = await db.call.findFirst({
    where: { contactId },
    orderBy: { startedAt: 'desc' },
  });

  if (call) {
    await db.call.update({ where: { id: call.id }, data: { notes: trimmed } });
  }

  const existing = await db.activity.findFirst({
    where: { contactId, type: 'note', ...(call ? { callId: call.id } : {}) },
    orderBy: { createdAt: 'desc' },
  });

  if (!trimmed) {
    // Clearing the box removes the note rather than leaving an empty one.
    if (existing) await db.activity.delete({ where: { id: existing.id } });
    return NextResponse.json({ saved: true, cleared: true });
  }

  if (existing) {
    await db.activity.update({
      where: { id: existing.id },
      data: { body: trimmed, summary: truncate(trimmed) },
    });
  } else {
    await db.activity.create({
      data: {
        contactId,
        type: 'note',
        summary: truncate(trimmed),
        body: trimmed,
        callId: call?.id ?? null,
      },
    });
  }

  return NextResponse.json({ saved: true });
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
