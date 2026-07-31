import { NextResponse } from 'next/server';
import { buildAuthUrl } from '@/integrations/audio/spotify-auth';
import { settingsUrl } from '@/lib/base-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Kicks off the PKCE flow by redirecting to Spotify.
export async function GET(request: Request) {
  try {
    return NextResponse.redirect(await buildAuthUrl());
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Could not start Spotify sign-in.';
    return NextResponse.redirect(
      settingsUrl(request, `spotify_error=${encodeURIComponent(message)}`),
    );
  }
}
