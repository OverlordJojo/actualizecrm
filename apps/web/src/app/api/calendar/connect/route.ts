import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { authUrl, isConfigured } from '@/integrations/calendar/google';
import { appBaseUrl } from '@/lib/base-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Starts the Google OAuth round trip. The redirect URI is derived from the
/// incoming request so connecting through the tunnel comes back to the tunnel.
export async function GET(request: Request) {
  if (!isConfigured()) {
    return NextResponse.redirect(
      `${appBaseUrl(request)}/settings?calendar_error=${encodeURIComponent(
        'Google credentials or CALENDAR_ENCRYPTION_KEY are not set.',
      )}`,
    );
  }

  const redirectUri = `${appBaseUrl(request)}/api/calendar/callback`;
  // Signed-in-only route, but a state nonce still matters: it stops a third
  // party from walking the operator through a connect flow for *their* Google
  // account and silently redirecting the operator's bookings.
  const state = randomBytes(16).toString('hex');

  const response = NextResponse.redirect(authUrl(redirectUri, state));
  response.cookies.set({
    name: 'calendar_oauth_state',
    value: state,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600,
  });
  return response;
}
