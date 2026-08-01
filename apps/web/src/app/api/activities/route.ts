import { NextResponse } from 'next/server';
import type { Prisma } from '@actualizecrm/db';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Conversations feed (build step 7).
 *
 * One reverse-chronological query over `Activity`, which is why that table
 * exists: calls, texts, emails, notes, stage changes and AI analysis all write
 * a row there, so the feed does not have to union five tables and sort the
 * result in application code.
 */

/// Which Activity types each channel filter covers. A voicemail drop and a
/// disposition are things that happened *on a call*, so they belong under
/// Calls rather than as their own filters nobody would think to click.
const CHANNEL_TYPES: Record<string, string[]> = {
  calls: ['call', 'disposition', 'voicemail_drop'],
  texts: ['sms'],
  email: ['email'],
  notes: ['note'],
  pipeline: ['stage_change', 'tag', 'import', 'automation'],
};

const PAGE_SIZE = 50;

/// How many transcripts a search will scan for matches before giving up on
/// widening the result. The trigram index makes the lookup cheap; this only
/// bounds the size of the `IN` list handed to the main query.
const TRANSCRIPT_MATCH_LIMIT = 500;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;

  const q = p.get('q')?.trim() ?? '';
  const contactId = p.get('contactId') ?? '';
  const channel = p.get('channel') ?? '';
  const disposition = p.get('disposition') ?? '';
  const tagId = p.get('tagId') ?? '';
  const listId = p.get('listId') ?? '';
  const from = p.get('from') ?? '';
  const to = p.get('to') ?? '';
  const view = p.get('view') ?? 'all';
  const cursor = p.get('cursor') ?? '';

  const and: Prisma.ActivityWhereInput[] = [];

  if (contactId) and.push({ contactId });

  if (channel && CHANNEL_TYPES[channel]) {
    and.push({ type: { in: CHANNEL_TYPES[channel] } });
  }

  if (disposition) {
    // The disposition lives in the activity's own payload rather than on a
    // joined row, so a JSON path filter keeps this to a single query.
    and.push({ meta: { path: ['disposition'], equals: disposition } });
  }

  if (from) and.push({ createdAt: { gte: new Date(from) } });
  if (to) {
    // `to` is a calendar date from a date input; the operator means the whole
    // of that day, not midnight at the start of it.
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    and.push({ createdAt: { lte: end } });
  }

  // §1.3 — the Removed view is how a soft-deleted lead is found and restored.
  if (view === 'removed') {
    and.push({ contact: { pipelineRemovedAt: { not: null } } });
  }

  if (tagId) and.push({ contact: { tags: { some: { tagId } } } });
  if (listId) and.push({ contact: { listId } });

  if (q) {
    // A transcript match should surface the call it belongs to, but Activity
    // has no relation to Call — only a nullable id — so the matching call ids
    // are resolved first and folded into the same OR.
    const transcriptMatches = await db.call.findMany({
      where: {
        OR: [
          { transcript: { contains: q, mode: 'insensitive' } },
          { notes: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
      take: TRANSCRIPT_MATCH_LIMIT,
    });

    const or: Prisma.ActivityWhereInput[] = [
      { summary: { contains: q, mode: 'insensitive' } },
      { body: { contains: q, mode: 'insensitive' } },
      {
        contact: {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { companyName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
          ],
        },
      },
    ];

    if (transcriptMatches.length) {
      or.push({ callId: { in: transcriptMatches.map((c) => c.id) } });
    }

    and.push({ OR: or });
  }

  const where: Prisma.ActivityWhereInput = and.length ? { AND: and } : {};

  const rows = await db.activity.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      contact: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          companyName: true,
          companyLocation: true,
          phone: true,
          email: true,
          stageId: true,
          pipelineRemovedAt: true,
          removalReason: true,
          tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
        },
      },
    },
  });

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  return NextResponse.json({
    activities: page.map((a) => ({
      id: a.id,
      type: a.type,
      direction: a.direction,
      summary: a.summary,
      body: a.body,
      meta: a.meta,
      callId: a.callId,
      createdAt: a.createdAt,
      contact: {
        ...a.contact,
        tags: a.contact.tags.map((t) => t.tag),
      },
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  });
}
