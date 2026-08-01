import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

/// Stage columns in board order. Surfaces used to have to load the whole board
/// just to populate a stage dropdown — the slide-over, the restore control and
/// the automation builder all need the list and none of them need the leads.
export async function GET(request: Request) {
  const pipelineId = new URL(request.url).searchParams.get('pipelineId');

  const stages = await db.pipelineStage.findMany({
    where: pipelineId
      ? { pipelineId }
      : { pipeline: { isDefault: true } },
    orderBy: { position: 'asc' },
    select: { id: true, name: true, color: true, position: true, pipelineId: true },
  });

  // A database seeded before the default flag existed, or one where the
  // operator unset it, should still populate a dropdown rather than an empty
  // one that looks broken.
  if (stages.length === 0 && !pipelineId) {
    return NextResponse.json(
      await db.pipelineStage.findMany({
        orderBy: { position: 'asc' },
        select: { id: true, name: true, color: true, position: true, pipelineId: true },
      }),
    );
  }

  return NextResponse.json(stages);
}

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
