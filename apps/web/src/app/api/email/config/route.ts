import { NextResponse } from 'next/server';
import { OPERATOR_TIMEZONE } from '@actualizecrm/db';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What Settings → Email needs to render.
 *
 * The transport status describes the environment this route runs in. The
 * worker is what actually sends, so the page also says plainly that the
 * credentials have to exist there — a green light here and an unset variable
 * on Railway is exactly the mismatch that makes automations fail silently.
 */
function transportStatus() {
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

/// Midnight today in the operator's timezone, as a UTC instant — the cap is a
/// limit on the operator's day, not on UTC's.
function startOfOperatorDay(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const midnightUtc = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: OPERATOR_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p2 = dtf.formatToParts(midnightUtc);
  const n = (t: string) => Number(p2.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return new Date(midnightUtc.getTime() + (midnightUtc.getTime() - asUtc));
}

export async function GET() {
  const settings = await getSettings();

  const sentToday = await db.emailMessage.count({
    where: {
      direction: 'outbound',
      status: 'sent',
      createdAt: { gte: startOfOperatorDay() },
    },
  });

  return NextResponse.json({
    provider: settings['email.provider'],
    fromName: settings['email.fromName'],
    fromAddress: settings['email.fromAddress'],
    dailySendCap: settings['email.dailySendCap'],
    sentToday,
    transport: transportStatus(),
  });
}
