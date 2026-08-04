import { db, getSetting, asNumber } from '@actualizecrm/db';

/**
 * Owner attribution (§6.2), decided deterministically at call end.
 *
 * The bug this fixes is not subtle: `Call.ownerConnect` was read by the
 * analytics rollup, by the daily brief and by the export — and written by
 * nothing at all. Every owner-connect figure the app has ever shown was zero,
 * and it looked like an AI problem because attribution had been designed to
 * depend on the extraction pipeline.
 *
 * It never needed to. A person who answers and stays on the line past a
 * threshold is an owner connect by definition. AMD already says whether a human
 * picked up, the leg state already says whether they reached the operator, and
 * the clock already says how long they stayed. **The model is an enhancer, not
 * a dependency** — §6.2 requires these numbers to be identical with
 * `DEEPINFRA_API_KEY` removed, which is only possible if nothing here consults
 * it.
 *
 * Written at call end rather than derived at read time because the analytics
 * rollup would otherwise have to re-join four tables across a year of calls.
 */

/// Seconds a human must stay on the line to count as the owner rather than a
/// gatekeeper who put the phone down.
const DEFAULT_OWNER_THRESHOLD_SECONDS = 10;

export async function ownerThresholdSeconds(): Promise<number> {
  return Math.max(
    1,
    asNumber(await getSetting('analytics.ownerThresholdSeconds'), DEFAULT_OWNER_THRESHOLD_SECONDS),
  );
}

/// Outcomes the operator sets that rule out an owner connect regardless of how
/// long the call ran.
const DISQUALIFYING = new Set(['wrong_number', 'automated_system', 'abandoned']);

export interface AttributionResult {
  ownerConnect: boolean;
  nonOwnerConnect: boolean;
  reason: string;
}

/**
 * Decides and stores whether a finished call was an owner connect.
 *
 * Safe to run more than once for a call: it recomputes from stored facts rather
 * than incrementing anything, so a redelivered hangup cannot double-count. That
 * matters because §6.1's other half — double counting from non-idempotent
 * webhooks — is fixed upstream in §1.2, and this must not reintroduce it.
 */
export async function finalizeAttribution(callId: string): Promise<AttributionResult> {
  const call = await db.call.findUnique({ where: { id: callId } });
  if (!call) return { ownerConnect: false, nonOwnerConnect: false, reason: 'no such call' };

  const threshold = await ownerThresholdSeconds();

  // Every condition is a stored fact. None of them consults a model.
  const humanAnswered = call.amdResult === 'human';
  const reachedOperator = call.bridgedAt !== null;
  const heldLongEnough = call.durationSec > threshold;
  const disqualified = DISQUALIFYING.has(call.disposition ?? '');

  let ownerConnect = false;
  let nonOwnerConnect = false;
  let reason: string;

  if (!humanAnswered) {
    reason = `AMD said ${call.amdResult ?? 'nothing'} — not a human`;
  } else if (!reachedOperator) {
    // A human answered but never got to the operator: held and abandoned, or
    // hung up while the conference was being joined. Real, and not a connect.
    reason = 'human answered but never bridged to the operator';
  } else if (disqualified) {
    reason = `dispositioned ${call.disposition}`;
    nonOwnerConnect = true;
  } else if (!heldLongEnough) {
    // Answered and bridged, then gone inside the threshold. That is the
    // operator's own snap judgement that it was a gatekeeper or a recording.
    nonOwnerConnect = true;
    reason = `human, but ${call.durationSec}s is inside the ${threshold}s threshold`;
  } else {
    ownerConnect = true;
    reason = `human, bridged, ${call.durationSec}s`;
  }

  await db.call.update({
    where: { id: callId },
    data: { ownerConnect, nonOwnerConnect },
  });

  return { ownerConnect, nonOwnerConnect, reason };
}

/**
 * Lets the AI downgrade an owner connect — and only downgrade (§6.2).
 *
 * The model may say the person who answered was a gatekeeper. It is allowed to
 * take an owner connect away, never to grant one, and only above 0.90
 * confidence. Deterministic signals decide by default; this is the narrow case
 * where a high-confidence read of the transcript beats a duration heuristic.
 *
 * A no-op when the pipeline is not running, which is what keeps attribution
 * identical with the AI disabled.
 */
export async function applyGatekeeperDowngrade(params: {
  callId: string;
  isGatekeeper: boolean;
  confidence: number;
}): Promise<boolean> {
  if (!params.isGatekeeper || params.confidence <= 0.9) return false;

  const updated = await db.call.updateMany({
    where: { id: params.callId, ownerConnect: true },
    data: { ownerConnect: false, nonOwnerConnect: true },
  });
  return updated.count > 0;
}
