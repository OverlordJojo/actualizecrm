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
  bridgeCalls,
  parkWithHoldAudio,
  speak,
  stopPlayback,
  isHumanVerdict,
  isMachineVerdict,
  isFaxVerdict,
  findConferenceByName,
} from '@actualizecrm/telephony';
import { pickCallerId, operatorSipUri } from './routing';
import {
  classifyGreeting,
  extractGreetingName,
  isMonologue,
  type GreetingKind,
} from './greeting';
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

/**
 * How long a prospect's phone rings before the dialer gives up (operator
 * setting).
 *
 * Clamped rather than trusted. Below ten seconds you hang up on people who were
 * walking to the phone; above ninety you are holding a line open for somebody
 * who is not coming, and that line could be ringing somebody else.
 */
export async function maxRingSeconds(): Promise<number> {
  return Math.min(
    Math.max(asNumber(await getSetting('dialer.maxRingSeconds'), 30), 10),
    90,
  );
}

export async function holdMaxSeconds(): Promise<number> {
  return Math.min(
    Math.max(asNumber(await getSetting('dialer.holdMaxSeconds'), 25), HOLD_MIN_SECONDS),
    HOLD_MAX_SECONDS_CAP,
  );
}

/**
 * What a queued owner hears while they wait.
 *
 * 47 CFR 64.1200 requires an abandoned call to identify the caller within two
 * seconds of the greeting, so this cannot simply be silence or music. But the
 * wording matters more than the requirement admits: a person who says "hello"
 * and gets a synthesised sentence back concludes it is a robocall, stops
 * talking, and is gone before the operator ever reaches them. The prompt that
 * exists to keep them on the line was losing them.
 *
 * So it is short, it says a person is coming, and it apologises — the three
 * things that read as a human on the other end rather than a dialler. Long
 * scripted greetings are what sound automated.
 */
export async function holdPrompt(): Promise<string> {
  const configured = await getSetting('dialer.holdPrompt');
  if (configured.trim()) return configured.trim();

  const from = await getSetting('email.fromName');
  const who = from.trim() || 'ActualizeCRM';
  return `Hi, it's ${who} — sorry, give me one second, I'm just here.`;
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
  if (!session || session.status === 'live') return;

  /**
   * No conference. The operator's leg simply stays up.
   *
   * The anchor is still the point — one leg that outlives every prospect, so
   * hang-up can never drop the operator and the session survives navigation.
   * What changed is that prospects are *bridged* to it rather than mixed with
   * it, because a mixer buffers to align packets and that cost close to a
   * second each way with only two people in the room.
   *
   * Parked callers do not need a room either: they wait on their own leg with
   * hold audio. Nobody on hold has ever needed to hear anybody.
   */
  await db.dialSession.update({
    where: { id: sessionId },
    data: { operatorLegId: callControlId, status: 'live' },
  });
}

/// Retained for the migration window: sessions started before the switch to
/// direct bridging still have a conference recorded against them.
async function legacyConference(
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
/**
 * Sends a lead to the back of its column.
 *
 * Used for legs that rang out. They are not skipped and not deleted — they
 * simply stop being next, so the queue in front of the operator is always
 * people who have not been tried today rather than the same unanswered numbers
 * cycling round.
 */
export async function sendToBackOfColumn(contactId: string): Promise<void> {
  const contact = await db.contact.findUnique({
    where: { id: contactId },
    select: { stageId: true },
  });
  if (!contact?.stageId) return;

  const last = await db.contact.aggregate({
    where: { stageId: contact.stageId },
    _max: { stagePosition: true },
  });
  await db.contact.update({
    where: { id: contactId },
    data: { stagePosition: (last._max.stagePosition ?? 0) + 1 },
  });
}

export async function openBurst(
  sessionId: string,
  contactIds: string[],
  allowedLines: number,
): Promise<{ burstId: string; legs: BurstLeg[] }> {
  const connectionId = requireCallControlAppId();
  const webhookUrl = requireWebhookUrl();

  const burstId = crypto.randomUUID();
  const ringSeconds = await maxRingSeconds();
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
        timeoutSecs: ringSeconds,
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

  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (!session?.operatorLegId) {
    // No operator leg means no session. Releasing the prospect is kinder than
    // holding them in silence while we work out why.
    await hangup(callControlId).catch(() => {});
    return 'ignored';
  }

  await db.contact.update({
    where: { id: call.contactId },
    data: { everConnected: true, connectCount: { increment: 1 } },
  });

  // Exactly one leg can move activeCallId off null, so two answering in the
  // same instant cannot both believe they won.
  let won = await db.dialSession.updateMany({
    where: { id: sessionId, activeCallId: null },
    data: { activeCallId: callId },
  });

  /**
   * A person always outranks a recording.
   *
   * The operator can be sitting on an answering machine's greeting, which is
   * useful but not urgent — it can be listened to later, or not at all. A human
   * who has just said hello cannot wait, and queueing them behind a machine is
   * how one ended up on hold for thirty-two seconds and was then dropped as
   * abandoned. Recordings yield.
   */
  if (won.count === 0) {
    const holder = session.activeCallId
      ? await db.call.findUnique({ where: { id: session.activeCallId } })
      : null;

    if (holder && holder.disposition === 'voicemail' && !holder.endedAt) {
      if (holder.callControlId) await hangup(holder.callControlId).catch(() => {});
      await db.call.update({
        where: { id: holder.id },
        data: { status: 'completed', endedAt: new Date() },
      });
      await db.dialSession.updateMany({
        where: { id: sessionId, activeCallId: holder.id },
        data: { activeCallId: null },
      });
      won = await db.dialSession.updateMany({
        where: { id: sessionId, activeCallId: null },
        data: { activeCallId: callId },
      });
    }
  }

  if (won.count === 1) {
    /**
     * Straight to the operator, with no conference in the middle.
     *
     * The conference was costing close to a second each way. A mixer buffers
     * every participant to align packets before combining them — correct for
     * three people, and pure latency for two. A bridge just joins the two media
     * paths.
     */
    if (!session.operatorLegId) {
      await hangup(callControlId).catch(() => {});
      await db.dialSession.updateMany({
        where: { id: sessionId, activeCallId: callId },
        data: { activeCallId: null },
      });
      return 'ignored';
    }

    await bridgeCalls({
      callControlId,
      otherCallControlId: session.operatorLegId,
      clientState: legState({ k: 'session', sessionId, role: 'prospect', callId }),
    });

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

  // Somebody got there first. They wait on their own leg — no room to put them
  // in, and nobody on hold needs to hear anybody.
  await speak(callControlId, await holdPrompt()).catch(() => {});
  await parkWithHoldAudio({
    callControlId,
    audioUrl: (await getSetting('dialer.holdMusicUrl')) || undefined,
  }).catch(() => {});
  await db.call.update({
    where: { id: callId },
    data: { status: 'held', heldAt: new Date() },
  });
  return 'held';
}

/**
 * Decides whether a machine greeting is worth the operator's ears.
 *
 * Called as transcript arrives on a leg already dispositioned voicemail. A
 * carrier's own recording carries nothing about the business and is dropped; a
 * greeting somebody recorded themselves is left playing, because the voice is
 * the whole point — owner or front desk is a judgement the operator makes in
 * two seconds and nothing else can make at all.
 *
 * Undecided greetings are kept. Hearing one robot costs a second; hanging up on
 * a real greeting throws away the judgement.
 */
export async function screenVoicemailGreeting(params: {
  sessionId: string;
  callId: string;
  callControlId: string;
  transcript: string;
}): Promise<GreetingKind> {
  const { sessionId, callId, callControlId, transcript } = params;

  const call = await db.call.findUnique({ where: { id: callId } });
  if (!call || call.endedAt) return 'unknown';

  /**
   * Screens **every** prospect leg, not only ones detection already called
   * machines.
   *
   * That guard was the hole. A recording AMD returned `not_sure` for was
   * bridged as a person and then never screened, because screening was gated on
   * a disposition only a `machine` verdict sets. The operator heard the whole
   * greeting and the words that gave it away were sitting in the transcript
   * unread.
   *
   * Detection judges tone in the first second; this judges words. They fail at
   * different things, so both run, and a machine has to get past both.
   */

  const contact = await db.contact.findUnique({
    where: { id: call.contactId },
    select: { firstName: true, lastName: true, companyName: true },
  });

  let name = extractGreetingName(transcript);

  /**
   * "Hi, you've reached Acme, please leave a message" is a person reading a
   * company script. It is still a real mailbox and still a callback — but the
   * word after "you've reached" is the business, not somebody's first name, and
   * writing it into the name field would have the operator open the callback
   * with "Hi Acme".
   *
   * The lead's own company name is the check. A generic word list cannot know
   * that "Acme" is a company; the record already does.
   */
  if (name && contact?.companyName) {
    const company = contact.companyName.toLowerCase();
    const heard = name.firstName.toLowerCase();
    if (company.includes(heard) || heard.includes(company.split(' ')[0])) {
      name = null;
    }
  }

  // Either signal is enough. A name is proof of a person; a first-person
  // greeting is proof somebody recorded it themselves. Both mean a mailbox
  // worth calling back, whether or not it names anyone.
  let kind = name ? 'human' : classifyGreeting(transcript);

  /**
   * Third detector: they never stopped talking.
   *
   * Words and tone can both be wrong — an unlisted carrier script, a recording
   * made by a real person, a garbled transcript. This one only asks whether the
   * far end behaved like somebody expecting an answer, and a recording never
   * does. It is what catches the greetings the other two miss.
   *
   * Only ever escalates. It can turn an undecided greeting into a recording; it
   * never overrules a positive read of the words, because "you've reached Josh"
   * is a mailbox worth calling back however long it runs on.
   */
  if (kind === 'unknown' && call.answeredAt) {
    const speakingSeconds = (Date.now() - call.answeredAt.getTime()) / 1000;
    const segments = Array.isArray(call.transcriptSegments)
      ? (call.transcriptSegments as unknown as { speaker: string }[])
      : [];
    const monologue = isMonologue({
      speakingSeconds,
      words: transcript.trim().split(/\s+/).filter(Boolean).length,
      operatorSpoke: segments.some((seg) => seg.speaker === 'You'),
    });
    if (monologue) kind = 'carrier';
  }

  // Still listening. Give the greeting another segment to identify itself.
  if (kind === 'unknown' && !name) return 'unknown';

  await hangup(callControlId).catch(() => {});
  await db.call.update({
    where: { id: callId },
    data: {
      status: 'completed',
      endedAt: new Date(),
      // Set here as well: a leg reaching this point may never have been called
      // a machine by detection at all.
      disposition: kind === 'carrier' ? 'voicemail' : call.disposition,
    },
  });
  // Frees the operator if this recording had been bridged to them.
  await releaseActive(sessionId, callId);

  if (kind === 'carrier') {
    await db.activity.create({
      data: {
        contactId: call.contactId,
        type: 'disposition',
        direction: 'outbound',
        summary: 'Carrier recording or phone menu — no mailbox worth following up',
        callId,
        meta: { greeting: transcript.slice(0, 300), classified: 'carrier' },
      },
    });
    return 'carrier';
  }

  /**
   * Somebody's own greeting. That is a callback, not a dead end.
   *
   * A person who recorded their own message is reachable, and a person who
   * says their name in it is certainly reachable — a carrier recording never
   * says a name. So the lead is filed to Callback automatically, and the name
   * is written to the record if it was spoken, which is often the only place a
   * cold lead's first name ever comes from.
   *
   * The name is only written over an empty field. An imported name is what the
   * operator's list says; a transcript is a guess at a word heard over a phone
   * line, and it does not get to overwrite the former.
   */
  const stage = await db.pipelineStage.findFirst({
    where: { name: 'Callback' },
    orderBy: { position: 'asc' },
  });

  // Only ever fills an empty field. An imported name is what the operator's
  // list says; a transcript is a guess at a word heard over a phone line, and a
  // guess does not overwrite a record.
  const nameUpdate = name
    ? {
        ...(contact?.firstName ? {} : { firstName: name.firstName }),
        ...(name.lastName && !contact?.lastName ? { lastName: name.lastName } : {}),
      }
    : {};

  if (stage) {
    await db.contact.updateMany({
      where: { stageId: stage.id },
      data: { stagePosition: { increment: 1 } },
    });
  }

  await db.contact.update({
    where: { id: call.contactId },
    data: {
      ...nameUpdate,
      lastDisposition: 'callback',
      ...(stage ? { stageId: stage.id, stagePosition: 0 } : {}),
      pipelineRemovedAt: null,
      removalReason: null,
    },
  });

  await db.call.update({ where: { id: callId }, data: { disposition: 'callback' } });

  await db.activity.create({
    data: {
      contactId: call.contactId,
      type: 'disposition',
      direction: 'outbound',
      summary: name
        ? `Voicemail from ${[name.firstName, name.lastName].filter(Boolean).join(' ')} — moved to Callback`
        : 'Personal voicemail greeting — moved to Callback',
      callId,
      meta: {
        greeting: transcript.slice(0, 300),
        classified: 'human',
        nameHeard: name ? `${name.firstName} ${name.lastName ?? ''}`.trim() : null,
      },
    },
  });

  return 'human';
}

/**
 * Whether this leg is the one the operator is actually listening to.
 *
 * Used to decide if a detected machine should be left playing for review or
 * dropped silently: a greeting is only worth hearing if there is nobody real on
 * the other line.
 */
async function operatorIsFree(sessionId: string, callId: string): Promise<boolean> {
  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  return session?.activeCallId === callId;
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

  /**
   * A person reaches the operator. Nothing else does.
   *
   * `not_sure` counts as a person: the same number has come back
   * human_residence on one call and not_sure on the next, and dropping an
   * uncertain verdict hangs up on real people. A machine that slips through as
   * not_sure is caught a second later by the greeting screen, which reads what
   * was said rather than guessing from tone.
   */
  if (!isMachineVerdict(verdict) && !isFaxVerdict(verdict)) {
    return routeAnswer({ sessionId, callId, callControlId });
  }

  const machine = isMachineVerdict(verdict);

  /**
   * A machine. The operator never listens to it (revised again, on the
   * operator's instruction — and they were right).
   *
   * Playing greetings for review sounded useful and was not: it occupied the
   * one line that matters while a real person waited behind it. Everything
   * worth knowing from a greeting is in its words, and words can be read
   * without anybody's attention.
   *
   * So the leg is released from the operator immediately and kept alive on its
   * own for a few seconds, purely to transcribe. `screenVoicemailGreeting` then
   * decides what it was and files the lead accordingly.
   */
  // Never bridged, so there is no slot to free — but clear it defensively in
  // case detection arrived after a race put this leg in the active position.
  await releaseActive(sessionId, callId);

  await db.call.update({
    where: { id: callId },
    data: { disposition: machine ? 'voicemail' : 'automated_system' },
  });
  await db.contact.update({
    where: { id: call.contactId },
    data: {
      lastDisposition: machine ? 'voicemail' : 'automated_system',
      noAnswerStreak: 0,
    },
  });

  // A fax or an unrecoverable tone has no greeting worth reading.
  if (!machine) {
    await hangup(callControlId).catch(() => {});
    await db.call.update({
      where: { id: callId },
      data: { status: 'completed', endedAt: new Date() },
    });
    return 'automated';
  }

  return 'voicemail';
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

  // Nothing to mute. The operator's leg is not in a room between calls — the
  // bridge ended with the prospect's leg, and their microphone reaches nobody
  // until the next one is bridged in.
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
  if (!session?.operatorLegId) return null;

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

  // Re-read after claiming. The hold sweep runs on its own timer and may have
  // retired this caller in the moment between the query and the claim, which
  // once produced a call marked bridged after it had been hung up.
  const stillThere = await db.call.findUnique({ where: { id: next.id } });
  if (!stillThere || stillThere.endedAt) {
    await db.dialSession.updateMany({
      where: { id: sessionId, activeCallId: next.id },
      data: { activeCallId: null },
    });
    return null;
  }

  // Stop the hold music first, or it plays over the operator's greeting.
  await stopPlayback(next.callControlId).catch(() => {});

  await bridgeCalls({
    callControlId: next.callControlId,
    otherCallControlId: session.operatorLegId,
    clientState: legState({
      k: 'session',
      sessionId,
      role: 'prospect',
      callId: next.id,
    }),
  });

  const heldSeconds = next.heldAt
    ? Math.round((Date.now() - next.heldAt.getTime()) / 1000)
    : next.heldSeconds;

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
/**
 * Hangs up voicemail legs that were kept alive to be read and never resolved.
 *
 * A machine is released from the operator immediately and left running only so
 * its greeting can be transcribed. If no transcript arrives — silence, a beep
 * with no words, transcription unavailable — nothing else would ever end that
 * leg, and it would bill until the carrier gave up.
 */
export async function sweepUnreadVoicemails(): Promise<number> {
  const cutoff = new Date(Date.now() - 25_000);

  const stale = await db.call.findMany({
    where: {
      disposition: 'voicemail',
      endedAt: null,
      answeredAt: { lte: cutoff },
      sessionId: { not: null },
    },
    select: { id: true, callControlId: true },
  });

  for (const call of stale) {
    if (call.callControlId) await hangup(call.callControlId).catch(() => {});
    await db.call.update({
      where: { id: call.id },
      data: { status: 'completed', endedAt: new Date() },
    });
  }
  return stale.length;
}

export async function sweepExpiredHolds(): Promise<number> {
  const limit = await holdMaxSeconds();
  const cutoff = new Date(Date.now() - limit * 1000);

  const expired = await db.call.findMany({
    where: { status: 'held', endedAt: null, heldAt: { lte: cutoff } },
    select: { id: true, callControlId: true, heldAt: true, contactId: true, sessionId: true },
  });

  for (const call of expired) {
    // Never abandon somebody the operator is free to take right now. The sweep
    // exists for callers nobody is coming back to, not for the one about to be
    // bridged — and losing that race drops a live prospect a second before they
    // would have been connected.
    if (call.sessionId) {
      const owner = await db.dialSession.findUnique({
        where: { id: call.sessionId },
        select: { activeCallId: true, status: true },
      });
      if (owner && owner.activeCallId === null && owner.status === 'live') continue;
    }

    const session = call.sessionId
      ? await db.dialSession.findUnique({ where: { id: call.sessionId } })
      : null;

    if (call.callControlId) {
      await stopPlayback(call.callControlId).catch(() => {});
      await speak(
        call.callControlId,
        "I'm sorry, no one is available to take your call right now. We'll try you again shortly. Goodbye.",
      ).catch(() => {});
      // Let the apology land before the leg goes away.
      await new Promise((r) => setTimeout(r, 3500));
      await hangup(call.callControlId).catch(() => {});
    }

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
/**
 * Puts the operator's leg back after a bridged call ends.
 *
 * Telnyx tears down both sides of a bridge together, so hanging up a prospect
 * takes the operator's leg with it — which ended the whole session on the first
 * hangup. The leg is the session, so it is re-established rather than mourned.
 *
 * Only while there is still a session to serve. A leg re-dialled after the
 * operator pressed End would ring them for no reason.
 */
export async function restoreOperatorLeg(sessionId: string): Promise<boolean> {
  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== 'live') return false;

  const sipUri = await operatorSipUri();
  const from = await pickCallerId('+10000000000');
  if (!sipUri || !from) return false;

  try {
    const leg = await originateOperatorLeg({
      sipUri,
      from: from.e164,
      connectionId: requireCallControlAppId(),
      webhookUrl: requireWebhookUrl(),
      clientState: legState({ k: 'session', sessionId, role: 'operator' }),
    });
    await db.dialSession.update({
      where: { id: sessionId },
      data: { operatorLegId: leg.callControlId },
    });
    return true;
  } catch (err) {
    console.error('[dialer] could not restore the operator leg', err);
    return false;
  }
}

export async function recordOperatorLegFailure(
  sessionId: string,
  cause: string | null,
): Promise<void> {
  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  // A session that reached `live` started fine; the operator leg ending after
  // that is them finishing, not a failure. This used to test for a conference
  // id — and once conferences were removed, every normal hangup was reported as
  // a session that never started.
  if (!session || session.status === 'live') return;

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

/**
 * Moves the operator to a different live caller (§ operator request).
 *
 * The spec's model is one conversation at a time with everyone else parked, and
 * that is still what the audio does — a conference where two prospects can hear
 * each other would be a disaster. What this adds is the ability to *choose*
 * which parked caller is the live one, rather than always taking the oldest.
 *
 * The current call is parked rather than dropped. Someone the operator stepped
 * away from is still a prospect who answered, and hanging up on them to talk to
 * somebody else would be worse than the hold they get instead.
 */
export async function switchToCall(params: {
  sessionId: string;
  callId: string;
}): Promise<boolean> {
  const { sessionId, callId } = params;

  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (!session?.operatorLegId) return false;
  if (session.activeCallId === callId) return true;

  const target = await db.call.findUnique({ where: { id: callId } });
  if (!target?.callControlId || target.endedAt) return false;

  /**
   * Park whoever is live, then bridge the one being switched to.
   *
   * Bridging the operator to a new leg is what moves them; the previous
   * prospect is left on their own leg with hold audio rather than dropped.
   * Somebody the operator stepped away from is still a prospect who answered,
   * and hanging up on them to talk to somebody else is worse than the hold.
   */
  if (session.activeCallId) {
    const current = await db.call.findUnique({ where: { id: session.activeCallId } });
    if (current?.callControlId && !current.endedAt) {
      await parkWithHoldAudio({
        callControlId: current.callControlId,
        audioUrl: (await getSetting('dialer.holdMusicUrl')) || undefined,
      }).catch(() => {});
      await db.call.update({
        where: { id: current.id },
        data: { status: 'held', heldAt: current.heldAt ?? new Date() },
      });
    }
  }

  await db.dialSession.update({
    where: { id: sessionId },
    data: { activeCallId: callId },
  });

  await stopPlayback(target.callControlId).catch(() => {});
  await bridgeCalls({
    callControlId: target.callControlId,
    otherCallControlId: session.operatorLegId,
    clientState: legState({ k: 'session', sessionId, role: 'prospect', callId }),
  });

  const heldSeconds = target.heldAt
    ? Math.round((Date.now() - target.heldAt.getTime()) / 1000)
    : target.heldSeconds;

  await db.call.update({
    where: { id: callId },
    data: { status: 'answered', bridgedAt: target.bridgedAt ?? new Date(), heldSeconds },
  });

  return true;
}

/**
 * Hangs up one specific leg, live or parked.
 *
 * Distinct from `hangupActive`, which only ever releases whoever the operator
 * is talking to. This is how a ringing or parked line is dropped without
 * disturbing the conversation in progress — the operator can see a lead they do
 * not want and clear the line for the next one.
 */
export async function hangupCall(params: {
  sessionId: string;
  callId: string;
}): Promise<boolean> {
  const { sessionId, callId } = params;

  const call = await db.call.findUnique({ where: { id: callId } });
  if (!call || call.endedAt) return false;

  if (call.callControlId) await hangup(call.callControlId).catch(() => {});
  await db.call.update({
    where: { id: callId },
    data: { status: 'completed', endedAt: new Date() },
  });

  // Only frees the operator if this was the leg they were on.
  await releaseActive(sessionId, callId);
  return true;
}
