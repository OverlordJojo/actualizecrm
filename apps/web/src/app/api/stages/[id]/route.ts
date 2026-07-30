import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

const patchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  color: z.string().trim().min(1).optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid stage.' }, { status: 400 });
  }

  const stage = await db.pipelineStage.update({
    where: { id: params.id },
    data: parsed.data,
  });
  return NextResponse.json(stage);
}

/// Preflight for the delete confirmation: how many leads are affected, and
/// which stages they could move to.
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const stage = await db.pipelineStage.findUnique({
    where: { id: params.id },
    include: { _count: { select: { contacts: true } } },
  });
  if (!stage) {
    return NextResponse.json({ error: 'Stage not found.' }, { status: 404 });
  }

  const siblings = await db.pipelineStage.findMany({
    where: { pipelineId: stage.pipelineId, NOT: { id: stage.id } },
    orderBy: { position: 'asc' },
    select: { id: true, name: true, color: true },
  });

  return NextResponse.json({
    id: stage.id,
    name: stage.name,
    leadCount: stage._count.contacts,
    destinations: siblings,
  });
}

/**
 * Deletes a stage (§1.1).
 *
 * If the stage holds leads, the caller must name a destination. v1 sent them
 * to Unassigned, which was tolerable while Unassigned was a visible column;
 * v2 removed that column, so clearing `stageId` would make the leads vanish
 * from the board with no obvious way to find them again. Never orphan a lead.
 */
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
) {
  const stage = await db.pipelineStage.findUnique({
    where: { id: params.id },
    include: { _count: { select: { contacts: true } } },
  });

  if (!stage) {
    return NextResponse.json({ error: 'Stage not found.' }, { status: 404 });
  }

  const siblings = await db.pipelineStage.count({
    where: { pipelineId: stage.pipelineId },
  });
  if (siblings <= 1) {
    return NextResponse.json(
      { error: 'A pipeline needs at least one stage.' },
      { status: 400 },
    );
  }

  const leadCount = stage._count.contacts;
  let destinationStageId: string | null = null;

  if (leadCount > 0) {
    let body: { destinationStageId?: string } = {};
    try {
      body = await request.json();
    } catch {
      // No body sent — handled below.
    }

    destinationStageId = body.destinationStageId ?? null;

    if (!destinationStageId) {
      return NextResponse.json(
        {
          error: `"${stage.name}" holds ${leadCount} lead${
            leadCount === 1 ? '' : 's'
          }. Choose a stage to move them to.`,
          leadCount,
          needsDestination: true,
        },
        { status: 400 },
      );
    }

    const destination = await db.pipelineStage.findUnique({
      where: { id: destinationStageId },
    });
    if (!destination || destination.pipelineId !== stage.pipelineId) {
      return NextResponse.json(
        { error: 'That destination stage is not in this pipeline.' },
        { status: 400 },
      );
    }

    await db.contact.updateMany({
      where: { stageId: stage.id },
      data: { stageId: destinationStageId },
    });
  }

  await db.pipelineStage.delete({ where: { id: params.id } });

  return NextResponse.json({
    deleted: true,
    leadsMoved: leadCount,
    destinationStageId,
  });
}
