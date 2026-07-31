import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Pending suggestions for a call or contact, for the accept/dismiss chips.
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const callId = p.get('callId');
  const contactId = p.get('contactId');

  if (!callId && !contactId) {
    return NextResponse.json(
      { error: 'Pass a callId or a contactId.' },
      { status: 400 },
    );
  }

  const suggestions = await db.aiSuggestion.findMany({
    where: {
      ...(callId ? { callId } : {}),
      ...(contactId ? { contactId } : {}),
      outcome: 'pending',
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json(suggestions);
}

const decideSchema = z.object({
  suggestionId: z.string().min(1),
  decision: z.enum(['accepted', 'dismissed']),
});

/**
 * Accepts or dismisses a suggestion.
 *
 * Accepting is the only path that writes the extracted value onto the contact.
 * Nothing is applied automatically — §5.6 treats that as a correctness
 * requirement, not a preference, because a wrong auto-write to a lead's email
 * costs a deal and is invisible until it does.
 *
 * Every decision is recorded either way, so accept-rate per field type is
 * measurable on the Analytics page.
 */
export async function POST(request: Request) {
  const parsed = decideSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid decision.' }, { status: 400 });
  }

  const { suggestionId, decision } = parsed.data;

  const suggestion = await db.aiSuggestion.findUnique({
    where: { id: suggestionId },
  });
  if (!suggestion) {
    return NextResponse.json({ error: 'Suggestion not found.' }, { status: 404 });
  }
  if (suggestion.outcome !== 'pending') {
    return NextResponse.json(
      { error: 'That suggestion was already decided.' },
      { status: 409 },
    );
  }

  if (decision === 'accepted' && suggestion.value) {
    await applyToContact(
      suggestion.contactId,
      suggestion.fieldType,
      suggestion.value,
    );
  }

  const updated = await db.aiSuggestion.update({
    where: { id: suggestionId },
    data: { outcome: decision, decidedAt: new Date() },
  });

  return NextResponse.json(updated);
}

async function applyToContact(
  contactId: string,
  fieldType: string,
  value: string,
): Promise<void> {
  const FIELD_COLUMN: Record<string, string> = {
    email: 'email',
    first_name: 'firstName',
    last_name: 'lastName',
    company: 'companyName',
    address: 'address',
  };

  const column = FIELD_COLUMN[fieldType];
  if (column) {
    await db.contact.update({
      where: { id: contactId },
      data: { [column]: value },
    });
    await db.activity.create({
      data: {
        contactId,
        type: 'note',
        summary: `Accepted AI suggestion: ${fieldType.replace(/_/g, ' ')}`,
        body: value,
        meta: { fieldType, value, source: 'ai_suggestion' },
      },
    });
    return;
  }

  if (fieldType === 'stage') {
    // The AI proposes a stage name; find the matching column in the active
    // pipeline rather than trusting an id it never saw.
    const stage = await db.pipelineStage.findFirst({
      where: { name: { equals: titleCase(value), mode: 'insensitive' } },
    });
    if (!stage) return;

    await db.contact.update({
      where: { id: contactId },
      data: { stageId: stage.id, pipelineRemovedAt: null },
    });
    await db.activity.create({
      data: {
        contactId,
        type: 'stage_change',
        summary: `Moved to ${stage.name} (accepted AI suggestion)`,
        meta: { toStage: stage.name, source: 'ai_suggestion' },
      },
    });
    return;
  }

  if (fieldType === 'booking') {
    // Bookings are never written straight to the calendar from here — the
    // accepted value populates the booking panel and the operator confirms.
    await db.activity.create({
      data: {
        contactId,
        type: 'note',
        summary: 'Accepted AI booking suggestion — confirm on the calendar',
        body: value,
        meta: { proposedDatetime: value, source: 'ai_suggestion' },
      },
    });
  }
}

function titleCase(s: string): string {
  return s
    .split(/[\s_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
