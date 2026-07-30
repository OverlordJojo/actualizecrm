import { NextResponse } from 'next/server';
import { getAccessToken } from '@/integrations/audio/spotify-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// The Web Playback SDK calls this whenever it needs a fresh token, including
/// mid-session when the old one expires.
export async function GET() {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json(
      { error: 'Spotify is not connected.' },
      { status: 401 },
    );
  }
  return NextResponse.json({ token });
}
