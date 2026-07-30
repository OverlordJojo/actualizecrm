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

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const remaining = await db.pipeline.count();
  if (remaining <= 1) {
    return NextResponse.json(
      { error: 'This is your only pipeline — leads would have nowhere to go.' },
      { status: 400 },
    );
  }

  // Cascade drops the stages; Contact.stageId is SetNull, so leads survive and
  // fall back to unassigned rather than being deleted with the pipeline.
  await db.pipeline.delete({ where: { id: params.id } });
  return NextResponse.json({ deleted: true });
}
