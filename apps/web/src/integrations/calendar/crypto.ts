import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for the Google refresh token.
 *
 * A refresh token is a standing key to the operator's calendar that does not
 * expire on its own, so it is the one credential in this app worth encrypting
 * at rest rather than storing as a plain Setting value. GCM rather than CBC
 * because it authenticates as well as encrypts: a tampered ciphertext fails to
 * decrypt instead of yielding plausible garbage.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;

function key(): Buffer {
  const hex = process.env.CALENDAR_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'CALENDAR_ENCRYPTION_KEY is not set. Generate 32 bytes of hex with ' +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`.',
    );
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `CALENDAR_ENCRYPTION_KEY must be 32 bytes of hex (64 characters); got ${buf.length} bytes.`,
    );
  }
  return buf;
}

/// Returns `iv:tag:ciphertext`, all hex. Self-describing, so a future key
/// rotation can tell an encrypted value from a legacy plaintext one.
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    ciphertext.toString('hex'),
  ].join(':');
}

export function decrypt(stored: string): string {
  const [ivHex, tagHex, dataHex] = stored.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Stored calendar token is not in the expected format.');
  }

  const tag = Buffer.from(tagHex, 'hex');
  if (tag.length !== TAG_BYTES) {
    throw new Error('Stored calendar token has a malformed authentication tag.');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

export function isConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}
