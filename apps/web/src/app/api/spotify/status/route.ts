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

  /**
   * Which device Spotify is actually routing audio to (§4.2).
   *
   * The load-bearing field for the "connected but silent" failure: registering
   * a device does not route to it, and the only way to know the transfer landed
   * is to read this back and compare. A 204 from the transfer call proves
   * nothing.
   *
   * 204 with no body means nothing is playing anywhere, which is a legitimate
   * state rather than an error — hence the tolerant parse.
   */
  let activeDeviceId: string | null = null;
  let playbackState: string | null = null;
  try {
    const player = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (player.ok && player.status !== 204) {
      const p = await player.json();
      activeDeviceId = p?.device?.id ?? null;
      playbackState = p?.is_playing ? 'playing' : 'paused';
    } else if (player.status === 204) {
      playbackState = 'idle';
    }
  } catch {
    // Leave both null rather than claiming a state we did not observe.
  }

  return NextResponse.json({
    connected: true,
    premium,
    activeDeviceId,
    playbackState,
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
