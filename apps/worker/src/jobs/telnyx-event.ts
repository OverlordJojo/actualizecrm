import { db } from '@actualizecrm/db';
import {
  startRecording,
  startTranscription,
  hangup,
  decodeClientState,
} from '@actualizecrm/telephony';
import {
  sessionLegState,
  onOperatorLegAnswered,
  routeAmdVerdict,
  releaseActive,
  finalizeAttribution,
  type SessionLegState,
} from '@actualizecrm/dialer';
import { relayToApp } from '../lib/app-relay';

/**
 * One Telnyx call event, processed off the queue (§1.2).
 *
 * This runs *after* the 200 has already gone back to Telnyx, which changes what
 * correctness means here. Nothing in this file is on a latency budget, and
 * nothing here may assume it is the first attempt: the receiver's Redis claim
 * stops redelivery of the same event, but BullMQ will retry this job if it
 * throws. Every write below is therefore either idempotent or guarded.
 *
 * The split with the app is by *resource*, not by preference. Anything that
 * needs only Postgres happens here. Anything that needs R2 presigning or the
 * extraction pipeline is relayed to the app, which owns those credentials —
 * the same split `jobs/voicemail.ts` already uses, and for the same reason.
 */

export interface TelnyxEventPayload {
  eventId: string;
  eventType: string;
  body: {
    data?: {
      id?: string;
      event_type?: string;
      payload?: TelnyxCallPayload;
    };
  };
}

interface TelnyxCallPayload {
  call_control_id?: string;
  call_session_id?: string;
  to?: string;
  from?: string;
  hangup_cause?: string;
  start_time?: string;
  end_time?: string;
  direction?: string;
  client_state?: string;
  /// AMD verdict.
  result?: string;
  recording_urls?: { mp3?: string; wav?: string };
  transcription_data?: {
    transcript?: string;
    confidence?: number;
    is_final?: boolean;
    track?: string;
  };
}

export interface TelnyxEventResult {
  handled: boolean;
  eventType: string;
  note?: string;
}

/**
 * Events whose handling needs something only the app has.
 *
 * `call.recording.saved` needs R2 and the extraction pipeline. A bulk voicemail
 * drop needs a presigned playback URL for the recording. Neither is worth
 * duplicating credentials for.
 */
function needsApp(eventType: string, state: Record<string, unknown> | null): boolean {
  if (eventType === 'call.recording.saved') return true;
  if (state?.k === 'vmdrop') return true;
  return false;
}

export async function processTelnyxEvent(
  payload: TelnyxEventPayload,
): Promise<TelnyxEventResult> {
  const data = payload.body?.data;
  const eventType = payload.eventType || data?.event_type || 'unknown';
  const p: TelnyxCallPayload = data?.payload ?? {};
  const callControlId = p.call_control_id;

  if (!callControlId) return { handled: false, eventType, note: 'no call_control_id' };

  const state = decodeClientState(p.client_state);

  // Conference-anchored session legs (§2). Handled here rather than relayed:
  // these are the events with a listener on the other end of them — a prospect
  // sitting in silence while an AMD verdict takes an extra hop to be acted on
  // is the cost, and it is paid in the one place the operator can hear it.
  const leg = sessionLegState(state);
  if (leg) {
    return handleSessionEvent(eventType, leg, callControlId, p);
  }

  if (needsApp(eventType, state)) {
    const relayed = await relayToApp(payload.body);
    return {
      handled: relayed.ok,
      eventType,
      note: relayed.ok ? 'relayed to app' : `relay failed: ${relayed.error}`,
    };
  }

  const call = await findCall(callControlId, p.to, state?.callId as string | undefined);

  switch (eventType) {
    case 'call.initiated': {
      if (p.direction === 'incoming' && p.from) {
        await recordInboundCall(p.from, p.to, callControlId, p.call_session_id);
        return { handled: true, eventType, note: 'inbound recorded' };
      }
      return { handled: true, eventType };
    }

    case 'call.answered': {
      if (!call) return { handled: false, eventType, note: 'no matching call row' };

      await db.call.update({
        where: { id: call.id },
        data: { status: 'answered', answeredAt: call.answeredAt ?? new Date() },
      });

      // Best-effort: failing to record or transcribe must never take a live
      // call down.
      startRecording(callControlId).catch((e) =>
        console.error('[telnyx] record_start failed', e),
      );
      if (await transcriptionEnabled()) {
        startTranscription(callControlId).catch((e) =>
          console.error('[telnyx] transcription_start failed', e),
        );
      }
      return { handled: true, eventType };
    }

    // Premium AMD verdict. Arrives separately from call.answered.
    case 'call.machine.detection.ended':
    case 'call.machine.premium.detection.ended': {
      if (!call) return { handled: false, eventType, note: 'no matching call row' };
      await db.call.update({
        where: { id: call.id },
        data: { amdResult: p.result ?? null },
      });
      return { handled: true, eventType, note: `amd=${p.result ?? 'null'}` };
    }

    case 'call.hangup': {
      if (!call) return { handled: false, eventType, note: 'no matching call row' };

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

      // A missed inbound call is a lead trying to reach you. Losing it because
      // nobody was at the desk is the most expensive kind of miss in cold
      // calling, so it becomes a task rather than a log line.
      if (call.direction === 'inbound' && !call.answeredAt) {
        await recordMissedInbound(call.id, call.contactId);
      }
      return { handled: true, eventType, note: `${durationSec}s` };
    }

    case 'call.transcription': {
      if (!call) return { handled: false, eventType, note: 'no matching call row' };

      const t = p.transcription_data;
      // Interim results are re-sent and revised; storing them makes the live
      // pane stutter and duplicate lines.
      if (t?.transcript && t.is_final !== false) {
        await appendLiveSegment(call.id, {
          // `inbound` on an outbound call is the prospect's audio — the side
          // the operator most needs to read back.
          speaker: t.track === 'inbound' ? 'Prospect' : 'You',
          text: t.transcript,
          confidence: t.confidence ?? null,
          at: new Date().toISOString(),
        });
      }
      return { handled: true, eventType };
    }

    // The drop hangs up here rather than after a fixed guess at the recording's
    // length: guessing short truncates the message, guessing long leaves dead
    // air on the prospect's voicemail.
    case 'call.playback.ended': {
      if (call?.voicemailDropped) {
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
      return { handled: true, eventType };
    }

    default:
      return { handled: true, eventType, note: 'ignored' };
  }
}

/**
 * Events belonging to a conference-anchored session (§2.2).
 *
 * The operator's leg and a prospect's leg take completely different paths
 * through the same event types, which is why the role is carried in
 * `client_state` rather than inferred: an inference that guesses wrong here
 * either drops the operator or bridges a machine.
 */
async function handleSessionEvent(
  eventType: string,
  leg: SessionLegState,
  callControlId: string,
  p: TelnyxCallPayload,
): Promise<TelnyxEventResult> {
  const { sessionId, role, callId } = leg;

  if (role === 'operator') {
    switch (eventType) {
      case 'call.answered':
        // The room can only be built once the operator is on the line — Telnyx
        // creates a conference from a live leg and has no empty-conference call.
        await onOperatorLegAnswered(sessionId, callControlId);
        return { handled: true, eventType, note: 'conference created' };

      case 'call.hangup': {
        // The operator's leg going away ends the session, whatever the cause.
        // Leaving prospects in a conference nobody is coming back to is the
        // worst available outcome.
        const { endSession, recordOperatorLegFailure } = await import(
          '@actualizecrm/dialer'
        );

        // A leg that ends *before* the conference exists never got answered, so
        // the session never started. That is invisible from the operator's
        // chair — no ringing, no error, no controls — and the carrier's cause is
        // the only thing that says why.
        await recordOperatorLegFailure(sessionId, p.hangup_cause ?? null);
        await endSession(sessionId).catch(() => {});
        return {
          handled: true,
          eventType,
          note: `operator leg ended (${p.hangup_cause ?? 'no cause'})`,
        };
      }

      default:
        return { handled: true, eventType, note: 'operator leg, ignored' };
    }
  }

  if (!callId) return { handled: false, eventType, note: 'prospect leg with no call id' };

  switch (eventType) {
    // Answer alone decides nothing. AMD has not spoken yet, and bridging on
    // answer is what puts a machine in the operator's ear.
    case 'call.answered':
      await db.call.updateMany({
        where: { id: callId, answeredAt: null },
        data: { answeredAt: new Date() },
      });
      return { handled: true, eventType, note: 'awaiting AMD' };

    case 'call.machine.detection.ended':
    case 'call.machine.premium.detection.ended': {
      const routing = await routeAmdVerdict({
        sessionId,
        callId,
        callControlId,
        verdict: p.result ?? null,
      });
      return { handled: true, eventType, note: `amd=${p.result} → ${routing}` };
    }

    case 'call.hangup': {
      const call = await db.call.findUnique({ where: { id: callId } });
      if (call && !call.endedAt) {
        const endedAt = p.end_time ? new Date(p.end_time) : new Date();
        const startedAt = call.answeredAt ?? call.startedAt;
        await db.call.update({
          where: { id: callId },
          data: {
            status: mapHangupCause(p.hangup_cause, call.answeredAt !== null),
            endedAt,
            durationSec: Math.max(
              0,
              Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
            ),
          },
        });
      }
      // Owner attribution, from stored facts only (§6.2). Deterministic and
      // deliberately independent of the AI pipeline — these numbers must be
      // identical with DEEPINFRA_API_KEY removed.
      const attribution = await finalizeAttribution(callId);

      // Frees the active slot and re-mutes the operator. Idempotent, because
      // the operator pressing Hang up and this webhook both run it.
      await releaseActive(sessionId, callId);
      return {
        handled: true,
        eventType,
        note: `prospect leg ended — ${attribution.reason}`,
      };
    }

    default:
      return { handled: true, eventType, note: 'prospect leg, ignored' };
  }
}

/**
 * Finds the call row an event belongs to.
 *
 * A row usually has no `callControlId` when its first webhook lands — the
 * browser places WebRTC calls and does not learn the Call Control id until the
 * leg is already up. Matching purely on that id would therefore never match,
 * and the id would never get stored: a deadlock.
 *
 * So: trust `client_state` when the leg was originated server-side, fall back
 * to the id, and otherwise adopt the most recent unlinked call to the same
 * number.
 */
async function findCall(callControlId: string, to?: string, hintCallId?: string) {
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
      // Only adopt a very recent row; an old call to the same prospect must not
      // absorb today's events.
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

/// Transcription is a setting, not an assumption — recording someone is a
/// choice the operator makes once and should be able to unmake.
async function transcriptionEnabled(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: 'transcription.enabled' } });
  return row?.value !== 'false';
}

interface LiveSegment {
  speaker: string;
  text: string;
  confidence: number | null;
  at: string;
}

/**
 * Appends one phrase to the call's running transcript.
 *
 * Read-modify-write on a Json column, which is safe here because Telnyx
 * delivers a call's transcription events in order on one leg. The post-call
 * pass overwrites this wholesale with the accurate, speaker-attributed version
 * — this is the rough live copy, and the UI says so.
 */
async function appendLiveSegment(callId: string, segment: LiveSegment): Promise<void> {
  const call = await db.call.findUnique({
    where: { id: callId },
    select: { transcriptSegments: true, transcriptStatus: true },
  });
  if (!call) return;

  const existing = Array.isArray(call.transcriptSegments)
    ? (call.transcriptSegments as unknown as LiveSegment[])
    : [];

  // Bounded: a long call must not grow one row without limit.
  const segments = [...existing, segment].slice(-400);

  await db.call.update({
    where: { id: callId },
    data: {
      transcriptSegments: segments as never,
      transcript: segments.map((s) => `${s.speaker}: ${s.text}`).join('\n'),
      transcriptStatus: call.transcriptStatus === 'done' ? 'done' : 'running',
    },
  });
}

/// US formatting only; every number this app stores is E.164 and almost always
/// NANP. Anything else is shown as-is rather than mangled.
function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * Opens a Call row for an incoming call, creating the lead if the number is
 * unknown. Idempotent on `callControlId`.
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

/// Missed inbound → a callback task due in an hour.
async function recordMissedInbound(callId: string, contactId: string): Promise<void> {
  const dueAt = new Date(Date.now() + 60 * 60 * 1000);

  // One task per missed call, not one per retry.
  const already = await db.callbackTask.findFirst({
    where: {
      contactId,
      completed: false,
      createdAt: { gte: new Date(Date.now() - 60_000) },
    },
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

/// Telnyx hangup causes are telecom jargon; the app stores operator-facing
/// states. `normal_clearing` on a call that never answered is a no-answer.
function mapHangupCause(cause: string | undefined, wasAnswered: boolean): string {
  if (wasAnswered) return 'completed';
  switch (cause) {
    case 'busy':
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
