import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { fireTrigger } from '@/integrations/automations/triggers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Tags with how many leads carry each, for the Conversations filter.
export async function GET() {
  const tags = await db.tag.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      color: true,
      _count: { select: { contacts: true } },
    },
  });

  return NextResponse.json(
    tags.map((t) => ({ id: t.id, name: t.name, color: t.color, count: t._count.contacts })),
  );
}

const attachSchema = z.object({
  contactId: z.string().min(1),
  /// Tag by name rather than id: the operator types a tag, they do not pick a
  /// row from a table, and a tag that does not exist yet should just work.
  name: z.string().trim().min(1).max(60),
  color: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = attachSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid tag.' }, { status: 400 });
  }

  const { contactId, name, color } = parsed.data;

  const contact = await db.contact.findUnique({ where: { id: contactId } });
  if (!contact) {
    return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
  }

  const tag = await db.tag.upsert({
    where: { name },
    create: { name, color: color ?? '#64748b' },
    update: {},
  });

  // The composite primary key rejects a duplicate, which is the desired
  // outcome — tagging something twice is a no-op, not an error.
  const created = await db.contactTag
    .create({ data: { contactId, tagId: tag.id } })
    .then(() => true)
    .catch(() => false);

  if (created) {
    await db.activity.create({
      data: {
        contactId,
        type: 'tag',
        summary: `Tagged ${tag.name}`,
        meta: { tagId: tag.id, tagName: tag.name },
      },
    });

    await fireTrigger('tag_added', { contactId, tagName: tag.name });
  }

  return NextResponse.json(tag, { status: created ? 201 : 200 });
}

const detachSchema = z.object({
  contactId: z.string().min(1),
  tagId: z.string().min(1),
});

export async function DELETE(request: Request) {
  const parsed = detachSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid tag removal.' }, { status: 400 });
  }

  const { contactId, tagId } = parsed.data;

  await db.contactTag
    .delete({ where: { contactId_tagId: { contactId, tagId } } })
    .catch(() => {
      // Already gone; the caller wanted it absent and it is absent.
    });

  return NextResponse.json({ removed: true });
}
