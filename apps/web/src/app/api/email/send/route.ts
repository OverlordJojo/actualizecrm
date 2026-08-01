import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { pokeWorker } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Queues one email.
 *
 * The app does not send — the worker does, because that is where the daily cap
 * is enforced and where a send has to work with the laptop shut. This writes
 * the job and nudges the worker so a test send does not sit for twenty seconds
 * looking broken.
 */

const sendSchema = z
  .object({
    contactId: z.string().min(1),
    templateId: z.string().optional(),
    subject: z.string().max(200).optional(),
    body: z.string().optional(),
    /// Settings → Email test send. Goes to a typed address rather than the
    /// lead's, and is exempt from the daily cap.
    toOverride: z.string().email().optional(),
  })
  .refine((v) => v.templateId || (v.subject && v.body), {
    message: 'Pick a template, or supply a subject and body.',
  });

export async function POST(request: Request) {
  const parsed = sendSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid send.' },
      { status: 400 },
    );
  }

  const { contactId, templateId, toOverride } = parsed.data;

  const contact = await db.contact.findUnique({ where: { id: contactId } });
  if (!contact) {
    return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });
  }
  if (contact.doNotContact && !toOverride) {
    return NextResponse.json(
      { error: 'That lead is marked do-not-contact.' },
      { status: 403 },
    );
  }
  if (!contact.email && !toOverride) {
    return NextResponse.json(
      { error: 'That lead has no email address on file.' },
      { status: 400 },
    );
  }

  let subject = parsed.data.subject ?? '';
  let body = parsed.data.body ?? '';
  let templateName: string | undefined;

  if (templateId) {
    const template = await db.messageTemplate.findUnique({ where: { id: templateId } });
    if (!template) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 });
    }
    subject = template.subject ?? '(no subject)';
    body = template.body;
    templateName = template.name;
  }

  const jobKey = `email:${contactId}:${Date.now()}`;
  const job = await db.scheduledJob.create({
    data: {
      type: 'email.send',
      jobKey,
      payload: { contactId, subject, body, templateName, toOverride },
      runAt: new Date(),
    },
  });

  const poked = await pokeWorker({
    type: 'email.send',
    jobKey,
    payload: { contactId, subject, body, templateName, toOverride, scheduledJobId: job.id },
  });

  return NextResponse.json({
    queued: true,
    jobId: job.id,
    // Tells the UI whether to expect a result in a second or in up to twenty.
    immediate: poked,
  });
}

/// Polled by the UI after a send so a failure surfaces as a message rather
/// than silence.
export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json({ error: 'Pass a jobId.' }, { status: 400 });
  }

  const job = await db.scheduledJob.findUnique({ where: { id: jobId } });
  if (!job) {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const to = (payload.toOverride as string) ?? undefined;

  const message = await db.emailMessage.findFirst({
    where: {
      contactId: payload.contactId as string,
      ...(to ? { toAddr: to } : {}),
      createdAt: { gte: job.createdAt },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, error: true, toAddr: true, subject: true },
  });

  return NextResponse.json({ job: { status: job.status, attempts: job.attempts }, message });
}
