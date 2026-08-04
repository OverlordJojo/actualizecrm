import { db } from '@actualizecrm/db';
import {
  originate,
  hangup,
  encodeClientState,
  requireWebhookUrl,
  signingKeyStatus,
} from '@actualizecrm/telephony';

/**
 * The live webhook round-trip test behind Settings → "Test webhook delivery"
 * (§1.2).
 *
 * The check this replaces read an environment variable and called a non-empty
 * string proof that events were arriving. It was not proof of anything: the
 * variable held a cloudflared URL that died when the laptop closed, and it
 * stayed non-empty forever afterwards. Worse, the same check *blocked dialing*
 * — which is the false "cannot dial" state §1.1 describes.
 *
 * So this proves the only thing worth proving: that Telnyx, right now, can
 * deliver a correctly signed event to this process. It does that by asking
 * Telnyx to originate a real leg and waiting for the resulting event to come
 * back through the signature-verifying receiver.
 *
 * **It never dials a person.** The destination is one of the operator's own
 * Telnyx numbers, and the leg is hung up the instant the first event arrives —
 * in practice before anything rings. That is a deliberate constraint, not an
 * incidental one: automated tests in this project must never place a call to
 * the operator's phone.
 */

export const PROBE_KIND = 'probe';

/// §1.3 fixes the budget at ten seconds. A round trip that needs longer than
/// that is not working, whatever it eventually does.
const PROBE_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (eventType: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * In-flight probes, in memory.
 *
 * Memory is correct here rather than sloppy: a probe is meaningful only to the
 * request that started it, and that request is being held open by this same
 * process. If the worker restarts mid-probe the operator gets a failure and
 * presses the button again, which is the right outcome — a restart genuinely
 * did interrupt delivery.
 */
const pending = new Map<string, Pending>();

/// Called by the receiver when a signed event carrying a probe id arrives.
export function resolveProbe(probeId: string, eventType: string): void {
  const waiter = pending.get(probeId);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  pending.delete(probeId);
  waiter.resolve(eventType);
}

export interface ProbeResult {
  ok: boolean;
  /// Milliseconds from origination to the event arriving back.
  roundTripMs?: number;
  eventType?: string;
  webhookUrl?: string;
  /// Plain-language reason, safe to show the operator verbatim.
  error?: string;
}

export async function runWebhookProbe(): Promise<ProbeResult> {
  let webhookUrl: string;
  try {
    webhookUrl = requireWebhookUrl();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Named precisely, because "I already set it" is the expected reply: the key
  // has to be on the **worker** service, which is the process that receives
  // events. Setting it in .env.local or on Vercel changes nothing here.
  const keyStatus = signingKeyStatus();
  if (keyStatus !== 'ok') {
    return {
      ok: false,
      webhookUrl,
      error:
        keyStatus === 'missing'
          ? 'TELNYX_PUBLIC_KEY is not set on the worker service, so every incoming ' +
            'event is rejected as unsigned. Add it in Railway → the worker service → ' +
            'Variables (not the database services, and not .env.local — this process ' +
            'runs on Railway). Copy the value from the Telnyx portal under Account ' +
            'Settings → Keys → Public Key.'
          : 'TELNYX_PUBLIC_KEY is set on the worker but is not a 32-byte ed25519 key, ' +
            'so every incoming event is rejected. It was probably truncated on paste, ' +
            'or it is the API key rather than the Public Key from Telnyx portal → ' +
            'Account Settings → Keys.',
    };
  }

  const connectionId = process.env.TELNYX_CONNECTION_ID;
  if (!connectionId) return { ok: false, webhookUrl, error: 'TELNYX_CONNECTION_ID is not set.' };

  // Dialing one of our own numbers is what keeps this safe to run on demand.
  const numbers = await db.phoneNumber.findMany({
    where: { active: true },
    orderBy: { dialsSent: 'asc' },
    select: { e164: true },
    take: 2,
  });

  if (numbers.length === 0) {
    return {
      ok: false,
      webhookUrl,
      error:
        'No active phone numbers. Buy a number under Settings → Phone Numbers ' +
        'first — the test places a brief call between your own numbers.',
    };
  }

  const from = numbers[0].e164;
  // A second number when there is one: some carriers reject a call from a
  // number to itself, which would fail the test for a reason unrelated to
  // webhook delivery.
  const to = (numbers[1] ?? numbers[0]).e164;

  const probeId = crypto.randomUUID();
  const startedAt = Date.now();

  const arrival = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(probeId);
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    pending.set(probeId, { resolve, timer });
  });

  let callControlId: string | null = null;
  try {
    const call = await originate({
      to,
      from,
      connectionId,
      webhookUrl,
      clientState: encodeClientState({ k: PROBE_KIND, probeId }),
      // Short enough that a failed probe cannot leave a leg ringing.
      timeoutSecs: 10,
    });
    callControlId = call.callControlId;
  } catch (err) {
    clearTimeout(pending.get(probeId)?.timer);
    pending.delete(probeId);
    return {
      ok: false,
      webhookUrl,
      error:
        'Telnyx refused to place the test call, so webhook delivery could not ' +
        `be tested: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const eventType = await arrival;

  // Hang up regardless of outcome. A probe that leaves a leg up is worse than
  // one that fails.
  if (callControlId) await hangup(callControlId).catch(() => {});

  if (!eventType) {
    return {
      ok: false,
      webhookUrl,
      error:
        `Telnyx placed the call but no event reached ${webhookUrl} within ` +
        '10 seconds. Either the webhook URL is not registered on the connection, ' +
        'or the signature is being rejected — the worker log names which.',
    };
  }

  return {
    ok: true,
    roundTripMs: Date.now() - startedAt,
    eventType,
    webhookUrl,
  };
}
