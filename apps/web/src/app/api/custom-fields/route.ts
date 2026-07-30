import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
  const fields = await db.customField.findMany({
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  return NextResponse.json(fields);
}

const createSchema = z.object({
  label: z.string().trim().min(1, 'Give the field a name.'),
  type: z.enum(['text', 'number', 'date']).default('text'),
});

/// Creates a custom field. Called inline from the import mapping screen, so it
/// must be idempotent on label — an operator who types "Roof Type" twice
/// should get the existing field back, not a duplicate or an error.
export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid field.' },
      { status: 400 },
    );
  }

  const { label, type } = parsed.data;

  const existing = await db.customField.findUnique({ where: { label } });
  if (existing) return NextResponse.json(existing);

  const count = await db.customField.count();
  const field = await db.customField.create({
    data: { label, type, position: count },
  });

  return NextResponse.json(field, { status: 201 });
}
