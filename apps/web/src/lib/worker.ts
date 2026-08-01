/**
 * Nudging the worker to run something now.
 *
 * The app's normal contract with the worker is one-way and asynchronous: write
 * a `ScheduledJob` row, and the drain picks it up within twenty seconds. That
 * is the right shape for automations, and it is why the worker does not care
 * whether the MacBook is on.
 *
 * It is the wrong shape for "Send test email", where the operator is standing
 * there diagnosing SMTP settings and twenty seconds of nothing reads as broken.
 * So for those, the row is still the source of truth and this only shortens the
 * wait — if the poke fails, the drain still runs the job.
 */

export function workerUrl(): string | null {
  const url = process.env.WORKER_URL;
  return url ? url.replace(/\/$/, '') : null;
}

export function isPokeConfigured(): boolean {
  return Boolean(workerUrl() && process.env.WORKER_SHARED_SECRET);
}

export async function pokeWorker(job: {
  type: string;
  jobKey: string;
  payload?: Record<string, unknown>;
}): Promise<boolean> {
  const base = workerUrl();
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!base || !secret) return false;

  try {
    const res = await fetch(`${base}/jobs/enqueue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': secret,
      },
      body: JSON.stringify(job),
      // The row is already written; a slow worker must not hold up the request.
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}
