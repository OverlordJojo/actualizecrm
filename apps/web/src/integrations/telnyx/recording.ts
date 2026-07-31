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

/// Plays a voicemail recording into the call, then hangs up when it finishes.
export async function playAudio(
  callControlId: string,
  audioUrl: string,
): Promise<void> {
  await callControl(callControlId, 'playback_start', {
    audio_url: audioUrl,
    // One pass — a looping voicemail drop would be a genuinely bad outcome.
    loop: 1,
  });
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
