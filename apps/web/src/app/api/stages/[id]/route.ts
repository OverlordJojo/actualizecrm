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

export async function DELETE(
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

  const siblings = await db.pipelineStage.count({
    where: { pipelineId: stage.pipelineId },
  });
  if (siblings <= 1) {
    return NextResponse.json(
      { error: 'A pipeline needs at least one stage.' },
      { status: 400 },
    );
  }

  // Leads in a deleted stage become unassigned rather than being deleted —
  // losing leads because a column was tidied up would be unforgivable.
  await db.pipelineStage.delete({ where: { id: params.id } });

  return NextResponse.json({
    deleted: true,
    leadsUnassigned: stage._count.contacts,
  });
}
