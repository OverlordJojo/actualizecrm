import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  showOnCard: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid field.' }, { status: 400 });
  }

  // Renaming to a label that already exists would collide on the unique
  // constraint; say so rather than surfacing a Prisma error.
  if (parsed.data.label) {
    const clash = await db.customField.findUnique({
      where: { label: parsed.data.label },
    });
    if (clash && clash.id !== params.id) {
      return NextResponse.json(
        { error: 'Another field already has that name.' },
        { status: 409 },
      );
    }
  }

  const updated = await db.customField.update({
    where: { id: params.id },
    data: parsed.data,
  });

  return NextResponse.json(updated);
}

/**
 * Deletes a custom field definition.
 *
 * The values stay on the contacts. `Contact.customFields` is a JSON blob keyed
 * by field id, and rewriting every contact row to strip one key is a large,
 * slow, irreversible edit to make on a delete that is usually a mistake being
 * corrected. An orphaned key renders as nothing and costs nothing; re-creating
 * the field with the same id would bring the data back.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  await db.customField.delete({ where: { id: params.id } }).catch(() => {});
  return NextResponse.json({ deleted: true });
}
