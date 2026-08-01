import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { fireTrigger } from '@/integrations/automations/triggers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// How far back the slide-over timeline goes in one load. Deep history is
/// reachable through Conversations search; the slide-over is for context on the
/// lead in front of you.
const TIMELINE_LIMIT = 200;

/**
 * Everything the contact slide-over renders.
 *
 * Calls come back separately from activities even though a call also writes an
 * activity row, because the transcript, recording and duration live on the Call
 * and the feed row only carries a summary. The slide-over keys them by id so a
 * transcript renders under its own call entry.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const contact = await db.contact.findUnique({
    where: { id: params.id },
    include: {
      stage: { select: { id: true, name: true, color: true, pipelineId: true } },
      list: { select: { id: true, name: true } },
      tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
    },
  });

  if (!contact) {
    return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
  }

  const [activities, calls, bookings, suggestions] = await Promise.all([
    db.activity.findMany({
      where: { contactId: contact.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: TIMELINE_LIMIT,
    }),
    db.call.findMany({
      where: { contactId: contact.id },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        durationSec: true,
        direction: true,
        disposition: true,
        status: true,
        fromE164: true,
        toE164: true,
        notes: true,
        amdResult: true,
        voicemailDropped: true,
        transcript: true,
        transcriptStatus: true,
        recordingPath: true,
      },
    }),
    db.booking.findMany({
      where: { contactId: contact.id },
      orderBy: { startsAt: 'desc' },
    }),
    db.aiSuggestion.findMany({
      where: { contactId: contact.id, outcome: 'pending' },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return NextResponse.json({
    contact: { ...contact, tags: contact.tags.map((t) => t.tag) },
    activities,
    calls,
    bookings,
    suggestions,
  });
}

const patchSchema = z.object({
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  phone: z.string().min(1).optional(),
  email: z.string().max(200).nullable().optional(),
  companyName: z.string().max(200).nullable().optional(),
  companyLocation: z.string().max(200).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  dealValue: z.number().nullable().optional(),
  stageId: z.string().nullable().optional(),
  doNotContact: z.boolean().optional(),
  notes: z.string().optional(),
});

/**
 * Inline edits from the slide-over and the Active Lead Card.
 *
 * Writes exactly the fields it was given. A missing key means "leave it alone",
 * which matters because two surfaces edit the same contact concurrently — the
 * dialer card and an open slide-over — and a full-object PUT would let the
 * staler of the two silently revert the other.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid update.' }, { status: 400 });
  }

  const existing = await db.contact.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
  }

  const { notes, phone, stageId, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };

  // Empty strings from a cleared input mean "no value", not the empty string.
  for (const key of ['firstName', 'lastName', 'email', 'companyName', 'companyLocation', 'address']) {
    if (data[key] === '') data[key] = null;
  }

  if (phone !== undefined) {
    const e164 = toE164(phone);
    if (!e164) {
      return NextResponse.json(
        { error: 'That is not a number we can dial.' },
        { status: 400 },
      );
    }
    if (e164 !== existing.phone) {
      const clash = await db.contact.findUnique({ where: { phone: e164 } });
      if (clash) {
        return NextResponse.json(
          { error: 'Another lead already has that number.' },
          { status: 409 },
        );
      }
      data.phone = e164;
    }
  }

  if (stageId !== undefined) {
    data.stageId = stageId;
    // Moving a removed lead into a stage is a restore; leaving the removal
    // timestamp set would have the retention sweep delete a lead that is
    // visibly back on the board.
    if (stageId && existing.pipelineRemovedAt) {
      data.pipelineRemovedAt = null;
      data.removalReason = null;
    }
  }

  const updated = await db.contact.update({ where: { id: params.id }, data });

  if (stageId !== undefined && stageId !== existing.stageId) {
    const stage = stageId
      ? await db.pipelineStage.findUnique({ where: { id: stageId } })
      : null;
    await db.activity.create({
      data: {
        contactId: params.id,
        type: 'stage_change',
        summary: stage ? `Moved to ${stage.name}` : 'Removed from the board',
        meta: { toStage: stage?.name ?? null, source: 'slide_over' },
      },
    });

    if (stage) {
      await fireTrigger('stage_changed', {
        contactId: params.id,
        stageId: stage.id,
        stageName: stage.name,
      });
    }
  }

  // A note typed in the slide-over is its own timeline entry rather than a
  // field on the contact — notes accumulate, they do not overwrite.
  if (notes && notes.trim()) {
    await db.activity.create({
      data: {
        contactId: params.id,
        type: 'note',
        summary: 'Note added',
        body: notes.trim(),
      },
    });
  }

  return NextResponse.json(updated);
}
