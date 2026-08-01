import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { pokeWorker } from '@/lib/worker';
import { checkA2pStatus } from '@/integrations/messaging/a2p';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The SMS send route — and the gate (§9).
 *
 * The gate is enforced **here**, at the route, not merely in the UI. Calling
 * this directly with a well-formed body while 10DLC registration is unapproved
 * returns 403 and sends nothing. That is the test that matters, and if it ever
 * sends, that is a ship-blocking bug.
 *
 * There is no bypass flag, no dev override and no environment in which this is
 * relaxed. The worker checks again at send time for the same reason.
 */

const sendSchema = z
  .object({
    contactId: z.string().min(1),
    templateId: z.string().optional(),
    body: z.string().optional(),
  })
  .refine((v) => v.templateId || v.body, {
    message: 'Pick a template or write a message.',
  });

export async function POST(request: Request) {
  const parsed = sendSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid message.' },
      { status: 400 },
    );
  }

  // Checked before anything else, including whether the lead exists: a blocked
  // gate should not be distinguishable by probing which leads are real.
  const gate = await checkA2pStatus();
  if (!gate.approved) {
    return NextResponse.json(
      {
        error: 'Texting is blocked until 10DLC registration is approved.',
        reason: gate.reason,
        state: gate.state,
      },
      { status: 403 },
    );
  }

  const { contactId, templateId } = parsed.data;

  const contact = await db.contact.findUnique({ where: { id: contactId } });
  if (!contact) {
    return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
  }
  if (contact.doNotContact) {
    return NextResponse.json(
      { error: 'That lead is marked do-not-contact.' },
      { status: 403 },
    );
  }

  let body = parsed.data.body ?? '';
  let templateName: string | undefined;

  if (templateId) {
    const template = await db.messageTemplate.findUnique({ where: { id: templateId } });
    if (!template) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 });
    }
    body = template.body;
    templateName = template.name;
  }

  const jobKey = `sms:${contactId}:${Date.now()}`;
  const job = await db.scheduledJob.create({
    data: {
      type: 'sms.send',
      jobKey,
      payload: { contactId, body, templateName },
      runAt: new Date(),
    },
  });

  const poked = await pokeWorker({
    type: 'sms.send',
    jobKey,
    payload: { contactId, body, templateName, scheduledJobId: job.id },
  });

  return NextResponse.json({ queued: true, jobId: job.id, immediate: poked });
}
