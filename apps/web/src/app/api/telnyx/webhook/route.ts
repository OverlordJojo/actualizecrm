import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  startRecording,
  playAudio,
  hangup,
  encodeClientState,
  decodeClientState,
} from '@/integrations/telnyx/recording';
import { archiveRecording, processCall } from '@/integrations/ai/pipeline';
import { resolveRecording, playbackUrl } from '@/integrations/audio/voicemail';
import { formatPhone } from '@/lib/phone';
import {
  burstState,
  routeHumanAnswer,
  routeNonHumanAnswer,
  startHoldAudio,
  type BurstState,
} from '@/integrations/telnyx/burst';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Telnyx call event receiver.
 *
 * Note on architecture: this webhook is **not** what drives the dialer's
 * auto-advance. The browser's WebRTC SDK reports `active` and `hangup`
 * locally, with no network round trip, which is what lets the music pause
 * within 300ms of answer (see integrations/audio). Routing that through
 * cloudflared would add hundreds of milliseconds of latency to the one
 * interaction where latency is audible.
 *
 * What this webhook is for:
 *   - server-side truth for call records (duration, hangup cause)
 *   - Call Control features like voicemail drop, which are issued server-side
 *   - inbound calls, which the browser never initiated
 *
 * So a missing webhook degrades reporting, not dialing. The Settings page says
 * as much rather than claiming the dialer is broken.
 */

interface TelnyxEvent {
  data?: {
    event_type?: string;
    payload?: {
      call_control_id?: string;
      call_session_id?: string;
      to?: string;
      from?: string;
      hangup_cause?: string;
      start_time?: string;
      end_time?: string;
      direction?: string;
      /// Echoed back verbatim on every event for a call we started with one.
      client_state?: string;
      /// Answering-machine detection verdict.
      result?: string;
    };
  };
}

/// State we attach to bulk voicemail drops so a webhook can tell what the call
/// was for. Written by the worker at origination and by the live drop route.
interface VoicemailDropState {
  k: 'vmdrop';
  callId: string;
  recordingId: string;
}

function voicemailDropState(raw?: string | null): VoicemailDropState | null {
  const state = decodeClientState(raw);
  return state?.k === 'vmdrop' ? (state as unknown as VoicemailDropState) : null;
}

export async function POST(request: Request) {
  let body: TelnyxEvent;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ received: true });
  }

  const eventType = body.data?.event_type;
  const p = body.data?.payload ?? {};
  const callControlId = p.call_control_id;

  if (!eventType || !callControlId) {
    // Always 200 — Telnyx retries non-2xx, and a malformed event we cannot
    // act on should not turn into a retry storm.
    return NextResponse.json({ received: true });
  }

  const drop = voicemailDropState(p.client_state);
  const burst = burstState(decodeClientState(p.client_state));
  const call = await findCall(callControlId, p.to, drop?.callId ?? burst?.callId);

  try {
    switch (eventType) {
      // Inbound (add-on A). The browser learns about the call through its own
      // SDK — this is the server-side record, so an inbound call that rang
      // while the tab was closed still lands in the timeline.
      case 'call.initiated': {
        if (p.direction === 'incoming' && p.from) {
          await recordInboundCall(p.from, p.to, callControlId, p.call_session_id);
        }
        break;
      }

      case 'call.answered': {
        // A burst leg is not routed on answer — AMD decides whether this is a
        // person, a machine or an IVR, and until it does nobody should be
        // bridged and nothing should be recorded.
        if (burst) break;

        if (call) {
          await db.call.update({
            where: { id: call.id },
            data: { status: 'answered', answeredAt: new Date() },
          });

          // A bulk drop is not a conversation — recording it would archive our
          // own message and nothing else, and the audio is already on file.
          if (!drop) {
            // Start recording server-side. Failing to record must never take
            // the call down, so this is best-effort.
            startRecording(callControlId).catch((e) =>
              console.error('[telnyx] record_start failed', e),
            );
          }
        }
        break;
      }

      // Premium AMD verdict (§4.2). Arrives separately from call.answered.
      case 'call.machine.detection.ended':
      case 'call.machine.premium.detection.ended': {
        if (call) {
          const verdict = p.result ?? null;
          await db.call.update({
            where: { id: call.id },
            data: { amdResult: verdict },
          });

          if (drop) {
            // Premium detection is followed by a greeting-ended event, which is
            // the right moment to start playing — a message that talks over the
            // greeting is a message the prospect hears half of. The basic
            // detector has no such event, so that path plays immediately.
            const waitForGreeting =
              eventType === 'call.machine.premium.detection.ended' &&
              verdict === 'machine';

            if (!waitForGreeting) {
              await performDrop(callControlId, call.id, drop, verdict);
            }
          }

          // §4.3 per-leg routing. `not_sure` is treated as non-human on
          // purpose: bridging the operator to something that might be an IVR
          // wastes the one resource a burst is trying to protect.
          if (burst) {
            if (verdict === 'human') {
              await routeHumanAnswer(callControlId, burst);
            } else {
              await routeNonHumanAnswer(callControlId, burst, verdict);
            }
          }
        }
        break;
      }

      // The machine has finished its greeting (and possibly beeped). Playing
      // now puts the whole message on the tape.
      case 'call.machine.greeting.ended':
      case 'call.machine.premium.greeting.ended': {
        if (call && drop) {
          await performDrop(callControlId, call.id, drop, call.amdResult);
        }
        break;
      }

      // Telnyx finished writing the recording. Archive it to R2 and run the
      // post-call pipeline: transcript, extraction, analysis.
      case 'call.recording.saved': {
        if (call) {
          const urls = (p as { recording_urls?: { mp3?: string; wav?: string } })
            .recording_urls;
          const url = urls?.mp3 ?? urls?.wav;
          if (url) {
            // Deliberately not awaited: Telnyx retries any response it does not
            // get quickly, and transcription plus two model passes takes far
            // longer than a webhook should hold open.
            archiveRecording(call.id, url)
              .then((key) => (key ? processCall(call.id) : null))
              .catch((e) => console.error('[telnyx] post-call pipeline', e));
          }
        }
        break;
      }

      case 'call.hangup': {
        if (call) {
          const endedAt = p.end_time ? new Date(p.end_time) : new Date();
          const startedAt = call.answeredAt ?? call.startedAt;
          const durationSec = Math.max(
            0,
            Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
          );

          await db.call.update({
            where: { id: call.id },
            data: {
              status: mapHangupCause(p.hangup_cause, call.answeredAt !== null),
              endedAt,
              durationSec,
            },
          });

          // A missed inbound call is a lead trying to reach you. Losing it
          // because nobody was at the desk is the single most expensive kind of
          // miss in cold calling, so it becomes a task rather than a log line.
          if (call.direction === 'inbound' && !call.answeredAt) {
            await recordMissedInbound(call.id, call.contactId);
          }

          // A held caller who hung up on their own is not abandoned by us —
          // they left. Recording it as abandoned would inflate the governor's
          // rate with calls that were never at risk of the 3% cap.
          if (burst && call.status === 'held') {
            const heldFor = call.answeredAt
              ? Math.round((Date.now() - call.answeredAt.getTime()) / 1000)
              : 0;
            await db.call.update({
              where: { id: call.id },
              data: { status: 'no_answer', heldSeconds: heldFor },
            });
          }
        }
        break;
      }

      // The identification prompt has finished playing to a queued owner, so
      // hold music starts. Silence is what makes people hang up.
      case 'call.speak.ended': {
        if (burst && call?.status === 'held') {
          await startHoldAudio(callControlId).catch(() => {});
        }
        break;
      }

      // The drop hangs up here rather than after a fixed guess at the
      // recording's length: guessing short truncates the message, guessing long
      // leaves dead air on the prospect's voicemail. The browser then sees the
      // hangup through its own SDK and auto-advances like any other call end.
      case 'call.playback.ended': {
        if (call && (drop || call.voicemailDropped)) {
          await hangup(callControlId).catch((e) =>
            console.error('[telnyx] hangup after drop failed', e),
          );
          await db.activity.create({
            data: {
              contactId: call.contactId,
              type: 'voicemail_drop',
              summary: 'Voicemail drop finished playing',
              callId: call.id,
              meta: { callControlId },
            },
          });
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    // Never let a database hiccup turn into a Telnyx retry loop.
    console.error('[telnyx webhook]', eventType, err);
  }

  return NextResponse.json({ received: true });
}

/**
 * Finds the call row an event belongs to.
 *
 * The browser places calls over WebRTC and does not learn the Call Control id
 * until the leg is already up, so a row usually has no `callControlId` when
 * its first webhook lands. Looking up purely by that id would therefore never
 * match, and the id would never get stored — a deadlock.
 *
 * So: match by id when we have it, otherwise fall back to the most recent
 * unlinked call to the same number and adopt the id from the event.
 */
async function findCall(callControlId: string, to?: string, hintCallId?: string) {
  // A call the worker originated tells us its row id in `client_state`, which
  // beats every other lookup: it is exact, and it works even in the window
  // before the worker has finished writing the Call Control id to the row.
  if (hintCallId) {
    const hinted = await db.call.findUnique({ where: { id: hintCallId } });
    if (hinted) {
      if (!hinted.callControlId) {
        return db.call.update({
          where: { id: hinted.id },
          data: { callControlId },
        });
      }
      return hinted;
    }
  }

  const byId = await db.call.findUnique({ where: { callControlId } });
  if (byId) return byId;

  if (!to) return null;

  const candidate = await db.call.findFirst({
    where: {
      toE164: to,
      callControlId: null,
      // Only adopt a very recent row; an old call to the same prospect must
      // not absorb today's events.
      startedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
    },
    orderBy: { startedAt: 'desc' },
  });

  if (!candidate) return null;

  return db.call.update({
    where: { id: candidate.id },
    data: { callControlId },
  });
}

/**
 * Opens a Call row for an incoming call, creating the lead if the number is
 * unknown.
 *
 * Idempotent on `callControlId`: Telnyx retries anything it does not get a
 * quick 2xx for, and a retried `call.initiated` must not produce a second call
 * record or a duplicate contact.
 */
async function recordInboundCall(
  from: string,
  to: string | undefined,
  callControlId: string,
  callSessionId: string | undefined,
): Promise<void> {
  const existing = await db.call.findUnique({ where: { callControlId } });
  if (existing) return;

  const contact =
    (await db.contact.findUnique({ where: { phone: from } })) ??
    (await db.contact.create({ data: { phone: from, source: 'inbound' } }));

  const ownedNumber = to
    ? await db.phoneNumber.findUnique({ where: { e164: to } })
    : null;

  const call = await db.call.create({
    data: {
      contactId: contact.id,
      callControlId,
      callSessionId: callSessionId ?? null,
      direction: 'inbound',
      status: 'ringing',
      toE164: to ?? '',
      fromE164: from,
      fromNumberId: ownedNumber?.id ?? null,
    },
  });

  await db.activity.create({
    data: {
      contactId: contact.id,
      type: 'call',
      direction: 'inbound',
      summary: `Inbound call from ${formatPhone(from)}`,
      callId: call.id,
      meta: {
        to: to ?? null,
        routedToBrowser: ownedNumber?.routeInboundToBrowser ?? true,
      },
    },
  });
}

/// Missed inbound → a callback task due in an hour, per add-on A.
async function recordMissedInbound(callId: string, contactId: string): Promise<void> {
  const dueAt = new Date(Date.now() + 60 * 60 * 1000);

  // One task per missed call, not one per webhook retry.
  const already = await db.callbackTask.findFirst({
    where: { contactId, completed: false, createdAt: { gte: new Date(Date.now() - 60_000) } },
  });
  if (already) return;

  await db.callbackTask.create({
    data: { contactId, dueAt, note: 'Missed inbound call — call them back.' },
  });

  await db.activity.create({
    data: {
      contactId,
      type: 'automation',
      direction: 'inbound',
      summary: 'Missed inbound call — callback task created for 1 hour from now',
      callId,
      meta: { dueAt: dueAt.toISOString(), reason: 'missed_inbound' },
    },
  });
}

/**
 * Plays the recording for a queued bulk drop.
 *
 * The awkward case is `human`. A silent hangup on a person who picked up is an
 * abandoned call, which US telemarketing rules cap and require a recorded
 * identification for. Playing the message instead both identifies the caller
 * and leaves them with something rather than dead air, so that is what happens
 * — and the timeline says plainly that a person answered, because "voicemail
 * drop" alone would misrepresent what the prospect experienced.
 *
 * Guarded by `voicemailDropped` so overlapping detection and greeting events
 * cannot start the audio twice.
 */
async function performDrop(
  callControlId: string,
  callId: string,
  drop: VoicemailDropState,
  verdict?: string | null,
): Promise<void> {
  // Claim the drop atomically; the loser of a double event does nothing.
  const claimed = await db.call.updateMany({
    where: { id: callId, voicemailDropped: false },
    data: { voicemailDropped: true },
  });
  if (claimed.count === 0) return;

  const recording = await resolveRecording(drop.recordingId);
  if (!recording) {
    await hangup(callControlId).catch(() => {});
    return;
  }

  const reachedPerson = verdict === 'human';

  try {
    const url = await playbackUrl(recording);
    await playAudio(
      callControlId,
      url,
      encodeClientState({ ...drop } as unknown as Record<string, unknown>),
    );
  } catch (err) {
    console.error('[telnyx] bulk drop playback failed', err);
    await db.call.updateMany({
      where: { id: callId },
      data: { voicemailDropped: false },
    });
    await hangup(callControlId).catch(() => {});
    return;
  }

  const call = await db.call.update({
    where: { id: callId },
    data: { disposition: 'voicemail' },
  });

  await db.contact.update({
    where: { id: call.contactId },
    data: { lastDisposition: 'voicemail', noAnswerStreak: 0 },
  });

  await db.activity.create({
    data: {
      contactId: call.contactId,
      type: 'voicemail_drop',
      direction: 'outbound',
      summary: reachedPerson
        ? `Played "${recording.name}" — a person answered, not a machine`
        : `Dropped voicemail "${recording.name}"`,
      callId,
      meta: {
        recordingId: recording.id,
        recordingName: recording.name,
        mode: 'bulk',
        amdResult: verdict ?? null,
        reachedPerson,
      },
    },
  });
}

/// Telnyx hangup causes are telecom jargon; the app stores operator-facing
/// states. `normal_clearing` on a call that never answered is a no-answer.
function mapHangupCause(cause: string | undefined, wasAnswered: boolean): string {
  if (wasAnswered) return 'completed';
  switch (cause) {
    case 'busy':
      return 'busy';
    case 'call_rejected':
    case 'user_busy':
      return 'busy';
    case 'no_answer':
    case 'timeout':
    case 'originator_cancel':
    case 'normal_clearing':
      return 'no_answer';
    default:
      return 'failed';
  }
}
