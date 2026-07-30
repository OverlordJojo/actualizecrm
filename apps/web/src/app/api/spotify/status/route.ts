import { NextResponse } from 'next/server';
import { getAccessToken, disconnectSpotify } from '@/integrations/audio/spotify-auth';
import { getSettings } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Whether music mode can actually work right now.
 *
 * Premium is checked explicitly because the Web Playback SDK simply refuses to
 * produce audio on a free account, with an error most people will not connect
 * to their subscription tier. Better to say it plainly in Settings.
 */
export async function GET() {
  const settings = await getSettings();
  const token = await getAccessToken();

  if (!process.env.SPOTIFY_CLIENT_ID) {
    return NextResponse.json({
      connected: false,
      premium: false,
      problem: 'SPOTIFY_CLIENT_ID is not set in .env.local.',
      playlistUri: settings['audio.spotifyPlaylistUri'],
      playlistName: settings['audio.spotifyPlaylistName'],
    });
  }

  if (!token) {
    return NextResponse.json({
      connected: false,
      premium: false,
      problem: null,
      playlistUri: settings['audio.spotifyPlaylistUri'],
      playlistName: settings['audio.spotifyPlaylistName'],
    });
  }

  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (res.status === 401) {
    await disconnectSpotify();
    return NextResponse.json({
      connected: false,
      premium: false,
      problem: 'Spotify sign-in expired — connect again.',
      playlistUri: settings['audio.spotifyPlaylistUri'],
      playlistName: settings['audio.spotifyPlaylistName'],
    });
  }

  if (!res.ok) {
    return NextResponse.json({
      connected: false,
      premium: false,
      problem: 'Could not reach Spotify.',
      playlistUri: settings['audio.spotifyPlaylistUri'],
      playlistName: settings['audio.spotifyPlaylistName'],
    });
  }

  const me = await res.json();
  const premium = me.product === 'premium';

  return NextResponse.json({
    connected: true,
    premium,
    displayName: me.display_name,
    problem: premium
      ? null
      : 'Spotify Premium is required to play music in the browser. ' +
        'Music mode will fall back to silence.',
    playlistUri: settings['audio.spotifyPlaylistUri'],
    playlistName: settings['audio.spotifyPlaylistName'],
  });
}

/// Disconnect.
export async function DELETE() {
  await disconnectSpotify();
  return NextResponse.json({ disconnected: true });
}
