import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AVAILABLE_MERGE_FIELDS } from '@actualizecrm/db';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const channel = new URL(request.url).searchParams.get('channel');

  const templates = await db.messageTemplate.findMany({
    where: channel ? { channel } : undefined,
    orderBy: [{ channel: 'asc' }, { name: 'asc' }],
  });

  return NextResponse.json({ templates, mergeFields: AVAILABLE_MERGE_FIELDS });
}

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the template a name.').max(120),
  channel: z.enum(['sms', 'email']),
  subject: z.string().max(200).optional(),
  body: z.string().trim().min(1, 'A template needs a body.'),
});

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid template.' },
      { status: 400 },
    );
  }

  // An email with no subject line arrives looking like spam, so the field is
  // required for email and meaningless for SMS.
  if (parsed.data.channel === 'email' && !parsed.data.subject?.trim()) {
    return NextResponse.json(
      { error: 'Email templates need a subject line.' },
      { status: 400 },
    );
  }

  const created = await db.messageTemplate.create({
    data: {
      name: parsed.data.name,
      channel: parsed.data.channel,
      subject: parsed.data.channel === 'email' ? parsed.data.subject!.trim() : null,
      body: parsed.data.body,
    },
  });

  return NextResponse.json(created, { status: 201 });
}
