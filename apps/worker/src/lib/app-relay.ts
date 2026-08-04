/**
 * Hands one webhook event to the app for the parts the worker cannot do alone.
 *
 * Two things still live in the app: R2 presigning (voicemail playback URLs,
 * recording archival) and the extraction pipeline. Teaching the worker to hold
 * those credentials as well would duplicate them for no gain, so the event goes
 * over instead — authenticated with the shared secret, which is the same
 * mechanism the app already uses to reach the worker in the other direction.
 *
 * This is deliberately a narrow, temporary seam. §5 rebuilds the audio path on
 * the worker (media forking needs a persistent process, which is the whole
 * reason the worker exists), and when it does, the recording branch stops
 * needing the app at all.
 */

export interface RelayResult {
  ok: boolean;
  status?: number;
  error?: string;
}

function appUrl(): string | null {
  const base = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  return base ? base.replace(/\/+$/, '') : null;
}

export async function relayToApp(body: unknown): Promise<RelayResult> {
  const base = appUrl();
  const secret = process.env.WORKER_SHARED_SECRET;

  if (!base) return { ok: false, error: 'APP_URL is not set.' };
  if (!secret) return { ok: false, error: 'WORKER_SHARED_SECRET is not set.' };

  try {
    const res = await fetch(`${base}/api/telnyx/relay`, {
      method: 'POST',
      headers: {
        'x-worker-secret': secret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // Long enough for a cold start on the app, short enough that a wedged
      // request cannot hold a queue slot. The job retries either way.
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      return { ok: false, status: res.status, error: `app returned ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
