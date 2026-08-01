import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Dead-lettered jobs, surfaced on the Automations page. A job that dies
/// silently is worse than one that dies loudly.
export async function GET() {
  const failed = await db.failedJob.findMany({
    orderBy: { failedAt: 'desc' },
    take: 25,
    select: {
      id: true,
      type: true,
      jobKey: true,
      error: true,
      attempts: true,
      failedAt: true,
      retriedAt: true,
    },
  });

  return NextResponse.json(failed);
}

/// Clears the dead-letter list once the operator has dealt with them.
export async function DELETE() {
  const { count } = await db.failedJob.deleteMany({});
  return NextResponse.json({ cleared: count });
}
