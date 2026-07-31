/**
 * The app's own base URL, for building redirects back into the UI.
 *
 * Derived from the incoming request rather than hardcoded, so an operator who
 * reached the app through the cloudflared tunnel is sent back to the tunnel
 * and not bounced to a localhost URL their browser session did not come from.
 */
export function appBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (explicit) return explicit.replace(/\/$/, '');

  // Behind cloudflared the request URL is already the public one, but proxies
  // vary; prefer the forwarded headers when present.
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto =
    request.headers.get('x-forwarded-proto') ??
    (host?.startsWith('localhost') || host?.startsWith('127.0.0.1')
      ? 'http'
      : 'https');

  if (host) return `${proto}://${host}`;

  return new URL(request.url).origin;
}

/// Redirect target for the Settings page, with an optional query string.
export function settingsUrl(request: Request, query?: string): string {
  return `${appBaseUrl(request)}/settings${query ? `?${query}` : ''}`;
}
