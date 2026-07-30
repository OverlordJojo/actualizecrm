import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// All pipelines with their stages and the leads in each stage.
export async function GET() {
  const pipelines = await db.pipeline.findMany({
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    include: {
      stages: { orderBy: { position: 'asc' } },
    },
  });
  return NextResponse.json(pipelines);
}

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the pipeline a name.'),
});

const DEFAULT_STAGES = [
  { name: 'New', color: '#64748b' },
  { name: 'Contacted', color: '#3b82f6' },
  { name: 'Booked', color: '#22c55e' },
];

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid pipeline.' },
      { status: 400 },
    );
  }

  const count = await db.pipeline.count();

  // A pipeline with no stages is a dead screen, so new ones start with a
  // minimal set the operator can rename or delete.
  const pipeline = await db.pipeline.create({
    data: {
      name: parsed.data.name,
      position: count,
      isDefault: count === 0,
      stages: { create: DEFAULT_STAGES.map((s, i) => ({ ...s, position: i })) },
    },
    include: { stages: { orderBy: { position: 'asc' } } },
  });

  return NextResponse.json(pipeline, { status: 201 });
}
