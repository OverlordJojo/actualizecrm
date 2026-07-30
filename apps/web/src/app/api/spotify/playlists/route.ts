import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAccessToken } from '@/integrations/audio/spotify-auth';
import { setSettings } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// The operator's own playlists and saved shows. Podcasts are included
/// deliberately — the spec is "songs, podcast episodes, anything".
export async function GET() {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json({ error: 'Spotify is not connected.' }, { status: 401 });
  }

  const auth = { Authorization: `Bearer ${token}` };

  const [playlistsRes, showsRes] = await Promise.all([
    fetch('https://api.spotify.com/v1/me/playlists?limit=50', {
      headers: auth,
      cache: 'no-store',
    }),
    fetch('https://api.spotify.com/v1/me/shows?limit=50', {
      headers: auth,
      cache: 'no-store',
    }),
  ]);

  if (!playlistsRes.ok) {
    return NextResponse.json(
      { error: 'Could not load your playlists.' },
      { status: playlistsRes.status },
    );
  }

  const playlists = await playlistsRes.json();
  const items = (playlists.items ?? []).map((p: any) => ({
    uri: p.uri,
    name: p.name,
    kind: 'playlist' as const,
    trackCount: p.tracks?.total ?? 0,
  }));

  // Saved shows are a nice-to-have; a failure here should not break the picker.
  if (showsRes.ok) {
    const shows = await showsRes.json();
    for (const s of shows.items ?? []) {
      items.push({
        uri: s.show.uri,
        name: s.show.name,
        kind: 'show' as const,
        trackCount: s.show.total_episodes ?? 0,
      });
    }
  }

  return NextResponse.json(items);
}

const selectSchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
});

/// Remembers which playlist to play while calls ring.
export async function POST(request: Request) {
  const parsed = selectSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid selection.' }, { status: 400 });
  }

  await setSettings({
    'audio.spotifyPlaylistUri': parsed.data.uri,
    'audio.spotifyPlaylistName': parsed.data.name,
  });

  return NextResponse.json({ saved: true });
}
