import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

const createSchema = z.object({
  pipelineId: z.string().min(1),
  name: z.string().trim().min(1, 'Give the stage a name.'),
  color: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid stage.' },
      { status: 400 },
    );
  }

  const count = await db.pipelineStage.count({
    where: { pipelineId: parsed.data.pipelineId },
  });

  const stage = await db.pipelineStage.create({
    data: {
      pipelineId: parsed.data.pipelineId,
      name: parsed.data.name,
      color: parsed.data.color ?? '#64748b',
      position: count,
    },
  });

  return NextResponse.json(stage, { status: 201 });
}

const reorderSchema = z.object({
  /// Stage ids in their new left-to-right order.
  orderedIds: z.array(z.string().min(1)).min(1),
});

/// Reorders stage columns. Sent as one request rather than one per stage so a
/// half-applied drag cannot leave the board in a scrambled order.
export async function PUT(request: Request) {
  const parsed = reorderSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid stage order.' }, { status: 400 });
  }

  await db.$transaction(
    parsed.data.orderedIds.map((id, position) =>
      db.pipelineStage.update({ where: { id }, data: { position } }),
    ),
  );

  return NextResponse.json({ reordered: true });
}
