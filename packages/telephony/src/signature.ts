import { createPublicKey, verify as verifySignature } from 'node:crypto';

/**
 * Telnyx webhook authentication (§1.2).
 *
 * The webhook is the one route on the worker that cannot be gated behind the
 * sign-in credential — Telnyx has no way to log in. Signature verification is
 * therefore the *only* thing standing between the public internet and a
 * handler that hangs up calls, moves leads and writes call records. An unsigned
 * request is not a degraded request; it is an unauthenticated one, and it is
 * rejected.
 *
 * Telnyx signs `${timestamp}|${rawBody}` with ed25519 and sends:
 *
 *   telnyx-signature-ed25519   base64 signature
 *   telnyx-timestamp           unix seconds
 *
 * Two consequences worth stating, because both have bitten people:
 *
 *   1. **The raw body must be verified, not a re-serialized object.** JSON
 *      round-tripping changes key order and whitespace, and the signature is
 *      over bytes. Read the body as text, verify, *then* parse.
 *   2. **The public key is per-account**, from the Telnyx portal under
 *      Account Settings → Keys. It is not the API key and not the connection
 *      id.
 */

/// ASN.1 SPKI wrapper for a bare 32-byte ed25519 key. Node's `createPublicKey`
/// will not take the raw key, and this prefix is fixed for the algorithm.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/// How far out of date a timestamp may be before the event is treated as a
/// replay. §1.2 fixes this at five minutes.
export const MAX_TIMESTAMP_AGE_SECONDS = 300;

export type SignatureFailure =
  | 'missing_public_key'
  | 'missing_signature'
  | 'missing_timestamp'
  | 'stale_timestamp'
  | 'malformed_public_key'
  | 'bad_signature';

export interface SignatureResult {
  ok: boolean;
  reason?: SignatureFailure;
  /// Human-readable, safe to log. Never contains the body or the key.
  detail?: string;
}

function publicKeyFromEnv(): Buffer | null {
  const raw = process.env.TELNYX_PUBLIC_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

/**
 * Verifies one webhook delivery.
 *
 * `rawBody` must be the exact bytes received. Passing `JSON.stringify(parsed)`
 * here will fail for reasons that look like a Telnyx bug and are not.
 */
export function verifyTelnyxSignature(params: {
  rawBody: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  /// Injectable for tests; defaults to now.
  nowSeconds?: number;
}): SignatureResult {
  const { rawBody, signature, timestamp } = params;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);

  const publicKey = publicKeyFromEnv();
  if (!publicKey) {
    return {
      ok: false,
      reason: process.env.TELNYX_PUBLIC_KEY
        ? 'malformed_public_key'
        : 'missing_public_key',
      detail: process.env.TELNYX_PUBLIC_KEY
        ? 'TELNYX_PUBLIC_KEY is not a 32-byte base64 ed25519 key.'
        : 'TELNYX_PUBLIC_KEY is not set, so no webhook can be authenticated.',
    };
  }

  if (!signature) {
    return {
      ok: false,
      reason: 'missing_signature',
      detail: 'No telnyx-signature-ed25519 header.',
    };
  }
  if (!timestamp) {
    return {
      ok: false,
      reason: 'missing_timestamp',
      detail: 'No telnyx-timestamp header.',
    };
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) {
    return {
      ok: false,
      reason: 'missing_timestamp',
      detail: 'telnyx-timestamp is not a number.',
    };
  }

  // Signed against absolute distance rather than `now - sent`, so a replay
  // carrying a *future* timestamp is refused too.
  const age = Math.abs(now - sent);
  if (age > MAX_TIMESTAMP_AGE_SECONDS) {
    return {
      ok: false,
      reason: 'stale_timestamp',
      detail: `Timestamp is ${age}s out of date (limit ${MAX_TIMESTAMP_AGE_SECONDS}s).`,
    };
  }

  let key;
  try {
    key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return {
      ok: false,
      reason: 'malformed_public_key',
      detail: 'TELNYX_PUBLIC_KEY could not be read as an ed25519 key.',
    };
  }

  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(`${timestamp}|${rawBody}`, 'utf8'),
      key,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    valid = false;
  }

  return valid
    ? { ok: true }
    : {
        ok: false,
        reason: 'bad_signature',
        detail: 'Signature does not match the body and timestamp.',
      };
}
