import nodemailer, { type Transporter } from 'nodemailer';
import {
  db,
  getSettings,
  asNumber,
  renderMergeFields,
  OPERATOR_TIMEZONE,
} from '@actualizecrm/db';

/**
 * Email sending — the worker owns this.
 *
 * Sending lives here rather than in the web app because an automation that
 * emails a lead at 9am has to go out with the laptop shut, and that is the
 * whole reason this service exists. The app never sends directly; it writes a
 * `ScheduledJob` and the worker picks it up, which means there is exactly one
 * sender, one place the SMTP credentials live, and one daily cap that is
 * actually enforced rather than merely displayed.
 */

let cached: { key: string; transport: Transporter } | null = null;

function smtpTransport(): Transporter | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  const port = Number(SMTP_PORT ?? 587);
  const key = `${SMTP_HOST}:${port}:${SMTP_USER}`;
  if (cached?.key === key) return cached.transport;

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 upgrades with STARTTLS.
    secure: port === 465,
    auth: {
      user: SMTP_USER,
      // Gmail app passwords are shown in four space-separated groups and get
      // pasted that way more often than not.
      pass: SMTP_PASS.replace(/\s+/g, ''),
    },
  });

  cached = { key, transport };
  return transport;
}

export interface EmailConfigStatus {
  configured: boolean;
  provider: 'smtp' | 'resend' | 'none';
  detail: string;
}

export function configStatus(): EmailConfigStatus {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return {
      configured: true,
      provider: 'smtp',
      detail: `SMTP via ${process.env.SMTP_HOST}`,
    };
  }
  if (process.env.RESEND_API_KEY) {
    return { configured: true, provider: 'resend', detail: 'Resend' };
  }
  return {
    configured: false,
    provider: 'none',
    detail: 'No SMTP credentials and no Resend key.',
  };
}

/// Midnight of today in the operator's timezone, as a UTC instant. The cap is a
/// per-day limit in the operator's day, not in UTC's.
function startOfOperatorDay(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const localMidnightUtc = new Date(
    `${get('year')}-${get('month')}-${get('day')}T00:00:00Z`,
  );

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: OPERATOR_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p2 = dtf.formatToParts(localMidnightUtc);
  const n = (t: string) => Number(p2.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return new Date(localMidnightUtc.getTime() + (localMidnightUtc.getTime() - asUtc));
}

export async function sentToday(): Promise<number> {
  return db.emailMessage.count({
    where: {
      direction: 'outbound',
      status: 'sent',
      createdAt: { gte: startOfOperatorDay() },
    },
  });
}

export interface SendEmailInput {
  contactId: string;
  subject: string;
  body: string;
  /// Set when the send came from a template, for the timeline entry.
  templateName?: string;
  /// Test sends bypass the contact lookup and go wherever they are told.
  toOverride?: string;
}

export interface SendEmailResult {
  sent: boolean;
  emailMessageId?: string;
  skipped?: string;
  error?: string;
}

/**
 * Sends one email and logs it.
 *
 * Every outcome writes an `EmailMessage` row — including failures — so the
 * Conversations timeline shows what was attempted, not just what succeeded. A
 * send that vanishes because SMTP was misconfigured is the failure mode this
 * is built to make visible.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const contact = await db.contact.findUnique({ where: { id: input.contactId } });
  if (!contact) return { sent: false, skipped: 'lead no longer exists' };

  const to = input.toOverride ?? contact.email;
  if (!to) return { sent: false, skipped: 'lead has no email address' };

  if (contact.doNotContact && !input.toOverride) {
    return { sent: false, skipped: 'lead is marked do-not-contact' };
  }

  const settings = await getSettings();
  const cap = asNumber(settings['email.dailySendCap'], 200);

  // Checked at send time rather than at queue time: an automation queued
  // yesterday must count against today's cap, which is the day it actually
  // sends on.
  if (!input.toOverride && cap > 0) {
    const already = await sentToday();
    if (already >= cap) {
      return {
        sent: false,
        skipped: `daily send cap of ${cap} reached (${already} sent today)`,
      };
    }
  }

  const merge = {
    firstName: contact.firstName,
    lastName: contact.lastName,
    companyName: contact.companyName,
    companyLocation: contact.companyLocation,
    email: contact.email,
    phone: contact.phone,
  };
  const subject = renderMergeFields(input.subject, merge);
  const body = renderMergeFields(input.body, merge);

  const fromAddress = settings['email.fromAddress'] || process.env.SMTP_USER || '';
  const fromName = settings['email.fromName'];
  const from = fromName ? `${fromName} <${fromAddress}>` : fromAddress;

  if (!fromAddress) {
    return { sent: false, error: 'No from-address configured in Settings → Email.' };
  }

  const record = await db.emailMessage.create({
    data: {
      contactId: contact.id,
      direction: 'outbound',
      subject,
      body,
      fromAddr: fromAddress,
      toAddr: to,
      status: 'queued',
    },
  });

  const status = configStatus();

  try {
    if (status.provider === 'smtp') {
      const transport = smtpTransport();
      if (!transport) throw new Error('SMTP is not configured.');
      const info = await transport.sendMail({ from, to, subject, text: body });
      await db.emailMessage.update({
        where: { id: record.id },
        data: { status: 'sent', provider: 'smtp', messageId: info.messageId },
      });
    } else if (status.provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, text: body }),
      });
      const json = (await res.json()) as { id?: string; message?: string };
      if (!res.ok) throw new Error(json.message ?? `Resend returned ${res.status}`);
      await db.emailMessage.update({
        where: { id: record.id },
        data: { status: 'sent', provider: 'resend', messageId: json.id ?? null },
      });
    } else {
      throw new Error(status.detail);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.emailMessage.update({
      where: { id: record.id },
      data: { status: 'failed', error: message.slice(0, 500) },
    });
    return { sent: false, emailMessageId: record.id, error: message };
  }

  await db.activity.create({
    data: {
      contactId: contact.id,
      type: 'email',
      direction: 'outbound',
      summary: input.templateName
        ? `Emailed "${subject}" (${input.templateName})`
        : `Emailed "${subject}"`,
      body,
      emailId: record.id,
      meta: { to, templateName: input.templateName ?? null },
    },
  });

  return { sent: true, emailMessageId: record.id };
}
