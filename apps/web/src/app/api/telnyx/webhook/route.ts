import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { startRecording } from '@/integrations/telnyx/recording';
import { archiveRecording, processCall } from '@/integrations/ai/pipeline';

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
    };
  };
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

  const call = await findCall(callControlId, p.to);

  try {
    switch (eventType) {
      case 'call.answered': {
        if (call) {
          await db.call.update({
            where: { id: call.id },
            data: { status: 'answered', answeredAt: new Date() },
          });

          // Start recording server-side. Failing to record must never take the
          // call down, so this is best-effort.
          startRecording(callControlId).catch((e) =>
            console.error('[telnyx] record_start failed', e),
          );
        }
        break;
      }

      // Premium AMD verdict (§4.2). Arrives separately from call.answered.
      case 'call.machine.detection.ended':
      case 'call.machine.premium.detection.ended': {
        if (call) {
          const verdict = (p as { result?: string }).result ?? null;
          await db.call.update({
            where: { id: call.id },
            data: { amdResult: verdict },
          });
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
        }
        break;
      }

      // Playback events matter for voicemail drop (build step 6): the drop
      // hangs up once the recording finishes rather than after a fixed guess.
      case 'call.playback.ended': {
        if (call?.voicemailDropped) {
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
async function findCall(callControlId: string, to?: string) {
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
