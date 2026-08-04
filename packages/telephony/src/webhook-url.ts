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

/// Bare origin of the service receiving webhooks, or null when it cannot be
/// determined — which off Railway means `WEBHOOK_BASE_URL` was not set.
export function webhookBaseUrl(): string | null {
  const explicit = process.env.WEBHOOK_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  // Railway gives a bare hostname, not a URL, and it is always TLS-terminated.
  if (railway) return `https://${railway.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

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
      'No webhook base URL. On Railway this comes from RAILWAY_PUBLIC_DOMAIN ' +
        'automatically; locally, set WEBHOOK_BASE_URL to a publicly reachable origin.',
    );
  }
  return url;
}
