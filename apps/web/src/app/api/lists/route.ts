import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Import batches, for the "load a list" dropdown and every filter that scopes
/// by where a lead came from.
export async function GET() {
  const lists = await db.leadList.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      sourceFile: true,
      createdAt: true,
      _count: { select: { contacts: true } },
    },
  });

  return NextResponse.json(
    lists.map((l) => ({
      id: l.id,
      name: l.name,
      sourceFile: l.sourceFile,
      createdAt: l.createdAt,
      count: l._count.contacts,
    })),
  );
}
