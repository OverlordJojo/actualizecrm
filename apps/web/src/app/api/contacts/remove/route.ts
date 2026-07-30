import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

const removeSchema = z.object({
  contactId: z.string().min(1),
  /// "not_interested" | "wrong_number" | "dnc" | "manual"
  reason: z.string().default('not_interested'),
});

/**
 * Removes a lead from the pipeline (§1.3).
 *
 * "Not Interested" is an action, not a stage. The lead disappears from every
 * kanban column and from every dial queue, but the row is **not** deleted —
 * the contact and its full conversation history stay queryable and searchable
 * on the Conversations page under the Removed filter.
 *
 * `pipelineRemovedAt` also starts the retention clock (§1.4). It is set here
 * rather than derived from record age, so a lead that sat in Booked for a year
 * keeps that year of history for another 7 days instead of losing it the
 * instant it is removed.
 */
export async function POST(request: Request) {
  const parsed = removeSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid removal.' }, { status: 400 });
  }

  const { contactId, reason } = parsed.data;

  const contact = await db.contact.findUnique({
    where: { id: contactId },
    include: { stage: true },
  });
  if (!contact) {
    return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
  }

  const fromStage = contact.stage?.name ?? 'no stage';

  const updated = await db.contact.update({
    where: { id: contactId },
    data: {
      stageId: null,
      pipelineRemovedAt: new Date(),
      removalReason: reason,
      // Marking do-not-contact for an explicit rejection is the honest
      // reading of "not interested" and keeps them out of future imports'
      // dial queues too.
      doNotContact: reason === 'not_interested' || reason === 'dnc',
    },
  });

  await db.activity.create({
    data: {
      contactId,
      type: 'stage_change',
      summary:
        reason === 'not_interested'
          ? 'Removed from pipeline — not interested'
          : `Removed from pipeline — ${reason.replace(/_/g, ' ')}`,
      meta: { fromStage, reason },
    },
  });

  return NextResponse.json(updated);
}

const restoreSchema = z.object({
  contactId: z.string().min(1),
  stageId: z.string().min(1),
});

/// Puts a removed lead back on the board, from the Conversations Removed view.
export async function PUT(request: Request) {
  const parsed = restoreSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid restore.' }, { status: 400 });
  }

  const { contactId, stageId } = parsed.data;

  const stage = await db.pipelineStage.findUnique({ where: { id: stageId } });
  if (!stage) {
    return NextResponse.json({ error: 'Stage not found.' }, { status: 404 });
  }

  const updated = await db.contact.update({
    where: { id: contactId },
    data: {
      stageId,
      pipelineRemovedAt: null,
      removalReason: null,
      doNotContact: false,
    },
  });

  await db.activity.create({
    data: {
      contactId,
      type: 'stage_change',
      summary: `Restored to pipeline in ${stage.name}`,
      meta: { toStage: stage.name },
    },
  });

  return NextResponse.json(updated);
}
