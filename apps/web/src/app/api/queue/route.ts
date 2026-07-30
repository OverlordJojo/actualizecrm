import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Leads to dial, in order, for a list or a pipeline stage.
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const listId = p.get('listId');
  const stageId = p.get('stageId');

  if (!listId && !stageId) {
    return NextResponse.json(
      { error: 'Pass a listId or a stageId.' },
      { status: 400 },
    );
  }

  const leads = await db.contact.findMany({
    where: {
      doNotContact: false,
      ...(listId ? { listId } : {}),
      ...(stageId ? { stageId } : {}),
    },
    // Never-dialed first, then longest since last dial. An operator working a
    // list wants the untouched leads before the callbacks.
    orderBy: [{ lastDialedAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      companyName: true,
      companyLocation: true,
      phone: true,
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
