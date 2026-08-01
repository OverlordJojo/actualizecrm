import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { fireTrigger } from '@/integrations/automations/triggers';

export const runtime = 'nodejs';

const bodySchema = z.object({
  contactId: z.string().min(1),
  /// null drops the lead back to unassigned.
  stageId: z.string().min(1).nullable(),
  /// Index within the destination column, for manual ordering.
  position: z.number().int().min(0).optional(),
});

/**
 * Moves a lead to a pipeline stage.
 *
 * Writes a stage_change activity so the move shows up on the contact timeline
 * and in Conversations, and fires the stage_changed automation trigger.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid move.' }, { status: 400 });
  }

  const { contactId, stageId, position } = parsed.data;

  const contact = await db.contact.findUnique({
    where: { id: contactId },
    include: { stage: true },
  });
  if (!contact) {
    return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
  }

  const toStage = stageId
    ? await db.pipelineStage.findUnique({ where: { id: stageId } })
    : null;

  if (stageId && !toStage) {
    return NextResponse.json({ error: 'Stage not found.' }, { status: 404 });
  }

  const fromName = contact.stage?.name ?? 'Unassigned';
  const toName = toStage?.name ?? 'Unassigned';
  const unchanged = contact.stageId === stageId;

  const updated = await db.contact.update({
    where: { id: contactId },
    data: {
      stageId,
      stagePosition: position ?? 0,
    },
  });

  // Reordering within the same column is not a stage change and should not
  // clutter the timeline with noise.
  if (!unchanged) {
    await db.activity.create({
      data: {
        contactId,
        type: 'stage_change',
        summary: `Moved from ${fromName} to ${toName}`,
        meta: {
          fromStageId: contact.stageId,
          toStageId: stageId,
          fromName,
          toName,
        },
      },
    });

    if (stageId) {
      await fireTrigger('stage_changed', {
        contactId,
        stageId,
        stageName: toName,
      });
    }
  }

  return NextResponse.json(updated);
}
