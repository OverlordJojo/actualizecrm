import { db } from '@actualizecrm/db';

/**
 * Bulk voicemail drop — the origination half.
 *
 * Splitting this across the two services is deliberate. The worker originates
 * the call, because a bulk drop queued at 4pm for tomorrow morning has to go
 * out with the laptop shut. The *app* then plays the audio, because it already
 * owns R2 presigning and the Call Control webhook; teaching the worker to talk
 * to R2 as well would duplicate credentials and code for no gain.
 *
 * The handoff is `client_state`: Telnyx echoes it back on every webhook for the
 * call, so the app learns which recording to play without the two services
 * sharing anything but the database.
 *
 * The live in-call drop (hotkey V) does not come through here at all — that one
 * is a command on a call that already exists.
 */

const BASE = 'https://api.telnyx.com/v2';

export interface VoicemailDropPayload {
  contactId: string;
  recordingId: string;
}

export interface VoicemailDropResult {
  originated: boolean;
  callId?: string;
  skipped?: string;
}

/**
 * Where Telnyx sends events for these calls.
 *
 * Per-call rather than the connection's configured URL, because the connection
 * webhook points at whatever cloudflared tunnel was last opened and that URL is
 * dead the moment the operator closes their laptop — which is the exact
 * situation this job exists to work in.
 */
function appWebhookUrl(): string {
  const base =
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.PUBLIC_WEBHOOK_URL;

  if (!base) {
    throw new Error(
      'APP_URL is not set. The worker needs the deployed app URL to receive ' +
        'Call Control events for bulk voicemail drops.',
    );
  }
  return `${base.replace(/\/$/, '')}/api/telnyx/webhook`;
}

/// US area code straight off the E.164 string. The worker has no phone-number
/// library and does not need one: every number it dials is already normalised.
function areaCode(e164: string): string | null {
  return /^\+1\d{10}$/.test(e164) ? e164.slice(2, 5) : null;
}

async function pickFromNumber(
  toE164: string,
): Promise<{ id: string; e164: string } | null> {
  const numbers = await db.phoneNumber.findMany({
    where: { active: true },
    orderBy: { dialsSent: 'asc' },
    select: { id: true, e164: true, areaCode: true },
  });
  if (numbers.length === 0) return null;

  const area = areaCode(toE164);
  const local = area ? numbers.find((n) => n.areaCode === area) : undefined;
  const chosen = local ?? numbers[0];
  return { id: chosen.id, e164: chosen.e164 };
}

export function encodeClientState(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(state)).toString('base64');
}

export async function runVoicemailDrop(
  payload: VoicemailDropPayload,
): Promise<VoicemailDropResult> {
  const apiKey = process.env.TELNYX_API_KEY;
  const connectionId = process.env.TELNYX_CONNECTION_ID;
  if (!apiKey || !connectionId) {
    throw new Error('TELNYX_API_KEY and TELNYX_CONNECTION_ID must be set.');
  }

  const contact = await db.contact.findUnique({
    where: { id: payload.contactId },
  });
  if (!contact) return { originated: false, skipped: 'lead no longer exists' };

  // Checked again here rather than only at queue time: a lead marked
  // do-not-contact between queueing and sending must not be dialled.
  if (contact.doNotContact) {
    return { originated: false, skipped: 'lead is marked do-not-contact' };
  }

  const recording = await db.voicemailRecording.findUnique({
    where: { id: payload.recordingId },
  });
  if (!recording) {
    return { originated: false, skipped: 'recording was deleted' };
  }

  const from = await pickFromNumber(contact.phone);
  if (!from) return { originated: false, skipped: 'no active number to dial from' };

  const call = await db.call.create({
    data: {
      contactId: contact.id,
      toE164: contact.phone,
      fromE164: from.e164,
      fromNumberId: from.id,
      status: 'ringing',
      direction: 'outbound',
    },
  });

  const res = await fetch(`${BASE}/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      connection_id: connectionId,
      to: contact.phone,
      from: from.e164,
      webhook_url: appWebhookUrl(),
      webhook_url_method: 'POST',
      // Premium AMD decides whether this reaches a machine or a person, and
      // the app's webhook branches on the verdict.
      answering_machine_detection: 'premium',
      answering_machine_detection_config: {
        total_analysis_time_millis: 5000,
        after_greeting_silence_millis: 800,
        between_words_silence_millis: 50,
        greeting_duration_millis: 3500,
      },
      // Long enough for a voicemail greeting to start, short enough that a
      // dead number does not hold a channel open.
      timeout_secs: 40,
      client_state: encodeClientState({
        k: 'vmdrop',
        callId: call.id,
        recordingId: recording.id,
      }),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      detail = JSON.parse(text)?.errors?.[0]?.detail ?? text;
    } catch {
      // keep the raw body
    }
    await db.call.update({
      where: { id: call.id },
      data: { status: 'failed', endedAt: new Date() },
    });
    throw new Error(`Telnyx call origination failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as {
    data?: { call_control_id?: string; call_session_id?: string };
  };

  await db.call.update({
    where: { id: call.id },
    data: {
      callControlId: json.data?.call_control_id ?? null,
      callSessionId: json.data?.call_session_id ?? null,
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

  return { originated: true, callId: call.id };
}
