import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

const patchSchema = z.object({
  name: z.string().trim().min(1).optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid pipeline.' }, { status: 400 });
  }

  const pipeline = await db.pipeline.update({
    where: { id: params.id },
    data: parsed.data,
  });
  return NextResponse.json(pipeline);
}

/// Preflight for the delete confirmation (§1.1): name the lead count that
/// will be affected before anything is destroyed.
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const pipeline = await db.pipeline.findUnique({
    where: { id: params.id },
    include: { stages: { select: { id: true, name: true } } },
  });
  if (!pipeline) {
    return NextResponse.json({ error: 'Pipeline not found.' }, { status: 404 });
  }

  const leadCount = await db.contact.count({
    where: { stageId: { in: pipeline.stages.map((s) => s.id) } },
  });

  const others = await db.pipeline.findMany({
    where: { NOT: { id: params.id } },
    select: { id: true, name: true },
  });

  return NextResponse.json({
    id: pipeline.id,
    name: pipeline.name,
    stageCount: pipeline.stages.length,
    leadCount,
    canDelete: others.length > 0,
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
) {
  const remaining = await db.pipeline.count();
  if (remaining <= 1) {
    return NextResponse.json(
      { error: 'This is your only pipeline — leads would have nowhere to go.' },
      { status: 400 },
    );
  }

  const pipeline = await db.pipeline.findUnique({
    where: { id: params.id },
    include: { stages: { select: { id: true } } },
  });
  if (!pipeline) {
    return NextResponse.json({ error: 'Pipeline not found.' }, { status: 404 });
  }

  const stageIds = pipeline.stages.map((s) => s.id);
  const leadCount = await db.contact.count({
    where: { stageId: { in: stageIds } },
  });

  // Leads must land somewhere real. The cascade would set stageId to null,
  // and with the Unassigned column gone in v2 that means invisible — so move
  // them into the destination pipeline's first stage instead.
  let destinationStageId: string | null = null;

  if (leadCount > 0) {
    let body: { destinationPipelineId?: string } = {};
    try {
      body = await request.json();
    } catch {
      // No body sent.
    }

    const targetPipelineId = body.destinationPipelineId;
    if (!targetPipelineId) {
      return NextResponse.json(
        {
          error: `"${pipeline.name}" holds ${leadCount} lead${
            leadCount === 1 ? '' : 's'
          }. Choose a pipeline to move them to.`,
          leadCount,
          needsDestination: true,
        },
        { status: 400 },
      );
    }

    const firstStage = await db.pipelineStage.findFirst({
      where: { pipelineId: targetPipelineId },
      orderBy: { position: 'asc' },
    });
    if (!firstStage) {
      return NextResponse.json(
        { error: 'That pipeline has no stages to move leads into.' },
        { status: 400 },
      );
    }

    destinationStageId = firstStage.id;
    await db.contact.updateMany({
      where: { stageId: { in: stageIds } },
      data: { stageId: destinationStageId },
    });
  }

  await db.pipeline.delete({ where: { id: params.id } });
  return NextResponse.json({ deleted: true, leadsMoved: leadCount, destinationStageId });
}
