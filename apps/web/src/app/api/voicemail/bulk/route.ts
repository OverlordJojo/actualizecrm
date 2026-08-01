import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@actualizecrm/db';
import { db } from '@/lib/db';
import { getSetting, asNumber } from '@/lib/settings';
import {
  resolveRecording,
  hasBulkAcknowledgement,
  BULK_VOICEMAIL_ACK_TEXT,
} from '@/integrations/audio/voicemail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bulk voicemail drop.
 *
 * Queues one `voicemail.drop` job per lead. The worker originates each call so
 * the batch keeps running with the laptop shut, which is the whole point of a
 * queued drop rather than an in-session one.
 *
 * Two things are deliberately not negotiable here:
 *
 *  - A do-not-contact lead is never queued, and the worker re-checks the flag
 *    at send time in case it was set after queueing.
 *  - If the batch touches any lead that has never been called, the TCPA
 *    acknowledgement must already be on file. The route returns 403 with the
 *    wording to display; it does not accept "acknowledge and send" in one
 *    request, because that turns a deliberate one-time decision into a checkbox
 *    on the way to sending.
 */

const SEGMENTS = ['list', 'stage', 'never_called', 'already_called'] as const;
type Segment = (typeof SEGMENTS)[number];

function whereFor(segment: Segment, id?: string): Prisma.ContactWhereInput {
  // Do-not-contact is excluded from every segment, not filtered in the UI.
  const base: Prisma.ContactWhereInput = { doNotContact: false };

  switch (segment) {
    case 'list':
      return { ...base, listId: id };
    case 'stage':
      return { ...base, stageId: id };
    case 'never_called':
      return { ...base, dialCount: 0 };
    case 'already_called':
      return { ...base, dialCount: { gt: 0 } };
  }
}

/// Segment sizes for the picker, so the operator sees what they are about to
/// queue before they queue it.
export async function GET() {
  const [lists, stages, neverCalled, alreadyCalled, ackAt] = await Promise.all([
    db.leadList.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        _count: { select: { contacts: true } },
      },
    }),
    db.pipelineStage.findMany({
      orderBy: { position: 'asc' },
      select: {
        id: true,
        name: true,
        _count: { select: { contacts: true } },
      },
    }),
    db.contact.count({ where: whereFor('never_called') }),
    db.contact.count({ where: whereFor('already_called') }),
    hasBulkAcknowledgement(),
  ]);

  return NextResponse.json({
    lists: lists.map((l) => ({ id: l.id, name: l.name, count: l._count.contacts })),
    stages: stages.map((s) => ({ id: s.id, name: s.name, count: s._count.contacts })),
    neverCalled,
    alreadyCalled,
    acknowledgedAt: ackAt,
    acknowledgementText: BULK_VOICEMAIL_ACK_TEXT,
  });
}

const queueSchema = z.object({
  segment: z.enum(SEGMENTS),
  /// Required for the list and stage segments.
  segmentId: z.string().optional(),
  recordingId: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = queueSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid bulk request.' }, { status: 400 });
  }

  const { segment, segmentId, recordingId } = parsed.data;

  if ((segment === 'list' || segment === 'stage') && !segmentId) {
    return NextResponse.json(
      { error: 'Pick which list or stage to drop to.' },
      { status: 400 },
    );
  }

  const recording = await resolveRecording(recordingId);
  if (!recording) {
    return NextResponse.json(
      {
        error:
          'No voicemail recording uploaded yet. Add one in Settings → Voicemail.',
      },
      { status: 400 },
    );
  }

  const where = whereFor(segment, segmentId);
  const contacts = await db.contact.findMany({
    where,
    select: { id: true, dialCount: true },
  });

  if (contacts.length === 0) {
    return NextResponse.json(
      { error: 'That segment has no leads we are allowed to dial.' },
      { status: 400 },
    );
  }

  const neverCalled = contacts.filter((c) => c.dialCount === 0);

  if (neverCalled.length > 0) {
    const ackAt = await hasBulkAcknowledgement();
    if (!ackAt) {
      return NextResponse.json(
        {
          error: 'This batch includes leads that have never been called.',
          requiresAcknowledgement: true,
          neverCalledCount: neverCalled.length,
          acknowledgementText: BULK_VOICEMAIL_ACK_TEXT,
        },
        { status: 403 },
      );
    }
  }

  // Spread the batch out rather than originating hundreds of calls at once.
  // Carrier analytics flag exactly that shape, and a queue that drains in one
  // burst is also a queue the operator cannot stop part-way.
  const spacing = Math.max(
    asNumber(await getSetting('voicemail.bulkSpacingSeconds'), 30),
    5,
  );

  const now = Date.now();
  // Day-scoped key: submitting the same segment twice in one day is a no-op
  // rather than two voicemails on the same prospect's phone.
  const day = new Date().toISOString().slice(0, 10);

  const created = await db.scheduledJob.createMany({
    data: contacts.map((c, i) => ({
      type: 'voicemail.drop',
      jobKey: `vmdrop:${day}:${c.id}`,
      payload: { contactId: c.id, recordingId: recording.id },
      runAt: new Date(now + i * spacing * 1000),
    })),
    skipDuplicates: true,
  });

  const skipped = contacts.length - created.count;

  return NextResponse.json({
    queued: created.count,
    skippedAlreadyQueuedToday: skipped,
    neverCalledCount: neverCalled.length,
    recordingName: recording.name,
    spacingSeconds: spacing,
    // Rough, but the operator's real question is "when is this done".
    finishesAboutAt: new Date(now + created.count * spacing * 1000),
  });
}
