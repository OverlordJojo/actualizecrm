import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyTelnyxSignature, decodeClientState } from '@actualizecrm/telephony';
import { enqueue } from '../queue';
import { claimEvent, releaseEvent } from './dedupe';
import { resolveProbe, PROBE_KIND } from './probe';

/**
 * The Telnyx webhook endpoint (§1.2).
 *
 * Four rules, each of which exists because breaking it produces a specific
 * failure that is hard to see from the outside:
 *
 *   1. **Verify before parsing.** The signature covers the raw bytes. Parsing
 *      first and re-serializing to verify changes key order and fails.
 *   2. **Reject the unsigned.** This is the one route that cannot sit behind
 *      the operator's sign-in gate, so the signature is the whole of its
 *      authentication. An unauthenticated request that reaches the handler can
 *      hang up live calls.
 *   3. **Answer 200 immediately, work later.** Telnyx times out fast and
 *      retries on anything else, so a slow handler turns one event into a
 *      retry storm. The event goes to BullMQ and this returns.
 *   4. **Claim before enqueueing.** Redelivery is normal, not exceptional, and
 *      processing a `call.answered` twice counts two connects.
 *
 * Rejections are deliberately terse. A detailed error body on an unauthenticated
 * endpoint tells an attacker how close they got.
 */

/// Telnyx will not retry a 2xx. Used for events that are validly signed but
/// that we have no interest in — retrying them would change nothing.
const ACCEPTED = { received: true };

interface TelnyxEnvelope {
  data?: {
    id?: string;
    event_type?: string;
    occurred_at?: string;
    payload?: Record<string, unknown>;
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/// Reads the body as raw text. Capped, because an unauthenticated endpoint
/// must not let a caller decide how much memory to allocate.
const MAX_BODY_BYTES = 1_000_000;

function readRawBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (!aborted) {
        aborted = true;
        resolve(null);
      }
    });
  });
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

export async function handleTelnyxWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawBody = await readRawBody(req);
  if (rawBody === null) {
    send(res, 413, { error: 'Body too large.' });
    return;
  }

  const verdict = verifyTelnyxSignature({
    rawBody,
    signature: headerValue(req, 'telnyx-signature-ed25519'),
    timestamp: headerValue(req, 'telnyx-timestamp'),
  });

  if (!verdict.ok) {
    // Logged in full because these are the only requests worth alerting on, and
    // a misconfigured TELNYX_PUBLIC_KEY looks identical to an attack from the
    // outside — the log is where the two are told apart.
    console.warn(`[telnyx] rejected webhook: ${verdict.reason} — ${verdict.detail}`);
    send(res, 401, { error: 'Invalid signature.' });
    return;
  }

  let envelope: TelnyxEnvelope;
  try {
    envelope = JSON.parse(rawBody) as TelnyxEnvelope;
  } catch {
    // Signed but unparseable. Retrying will not help, so take it off Telnyx's
    // hands rather than inviting redelivery.
    send(res, 200, ACCEPTED);
    return;
  }

  const eventId = envelope.data?.id;
  const eventType = envelope.data?.event_type;

  if (!eventId || !eventType) {
    send(res, 200, ACCEPTED);
    return;
  }

  const claim = await claimEvent(eventId);

  if (!claim.claimed && claim.reason === 'duplicate') {
    // The normal, expected path for a retry. Not a warning.
    send(res, 200, { received: true, duplicate: true });
    return;
  }

  if (!claim.claimed) {
    // Redis is unreachable. Processing twice is recoverable; dropping a
    // `call.answered` is not, so ask Telnyx to try again.
    console.error(`[telnyx] could not claim ${eventId}: ${claim.error}`);
    send(res, 503, { error: 'Temporarily unavailable.' });
    return;
  }

  // The webhook-delivery test (§1.2) resolves here, before the queue. What it
  // is proving is that a signed event from Telnyx reached this process — the
  // work the event triggers is a separate question and is not what the button
  // claims.
  const state = decodeClientState(
    envelope.data?.payload?.client_state as string | undefined,
  );
  if (state?.k === PROBE_KIND) {
    resolveProbe(String(state.probeId ?? ''), eventType);
  }

  try {
    await enqueue(
      {
        type: 'telnyx.event',
        // Telnyx's id is already unique per event, and BullMQ dedupes on job
        // id — a second layer behind the Redis claim.
        jobKey: `telnyx:${eventId}`,
        payload: { eventId, eventType, body: JSON.parse(rawBody) },
      },
      // Call events are worthless once the call is long over, so a stuck event
      // should not retry for an hour. Three quick attempts, then let it go.
      { attempts: 3, backoff: { type: 'exponential', delay: 1_000 } },
    );
  } catch (err) {
    await releaseEvent(eventId);
    console.error('[telnyx] could not enqueue event', err);
    send(res, 503, { error: 'Temporarily unavailable.' });
    return;
  }

  send(res, 200, ACCEPTED);
}
