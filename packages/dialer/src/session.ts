import { db, getSetting, asNumber } from '@actualizecrm/db';
import {
  originate,
  originateOperatorLeg,
  hangup,
  encodeClientState,
  requireCallControlAppId,
  requireWebhookUrl,
  createConference,
  joinConference,
  leaveConference,
  muteParticipants,
  unmuteParticipants,
  holdParticipants,
  unholdParticipants,
  speakToConference,
  isHumanVerdict,
  isMachineVerdict,
  isFaxVerdict,
  findConferenceByName,
} from '@actualizecrm/telephony';
import { pickCallerId, operatorSipUri } from './routing';
import type { SessionLegState } from './state';

/**
 * Session lifecycle for the conference-anchored dialer (§2.2).
 *
 * The ordering below is forced by Telnyx rather than chosen, and getting it
 * wrong produces silence rather than an error:
 *
 *   1. Originate the operator's leg to their softphone.
 *   2. Wait for them to answer. Only then can a conference exist — Telnyx
 *      creates one *from* a live leg and has no empty-conference primitive.
 *   3. Create the conference around that leg, muted.
 *   4. Only now open bursts.
 *
 * Step 2 is why `startSession` returns before the session is usable and the
 * webhook finishes the job. Anything that tries to collapse this into one
 * synchronous call ends up creating conferences that never start.
 */

export const HOLD_MIN_SECONDS = 10;
export const HOLD_MAX_SECONDS_CAP = 45;

export async function holdMaxSeconds(): Promise<number> {
  return Math.min(
    Math.max(asNumber(await getSetting('dialer.holdMaxSeconds'), 25), HOLD_MIN_SECONDS),
    HOLD_MAX_SECONDS_CAP,
  );
}

/**
 * The identification a queued owner hears before the hold music.
 *
 * Not decoration. 47 CFR 64.1200 requires an abandoned call to carry a recorded
 * identification of the caller within two seconds of the greeting, so this names
 * the business rather than saying "please hold" — and it doubles as the thing
 * that stops people hanging up into silence.
 */
export async function holdPrompt(): Promise<string> {
  const configured = await getSetting('dialer.holdPrompt');
  if (configured.trim()) return configured.trim();

  const from = await getSetting('email.fromName');
  return `Hello, this is ${from.trim() || 'ActualizeCRM'} calling. One moment please, connecting you now.`;
}

function legState(state: SessionLegState): string {
  return encodeClientState(state as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Starting and ending
// ---------------------------------------------------------------------------

export interface StartSessionParams {
  contactIds: string[];
  linesPerBurst: number;
  sourceType: string;
  sourceName?: string;
}

/**
 * Opens a session by calling the operator's own softphone.
 *
 * Nothing is dialled to a prospect here. The conference does not exist yet, and
 * originating a prospect leg before there is somewhere to put it is how you get
 * a live human listening to silence.
 */
export async function startSession(
  params: StartSessionParams,
): Promise<{ sessionId: string; operatorLegId: string | null }> {
  const connectionId = requireCallControlAppId();
  const webhookUrl = requireWebhookUrl();

  const sipUri = await operatorSipUri();
  if (!sipUri) {
    throw new Error(
      'The browser is not registered as a phone yet, so there is nobody to connect ' +
        'calls to. Wait for the dialer to read Ready, then start the session.',
    );
  }

  // Any owned number will do for the operator's own leg — it never reaches a
  // prospect, so local presence is irrelevant here.
  const from = await pickCallerId(params.contactIds[0] ?? '+10000000000');
  if (!from) throw new Error('No active phone numbers to dial from.');

  const session = await db.dialSession.create({
    data: {
      sourceType: params.sourceType,
      sourceName: params.sourceName ?? null,
      status: 'starting',
      linesPerBurst: Math.max(1, params.linesPerBurst),
      queue: {
        create: params.contactIds.map((contactId, position) => ({
          contactId,
          position,
          status: 'pending',
        })),
      },
    },
  });

  try {
    const leg = await originateOperatorLeg({
      sipUri,
      from: from.e164,
      connectionId,
      webhookUrl,
      clientState: legState({ k: 'session', sessionId: session.id, role: 'operator' }),
    });

    await db.dialSession.update({
      where: { id: session.id },
      data: { operatorLegId: leg.callControlId },
    });

    return { sessionId: session.id, operatorLegId: leg.callControlId };
  } catch (err) {
    await db.dialSession.update({
      where: { id: session.id },
      data: { status: 'ended', endedAt: new Date() },
    });
    throw err;
  }
}

/**
 * The operator picked up. Build the room around them (§2.2 step 2).
 *
 * Muted on join: between calls the operator is not talking to anyone, and an
 * open microphone means the next prospect bridged in hears the tail of whatever
 * was being said in the room.
 */
export async function onOperatorLegAnswered(
  sessionId: string,
  callControlId: string,
): Promise<void> {
  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (!session || session.conferenceId) return;

  const conference = await createConference({
    callControlId,
    name: `actualizecrm-${sessionId}`,
  });

  // Written down **before** anything else is attempted. Creating the conference
  // is the step that cannot be repeated cleanly, so losing the id to a failure
  // in a later call strands a live conference the app has no record of — which
  // is exactly what happened: the join below threw, the id was never saved, and
  // every retry then died on "already exists".
  await db.dialSession.update({
    where: { id: sessionId },
    data: {
      conferenceId: conference.id,
      conferenceName: conference.name,
      operatorLegId: callControlId,
      status: 'live',
    },
  });

  // No join. The creating leg is already the conference's first participant —
  // joining it again is what broke this. Muting is a separate action, and
  // best-effort: an unmuted operator between calls is untidy, not broken.
  await muteParticipants({
    conferenceId: conference.id,
    callControlIds: [callControlId],
  }).catch((err) => {
    console.error('[dialer] could not mute the operator on join', err);
  });
}

/**
 * Tears the session down (§2.4).
 *
 * Prospects are released before the operator's leg. The other order leaves
 * whoever was on hold listening to music in a conference nobody is coming back
 * to, until Telnyx eventually reaps it.
 */
export async function endSession(sessionId: string): Promise<void> {
  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (!session) return;

  await db.dialSession.update({
    where: { id: sessionId },
    data: { status: 'ending' },
  });

  const live = await db.call.findMany({
    where: { sessionId, endedAt: null },
    select: { id: true, callControlId: true },
  });

  for (const call of live) {
    if (call.callControlId) await hangup(call.callControlId).catch(() => {});
  }

  if (session.operatorLegId) await hangup(session.operatorLegId).catch(() => {});

  await db.dialSession.update({
    where: { id: sessionId },
    data: {
      status: 'ended',
      endedAt: new Date(),
      activeCallId: null,
    },
  });
}

/// Finishes the current call, then stops advancing. The operator leg and the
/// conference stay up, so resuming costs nothing.
export async function pauseSession(sessionId: string): Promise<void> {
  await db.dialSession.updateMany({
    where: { id: sessionId, status: 'live' },
    data: { status: 'paused' },
  });
}

export async function resumeSession(sessionId: string): Promise<void> {
  await db.dialSession.updateMany({
    where: { id: sessionId, status: 'paused' },
    data: { status: 'live' },
  });
}

// ---------------------------------------------------------------------------
// Bursts
// ---------------------------------------------------------------------------

export interface BurstLeg {
  callId: string;
  contactId: string;
  to: string;
  from: string;
  callControlId: string | null;
  error?: string;
}

/**
 * Opens a burst of `n` legs, each from a different owned number.
 *
 * Two concurrent calls from one number is the most obvious pattern carrier
 * analytics look for, so running out of distinct numbers caps the burst rather
 * than doubling up. That cap is silent by design in the sense that it degrades
 * safely — but it is reported back so the UI can say why three lines produced
 * one leg.
 */
export async function openBurst(
  sessionId: string,
  contactIds: string[],
  allowedLines: number,
): Promise<{ burstId: string; legs: BurstLeg[] }> {
  const connectionId = requireCallControlAppId();
  const webhookUrl = requireWebhookUrl();

  const burstId = crypto.randomUUID();
  const wanted = contactIds.slice(0, Math.max(1, allowedLines));
  const legs: BurstLeg[] = [];
  const usedNumbers: string[] = [];

  // Never dial a number this account owns. It cannot connect, it burns a line
  // out of the burst, and it looks from the outside exactly like a lead that
  // will not answer.
  const owned = new Set(
    (await db.phoneNumber.findMany({ select: { e164: true } })).map((n) => n.e164),
  );

  for (let i = 0; i < wanted.length; i++) {
    const contact = await db.contact.findUnique({ where: { id: wanted[i] } });
    if (!contact || contact.doNotContact) continue;
    if (owned.has(contact.phone)) continue;

    const from = await pickCallerId(contact.phone, usedNumbers);
    if (!from) break; // out of distinct numbers — cap rather than double up
    usedNumbers.push(from.id);

    const call = await db.call.create({
      data: {
        contactId: contact.id,
        sessionId,
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
        clientState: legState({
          k: 'session',
          sessionId,
          role: 'prospect',
          callId: call.id,
          burstId,
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

  // Dials counted here, from legs actually originated — not from a UI event.
  // §6.2 is explicit that the UI never writes analytics data, and every burst
  // leg counts including the ones nobody ever hears.
  await db.dialSession.update({
    where: { id: sessionId },
    data: { dials: { increment: legs.filter((l) => l.callControlId).length } },
  });

  return { burstId, legs };
}

// ---------------------------------------------------------------------------
// AMD routing — the part that decides what reaches the operator's ears
// ---------------------------------------------------------------------------

export type AmdRouting = 'bridged' | 'held' | 'voicemail' | 'automated' | 'ignored';

/**
 * A prospect answered. Connect them **now** (§2.2, revised).
 *
 * The spec holds every leg unbridged until AMD has decided. That is correct on
 * paper and wrong in the mouth: premium AMD takes several seconds, and those
 * seconds are spent by a person who has just said "hello" into total silence.
 * They conclude it is a robocall and hang up, and the operator never learns the
 * call existed. Dead air is the most expensive thing a dialer can produce.
 *
 * So the order is inverted. The first answer bridges immediately, and the AMD
 * verdict — which still arrives — is used to *remove* a machine once it is
 * known to be one. The operator may hear a second or two of an answering
 * machine; they will not lose the person who picked up.
 */
export async function routeAnswer(params: {
  sessionId: string;
  callId: string;
  callControlId: string;
}): Promise<AmdRouting> {
  const { sessionId, callId, callControlId } = params;

  const call = await db.call.findUnique({ where: { id: callId } });
  if (!call || call.endedAt || call.bridgedAt || call.heldAt) return 'ignored';

  const session = await ensureConference(sessionId);
  if (!session?.conferenceId) {
    await hangup(callControlId).catch(() => {});
    return 'ignored';
  }

  await db.contact.update({
    where: { id: call.contactId },
    data: { everConnected: true, connectCount: { increment: 1 } },
  });

  // Exactly one leg can move activeCallId off null, so two answering in the
  // same instant cannot both believe they won.
  const won = await db.dialSession.updateMany({
    where: { id: sessionId, activeCallId: null },
    data: { activeCallId: callId },
  });

  if (won.count === 1) {
    await joinConference({
      conferenceId: session.conferenceId,
      callControlId,
      startConferenceOnEnter: true,
      clientState: legState({ k: 'session', sessionId, role: 'prospect', callId }),
    });

    if (session.operatorLegId) {
      for (let i = 0; i < 3; i++) {
        try {
          await unmuteParticipants({
            conferenceId: session.conferenceId,
            callControlIds: [session.operatorLegId],
          });
          break;
        } catch (err) {
          if (i === 2) console.error('[dialer] could not unmute the operator', err);
          else await new Promise((r) => setTimeout(r, 250));
        }
      }
    }

    await db.call.update({
      where: { id: callId },
      data: { status: 'answered', bridgedAt: new Date() },
    });
    await db.dialSession.update({
      where: { id: sessionId },
      data: { connects: { increment: 1 } },
    });
    return 'bridged';
  }

  // Somebody got there first: park them with the identification prompt.
  await joinConference({
    conferenceId: session.conferenceId,
    callControlId,
    hold: true,
    clientState: legState({ k: 'session', sessionId, role: 'prospect', callId }),
  });
  await speakToConference({
    conferenceId: session.conferenceId,
    text: await holdPrompt(),
    callControlIds: [callControlId],
  }).catch(() => {});
  await db.call.update({
    where: { id: callId },
    data: { status: 'held', heldAt: new Date() },
  });
  return 'held';
}

/**
 * Returns the session with a live conference, rebuilding one if it has ended.
 *
 * A Telnyx conference ends when its last active participant leaves, and a
 * session idling between bursts is exactly when that happens.
 */
async function ensureConference(sessionId: string) {
  let session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (!session?.conferenceId || !session.operatorLegId) return session;

  const live = await findConferenceByName(
    session.conferenceName ?? `actualizecrm-${sessionId}`,
  );
  if (live) return session;

  console.warn('[dialer] conference had ended — rebuilding around the operator');
  try {
    const rebuilt = await createConference({
      callControlId: session.operatorLegId,
      name: `actualizecrm-${sessionId}-${Date.now()}`,
    });
    await db.dialSession.update({
      where: { id: sessionId },
      data: { conferenceId: rebuilt.id, conferenceName: rebuilt.name },
    });
    session = await db.dialSession.findUnique({ where: { id: sessionId } });
  } catch (err) {
    console.error('[dialer] could not rebuild the conference', err);
  }
  return session;
}

/**
 * Acts on an AMD verdict for one prospect leg (§2.2 step 6).
 *
 * `not_sure` is treated as non-human deliberately. Bridging the operator to
 * something that might be an IVR wastes the one resource a burst exists to
 * protect, and the cost of being wrong in the other direction — dropping a
 * person — is bounded by the callback the disposition creates.
 */
export async function routeAmdVerdict(params: {
  sessionId: string;
  callId: string;
  callControlId: string;
  verdict: string | null;
}): Promise<AmdRouting> {
  const { sessionId, callId, callControlId, verdict } = params;

  const call = await db.call.findUnique({ where: { id: callId } });
  if (!call || call.endedAt) return 'ignored';

  await db.call.update({ where: { id: callId }, data: { amdResult: verdict } });

  // A person, or something AMD could not name. Either way they stay: the leg
  // was already bridged on answer, and `not_sure` is far too common to hang up
  // on — the same number has come back human_residence on one call and not_sure
  // on the next.
  if (!isMachineVerdict(verdict) && !isFaxVerdict(verdict)) {
    return call.bridgedAt ? 'bridged' : call.heldAt ? 'held' : 'ignored';
  }

  // A machine, now known. Remove it — the operator has heard a second or two of
  // a greeting, which is the price of never making a human wait in silence.
  await hangup(callControlId).catch(() => {});
  await db.call.update({
    where: { id: callId },
    data: {
      disposition: isMachineVerdict(verdict) ? 'voicemail' : 'automated_system',
      status: 'completed',
      endedAt: new Date(),
    },
  });
  await db.contact.update({
    where: { id: call.contactId },
    data: {
      lastDisposition: isMachineVerdict(verdict) ? 'voicemail' : 'automated_system',
      noAnswerStreak: 0,
    },
  });
  await db.activity.create({
    data: {
      contactId: call.contactId,
      type: 'disposition',
      direction: 'outbound',
      summary: isMachineVerdict(verdict)
        ? 'Reached a machine — dropped once detection confirmed it'
        : 'Reached a fax or modem — dropped once detection confirmed it',
      callId,
      meta: { amdResult: verdict, bridgedFirst: call.bridgedAt !== null },
    },
  });

  // If it was the one the operator was on, free the slot so the loop advances.
  await releaseActive(sessionId, callId);

  return isMachineVerdict(verdict) ? 'voicemail' : 'automated';
}

// ---------------------------------------------------------------------------
// Advancing
// ---------------------------------------------------------------------------

/**
 * Releases the active prospect — and only the prospect (§2.4).
 *
 * The operator's leg is never touched. That is the whole point of anchoring on
 * a conference, and it is what makes Hang up safe to enable the instant a leg
 * bridges.
 */
export async function hangupActive(sessionId: string): Promise<boolean> {
  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (!session?.activeCallId) return false;

  const call = await db.call.findUnique({ where: { id: session.activeCallId } });
  if (!call) return false;

  if (call.callControlId) await hangup(call.callControlId).catch(() => {});
  await releaseActive(sessionId, session.activeCallId);
  return true;
}

/**
 * Clears the active slot and re-mutes the operator.
 *
 * Called both when the operator hangs up and when the prospect does. Idempotent
 * on `activeCallId`, because both paths can fire for one call — the operator
 * presses hang up and the resulting `call.hangup` webhook arrives moments later.
 */
export async function releaseActive(sessionId: string, callId: string): Promise<void> {
  const cleared = await db.dialSession.updateMany({
    where: { id: sessionId, activeCallId: callId },
    data: { activeCallId: null },
  });
  if (cleared.count === 0) return;

  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (session?.conferenceId && session.operatorLegId) {
    await muteParticipants({
      conferenceId: session.conferenceId,
      callControlIds: [session.operatorLegId],
    }).catch(() => {});
  }
}

/**
 * Takes the longest-waiting held caller off hold and makes them active.
 *
 * Called on advance *instead of* opening a burst. Somebody already listening to
 * hold music has a far stronger claim on the operator than a lead who has not
 * been dialled, and draining first is what keeps the abandonment rate under the
 * cap that §2.5 enforces.
 */
export async function bridgeOldestHeld(sessionId: string): Promise<string | null> {
  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (!session?.conferenceId) return null;

  const next = await db.call.findFirst({
    where: { sessionId, status: 'held', endedAt: null },
    orderBy: { heldAt: 'asc' },
  });
  if (!next?.callControlId) return null;

  const won = await db.dialSession.updateMany({
    where: { id: sessionId, activeCallId: null },
    data: { activeCallId: next.id },
  });
  if (won.count === 0) return null;

  await unholdParticipants({
    conferenceId: session.conferenceId,
    callControlIds: [next.callControlId],
  }).catch(() => {});

  // A held caller being promoted may be the first live participant of all, if
  // every earlier leg resolved to a machine. Starting the conference is
  // idempotent, so doing it here costs nothing and closes that gap.
  await joinConference({
    conferenceId: session.conferenceId,
    callControlId: next.callControlId,
    startConferenceOnEnter: true,
  }).catch(() => {
    // Already a participant — expected, since they were joined on hold.
  });

  if (session.operatorLegId) {
    await unmuteParticipants({
      conferenceId: session.conferenceId,
      callControlIds: [session.operatorLegId],
    }).catch(() => {});
  }

  const heldSeconds = next.heldAt
    ? Math.round((Date.now() - next.heldAt.getTime()) / 1000)
    : 0;

  await db.call.update({
    where: { id: next.id },
    data: { bridgedAt: new Date(), status: 'answered', heldSeconds },
  });

  return next.id;
}

/**
 * Retires anyone held past the limit (§2.2 step 10).
 *
 * They hear an apology rather than a click. The call was ours, and hanging up
 * silently on somebody who waited is both rude and exactly the behaviour the
 * abandonment rules exist to discourage.
 */
export async function sweepExpiredHolds(): Promise<number> {
  const limit = await holdMaxSeconds();
  const cutoff = new Date(Date.now() - limit * 1000);

  const expired = await db.call.findMany({
    where: { status: 'held', endedAt: null, heldAt: { lte: cutoff } },
    select: { id: true, callControlId: true, heldAt: true, contactId: true, sessionId: true },
  });

  for (const call of expired) {
    const session = call.sessionId
      ? await db.dialSession.findUnique({ where: { id: call.sessionId } })
      : null;

    if (call.callControlId && session?.conferenceId) {
      await speakToConference({
        conferenceId: session.conferenceId,
        text: "I'm sorry, no one is available to take your call right now. We'll try you again shortly. Goodbye.",
        callControlIds: [call.callControlId],
      }).catch(() => {});
      // Let the apology land before the leg goes away.
      await new Promise((r) => setTimeout(r, 3500));
      await leaveConference({
        conferenceId: session.conferenceId,
        callControlId: call.callControlId,
      }).catch(() => {});
    }
    if (call.callControlId) await hangup(call.callControlId).catch(() => {});

    const heldSeconds = call.heldAt
      ? Math.round((Date.now() - call.heldAt.getTime()) / 1000)
      : limit;

    await db.call.update({
      where: { id: call.id },
      data: {
        status: 'abandoned',
        disposition: 'abandoned',
        endedAt: new Date(),
        heldSeconds,
      },
    });
    await db.activity.create({
      data: {
        contactId: call.contactId,
        type: 'disposition',
        direction: 'outbound',
        summary: `Abandoned after ${heldSeconds}s on hold — nobody was free to take the call`,
        callId: call.id,
        meta: { heldSeconds, reason: 'hold_expired' },
      },
    });
  }

  return expired.length;
}

/**
 * Records why the operator's leg never made it (§2.2 step 1).
 *
 * Only writes when the conference was never created — that is precisely the
 * case where the session silently did nothing. Once the conference exists, a
 * hangup is the operator leaving normally and needs no explanation.
 *
 * The causes are translated because the operator should not have to know what
 * a 480 is, and because the two most likely ones have completely different
 * fixes: an unregistered softphone is something they can act on immediately,
 * while a rejected route is a configuration problem.
 */
export async function recordOperatorLegFailure(
  sessionId: string,
  cause: string | null,
): Promise<void> {
  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (!session || session.conferenceId) return;

  const explanation = explainOperatorFailure(cause);

  await db.dialSession.update({
    where: { id: sessionId },
    data: { failureReason: explanation },
  });
}

export function explainOperatorFailure(cause: string | null): string {
  switch ((cause ?? '').toLowerCase()) {
    case 'no_answer':
    case 'timeout':
    case 'originator_cancel':
      return (
        'The dialer called your softphone and it rang without being answered. ' +
        'If you did not hear anything, the browser tab was not registered as a ' +
        'phone — check that the Dialer page reads Ready before starting.'
      );
    case 'unallocated_number':
    case 'no_route_destination':
    case 'invalid_number_format':
      return (
        'Telnyx could not route the call to your softphone at all. The WebRTC ' +
        'credential exists but the SIP address is unreachable from the Call ' +
        'Control Application — this is a configuration problem, not something ' +
        'you did.'
      );
    case 'call_rejected':
    case 'user_busy':
      return (
        'Your softphone refused the call. Usually another tab is registered ' +
        'with the same credential and took it — close other Dialer tabs and ' +
        'try again.'
      );
    case 'normal_clearing':
      return (
        'The call to your softphone ended before it was answered. If the ' +
        'browser never rang, it was not registered as a phone when the session ' +
        'started.'
      );
    default:
      return cause
        ? `The dialer could not reach your softphone (${cause}).`
        : 'The dialer could not reach your softphone, and the carrier gave no reason.';
  }
}
