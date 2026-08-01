import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  addOperatorDays,
  endOfOperatorDay,
  operatorHour,
  startOfOperatorDay,
} from '@/lib/operator-time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Analytics (§7).
 *
 * Reads `DailyMetrics` rollups rather than scanning raw call rows. At ~1,200
 * dials a day the Call table passes a million rows inside a year and live
 * aggregation stops being viable — so the nightly job does the work and this
 * only adds today, which the rollup has not covered yet.
 *
 * Every boundary resolves in the operator's timezone. A dial at 5pm Pacific is
 * 00:00 UTC the next day; bucketing by UTC would file a third of every
 * afternoon on the wrong date and quietly corrupt every comparison here.
 */

export interface Totals {
  dials: number;
  connects: number;
  voicemails: number;
  ownerConnects: number;
  nonOwnerConnects: number;
  overOneMinute: number;
  interested: number;
  booked: number;
  abandoned: number;
  talkTimeSec: number;
  billedSec: number;
  telephonyCost: number;
}

const EMPTY: Totals = {
  dials: 0,
  connects: 0,
  voicemails: 0,
  ownerConnects: 0,
  nonOwnerConnects: 0,
  overOneMinute: 0,
  interested: 0,
  booked: 0,
  abandoned: 0,
  talkTimeSec: 0,
  billedSec: 0,
  telephonyCost: 0,
};

function add(a: Totals, b: Partial<Totals>): Totals {
  const out = { ...a };
  for (const k of Object.keys(EMPTY) as (keyof Totals)[]) {
    out[k] = a[k] + (b[k] ?? 0);
  }
  return out;
}

/// Today has not been rolled up yet, so it is computed live from raw calls.
/// This is the only scan, and it is bounded by one day of dialing.
async function computeToday(
  from: Date,
  to: Date,
): Promise<{
  totals: Totals;
  dialsByHour: Record<string, number>;
  byNumber: Record<string, { dials: number; connects: number }>;
}> {
  const calls = await db.call.findMany({
    where: { startedAt: { gte: from, lte: to } },
    select: {
      status: true,
      disposition: true,
      durationSec: true,
      answeredAt: true,
      startedAt: true,
      ownerConnect: true,
      nonOwnerConnect: true,
      amdResult: true,
      fromNumberId: true,
      contact: { select: { stage: { select: { name: true } } } },
    },
  });

  const totals: Totals = { ...EMPTY, dials: calls.length };
  const dialsByHour: Record<string, number> = {};
  const byNumber: Record<string, { dials: number; connects: number }> = {};

  for (const c of calls) {
    const hour = String(operatorHour(c.startedAt));
    dialsByHour[hour] = (dialsByHour[hour] ?? 0) + 1;

    if (c.fromNumberId) {
      byNumber[c.fromNumberId] ??= { dials: 0, connects: 0 };
      byNumber[c.fromNumberId].dials++;
    }

    if (c.answeredAt) {
      totals.connects++;
      if (c.fromNumberId) byNumber[c.fromNumberId].connects++;
      totals.talkTimeSec += c.durationSec;
      totals.billedSec += Math.max(c.durationSec, 1);
    }

    if (c.amdResult === 'machine' || c.disposition === 'voicemail') totals.voicemails++;
    if (c.ownerConnect) totals.ownerConnects++;
    if (c.nonOwnerConnect) totals.nonOwnerConnects++;
    if (c.durationSec > 60) totals.overOneMinute++;
    if (c.status === 'abandoned') totals.abandoned++;

    // Interested is a superset of Booked — every booking counts in both.
    const stage = c.contact?.stage?.name;
    if (c.disposition === 'booked' || stage === 'Booked') {
      totals.booked++;
      totals.interested++;
    } else if (stage === 'Interested') {
      totals.interested++;
    }
  }

  const rate = await db.setting.findUnique({ where: { key: 'analytics.ratePerMinute' } });
  totals.telephonyCost = (totals.billedSec / 60) * Number(rate?.value ?? 0.005);

  return { totals, dialsByHour, byNumber };
}

/// Sums rollups across a range, folding in a live "today" when the range
/// includes it.
async function gather(from: Date, to: Date) {
  const todayStart = startOfOperatorDay(new Date());

  const rollups = await db.dailyMetrics.findMany({
    where: { date: { gte: startOfOperatorDay(from), lte: to } },
    orderBy: { date: 'asc' },
  });

  let totals = { ...EMPTY };
  const dialsByHour: Record<string, number> = {};
  const byNumber: Record<string, { dials: number; connects: number }> = {};
  const series: { date: string; dials: number; booked: number }[] = [];

  for (const r of rollups) {
    totals = add(totals, r);
    series.push({
      date: r.date.toISOString().slice(0, 10),
      dials: r.dials,
      booked: r.booked,
    });

    for (const [h, n] of Object.entries((r.dialsByHour ?? {}) as Record<string, number>)) {
      dialsByHour[h] = (dialsByHour[h] ?? 0) + n;
    }
    for (const [id, v] of Object.entries(
      (r.byNumber ?? {}) as Record<string, { dials: number; connects: number }>,
    )) {
      byNumber[id] ??= { dials: 0, connects: 0 };
      byNumber[id].dials += v.dials;
      byNumber[id].connects += v.connects;
    }
  }

  // Only add live figures when the window actually reaches into today, and
  // only when the rollup has not already covered it.
  const coversToday = to >= todayStart && from <= endOfOperatorDay(new Date());
  const alreadyRolled = rollups.some((r) => r.date.getTime() === todayStart.getTime());

  if (coversToday && !alreadyRolled) {
    const live = await computeToday(
      todayStart > from ? todayStart : from,
      to < endOfOperatorDay(new Date()) ? to : endOfOperatorDay(new Date()),
    );
    totals = add(totals, live.totals);
    series.push({
      date: todayStart.toISOString().slice(0, 10),
      dials: live.totals.dials,
      booked: live.totals.booked,
    });
    for (const [h, n] of Object.entries(live.dialsByHour)) {
      dialsByHour[h] = (dialsByHour[h] ?? 0) + n;
    }
    for (const [id, v] of Object.entries(live.byNumber)) {
      byNumber[id] ??= { dials: 0, connects: 0 };
      byNumber[id].dials += v.dials;
      byNumber[id].connects += v.connects;
    }
  }

  return { totals, dialsByHour, byNumber, series };
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const fromParam = p.get('from');
  const toParam = p.get('to');

  const to = toParam ? endOfOperatorDay(new Date(toParam)) : endOfOperatorDay(new Date());
  const from = fromParam
    ? startOfOperatorDay(new Date(fromParam))
    : startOfOperatorDay(new Date());

  // The comparison window is the immediately preceding period of identical
  // length (§7.2) — not "last month" or "same period last year".
  const days = Math.max(
    Math.round((to.getTime() - from.getTime()) / 86_400_000),
    1,
  );
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = addOperatorDays(from, -days);

  const [current, previous, numbers, suggestionStats] = await Promise.all([
    gather(from, to),
    gather(prevFrom, prevTo),
    db.phoneNumber.findMany({
      select: { id: true, e164: true, purchasedAt: true, active: true },
    }),
    db.aiSuggestion.groupBy({
      by: ['fieldType', 'outcome'],
      _count: { _all: true },
      where: { createdAt: { gte: from, lte: to } },
    }),
  ]);

  // Accept rate per field type, so the model's reliability is measured rather
  // than assumed (§5.6).
  const byField: Record<string, { accepted: number; dismissed: number; pending: number }> = {};
  for (const row of suggestionStats) {
    byField[row.fieldType] ??= { accepted: 0, dismissed: 0, pending: 0 };
    const n = row._count._all;
    if (row.outcome === 'accepted') byField[row.fieldType].accepted += n;
    else if (row.outcome === 'dismissed') byField[row.fieldType].dismissed += n;
    else byField[row.fieldType].pending += n;
  }

  return NextResponse.json({
    range: { from: from.toISOString(), to: to.toISOString(), days },
    previousRange: { from: prevFrom.toISOString(), to: prevTo.toISOString() },
    current: current.totals,
    previous: previous.totals,
    dialsByHour: current.dialsByHour,
    series: current.series,
    numbers: numbers.map((n) => ({
      id: n.id,
      e164: n.e164,
      active: n.active,
      daysInService: Math.max(
        Math.round((Date.now() - n.purchasedAt.getTime()) / 86_400_000),
        0,
      ),
      dials: current.byNumber[n.id]?.dials ?? 0,
      connects: current.byNumber[n.id]?.connects ?? 0,
    })),
    aiAcceptRate: byField,
  });
}
