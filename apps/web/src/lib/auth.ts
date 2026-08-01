import { scrypt, timingSafeEqual, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password verification for the single-operator gate.
 *
 * This is **not** a user model. There is no User table, no roles, no invites
 * and no `userId` on anything — the app is single-operator by design and adding
 * those would be solving a different problem. This exists because the app is
 * deployed at a public URL with every lead, recording and transcript behind it,
 * and an unauthenticated public URL is not a design decision, it is an
 * oversight.
 *
 * Node-only: `node:crypto` is unavailable on the Edge runtime, so the
 * middleware imports `lib/session.ts` instead and never touches this file.
 */

const scryptAsync = promisify(scrypt);

/// Matches the cost used to generate the stored hash.
const KEY_LENGTH = 64;

export function isConfigured(): boolean {
  return Boolean(
    process.env.AUTH_USERNAME &&
      process.env.AUTH_PASSWORD_HASH &&
      process.env.AUTH_SECRET,
  );
}

/// `salt:hash`, both hex. Generated once and stored in the environment; the
/// plaintext password is never written down anywhere the repo can see.
function storedHash(): { salt: string; hash: Buffer } | null {
  const raw = process.env.AUTH_PASSWORD_HASH;
  if (!raw) return null;
  const [salt, hash] = raw.split(':');
  if (!salt || !hash) return null;
  return { salt, hash: Buffer.from(hash, 'hex') };
}

/**
 * Constant-time credential check.
 *
 * Both the username and the password are compared without an early return, and
 * a wrong username still performs the full key derivation. Otherwise a failed
 * login answers noticeably faster for an unknown username than a known one,
 * which tells an attacker when they have guessed the first half.
 */
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  const expectedUser = process.env.AUTH_USERNAME;
  const stored = storedHash();
  if (!expectedUser || !stored) return false;

  const derived = (await scryptAsync(
    password,
    stored.salt,
    KEY_LENGTH,
  )) as Buffer;

  const passwordOk =
    derived.length === stored.hash.length && timingSafeEqual(derived, stored.hash);

  const givenUser = Buffer.from(username);
  const wantUser = Buffer.from(expectedUser);
  const userOk =
    givenUser.length === wantUser.length && timingSafeEqual(givenUser, wantUser);

  return passwordOk && userOk;
}

/// Used by the setup helper to mint a hash for a new password.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}
