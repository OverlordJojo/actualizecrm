import { connection } from '../queue';

/**
 * Webhook idempotency, keyed on Telnyx's own event id (§1.2).
 *
 * Telnyx retries any delivery it does not get a 2xx for, and it retries on its
 * own schedule regardless of whether the first attempt actually succeeded —
 * a slow handler that eventually finished still gets redelivered. Without a
 * guard, every retried `call.answered` counted a second connect and every
 * retried `call.initiated` counted a second dial. That is a large share of the
 * analytics double-counting §6.1 describes, and it is fixed here rather than
 * in the metrics: the counts are correct because the events are processed once,
 * not because the aggregation compensates.
 *
 * Redis rather than Postgres because this is hot-path, write-heavy, and
 * genuinely disposable after a day. `SET NX EX` is a single atomic round trip,
 * so two deliveries arriving concurrently cannot both win.
 */

/// Telnyx stops retrying long before this. A full day gives generous headroom
/// without letting the key space grow unbounded.
const TTL_SECONDS = 60 * 60 * 24;

const KEY_PREFIX = 'telnyx:event:';

export type ClaimOutcome =
  | { claimed: true }
  | { claimed: false; reason: 'duplicate' }
  /// Redis is down. The caller decides what to do; dropping the event would be
  /// worse than processing it twice, so this is distinguished from a duplicate.
  | { claimed: false; reason: 'unavailable'; error: string };

/**
 * Claims one event id for processing.
 *
 * Returns `claimed: true` exactly once per id. Everything else is a redelivery
 * and must be dropped.
 */
export async function claimEvent(eventId: string): Promise<ClaimOutcome> {
  try {
    const result = await connection.set(
      `${KEY_PREFIX}${eventId}`,
      Date.now().toString(),
      'EX',
      TTL_SECONDS,
      'NX',
    );
    return result === 'OK' ? { claimed: true } : { claimed: false, reason: 'duplicate' };
  } catch (err) {
    return {
      claimed: false,
      reason: 'unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Releases a claim.
 *
 * Used when the event was claimed but could not be handed to the queue. Without
 * this, a failed enqueue would leave the id marked as seen for 24 hours and
 * Telnyx's retry — the thing that exists to recover exactly this case — would
 * be discarded as a duplicate.
 */
export async function releaseEvent(eventId: string): Promise<void> {
  await connection.del(`${KEY_PREFIX}${eventId}`).catch(() => {});
}
