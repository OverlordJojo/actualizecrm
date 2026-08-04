import { db } from '@actualizecrm/db';

/**
 * Applying an outcome (§3.5).
 *
 * An outcome is a decision about where the lead goes next, not just a label on
 * a call, so setting one moves the lead in the same operation. Splitting the
 * two — record the disposition here, move the card there — is how a board ends
 * up disagreeing with the call history, and it puts a step in front of the
 * operator that they will eventually forget under pressure.
 *
 * "Not Interested" trashes rather than files: the lead leaves every column, and
 * the contact and its whole conversation history stay searchable forever (§3.3,
 * §7.6).
 */

/// Maps an outcome to the stage it files the lead into. `null` means trash.
const OUTCOME_STAGE: Record<string, string | null> = {
  not_interested: null,
  callback: 'Callback',
  interested: 'Interested',
  booked: 'Booked',
};

export interface OutcomeResult {
  applied: boolean;
  /// Set when the lead was trashed, so the UI can offer Undo (§3.3).
  trashed?: boolean;
  movedToStageId?: string | null;
  previousStageId?: string | null;
  contactId?: string;
  note?: string;
}

export async function applyOutcome(params: {
  callId: string;
  contactId?: string;
  disposition: string;
}): Promise<OutcomeResult> {
  const call = await db.call.findUnique({ where: { id: params.callId } });
  const contactId = params.contactId ?? call?.contactId;
  if (!contactId) return { applied: false, note: 'no contact for that call' };

  const contact = await db.contact.findUnique({ where: { id: contactId } });
  if (!contact) return { applied: false, note: 'lead no longer exists' };

  const previousStageId = contact.stageId;

  await db.call.updateMany({
    where: { id: params.callId },
    data: { disposition: params.disposition },
  });

  // A machine-determined outcome records itself and moves nothing. Only the
  // four the operator can choose carry a stage.
  if (!(params.disposition in OUTCOME_STAGE)) {
    await db.contact.update({
      where: { id: contactId },
      data: { lastDisposition: params.disposition },
    });
    return { applied: true, contactId, note: 'recorded without moving the lead' };
  }

  const stageName = OUTCOME_STAGE[params.disposition];

  if (stageName === null) {
    await db.contact.update({
      where: { id: contactId },
      data: {
        lastDisposition: params.disposition,
        pipelineRemovedAt: new Date(),
        removalReason: 'not_interested',
        stageId: null,
      },
    });
    await db.activity.create({
      data: {
        contactId,
        type: 'disposition',
        direction: 'outbound',
        summary: 'Not interested — removed from the pipeline',
        callId: params.callId,
        meta: { disposition: params.disposition, previousStageId },
      },
    });
    return { applied: true, trashed: true, contactId, previousStageId };
  }

  const stage = await db.pipelineStage.findFirst({
    where: { name: stageName },
    orderBy: { position: 'asc' },
  });
  if (!stage) {
    // The stage was renamed or deleted. Record the outcome rather than losing
    // it; the operator can move the card by hand.
    await db.contact.update({
      where: { id: contactId },
      data: { lastDisposition: params.disposition },
    });
    return {
      applied: true,
      contactId,
      note: `no stage named "${stageName}" — outcome recorded, lead not moved`,
    };
  }

  // Top of the column: a lead that just got a positive outcome is the one most
  // worth seeing first.
  await db.contact.updateMany({
    where: { stageId: stage.id },
    data: { stagePosition: { increment: 1 } },
  });

  await db.contact.update({
    where: { id: contactId },
    data: {
      lastDisposition: params.disposition,
      stageId: stage.id,
      stagePosition: 0,
      pipelineRemovedAt: null,
      removalReason: null,
    },
  });

  await db.activity.create({
    data: {
      contactId,
      type: 'disposition',
      direction: 'outbound',
      summary: `Moved to ${stage.name}`,
      callId: params.callId,
      meta: { disposition: params.disposition, previousStageId, stageId: stage.id },
    },
  });

  return { applied: true, movedToStageId: stage.id, contactId, previousStageId };
}

/**
 * Puts a trashed lead back (§3.3's Undo).
 *
 * Restores the stage it came from rather than dropping it in New, because the
 * ten-second window exists for misclicks and a misclick should cost nothing.
 */
export async function undoTrash(params: {
  contactId: string;
  stageId?: string | null;
}): Promise<void> {
  const stageId =
    params.stageId ??
    (await db.pipelineStage.findFirst({ where: { name: 'New' }, orderBy: { position: 'asc' } }))
      ?.id ??
    null;

  await db.contact.update({
    where: { id: params.contactId },
    data: {
      pipelineRemovedAt: null,
      removalReason: null,
      stageId,
      stagePosition: 0,
    },
  });

  await db.activity.create({
    data: {
      contactId: params.contactId,
      type: 'disposition',
      direction: 'outbound',
      summary: 'Removal undone — lead restored to the pipeline',
      meta: { stageId },
    },
  });
}

/**
 * The outcome for a call that ended without the operator choosing one (§3.4).
 *
 * A normal hangup means they finished and moved on, so the lead is trashed as
 * Not Interested. A carrier failure means the call never happened — that must
 * never destroy a lead, so it is dispositioned `failed` and left where it is
 * for a retry. Getting this backwards silently deletes leads for reasons the
 * prospect had no part in.
 */
export function autoDispositionFor(params: {
  wasAnswered: boolean;
  carrierFailure: boolean;
}): 'not_interested' | 'failed' | 'no_answer' {
  if (params.carrierFailure) return 'failed';
  if (!params.wasAnswered) return 'no_answer';
  return 'not_interested';
}
