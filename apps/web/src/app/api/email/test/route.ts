import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { pokeWorker } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ to: z.string().email() });

/**
 * Settings → Email → Send test.
 *
 * Deliberately routed through the worker, because the worker is what sends
 * every automation email. A test that ran here would prove the web app's
 * credentials work and tell the operator nothing about the ones that matter.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }

  // The sender needs a contact for merge fields; any lead will do for a test,
  // and the address is overridden so nothing reaches a prospect.
  const contact = await db.contact.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!contact) {
    return NextResponse.json(
      { error: 'Import at least one lead first — the test renders merge fields against a real one.' },
      { status: 400 },
    );
  }

  const payload = {
    contactId: contact.id,
    subject: 'ActualizeCRM test email',
    body:
      'This is a test send from ActualizeCRM.\n\n' +
      'Merge fields render like this: first name "{{first_name}}", company "{{company}}".\n\n' +
      'If you are reading this, the worker can send email and automations will too.',
    toOverride: parsed.data.to,
  };

  const jobKey = `email-test:${Date.now()}`;
  const job = await db.scheduledJob.create({
    data: { type: 'email.send', jobKey, payload, runAt: new Date() },
  });

  const poked = await pokeWorker({
    type: 'email.send',
    jobKey,
    payload: { ...payload, scheduledJobId: job.id },
  });

  return NextResponse.json({ queued: true, jobId: job.id, immediate: poked });
}
