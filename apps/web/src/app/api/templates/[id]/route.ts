import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  subject: z.string().max(200).nullable().optional(),
  body: z.string().trim().min(1).optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid template.' }, { status: 400 });
  }

  const updated = await db.messageTemplate.update({
    where: { id: params.id },
    data: parsed.data,
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  await db.messageTemplate.delete({ where: { id: params.id } }).catch(() => {});
  return NextResponse.json({ deleted: true });
}
