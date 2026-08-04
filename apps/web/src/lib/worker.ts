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

/**
 * Where Telnyx sends call events (§1.2).
 *
 * The worker owns the endpoint, so the app derives the URL from `WORKER_URL`
 * rather than keeping a second copy that could drift. Any leg this app
 * originates must carry this as its `webhook_url`, or its events go to a
 * process that is not listening for them.
 */
export function telnyxWebhookUrl(): string | null {
  const base = workerUrl();
  return base ? `${base}/api/telnyx/webhook` : null;
}

/**
 * Runs the live webhook round-trip test on the worker.
 *
 * Held open for the full result rather than returning a job id: the operator
 * pressed a button and is watching, and §1.3 gives the whole thing ten seconds.
 */
export async function testWebhookDelivery(): Promise<{
  ok: boolean;
  roundTripMs?: number;
  eventType?: string;
  webhookUrl?: string;
  error?: string;
  registration?: unknown;
}> {
  const base = workerUrl();
  const secret = process.env.WORKER_SHARED_SECRET;

  if (!base) {
    return {
      ok: false,
      error:
        'WORKER_URL is not set, so the app cannot reach the service that ' +
        'receives call events.',
    };
  }
  if (!secret) return { ok: false, error: 'WORKER_SHARED_SECRET is not set.' };

  try {
    const res = await fetch(`${base}/telnyx/test-webhook`, {
      method: 'POST',
      headers: { 'x-worker-secret': secret },
      // The probe itself is capped at 10s; this allows for the round trip to
      // the worker on top of that.
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });

    if (!res.ok) {
      return { ok: false, error: `The worker answered ${res.status}.` };
    }
    return (await res.json()) as { ok: boolean };
  } catch (err) {
    return {
      ok: false,
      error:
        'Could not reach the worker: ' +
        (err instanceof Error ? err.message : String(err)),
    };
  }
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
