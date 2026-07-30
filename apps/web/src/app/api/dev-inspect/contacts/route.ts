import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Test-only inspection endpoint used by the import test harness.
 *
 * Returns 404 outside development so it cannot be reached from a production
 * build. Nothing in the app UI calls this — if you find yourself wanting it
 * from a component, add a real route instead.
 */
function devOnly() {
  return process.env.NODE_ENV === 'development'
    ? null
    : NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function GET() {
  const blocked = devOnly();
  if (blocked) return blocked;

  const contacts = await db.contact.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      companyName: true,
      companyLocation: true,
      email: true,
      customFields: true,
      listId: true,
    },
  });
  return NextResponse.json(contacts);
}

export async function PATCH(request: Request) {
  const blocked = devOnly();
  if (blocked) return blocked;

  const { phone, ...patch } = await request.json();
  const updated = await db.contact.update({ where: { phone }, data: patch });
  return NextResponse.json(updated);
}

export async function DELETE() {
  const blocked = devOnly();
  if (blocked) return blocked;

  await db.activity.deleteMany();
  await db.contact.deleteMany();
  await db.leadList.deleteMany();
  return NextResponse.json({ cleared: true });
}
