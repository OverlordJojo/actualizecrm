import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toE164 } from '@/lib/phone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Create Lead (§3.8).
 *
 * Lands in **New**, at the top of the column — which is the top of the dial
 * queue (§3.2). A lead typed in by hand is almost always one the operator wants
 * to call now, not after the hundred already sitting there.
 *
 * Phone is the dedupe key. An existing contact on the same number is updated
 * rather than duplicated, and a trashed one is restored: typing in somebody you
 * removed last month is a clear signal you want them back.
 */
const createSchema = z.object({
  phone: z.string().min(7),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  jobTitle: z.string().optional(),
  companyName: z.string().optional(),
  companyLocation: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
  dealValue: z.number().nullable().optional(),
});

const blank = (v?: string) => (v && v.trim() ? v.trim() : null);

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid lead.' }, { status: 400 });
  }

  const phone = toE164(parsed.data.phone);
  if (!phone) {
    return NextResponse.json(
      { error: 'That phone number is not one we can dial.' },
      { status: 400 },
    );
  }

  const stage = await db.pipelineStage.findFirst({
    where: { name: 'New' },
    orderBy: { position: 'asc' },
    select: { id: true },
  });

  const data = {
    firstName: blank(parsed.data.firstName),
    lastName: blank(parsed.data.lastName),
    jobTitle: blank(parsed.data.jobTitle),
    companyName: blank(parsed.data.companyName),
    companyLocation: blank(parsed.data.companyLocation),
    email: blank(parsed.data.email),
    address: blank(parsed.data.address),
    dealValue: parsed.data.dealValue ?? null,
  };

  // Everything already in New shifts down one, so the new lead is next up.
  if (stage) {
    await db.contact.updateMany({
      where: { stageId: stage.id },
      data: { stagePosition: { increment: 1 } },
    });
  }

  const contact = await db.contact.upsert({
    where: { phone },
    create: {
      ...data,
      phone,
      source: 'manual',
      stageId: stage?.id ?? null,
      stagePosition: 0,
    },
    update: {
      ...data,
      stageId: stage?.id ?? null,
      stagePosition: 0,
      // Restore a lead that had been removed — see the note above.
      pipelineRemovedAt: null,
      removalReason: null,
    },
  });

  const notes = blank(parsed.data.notes);
  if (notes) {
    await db.activity.create({
      data: {
        contactId: contact.id,
        type: 'note',
        summary: notes,
        meta: { source: 'create_lead' },
      },
    });
  }

  return NextResponse.json(contact, { status: 201 });
}
