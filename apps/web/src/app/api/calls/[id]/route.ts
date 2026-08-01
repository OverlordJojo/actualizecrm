import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { DISPOSITION_BY_VALUE, isDisposition } from '@/lib/dispositions';
import { formatPhone } from '@/lib/phone';
import { fireTrigger } from '@/integrations/automations/triggers';

export const runtime = 'nodejs';

const patchSchema = z.object({
  /// Reported by the browser's WebRTC SDK as the call progresses.
  status: z.enum(['ringing', 'answered', 'completed', 'failed', 'busy', 'no_answer']).optional(),
  disposition: z.string().optional(),
  notes: z.string().optional(),
  callControlId: z.string().optional(),
  durationSec: z.number().int().min(0).optional(),
});

/// Updates a call in flight or on completion, and mirrors the outcome onto the
/// contact so the pipeline card and stats stay current.
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid update.' }, { status: 400 });
  }

  const call = await db.call.findUnique({ where: { id: params.id } });
  if (!call) {
    return NextResponse.json({ error: 'Call not found.' }, { status: 404 });
  }

  const { status, disposition, notes, callControlId, durationSec } = parsed.data;
  const data: Record<string, unknown> = {};

  if (callControlId) data.callControlId = callControlId;
  if (notes !== undefined) data.notes = notes;
  if (durationSec !== undefined) data.durationSec = durationSec;

  if (status) {
    data.status = status;
    if (status === 'answered' && !call.answeredAt) {
      data.answeredAt = new Date();
    }
    if (['completed', 'failed', 'busy', 'no_answer'].includes(status) && !call.endedAt) {
      data.endedAt = new Date();
    }
  }

  if (disposition) {
    if (!isDisposition(disposition)) {
      return NextResponse.json({ error: 'Unknown disposition.' }, { status: 400 });
    }
    data.disposition = disposition;
  }

  const updated = await db.call.update({ where: { id: params.id }, data });

  // --- mirror onto the contact --------------------------------------------
  if (status === 'answered') {
    await db.contact.update({
      where: { id: call.contactId },
      data: {
        connectCount: { increment: 1 },
        everConnected: true,
        noAnswerStreak: 0,
      },
    });
  }

  if (disposition && isDisposition(disposition)) {
    const meta = DISPOSITION_BY_VALUE[disposition];

    const contactAfter = await db.contact.update({
      where: { id: call.contactId },
      data: {
        lastDisposition: disposition,
        // The "no answer N times" automation trigger reads this streak, so it
        // only advances on an actual no-answer and resets on anything else.
        noAnswerStreak:
          disposition === 'no_answer' ? { increment: 1 } : { set: 0 },
      },
    });

    // §1.3 — Not Interested is a removal, not a stage. The lead leaves the
    // board and every dial queue, but keeps its history.
    if (disposition === 'not_interested') {
      const contact = await db.contact.findUnique({
        where: { id: call.contactId },
        include: { stage: true },
      });

      await db.contact.update({
        where: { id: call.contactId },
        data: {
          stageId: null,
          pipelineRemovedAt: new Date(),
          removalReason: 'not_interested',
          doNotContact: true,
        },
      });

      await db.activity.create({
        data: {
          contactId: call.contactId,
          type: 'stage_change',
          summary: 'Removed from pipeline — not interested',
          callId: call.id,
          meta: { fromStage: contact?.stage?.name ?? null, reason: 'not_interested' },
        },
      });
    }

    await db.activity.create({
      data: {
        contactId: call.contactId,
        type: 'disposition',
        direction: 'outbound',
        summary: `Marked ${meta.label}`,
        body: notes || null,
        callId: call.id,
        meta: { disposition, durationSec: updated.durationSec },
      },
    });

    await fireTrigger('disposition_set', {
      contactId: call.contactId,
      disposition,
    });

    if (disposition === 'no_answer') {
      await fireTrigger('no_answer_n_times', {
        contactId: call.contactId,
        noAnswerStreak: contactAfter.noAnswerStreak,
      });
    }
  }

  return NextResponse.json(updated);
}

/// Writes the call summary line into the timeline once the call is over.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const call = await db.call.findUnique({
    where: { id: params.id },
    include: { contact: true },
  });
  if (!call) {
    return NextResponse.json({ error: 'Call not found.' }, { status: 404 });
  }

  const mins = Math.floor(call.durationSec / 60);
  const secs = call.durationSec % 60;
  const duration = call.durationSec > 0 ? ` · ${mins}m ${secs}s` : '';

  await db.activity.create({
    data: {
      contactId: call.contactId,
      type: 'call',
      direction: 'outbound',
      summary: `Dialed ${formatPhone(call.toE164)}${duration}`,
      body: call.notes,
      callId: call.id,
      meta: {
        durationSec: call.durationSec,
        disposition: call.disposition,
        fromE164: call.fromE164,
        status: call.status,
      },
    },
  });

  await fireTrigger('call_completed', { contactId: call.contactId });

  return NextResponse.json({ logged: true });
}
