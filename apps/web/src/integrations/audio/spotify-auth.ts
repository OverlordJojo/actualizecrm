/**
 * Spotify Authorization Code flow with PKCE.
 *
 * PKCE means no client secret ever reaches the browser, and none is needed on
 * the server either — which matters here because this app is local-first and
 * has no secure backend to speak of.
 *
 * Tokens live in the Setting table rather than localStorage so a page reload
 * mid-session does not silently drop the music.
 */
import { db } from '@/lib/db';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export const SPOTIFY_REDIRECT_URI = 'http://localhost:3000/api/spotify/callback';

/// streaming = play audio in the browser (Premium only).
/// The read scopes are for listing the operator's own playlists.
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

const KEY_ACCESS = 'audio.spotifyAccessToken';
const KEY_REFRESH = 'audio.spotifyRefreshToken';
const KEY_EXPIRES = 'audio.spotifyExpiresAt';
const KEY_VERIFIER = 'audio.spotifyCodeVerifier';

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function createVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

async function put(key: string, value: string) {
  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

async function get(key: string): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function storeVerifier(verifier: string) {
  await put(KEY_VERIFIER, verifier);
}

export async function takeVerifier(): Promise<string | null> {
  const v = await get(KEY_VERIFIER);
  if (v) await put(KEY_VERIFIER, '');
  return v || null;
}

export async function buildAuthUrl(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) throw new Error('SPOTIFY_CLIENT_ID is not set in .env.local.');

  const verifier = createVerifier();
  await storeVerifier(verifier);
  const challenge = await challengeFor(verifier);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });

  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string, verifier: string) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) throw new Error('SPOTIFY_CLIENT_ID is not set.');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      json.error_description ?? json.error ?? 'Spotify rejected the sign-in.',
    );
  }

  await saveTokens(json);
  return json;
}

async function saveTokens(t: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}) {
  await put(KEY_ACCESS, t.access_token);
  if (t.refresh_token) await put(KEY_REFRESH, t.refresh_token);
  await put(KEY_EXPIRES, String(Date.now() + t.expires_in * 1000));
}

/**
 * Returns a usable access token, refreshing when it is close to expiry.
 *
 * The 60-second margin matters: a token that expires mid-call would kill the
 * music at the worst possible moment.
 */
export async function getAccessToken(): Promise<string | null> {
  const access = await get(KEY_ACCESS);
  const expiresAt = Number((await get(KEY_EXPIRES)) ?? 0);

  if (access && Date.now() < expiresAt - 60_000) return access;

  const refresh = await get(KEY_REFRESH);
  if (!refresh) return null;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) return null;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
    }),
  });

  if (!res.ok) return null;

  const json = await res.json();
  await saveTokens(json);
  return json.access_token;
}

export async function disconnectSpotify() {
  await Promise.all([
    put(KEY_ACCESS, ''),
    put(KEY_REFRESH, ''),
    put(KEY_EXPIRES, '0'),
  ]);
}

export async function isConnected(): Promise<boolean> {
  return (await get(KEY_REFRESH)) !== null && (await get(KEY_REFRESH)) !== '';
}
