/**
 * Two-way calendar sync (§2), every 15 minutes.
 *
 * The worker triggers it; the web app does it. All the Google plumbing — the
 * encrypted refresh token, the OAuth client, the §2.4 booking format — already
 * lives in the app, and duplicating the token handling here would mean two
 * places for it to drift out of step.
 *
 * A calendar that is not connected is not an error. Returning "skipped" keeps
 * it out of the dead-letter queue, which is for things the operator needs to
 * look at.
 */

export interface ReconcileResult {
  checked?: number;
  moved?: number;
  cancelled?: number;
  skipped?: string;
}

function appUrl(): string | null {
  const base =
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.PUBLIC_WEBHOOK_URL;
  return base ? base.replace(/\/$/, '') : null;
}

export async function reconcileCalendar(): Promise<ReconcileResult> {
  const base = appUrl();
  const secret = process.env.WORKER_SHARED_SECRET;

  if (!base) return { skipped: 'APP_URL is not set' };
  if (!secret) return { skipped: 'WORKER_SHARED_SECRET is not set' };

  const res = await fetch(`${base}/api/calendar/reconcile`, {
    method: 'POST',
    headers: { 'x-worker-secret': secret, 'Content-Type': 'application/json' },
    // Generous: the app walks up to 200 bookings against the Google API.
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`Reconcile returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  return (await res.json()) as ReconcileResult;
}
