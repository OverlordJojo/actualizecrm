/**
 * Retires multi-line callers held past the limit (§4.4).
 *
 * The worker triggers it; the app performs it, because hanging up a leg means
 * Telnyx Call Control and all of that lives in the app. Same split as calendar
 * reconciliation, for the same reason.
 *
 * Runs every ten seconds. That is unusually frequent for this queue, and it is
 * deliberate: the hold limit is 10–45 seconds, so a minute-granularity job
 * would routinely let people sit past a limit that exists to keep the operation
 * under a legal cap.
 */

import { sweepExpiredHolds } from '@actualizecrm/dialer';

export interface SweepResult {
  abandoned: number;
  skipped?: string;
}

/**
 * Runs the sweep here rather than asking the app to (§2).
 *
 * It used to POST to the app, because Call Control lived there. It does not any
 * more, and the round trip was exactly the wrong dependency for this job: the
 * case that strands somebody on hold is the browser being closed, crashed or
 * offline mid-burst, and a sweep that needs the app to answer is weakest in
 * precisely that situation.
 */
export async function sweepHeldCalls(): Promise<SweepResult> {
  try {
    return { abandoned: await sweepExpiredHolds() };
  } catch (err) {
    // A ten-second job must never throw into the dead-letter queue over a
    // transient blip; the next tick will try again.
    return { abandoned: 0, skipped: String(err).slice(0, 120) };
  }
}
