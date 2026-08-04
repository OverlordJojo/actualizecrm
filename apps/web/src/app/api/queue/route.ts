import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The dial queue (§3.2).
 *
 * By default this is the **New** column in kanban order — top card dialled
 * first. That is the whole contract now: reordering New reorders the dial
 * queue, which is why the column header says so.
 *
 * Ordering is `stagePosition`, not "least recently dialled". The old ordering
 * was a second, invisible sort that could disagree with the board the operator
 * was looking at: they would drag a card to the top of the column and the
 * dialer would call somebody else, with nothing on screen explaining why.
 */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const stageName = p.get('stage');
  const stageIdParam = p.get('stageId');

  let stageId = stageIdParam;
  if (!stageId) {
    const stage = await db.pipelineStage.findFirst({
      where: { name: stageName ?? 'New' },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    if (!stage) return NextResponse.json([]);
    stageId = stage.id;
  }

  const leads = await db.contact.findMany({
    where: {
      doNotContact: false,
      // Trashed leads never re-enter a dial queue unless restored (§3.3).
      pipelineRemovedAt: null,
      stageId,
    },
    orderBy: [{ stagePosition: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      companyName: true,
      companyLocation: true,
      phone: true,
      // The Active Lead Card edits these inline, so they come down with the
      // queue rather than being fetched per lead mid-session.
      email: true,
      address: true,
      dealValue: true,
      lastDisposition: true,
      stageId: true,
      stagePosition: true,
      customFields: true,
      listId: true,
    },
  });

  return NextResponse.json(leads);
}
