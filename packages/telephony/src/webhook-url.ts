/**
 * Where Telnyx sends call events (§1.1, §1.2).
 *
 * v1 tunnelled to the operator's laptop with cloudflared, which handed out a
 * **new hostname on every run**. That is why the Settings page grew a check for
 * a stored tunnel URL, and why that check ended up blocking dialing: the app is
 * deployed now, the hostname is stable, and the absence of a tunnel means
 * nothing at all.
 *
 * Railway injects `RAILWAY_PUBLIC_DOMAIN` into every deploy, so the worker
 * knows its own address without being told. `WEBHOOK_BASE_URL` overrides it for
 * local development, where there is no injected domain and events have to be
 * pointed somewhere by hand.
 */

export const WEBHOOK_PATH = '/api/telnyx/webhook';

/**
 * Bare origin of the service receiving webhooks, or null if undeterminable.
 *
 * Three sources, in order, because this module is read from **two different
 * processes** and each knows the answer by a different name:
 *
 *   1. `WEBHOOK_BASE_URL` — explicit override, for running the worker locally.
 *   2. `RAILWAY_PUBLIC_DOMAIN` — the worker's own address, injected by Railway.
 *      Only ever set inside the worker.
 *   3. `WORKER_URL` — the *app's* name for the worker. The app originates legs
 *      too (session start, bursts), and on Vercel neither of the above exists.
 *
 * Leaving out the third is what made "Start session" fail with "No webhook base
 * URL" on a deployment where webhooks were demonstrably working: the worker
 * could resolve its own address and the app could not, even though both were
 * talking about the same host.
 */
export function webhookBaseUrl(): string | null {
  const normalise = (v: string) =>
    (v.startsWith('http') ? v : `https://${v}`).replace(/\/+$/, '');

  const explicit = process.env.WEBHOOK_BASE_URL?.trim();
  if (explicit) return normalise(explicit);

  // Railway gives a bare hostname, not a URL, and it is always TLS-terminated.
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return normalise(railway);

  const worker = process.env.WORKER_URL?.trim();
  if (worker) return normalise(worker);

  return null;
}

export function webhookUrl(): string | null {
  const base = webhookBaseUrl();
  return base ? `${base}${WEBHOOK_PATH}` : null;
}

/// The same value, but throwing rather than returning null — for callers that
/// cannot proceed without it and want the reason in the stack trace.
export function requireWebhookUrl(): string {
  const url = webhookUrl();
  if (!url) {
    throw new Error(
      'No webhook base URL, so Telnyx would have nowhere to report what this ' +
        'call does. The worker gets this from RAILWAY_PUBLIC_DOMAIN and the app ' +
        'from WORKER_URL — set WORKER_URL on the web deployment, or ' +
        'WEBHOOK_BASE_URL when running the worker locally.',
    );
  }
  return url;
}
