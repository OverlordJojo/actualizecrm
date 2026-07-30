import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Test-only. 404s outside development — see ../contacts/route.ts.
export async function GET(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const contactId = new URL(request.url).searchParams.get('contactId');

  const activities = await db.activity.findMany({
    where: contactId ? { contactId } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return NextResponse.json(activities);
}
