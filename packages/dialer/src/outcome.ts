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

/// The reverse of OUTCOME_STAGE: the model suggests a stage, and applying it
/// needs the outcome that files a lead there.
const DISPOSITION_FOR_STAGE: Record<string, string> = {
  Callback: 'callback',
  Interested: 'interested',
  Booked: 'booked',
  'Not Interested': 'not_interested',
};

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

/**
 * Applies §3.4 when a call ends without the operator choosing an outcome.
 *
 * This was written and never wired, which is why leads stayed in the queue
 * after being called: only an explicit outcome moved anything, so hanging up
 * and moving on left the lead exactly where it was, to be dialled again next
 * session.
 *
 * Three endings, three different right answers:
 *
 *   - **Answered, then hung up with no outcome.** The operator spoke to them
 *     and moved on. That is a no, so the lead is trashed as Not Interested and
 *     leaves the board — undoable for ten seconds like every other removal.
 *
 *   - **Carrier failure.** `call_rejected`, an unallocated number, a network
 *     fault. The prospect had no part in this and destroying the lead over it
 *     would be silent data loss, so it is dispositioned Failed and stays put
 *     for a retry.
 *
 *   - **Nobody picked up.** Also not a no. The lead stays, but goes to the
 *     bottom of the column so the next session works through people who have
 *     not been tried yet before coming back round. A dialer that opens on the
 *     same twelve no-answers every morning is a dialer nobody uses twice.
 */
export async function applyAutoOutcome(params: {
  callId: string;
  wasAnswered: boolean;
  hangupCause?: string | null;
}): Promise<OutcomeResult> {
  const call = await db.call.findUnique({ where: { id: params.callId } });
  if (!call) return { applied: false, note: 'no such call' };

  // The operator decided. Nothing to infer.
  if (call.disposition) return { applied: false, note: 'already dispositioned' };

  const carrierFailure = CARRIER_FAILURE_CAUSES.has(
    (params.hangupCause ?? '').toLowerCase(),
  );

  const disposition = autoDispositionFor({
    wasAnswered: params.wasAnswered,
    carrierFailure,
  });

  if (disposition === 'not_interested') {
    /**
     * Before defaulting to a no, take the AI's read (operator instruction).
     *
     * The panel highlights what the model believes the call was, and the
     * operator confirms with one key. When they hang up without confirming —
     * which is most calls, because the next one is already ringing — that
     * highlight is still the best available reading of what happened, and
     * throwing it away to file everything as Not Interested loses real
     * callbacks.
     *
     * Only ever used when the operator chose nothing. An explicit outcome is
     * never overridden by a model, and a suggestion the operator has already
     * dismissed is not resurrected.
     */
    const suggested = await db.aiSuggestion.findFirst({
      where: {
        callId: params.callId,
        fieldType: 'stage',
        outcome: 'pending',
        confidence: { gte: 0.6 },
      },
      orderBy: { createdAt: 'desc' },
    });

    const fromAi = suggested?.value ? DISPOSITION_FOR_STAGE[suggested.value] : null;

    if (fromAi) {
      await db.aiSuggestion.update({
        where: { id: suggested!.id },
        data: { outcome: 'auto_applied', decidedAt: new Date() },
      });
      const result = await applyOutcome({ callId: params.callId, disposition: fromAi });
      return { ...result, note: `auto-applied the AI's read: ${fromAi}` };
    }

    return applyOutcome({ callId: params.callId, disposition });
  }

  // Failed and no-answer both stay in the pipeline. Record the outcome and,
  // for a no-answer, move them behind everyone untried.
  await db.call.update({
    where: { id: params.callId },
    data: { disposition },
  });
  await db.contact.update({
    where: { id: call.contactId },
    data: {
      lastDisposition: disposition,
      ...(disposition === 'no_answer'
        ? { noAnswerStreak: { increment: 1 } }
        : {}),
    },
  });

  // Rang out. Not skipped, not deleted — just no longer next, so the queue in
  // front of the operator is always people who have not been tried today.
  if (disposition === 'no_answer' || disposition === 'failed') {
    const contact = await db.contact.findUnique({
      where: { id: call.contactId },
      select: { stageId: true },
    });
    if (contact?.stageId) {
      const last = await db.contact.aggregate({
        where: { stageId: contact.stageId },
        _max: { stagePosition: true },
      });
      await db.contact.update({
        where: { id: call.contactId },
        data: { stagePosition: (last._max.stagePosition ?? 0) + 1 },
      });
    }
  }

  return { applied: true, contactId: call.contactId, note: disposition };
}

/// Hangup causes that must never cost a lead. Kept here rather than imported
/// from the app so the engine can decide without reaching across services.
const CARRIER_FAILURE_CAUSES = new Set([
  'call_rejected',
  'unallocated_number',
  'invalid_number_format',
  'network_out_of_order',
  'no_route_destination',
  'service_unavailable',
  'recovery_on_timer_expire',
  'destination_out_of_order',
]);
