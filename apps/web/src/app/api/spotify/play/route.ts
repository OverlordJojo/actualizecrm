import { NextResponse } from 'next/server';
import { getAccessToken } from '@/integrations/audio/spotify-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Starts playback of a playlist or show on our browser device.
export async function POST(request: Request) {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json({ error: 'Spotify is not connected.' }, { status: 401 });
  }

  const { deviceId, contextUri } = await request.json();

  const res = await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ context_uri: contextUri }),
    },
  );

  // 204 = success with no body, which is the normal case here.
  if (res.status === 204 || res.ok) return NextResponse.json({ playing: true });

  const body = await res.text();
  return NextResponse.json(
    { error: body || 'Spotify refused to start playback.' },
    { status: res.status },
  );
}

/// Moves playback to our browser device without starting it.
export async function PUT(request: Request) {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json({ error: 'Spotify is not connected.' }, { status: 401 });
  }

  const { deviceId } = await request.json();

  const res = await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  });

  return NextResponse.json({ transferred: res.status === 204 || res.ok });
}
