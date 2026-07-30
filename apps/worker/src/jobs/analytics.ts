import { db, OPERATOR_TIMEZONE } from '@actualizecrm/db';

/**
 * Nightly analytics rollup (§7.5).
 *
 * Day boundaries are computed in the operator's timezone, not UTC. A call at
 * 5pm Pacific on the 3rd is 00:00 UTC on the 4th; bucketing by UTC would put
 * a third of every afternoon's dials on the wrong day and quietly corrupt
 * every period comparison on the Analytics page.
 */

// Shared with the web app and the cron schedules — see packages/db.
const OPERATOR_TZ = OPERATOR_TIMEZONE;
/// Default Telnyx outbound rate; overridable in Settings.
const DEFAULT_RATE_PER_MIN = 0.005;

/// Midnight of `date`'s local day, expressed as the corresponding UTC instant.
export function localDayStart(date: Date, tz = OPERATOR_TZ): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const localMidnightUtc = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);

  // Offset between the zone and UTC at that moment, accounting for DST.
  const offsetMs = tzOffsetMs(localMidnightUtc, tz);
  return new Date(localMidnightUtc.getTime() + offsetMs);
}

function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return at.getTime() - asUtc;
}

function localHour(at: Date, tz = OPERATOR_TZ): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    }).format(at),
  );
}

/// Rolls up a single local day. Defaults to yesterday, which is what the
/// nightly job wants; today's partial figures are computed live by the page.
export async function rollupDay(target?: Date): Promise<void> {
  const dayStart = localDayStart(target ?? new Date(Date.now() - 86_400_000));
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const calls = await db.call.findMany({
    where: { startedAt: { gte: dayStart, lt: dayEnd } },
    select: {
      id: true,
      status: true,
      disposition: true,
      durationSec: true,
      answeredAt: true,
      ownerConnect: true,
      nonOwnerConnect: true,
      startedAt: true,
      fromNumberId: true,
      amdResult: true,
      contact: { select: { stage: { select: { name: true } } } },
    },
  });

  const dialsByHour: Record<string, number> = {};
  const byNumber: Record<string, { dials: number; connects: number }> = {};

  let connects = 0;
  let voicemails = 0;
  let ownerConnects = 0;
  let nonOwnerConnects = 0;
  let overOneMinute = 0;
  let interested = 0;
  let booked = 0;
  let abandoned = 0;
  let talkTimeSec = 0;
  let billedSec = 0;

  for (const c of calls) {
    const hour = String(localHour(c.startedAt));
    dialsByHour[hour] = (dialsByHour[hour] ?? 0) + 1;

    if (c.fromNumberId) {
      byNumber[c.fromNumberId] ??= { dials: 0, connects: 0 };
      byNumber[c.fromNumberId].dials++;
    }

    const answered = c.answeredAt !== null;
    if (answered) {
      connects++;
      if (c.fromNumberId) byNumber[c.fromNumberId].connects++;
      talkTimeSec += c.durationSec;
      // Telnyx bills per second with a 1-second minimum on connected calls.
      billedSec += Math.max(c.durationSec, 1);
    }

    if (c.amdResult === 'machine' || c.disposition === 'voicemail') voicemails++;
    if (c.ownerConnect) ownerConnects++;
    if (c.nonOwnerConnect) nonOwnerConnects++;
    if (c.durationSec > 60) overOneMinute++;
    if (c.status === 'abandoned') abandoned++;

    // Interested is a superset of Booked — every booking counts in both.
    const stage = c.contact?.stage?.name;
    if (c.disposition === 'booked' || stage === 'Booked') {
      booked++;
      interested++;
    } else if (stage === 'Interested') {
      interested++;
    }
  }

  const rateSetting = await db.setting.findUnique({
    where: { key: 'analytics.ratePerMinute' },
  });
  const ratePerMin = Number(rateSetting?.value ?? DEFAULT_RATE_PER_MIN);

  // Prorated daily share of every active number's monthly rental.
  const numbers = await db.phoneNumber.findMany({
    where: { active: true },
    select: { monthlyCost: true },
  });
  const daysInMonth = new Date(
    dayStart.getUTCFullYear(),
    dayStart.getUTCMonth() + 1,
    0,
  ).getDate();
  const rentalCost = numbers.reduce(
    (sum, n) => sum + (n.monthlyCost ?? 0) / daysInMonth,
    0,
  );

  const telephonyCost = (billedSec / 60) * ratePerMin + rentalCost;

  await db.dailyMetrics.upsert({
    where: { date: dayStart },
    create: {
      date: dayStart,
      dials: calls.length,
      connects,
      voicemails,
      ownerConnects,
      nonOwnerConnects,
      overOneMinute,
      interested,
      booked,
      abandoned,
      talkTimeSec,
      billedSec,
      telephonyCost,
      dialsByHour,
      byNumber,
    },
    update: {
      dials: calls.length,
      connects,
      voicemails,
      ownerConnects,
      nonOwnerConnects,
      overOneMinute,
      interested,
      booked,
      abandoned,
      talkTimeSec,
      billedSec,
      telephonyCost,
      dialsByHour,
      byNumber,
      computedAt: new Date(),
    },
  });
}
