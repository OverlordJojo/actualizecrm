/**
 * Call recording via Telnyx Call Control.
 *
 * Recording happens on Telnyx's side, not in the browser. v2's original design
 * used MediaRecorder in the operator's tab, which meant the laptop encoded
 * audio for seven hours a day and wrote it to local disk. Telnyx is already in
 * the media path, so it can do both for free in battery terms.
 *
 * `channels: "dual"` is the load-bearing option: it records the operator and
 * the prospect as separate channels, which is what makes speaker attribution
 * in the transcript structural rather than guessed.
 */

const BASE = 'https://api.telnyx.com/v2';

async function callControl(
  callControlId: string,
  action: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY is not set.');

  const res = await fetch(
    `${BASE}/calls/${encodeURIComponent(callControlId)}/actions/${action}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    },
  );

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      detail = JSON.parse(text)?.errors?.[0]?.detail ?? text;
    } catch {
      // keep the raw text
    }
    throw new Error(`Telnyx ${action} failed (${res.status}): ${detail}`);
  }
}

/// Starts dual-channel recording on a live call.
export async function startRecording(callControlId: string): Promise<void> {
  await callControl(callControlId, 'record_start', {
    format: 'mp3',
    // Separate legs — see the note at the top of this file.
    channels: 'dual',
    // Play nothing to either party; this is a silent recording.
    play_beep: false,
  });
}

export async function stopRecording(callControlId: string): Promise<void> {
  await callControl(callControlId, 'record_stop', {});
}

/**
 * Starts live transcription on the call.
 *
 * This is separate from recording and serves a different purpose: recording +
 * Deepgram produces the accurate post-call transcript, while this streams
 * rough text back during the call so the operator sees something live. Telnyx
 * delivers it as `call.transcription` webhooks.
 */
export async function startTranscription(callControlId: string): Promise<void> {
  await callControl(callControlId, 'transcription_start', {
    transcription_engine: 'B',
    language: 'en',
    interim_results: false,
  });
}

export async function stopTranscription(callControlId: string): Promise<void> {
  await callControl(callControlId, 'transcription_stop', {});
}

/**
 * Plays a voicemail recording into the call.
 *
 * This does not hang up. Telnyx has no "play then hang up" primitive, and
 * guessing a duration either truncates the message or leaves dead air on the
 * prospect's voicemail. Instead the caller passes a `clientState`, Telnyx
 * echoes it back on `call.playback.ended`, and the webhook hangs up at the
 * moment the audio actually finished.
 */
export async function playAudio(
  callControlId: string,
  audioUrl: string,
  clientState?: string,
): Promise<void> {
  await callControl(callControlId, 'playback_start', {
    audio_url: audioUrl,
    // One pass — a looping voicemail drop would be a genuinely bad outcome.
    loop: 1,
    ...(clientState ? { client_state: clientState } : {}),
  });
}

/// Telnyx `client_state` is base64 on the wire and echoed back on every event
/// for the call. It is how a webhook learns what a command was for without the
/// two services sharing anything but the database.
export function encodeClientState(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(state)).toString('base64');
}

export function decodeClientState(
  raw: string | undefined | null,
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export async function hangup(callControlId: string): Promise<void> {
  await callControl(callControlId, 'hangup', {});
}

/// Answering machine detection on an outbound call (§4.2).
export function amdParams() {
  return {
    answering_machine_detection: 'premium' as const,
    answering_machine_detection_config: {
      total_analysis_time_millis: 5000,
      after_greeting_silence_millis: 800,
      between_words_silence_millis: 50,
      greeting_duration_millis: 3500,
    },
  };
}

/**
 * Speaks a line into the call using Telnyx TTS.
 *
 * Used for the hold prompt on a queued owner. Silence makes people hang up
 * within seconds, and this is also what satisfies the abandoned-call
 * identification requirement in 47 CFR 64.1200 — the caller has to be
 * identified within two seconds of the greeting, so the text must name the
 * business rather than just saying "please hold".
 */
export async function speak(
  callControlId: string,
  text: string,
  clientState?: string,
): Promise<void> {
  await callControl(callControlId, 'speak', {
    payload: text,
    voice: 'female',
    language: 'en-US',
    ...(clientState ? { client_state: clientState } : {}),
  });
}

/// Stops whatever is currently playing, so hold music does not bleed into the
/// conversation when a held call is finally bridged.
export async function stopPlayback(callControlId: string): Promise<void> {
  await callControl(callControlId, 'playback_stop', {});
}

/**
 * Sends a live leg to the operator's softphone.
 *
 * A transfer rather than a bridge: the operator's browser is a SIP endpoint,
 * not a Call Control leg we hold an id for, so there is nothing to bridge
 * *to*. Transferring rings the softphone, which the dialer already knows how
 * to answer.
 */
export async function transferToOperator(
  callControlId: string,
  sipUri: string,
  fromE164: string,
  clientState?: string,
): Promise<void> {
  await callControl(callControlId, 'transfer', {
    to: sipUri,
    // Show the prospect's number on the softphone, not our own outbound
    // caller ID — the operator needs to know who they are about to talk to.
    from: fromE164,
    ...(clientState ? { client_state: clientState } : {}),
  });
}

/// Originates an outbound leg server-side, with premium AMD enabled.
export async function originate(params: {
  to: string;
  from: string;
  connectionId: string;
  webhookUrl: string;
  clientState: string;
  timeoutSecs?: number;
}): Promise<{ callControlId: string | null; callSessionId: string | null }> {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY is not set.');

  const res = await fetch(`${BASE}/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      connection_id: params.connectionId,
      to: params.to,
      from: params.from,
      webhook_url: params.webhookUrl,
      webhook_url_method: 'POST',
      client_state: params.clientState,
      timeout_secs: params.timeoutSecs ?? 30,
      ...amdParams(),
    }),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      detail = JSON.parse(text)?.errors?.[0]?.detail ?? text;
    } catch {
      // keep the raw body
    }
    throw new Error(`Telnyx origination failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as {
    data?: { call_control_id?: string; call_session_id?: string };
  };
  return {
    callControlId: json.data?.call_control_id ?? null,
    callSessionId: json.data?.call_session_id ?? null,
  };
}
