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

export interface SweepResult {
  held?: number;
  abandoned: number;
  skipped?: string;
}

function appUrl(): string | null {
  const base =
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.PUBLIC_WEBHOOK_URL;
  return base ? base.replace(/\/$/, '') : null;
}

export async function sweepHeldCalls(): Promise<SweepResult> {
  const base = appUrl();
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!base || !secret) return { abandoned: 0, skipped: 'app URL or secret not set' };

  try {
    const res = await fetch(`${base}/api/dialer/sweep`, {
      method: 'POST',
      headers: { 'x-worker-secret': secret, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { abandoned: 0, skipped: `sweep returned ${res.status}` };
    return (await res.json()) as SweepResult;
  } catch (err) {
    // A ten-second job must never throw into the dead-letter queue over a
    // transient network blip; the next tick will try again.
    return { abandoned: 0, skipped: String(err).slice(0, 80) };
  }
}
