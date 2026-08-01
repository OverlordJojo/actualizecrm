/**
 * Session cookie signing and verification.
 *
 * Kept free of `node:crypto` on purpose: the middleware that gates every route
 * runs on the Edge runtime, where only Web Crypto exists. Password hashing
 * lives in `lib/auth.ts`, which is imported solely by the login route and runs
 * under Node.
 *
 * The token is a signed statement, not an opaque id — there is no session
 * table, because there is exactly one operator and a database round trip on
 * every request to learn something we already signed is waste.
 */

export const SESSION_COOKIE = 'actualize_session';

/// Long enough that the operator is not logged out mid-dialing-day, short
/// enough that a forgotten laptop is not indefinitely open.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      'AUTH_SECRET is missing or too short. Generate one with ' +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`.',
    );
  }
  return value;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  );
  return base64url(new Uint8Array(signature));
}

export interface SessionPayload {
  /// Who the session is for. One operator, but naming it keeps the token
  /// self-describing rather than a bare timestamp.
  sub: string;
  /// Unix seconds.
  exp: number;
}

export async function signSession(sub: string): Promise<string> {
  const payload: SessionPayload = {
    sub,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmac(body)}`;
}

/**
 * Returns the payload when the token is genuine and unexpired, otherwise null.
 *
 * The signature is compared with a constant-time scan. A byte-by-byte early
 * return leaks how much of a forged signature was correct, which is enough to
 * reconstruct one guess at a time.
 */
export async function verifySession(
  token: string | undefined,
): Promise<SessionPayload | null> {
  if (!token) return null;

  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  let expected: string;
  try {
    expected = await hmac(body);
  } catch {
    // Misconfigured secret — fail closed rather than letting everyone in.
    return null;
  }

  if (provided.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (mismatch !== 0) return null;

  try {
    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64url(body)),
    ) as SessionPayload;
    if (typeof payload.exp !== 'number') return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
