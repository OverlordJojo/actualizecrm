import { NextResponse } from 'next/server';
import { exchangeCode, takeVerifier } from '@/integrations/audio/spotify-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SETTINGS = 'http://localhost:3000/settings';

/// Spotify redirects here after the operator approves. Always lands back on
/// Settings, with the outcome in the query string.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const error = params.get('error');
  if (error) {
    return NextResponse.redirect(
      `${SETTINGS}?spotify_error=${encodeURIComponent(
        error === 'access_denied' ? 'Spotify sign-in was cancelled.' : error,
      )}`,
    );
  }

  const code = params.get('code');
  if (!code) {
    return NextResponse.redirect(
      `${SETTINGS}?spotify_error=${encodeURIComponent('Spotify sent no code back.')}`,
    );
  }

  const verifier = await takeVerifier();
  if (!verifier) {
    return NextResponse.redirect(
      `${SETTINGS}?spotify_error=${encodeURIComponent(
        'Sign-in expired — start it again from Settings.',
      )}`,
    );
  }

  try {
    await exchangeCode(code, verifier);
    return NextResponse.redirect(`${SETTINGS}?spotify=connected`);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Could not finish Spotify sign-in.';
    return NextResponse.redirect(
      `${SETTINGS}?spotify_error=${encodeURIComponent(message)}`,
    );
  }
}
