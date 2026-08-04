import { db } from '@/lib/db';
import { getSetting, asNumber } from '@/lib/settings';
import { telnyxWebhookUrl } from '@/lib/worker';
import {
  originate,
  speak,
  playAudio,
  stopPlayback,
  hangup,
  transferToOperator,
  encodeClientState,
} from './recording';
import { operatorSipUri } from './webrtc';
import { pickCallerId } from './caller-id';
import { resolveRecording, playbackUrl } from '@/integrations/audio/voicemail';
import { allowedLinesNow, recordAbandoned } from './governor';

/**
 * Multi-line burst dialing (§4.3, §4.4).
 *
 * **This does not reduce spam labelling — it increases it.** Carrier analytics
 * flag high call volume per number and short-duration calls, and a burst
 * produces both. The genuine mitigation is number rotation with area-code
 * matching plus retiring numbers on a schedule, which the dialer already does.
 * What bursts buy is throughput, paid for in abandoned calls.
 *
 * Shape of a burst:
 *
 *   - N legs originate simultaneously, each from a **different** owned number.
 *     Two concurrent calls from one number is the most obvious pattern there
 *     is for analytics to catch.
 *   - Premium AMD runs on every leg. Machines, faxes and IVRs are disposed of
 *     silently; the operator is never notified about them, because a
 *     notification the operator cannot act on is just an interruption.
 *   - The first human is transferred to the operator's softphone.
 *   - Every additional human hears an identification prompt and hold audio,
 *     and is parked in the held queue. On the next advance the oldest held
 *     call is bridged *instead of* starting a new burst.
 *   - A held call that outlives `HOLD_MAX_SECONDS` gets an apology, a hangup,
 *     and a permanent record as abandoned. That number feeds the governor,
 *     which is what keeps the operation under the 3% legal cap.
 */

/// State attached to every burst leg, echoed back by Telnyx on each event.
export interface BurstState {
  k: 'burst';
  burstId: string;
  callId: string;
  /// 0-based position within the burst, purely for diagnostics.
  position: number;
}

export function burstState(raw: unknown): BurstState | null {
  const s = raw as BurstState | null;
  return s && s.k === 'burst' ? s : null;
}

export const HOLD_MIN_SECONDS = 10;
export const HOLD_MAX_SECONDS_CAP = 45;

export async function holdMaxSeconds(): Promise<number> {
  return Math.min(
    Math.max(asNumber(await getSetting('dialer.holdMaxSeconds'), 25), HOLD_MIN_SECONDS),
    HOLD_MAX_SECONDS_CAP,
  );
}

/**
 * The identification prompt a queued owner hears.
 *
 * Not decoration. 47 CFR 64.1200 requires an abandoned call to carry a
 * recorded identification of the caller within two seconds of the greeting, so
 * this names the business rather than saying "please hold". It doubles as the
 * thing that stops people hanging up into silence.
 */
export async function holdPrompt(): Promise<string> {
  const configured = await getSetting('dialer.holdPrompt');
  if (configured.trim()) return configured.trim();

  const from = await getSetting('email.fromName');
  const who = from.trim() || 'ActualizeCRM';
  return `Hello, this is ${who} calling. One moment please, connecting you now.`;
}

export interface BurstLeg {
  callId: string;
  contactId: string;
  to: string;
  from: string;
  callControlId: string | null;
  error?: string;
}

/**
 * Opens a burst.
 *
 * Consults the governor immediately before originating and never from a cache:
 * the whole point is that the rate reacts inside the session causing it.
 */
export async function startBurst(
  contactIds: string[],
): Promise<{ burstId: string; legs: BurstLeg[]; allowedLines: number }> {
  const connectionId = process.env.TELNYX_CONNECTION_ID;
  if (!connectionId) throw new Error('TELNYX_CONNECTION_ID is not set.');

  // Events for these legs go to the worker, not back here (§1.2). Pointing them
  // at the app would send them to a route that no longer exists.
  const webhookUrl = telnyxWebhookUrl();
  if (!webhookUrl) {
    throw new Error(
      'WORKER_URL is not set, so Telnyx has nowhere to report what these calls do.',
    );
  }

  const allowed = await allowedLinesNow();
  const wanted = contactIds.slice(0, allowed);

  const burstId = crypto.randomUUID();
  const legs: BurstLeg[] = [];
  const usedNumbers = new Set<string>();

  for (let i = 0; i < wanted.length; i++) {
    const contact = await db.contact.findUnique({ where: { id: wanted[i] } });
    if (!contact || contact.doNotContact) continue;

    // Each leg from a different owned number.
    let from = await pickCallerId(contact.phone);
    if (from && usedNumbers.has(from.id)) {
      const alt = await db.phoneNumber.findFirst({
        where: { active: true, id: { notIn: Array.from(usedNumbers) } },
        orderBy: { dialsSent: 'asc' },
      });
      from = alt ? { id: alt.id, e164: alt.e164 } : null;
    }
    // Running out of distinct numbers caps the burst rather than doubling up.
    if (!from) break;
    usedNumbers.add(from.id);

    const call = await db.call.create({
      data: {
        contactId: contact.id,
        toE164: contact.phone,
        fromE164: from.e164,
        fromNumberId: from.id,
        status: 'ringing',
        burstId,
      },
    });

    try {
      const originated = await originate({
        to: contact.phone,
        from: from.e164,
        connectionId,
        webhookUrl,
        clientState: encodeClientState({
          k: 'burst',
          burstId,
          callId: call.id,
          position: i,
        }),
      });

      await db.call.update({
        where: { id: call.id },
        data: {
          callControlId: originated.callControlId,
          callSessionId: originated.callSessionId,
        },
      });

      await db.$transaction([
        db.phoneNumber.update({
          where: { id: from.id },
          data: { dialsSent: { increment: 1 } },
        }),
        db.contact.update({
          where: { id: contact.id },
          data: { dialCount: { increment: 1 }, lastDialedAt: new Date() },
        }),
      ]);

      legs.push({
        callId: call.id,
        contactId: contact.id,
        to: contact.phone,
        from: from.e164,
        callControlId: originated.callControlId,
      });
    } catch (err) {
      await db.call.update({
        where: { id: call.id },
        data: { status: 'failed', endedAt: new Date() },
      });
      legs.push({
        callId: call.id,
        contactId: contact.id,
        to: contact.phone,
        from: from.e164,
        callControlId: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { burstId, legs, allowedLines: allowed };
}

/// True when some leg in this burst has already been sent to the operator.
async function operatorIsBusy(burstId: string): Promise<boolean> {
  const bridged = await db.call.count({
    where: { burstId, status: { in: ['bridged', 'answered'] } },
  });
  return bridged > 0;
}

/**
 * A human answered. Either they get the operator, or they get the hold queue.
 *
 * Claimed with a conditional update so two legs answering in the same instant
 * cannot both believe they won — the loser falls through to being held, which
 * is exactly the queued-owner rule.
 */
export async function routeHumanAnswer(
  callControlId: string,
  state: BurstState,
): Promise<'bridged' | 'held' | 'ignored'> {
  const busy = await operatorIsBusy(state.burstId);

  if (!busy) {
    const won = await db.call.updateMany({
      where: { id: state.callId, status: 'ringing' },
      data: { status: 'answered', answeredAt: new Date() },
    });
    if (won.count === 0) return 'ignored';

    const sipUri = await operatorSipUri();
    const call = await db.call.findUnique({ where: { id: state.callId } });

    if (!sipUri || !call) {
      // No route to the operator — better to release the prospect than leave
      // them listening to nothing.
      await hangup(callControlId).catch(() => {});
      return 'ignored';
    }

    await transferToOperator(
      callControlId,
      sipUri,
      call.toE164,
      encodeClientState({ ...state }),
    );

    await db.call.update({
      where: { id: state.callId },
      data: { status: 'bridged' },
    });

    return 'bridged';
  }

  // --- the queued-owner rule ----------------------------------------------
  await db.call.updateMany({
    where: { id: state.callId, status: 'ringing' },
    data: { status: 'held', answeredAt: new Date() },
  });

  // A human picked up, which is what "owner verified" means here regardless of
  // whether the operator ever got to speak to them.
  const call = await db.call.findUnique({ where: { id: state.callId } });
  if (call) {
    await db.contact.update({
      where: { id: call.contactId },
      data: { everConnected: true, connectCount: { increment: 1 } },
    });
  }

  await speak(callControlId, await holdPrompt(), encodeClientState({ ...state })).catch(
    () => {},
  );

  return 'held';
}

/// Hold music after the prompt finishes, when the operator has configured a
/// recording for it. Silence is what makes people hang up.
export async function startHoldAudio(callControlId: string): Promise<void> {
  const id = await getSetting('dialer.holdMusicRecordingId');
  if (!id) return;

  const recording = await resolveRecording(id);
  if (!recording) return;

  try {
    const url = await playbackUrl(recording);
    await playAudio(callControlId, url);
  } catch {
    // Hold music failing is not worth dropping the call over.
  }
}

/**
 * A machine, fax or IVR answered.
 *
 * The operator is never notified. §4.3 is explicit about this and it is the
 * right call: an interruption they cannot act on during a live conversation is
 * strictly worse than a line in the timeline they can read later.
 */
export async function routeNonHumanAnswer(
  callControlId: string,
  state: BurstState,
  verdict: string | null,
): Promise<'voicemail' | 'automated'> {
  const isMachine = verdict === 'machine';

  const call = await db.call.findUnique({ where: { id: state.callId } });
  if (!call) return isMachine ? 'voicemail' : 'automated';

  if (isMachine) {
    // Drop the voicemail only if the operator has one configured *and* has
    // switched bulk dropping on. Leaving a message on every burst machine
    // without that being an explicit choice is not something to do quietly.
    const dropEnabled = (await getSetting('dialer.burstVoicemailDrop')) === 'true';
    const recording = dropEnabled ? await resolveRecording(null) : null;

    if (recording) {
      try {
        const url = await playbackUrl(recording);
        await playAudio(
          callControlId,
          url,
          encodeClientState({ k: 'vmdrop', callId: call.id, recordingId: recording.id }),
        );
        await db.call.update({
          where: { id: call.id },
          data: { status: 'answered', answeredAt: new Date(), voicemailDropped: true },
        });
      } catch {
        await hangup(callControlId).catch(() => {});
      }
    } else {
      await hangup(callControlId).catch(() => {});
    }

    await setSystemDisposition(call.id, call.contactId, 'voicemail');
    return 'voicemail';
  }

  await hangup(callControlId).catch(() => {});
  await setSystemDisposition(call.id, call.contactId, 'automated_system');
  return 'automated';
}

async function setSystemDisposition(
  callId: string,
  contactId: string,
  disposition: 'voicemail' | 'automated_system',
): Promise<void> {
  await db.call.update({ where: { id: callId }, data: { disposition } });
  await db.contact.update({
    where: { id: contactId },
    data: { lastDisposition: disposition, noAnswerStreak: 0 },
  });
  await db.activity.create({
    data: {
      contactId,
      type: 'disposition',
      direction: 'outbound',
      summary:
        disposition === 'voicemail'
          ? 'Reached a machine on a multi-line burst'
          : 'Reached an automated system on a multi-line burst',
      callId,
      meta: { disposition, source: 'burst', notifiedOperator: false },
    },
  });
}

export interface HeldCall {
  callId: string;
  contactId: string;
  callControlId: string | null;
  toE164: string;
  heldSeconds: number;
}

/// Everyone currently parked, oldest first — the order they get bridged in.
export async function heldQueue(): Promise<HeldCall[]> {
  const rows = await db.call.findMany({
    where: { status: 'held' },
    orderBy: { answeredAt: 'asc' },
    select: {
      id: true,
      contactId: true,
      callControlId: true,
      toE164: true,
      answeredAt: true,
    },
  });

  const now = Date.now();
  return rows.map((r) => ({
    callId: r.id,
    contactId: r.contactId,
    callControlId: r.callControlId,
    toE164: r.toE164,
    heldSeconds: r.answeredAt ? Math.round((now - r.answeredAt.getTime()) / 1000) : 0,
  }));
}

/**
 * Bridges the longest-waiting held call to the operator.
 *
 * Called on advance *instead of* starting a new burst: somebody already
 * listening to hold music has a far stronger claim on the operator than a
 * lead who has not been dialled yet, and draining first is what keeps the
 * abandonment rate down.
 */
export async function bridgeOldestHeld(): Promise<HeldCall | null> {
  const queue = await heldQueue();
  const next = queue[0];
  if (!next?.callControlId) return null;

  const sipUri = await operatorSipUri();
  if (!sipUri) return null;

  // Stop the hold music first, or it plays over the operator's greeting.
  await stopPlayback(next.callControlId).catch(() => {});

  await transferToOperator(next.callControlId, sipUri, next.toE164).catch(() => null);

  await db.call.update({
    where: { id: next.callId },
    data: { status: 'bridged', heldSeconds: next.heldSeconds },
  });

  return next;
}

/**
 * Gives up on anyone held past the limit.
 *
 * They hear an apology rather than a click — the call was ours, and hanging up
 * silently on someone who waited is both rude and exactly the behaviour the
 * abandonment rules exist to discourage.
 */
export async function sweepExpiredHolds(): Promise<number> {
  const limit = await holdMaxSeconds();
  const queue = await heldQueue();

  let abandoned = 0;
  for (const held of queue) {
    if (held.heldSeconds < limit) continue;

    if (held.callControlId) {
      await stopPlayback(held.callControlId).catch(() => {});
      await speak(
        held.callControlId,
        "I'm sorry, no one is available to take your call right now. We'll try you again shortly. Goodbye.",
      ).catch(() => {});
      // Give the apology a moment to play before the leg goes away.
      await new Promise((r) => setTimeout(r, 3500));
      await hangup(held.callControlId).catch(() => {});
    }

    await recordAbandoned(held.callId, held.heldSeconds);
    abandoned++;
  }

  return abandoned;
}
