import { db, getSettings, OPERATOR_TIMEZONE } from '@actualizecrm/db';
import { sendEmail } from '../lib/mailer';

/**
 * Daily brief (add-on C).
 *
 * A BullMQ job, not `node-cron`: an in-process scheduler loses every pending
 * job on redeploy, and Railway redeploys on every push. The repeatable fires
 * every five minutes and this decides whether the configured send time has
 * arrived — which also means a deploy at 07:58 does not cause the 08:00 brief
 * to be missed entirely.
 *
 * Sending is guarded by a per-day marker so five-minute ticks cannot produce
 * five briefs.
 */

const SENT_MARKER = 'brief.lastSentDate';

function operatorParts(at: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    date: `${g('year')}-${g('month')}-${g('day')}`,
    minutes: Number(g('hour')) * 60 + Number(g('minute')),
  };
}

function dayStart(dateKey: string): Date {
  // The rollup stores each day at UTC midnight of the local date.
  return new Date(`${dateKey}T00:00:00Z`);
}

function rate(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

export interface BriefResult {
  sent: boolean;
  skipped?: string;
  to?: string;
}

export async function runDailyBrief(force = false): Promise<BriefResult> {
  const settings = await getSettings();
  if (settings['brief.enabled'] !== 'true' && !force) {
    return { sent: false, skipped: 'daily brief is switched off' };
  }

  const now = new Date();
  const { date: today, minutes } = operatorParts(now);

  const [hh, mm] = (settings['brief.sendTime'] || '08:00').split(':').map(Number);
  const target = hh * 60 + mm;

  if (!force) {
    // Fire in the window from the configured time up to an hour after, so a
    // worker that was redeploying at exactly 08:00 still sends at 08:05.
    if (minutes < target || minutes > target + 60) {
      return { sent: false, skipped: `not the send window (${settings['brief.sendTime']})` };
    }
    const marker = await db.setting.findUnique({ where: { key: SENT_MARKER } });
    if (marker?.value === today) {
      return { sent: false, skipped: 'already sent today' };
    }
  }

  const recipient = settings['brief.recipient'] || process.env.SMTP_USER || '';
  if (!recipient) {
    return { sent: false, skipped: 'no recipient configured' };
  }

  // Claim the day before sending. A crash after the send would otherwise
  // resend on the next tick, and a duplicate brief is more confusing than a
  // missing one.
  await db.setting.upsert({
    where: { key: SENT_MARKER },
    create: { key: SENT_MARKER, value: today },
    update: { value: today },
  });

  const yesterdayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now.getTime() - 86_400_000));
  const dayBeforeKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now.getTime() - 2 * 86_400_000));

  const [yesterday, dayBefore, overdue, recent] = await Promise.all([
    db.dailyMetrics.findUnique({ where: { date: dayStart(yesterdayKey) } }),
    db.dailyMetrics.findUnique({ where: { date: dayStart(dayBeforeKey) } }),
    db.callbackTask.findMany({
      where: { completed: false, dueAt: { lt: now } },
      orderBy: { dueAt: 'asc' },
      take: 25,
      include: {
        contact: { select: { firstName: true, lastName: true, phone: true, companyName: true } },
      },
    }),
    // Fourteen days of rollups, for the week-over-week per-number comparison.
    db.dailyMetrics.findMany({
      where: { date: { gte: new Date(dayStart(yesterdayKey).getTime() - 13 * 86_400_000) } },
      orderBy: { date: 'asc' },
    }),
  ]);

  const y = yesterday;
  const b = dayBefore;

  const lines: string[] = [];
  lines.push(`ActualizeCRM — ${yesterdayKey}`, '');

  if (!y) {
    lines.push('No dials were rolled up for yesterday.');
  } else {
    const delta = (now_: number, before: number | undefined) =>
      before === undefined ? '' : ` (${now_ - before >= 0 ? '+' : ''}${now_ - before} vs the day before)`;

    lines.push(
      `Dials:        ${y.dials}${delta(y.dials, b?.dials)}`,
      `Connects:     ${y.connects}${delta(y.connects, b?.connects)}`,
      `Connect rate: ${rate(y.connects, y.dials)}${
        b ? ` (was ${rate(b.connects, b.dials)})` : ''
      }`,
      `Owner connects: ${y.ownerConnects}${delta(y.ownerConnects, b?.ownerConnects)}`,
      `Booked:       ${y.booked}${delta(y.booked, b?.booked)}`,
      `Talk time:    ${Math.round(y.talkTimeSec / 60)} minutes`,
      '',
    );

    const hours = Object.entries((y.dialsByHour ?? {}) as Record<string, number>);
    if (hours.length) {
      const best = hours.reduce((a, c) => (c[1] > a[1] ? c : a));
      lines.push(`Best hour:    ${best[0]}:00–${Number(best[0]) + 1}:00 with ${best[1]} dials`, '');
    }
  }

  // --- overdue callbacks ---------------------------------------------------
  lines.push(`Callbacks past due: ${overdue.length}`);
  for (const t of overdue.slice(0, 10)) {
    const name =
      [t.contact.firstName, t.contact.lastName].filter(Boolean).join(' ') ||
      t.contact.companyName ||
      t.contact.phone;
    lines.push(`  · ${name} — ${t.contact.phone}, due ${t.dueAt.toISOString().slice(0, 16).replace('T', ' ')}`);
  }
  if (overdue.length > 10) lines.push(`  …and ${overdue.length - 10} more`);
  lines.push('');

  // --- spam-label early warning -------------------------------------------
  // A number whose connect rate has fallen sharply week over week is usually
  // being labelled, not unlucky. Surfacing it early is the whole point.
  const half = Math.ceil(recent.length / 2);
  const older = recent.slice(0, half);
  const newer = recent.slice(half);

  const agg = (rows: typeof recent) => {
    const out: Record<string, { dials: number; connects: number }> = {};
    for (const r of rows) {
      for (const [id, v] of Object.entries(
        (r.byNumber ?? {}) as Record<string, { dials: number; connects: number }>,
      )) {
        out[id] ??= { dials: 0, connects: 0 };
        out[id].dials += v.dials;
        out[id].connects += v.connects;
      }
    }
    return out;
  };

  const before = agg(older);
  const after = agg(newer);
  const numbers = await db.phoneNumber.findMany({ select: { id: true, e164: true } });
  const byId = new Map(numbers.map((n) => [n.id, n.e164]));

  const flagged: string[] = [];
  for (const [id, nowStats] of Object.entries(after)) {
    const wasStats = before[id];
    // Needs enough volume on both sides for the comparison to mean anything.
    if (!wasStats || wasStats.dials < 20 || nowStats.dials < 20) continue;
    const wasRate = wasStats.connects / wasStats.dials;
    const nowRate = nowStats.connects / nowStats.dials;
    if (wasRate <= 0) continue;
    const drop = (wasRate - nowRate) / wasRate;
    if (drop > 0.2) {
      flagged.push(
        `  · ${byId.get(id) ?? id}: ${(wasRate * 100).toFixed(1)}% → ${(nowRate * 100).toFixed(1)}% (down ${(drop * 100).toFixed(0)}%)`,
      );
    }
  }

  if (flagged.length) {
    lines.push('Numbers whose connect rate dropped more than 20% week over week:');
    lines.push(...flagged);
    lines.push(
      '',
      'That pattern usually means carrier labelling. Rotate the number out and',
      'let it rest rather than dialing it harder.',
    );
  } else {
    lines.push('No number lost more than 20% of its connect rate week over week.');
  }

  const result = await sendEmail({
    contactId: '',
    subject: `ActualizeCRM daily brief — ${yesterdayKey}`,
    body: lines.join('\n'),
    toOverride: recipient,
  });

  if (result.error) throw new Error(result.error);
  if (!result.sent) {
    // Roll the marker back so the next tick can retry.
    await db.setting.deleteMany({ where: { key: SENT_MARKER } });
    return { sent: false, skipped: result.skipped };
  }

  return { sent: true, to: recipient };
}
