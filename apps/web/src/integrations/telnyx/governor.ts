import { db } from '@/lib/db';
import { getSetting, setSetting, asNumber } from '@/lib/settings';

/**
 * Abandonment governor (§4.4) — non-optional.
 *
 * Dialing more lines than you can answer produces abandoned calls: the prospect
 * picks up and nobody is there. US telemarketing rules (47 CFR 64.1200) cap
 * abandonment at **3% of live answers measured over 30 days**, require a
 * recorded identification message within two seconds of the greeting, and
 * require retaining the records.
 *
 * So this is not a warning banner. At 2% the burst size is automatically
 * reduced; at 3% multi-line is hard-blocked and the dialer is forced to single
 * line until the rolling rate recovers. There is deliberately no override flag —
 * a governor with a bypass is a governor that gets bypassed on the day the
 * numbers look bad, which is exactly the day it is doing its job.
 */

/// The measurement window the rule specifies.
const WINDOW_DAYS = 30;

export const WARN_THRESHOLD = 0.02;
export const BLOCK_THRESHOLD = 0.03;

/// Hard cap from §4.4. More lines is not a setting the operator can raise.
export const MAX_LINES_PER_BURST = 3;

export interface GovernorState {
  /// Abandoned ÷ total human answers over the window, as a fraction.
  rate: number;
  abandoned: number;
  humanAnswers: number;
  /// What the dialer is allowed to originate right now.
  allowedLines: number;
  /// The operator's configured preference, before the governor clamps it.
  configuredLines: number;
  blocked: boolean;
  warning: string | null;
  windowDays: number;
}

/**
 * The threshold decision, separated from the query so it can be pinned at the
 * exact boundaries.
 *
 * Both comparisons are `>=`. 3.0% is *at* the cap, not under it, and a rule
 * that only engages above the limit has already been broken by the time it
 * fires.
 */
export function clampLines(
  rate: number,
  configuredLines: number,
): { allowedLines: number; warning: string | null; blocked: boolean } {
  if (rate >= BLOCK_THRESHOLD) {
    return {
      allowedLines: 1,
      blocked: true,
      warning:
        `Abandonment is ${(rate * 100).toFixed(1)}% over the last ${WINDOW_DAYS} days, at or above the 3% legal cap. ` +
        'Multi-line dialing is blocked and the dialer is on a single line until the rolling rate recovers.',
    };
  }

  if (rate >= WARN_THRESHOLD) {
    const allowedLines = Math.max(configuredLines - 1, 1);
    return {
      allowedLines,
      blocked: false,
      warning:
        `Abandonment is ${(rate * 100).toFixed(1)}% over the last ${WINDOW_DAYS} days, past the 2% mark. ` +
        `Burst size has been reduced to ${allowedLines} automatically.`,
    };
  }

  return { allowedLines: configuredLines, warning: null, blocked: false };
}

/**
 * The rolling rate.
 *
 * Denominator is **human answers**, not dials. A no-answer was never at risk of
 * being abandoned, and including it would flatter the number by however many
 * people did not pick up — which is most of them.
 */
export async function abandonmentState(): Promise<GovernorState> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

  const [abandoned, humanAnswers] = await Promise.all([
    db.call.count({ where: { status: 'abandoned', startedAt: { gte: since } } }),
    db.call.count({
      where: {
        startedAt: { gte: since },
        // A human answer is either a leg AMD called human, or one that was
        // answered and never classified as a machine.
        OR: [
          // Premium AMD reports human_residence / human_business; matching only
          // "human" made the abandonment denominator far too small, which
          // flatters the rate the governor exists to police.
          { amdResult: { startsWith: 'human' } },
          { AND: [{ answeredAt: { not: null } }, { amdResult: null }] },
        ],
      },
    }),
  ]);

  // Abandoned calls are answered by a human by definition, so they belong in
  // the denominator too.
  const denominator = humanAnswers + abandoned;
  const rate = denominator > 0 ? abandoned / denominator : 0;

  const configuredLines = Math.min(
    Math.max(asNumber(await getSetting('dialer.linesPerBurst'), 1), 1),
    MAX_LINES_PER_BURST,
  );

  const { allowedLines, warning, blocked } = clampLines(rate, configuredLines);

  return {
    rate,
    abandoned,
    humanAnswers: denominator,
    allowedLines,
    configuredLines,
    blocked,
    warning,
    windowDays: WINDOW_DAYS,
  };
}

/**
 * How many lines the next burst may use.
 *
 * Called immediately before originating, never cached: the whole point is that
 * the rate reacts within the session that is causing it.
 */
export async function allowedLinesNow(): Promise<number> {
  return (await abandonmentState()).allowedLines;
}

/// Persists the operator's preference, clamped to the hard cap.
export async function setLinesPerBurst(lines: number): Promise<number> {
  const clamped = Math.min(Math.max(Math.round(lines), 1), MAX_LINES_PER_BURST);
  await setSetting('dialer.linesPerBurst', String(clamped));
  return clamped;
}

/**
 * Records an abandoned call.
 *
 * Kept on the Call row rather than a separate table: it already carries the
 * number dialed, the timestamp and `heldSeconds`, which is exactly the record
 * the rule requires retaining, and a parallel table would be one more thing to
 * keep in step.
 */
export async function recordAbandoned(callId: string, heldSeconds: number): Promise<void> {
  const call = await db.call.update({
    where: { id: callId },
    data: {
      status: 'abandoned',
      // Its own disposition, not 'no_answer' — they *did* answer, which is
      // exactly why it counts against the cap. Filing it as a no-answer would
      // hide the calls the governor exists to measure.
      disposition: 'abandoned',
      heldSeconds,
      endedAt: new Date(),
    },
  });

  await db.activity.create({
    data: {
      contactId: call.contactId,
      type: 'call',
      direction: 'outbound',
      summary: `Abandoned after ${heldSeconds}s on hold — nobody was free to take it`,
      callId,
      meta: { abandoned: true, heldSeconds, toE164: call.toE164 },
    },
  });
}
