import { NextResponse } from 'next/server';
import { buildAuthUrl } from '@/integrations/audio/spotify-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Kicks off the PKCE flow by redirecting to Spotify.
export async function GET() {
  try {
    return NextResponse.redirect(await buildAuthUrl());
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Could not start Spotify sign-in.';
    return NextResponse.redirect(
      `http://localhost:3000/settings?spotify_error=${encodeURIComponent(message)}`,
    );
  }
}
