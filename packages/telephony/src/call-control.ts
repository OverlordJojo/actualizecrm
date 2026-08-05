/**
 * Telnyx Call Control primitives, shared by the web app and the worker.
 *
 * These moved out of `apps/web/src/integrations/telnyx/recording.ts` when the
 * webhook moved to the worker (§1). Nothing here touches the database or the
 * request — it is the raw REST surface and only that, which is why both
 * services can hold it without either owning it.
 *
 * `channels: "dual"` on recording is the load-bearing option: it records the
 * operator and the prospect as separate channels, which is what makes speaker
 * attribution in the transcript structural rather than guessed (§5.2).
 */

export const TELNYX_API = 'https://api.telnyx.com/v2';

/**
 * Opts out of Next.js's fetch cache.
 *
 * Next patches global `fetch` and caches GETs by default, which would serve a
 * stale connection or call state; plain Node ignores the option entirely. It is
 * cast because `@types/node`'s `RequestInit` has no `cache` field — this
 * package is compiled against Node's types and consumed by both runtimes.
 */
export const NO_STORE = { cache: 'no-store' } as unknown as RequestInit;

export class TelnyxCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly action: string,
  ) {
    super(message);
    this.name = 'TelnyxCallError';
  }
}

function apiKey(): string {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY is not set.');
  return key;
}

/// Pulls the useful sentence out of a Telnyx error body, falling back to raw
/// text. Their errors are an array and the first `detail` is the readable one.
export function telnyxErrorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return parsed?.errors?.[0]?.detail ?? parsed?.errors?.[0]?.title ?? text;
  } catch {
    return text;
  }
}

async function callControl(
  callControlId: string,
  action: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const res = await fetch(
    `${TELNYX_API}/calls/${encodeURIComponent(callControlId)}/actions/${action}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...NO_STORE,
    },
  );

  if (!res.ok) {
    throw new TelnyxCallError(
      `Telnyx ${action} failed (${res.status}): ${telnyxErrorDetail(await res.text())}`,
      res.status,
      action,
    );
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
 * Separate from recording and serving a different purpose: recording plus
 * post-call transcription produces the accurate archive, while this streams
 * rough text back *during* the call so the operator sees something live.
 * Telnyx delivers it as `call.transcription` webhooks.
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
 * Plays a recording into the call.
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

/// Stops whatever is currently playing, so hold music does not bleed into the
/// conversation when a held call is finally bridged.
export async function stopPlayback(callControlId: string): Promise<void> {
  await callControl(callControlId, 'playback_stop', {});
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

export async function hangup(callControlId: string): Promise<void> {
  await callControl(callControlId, 'hangup', {});
}

export async function answer(
  callControlId: string,
  clientState?: string,
): Promise<void> {
  await callControl(callControlId, 'answer', {
    ...(clientState ? { client_state: clientState } : {}),
  });
}

/**
 * Sends a live leg to a SIP address.
 *
 * Retained for inbound routing. The multi-line dialer does **not** use this —
 * §2.2 anchors every session on a conference instead, because a transfer
 * leaves the operator's audio path owned by whichever prospect leg happens to
 * be up, and that is what made hang-up uncontrollable.
 */
export async function transfer(
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

/// Answering machine detection on an outbound call (§2.2 step 4).
export function amdParams() {
  return {
    answering_machine_detection: 'premium' as const,
    answering_machine_detection_config: {
      // AMD no longer gates the connection — the leg is bridged on answer and
      // this only removes machines afterwards — so accuracy is free. Nobody
      // waits on this number any more.
      total_analysis_time_millis: 8000,
      after_greeting_silence_millis: 1000,
      between_words_silence_millis: 75,
      greeting_duration_millis: 3500,
    },
  };
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
  const res = await fetch(`${TELNYX_API}/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
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
    ...NO_STORE,
  });

  if (!res.ok) {
    throw new TelnyxCallError(
      `Telnyx origination failed (${res.status}): ${telnyxErrorDetail(await res.text())}`,
      res.status,
      'dial',
    );
  }

  const json = (await res.json()) as {
    data?: { call_control_id?: string; call_session_id?: string };
  };
  return {
    callControlId: json.data?.call_control_id ?? null,
    callSessionId: json.data?.call_session_id ?? null,
  };
}

/**
 * Originates the operator's own leg, to their SIP address (§2.2 step 1).
 *
 * Deliberately not `originate()`: no answering-machine detection. AMD on the
 * operator's own softphone would be nonsense, and premium AMD holds a leg
 * unbridged for up to five seconds while it decides — five seconds of the
 * operator staring at a dead session at the start of every run.
 *
 * The long `timeoutSecs` is intentional too. This leg is the session; if it
 * fails to establish there is no session, so it gets time to register rather
 * than racing a browser that may still be waking its microphone.
 */
export async function originateOperatorLeg(params: {
  sipUri: string;
  from: string;
  connectionId: string;
  webhookUrl: string;
  clientState: string;
  timeoutSecs?: number;
}): Promise<{ callControlId: string | null; callSessionId: string | null }> {
  const res = await fetch(`${TELNYX_API}/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      connection_id: params.connectionId,
      to: params.sipUri,
      from: params.from,
      webhook_url: params.webhookUrl,
      webhook_url_method: 'POST',
      client_state: params.clientState,
      timeout_secs: params.timeoutSecs ?? 60,
    }),
    ...NO_STORE,
  });

  if (!res.ok) {
    throw new TelnyxCallError(
      `Could not reach the operator's softphone (${res.status}): ${telnyxErrorDetail(await res.text())}`,
      res.status,
      'operator_leg',
    );
  }

  const json = (await res.json()) as {
    data?: { call_control_id?: string; call_session_id?: string };
  };
  return {
    callControlId: json.data?.call_control_id ?? null,
    callSessionId: json.data?.call_session_id ?? null,
  };
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

/**
 * Whether an AMD verdict means a person picked up.
 *
 * **Premium AMD does not return `"human"`.** It distinguishes the kind of
 * human: `human_residence` and `human_business`. Testing for `"human"` alone
 * therefore classifies every real person as a machine — which is exactly what
 * happened, and why a burst could reach somebody and hang up on them before the
 * operator ever heard it.
 *
 * `human` is still accepted because the basic detector does return it, and a
 * connection is only ever configured per call.
 */
export function isHumanVerdict(verdict: string | null | undefined): boolean {
  if (!verdict) return false;
  const v = verdict.toLowerCase();
  return v === 'human' || v.startsWith('human_');
}

/**
 * Whether an AMD verdict means a machine took the call.
 *
 * Everything that is neither human nor machine — `not_sure`, `silence`,
 * `fax_detected` — is deliberately *not* machine. §2.2 treats those as
 * automated systems, because bridging the operator to something that might be
 * an IVR wastes the one resource a burst exists to protect.
 */
export function isMachineVerdict(verdict: string | null | undefined): boolean {
  const v = (verdict ?? '').toLowerCase();
  return v === 'machine' || v.startsWith('machine_');
}

/// Fax and modem tones. Never worth connecting an operator to, and unlike
/// `not_sure` there is no chance a person is behind it.
export function isFaxVerdict(verdict: string | null | undefined): boolean {
  const v = (verdict ?? '').toLowerCase();
  return v.includes('fax') || v.includes('modem');
}

/**
 * Connects two legs directly, with no conference in between.
 *
 * A conference mixes: it buffers each participant to align packets before
 * combining them, which is correct for three people talking and costs close to
 * a second of round-trip when only two are. That delay is symmetric — the
 * operator hears the prospect late *and* is heard late — which is exactly how a
 * mixer presents and nothing like how distance presents.
 *
 * A bridge just connects the two media paths. No alignment, no mixing, no
 * buffer beyond the jitter one each leg already has.
 *
 * The cost is that a bridge is strictly two-party, so a parked caller cannot
 * sit inside it. They wait on their own leg with hold audio instead, which is
 * what §2.2's hold queue needed anyway — nobody on hold needs to hear anybody.
 */
export async function bridgeCalls(params: {
  callControlId: string;
  otherCallControlId: string;
  clientState?: string;
}): Promise<void> {
  await callControl(params.callControlId, 'bridge', {
    call_control_id: params.otherCallControlId,
    // Neither side hears a tone when they are joined. A beep mid-greeting is
    // the prospect's first impression of the call.
    play_ringtone: false,
    ...(params.clientState ? { client_state: params.clientState } : {}),
  });
}

/**
 * Parks a leg on its own, playing hold audio in a loop.
 *
 * Used for a queued owner while the operator is on another call. Silence makes
 * people hang up within seconds, so something has to play — but it is played
 * *to that leg alone*, not into a shared room, which is why no conference is
 * needed to hold somebody.
 */
export async function parkWithHoldAudio(params: {
  callControlId: string;
  audioUrl?: string;
  clientState?: string;
}): Promise<void> {
  if (!params.audioUrl) return;
  await callControl(params.callControlId, 'playback_start', {
    audio_url: params.audioUrl,
    loop: 'infinity',
    ...(params.clientState ? { client_state: params.clientState } : {}),
  });
}
