import { TELNYX_API, telnyxErrorDetail, NO_STORE, TelnyxCallError } from './call-control';

/**
 * Telnyx conferences — the anchor the whole dialer hangs off (§2.2).
 *
 * Why a conference rather than a transfer, stated once so it does not get
 * re-litigated: a transfer hands the operator's audio path to whichever
 * prospect leg happens to be up. That makes the operator's presence a property
 * of the prospect's leg, so there is nothing stable to hang up *from*, no way
 * to hold a second answerer, and no way to run AMD before the operator's ears
 * are committed. It is why the hang-up button had no leg to act on.
 *
 * A conference inverts that. The operator joins once at session start and stays
 * for the entire session; prospect legs join and leave around them. Hanging up
 * a prospect is a `leave` on that prospect's leg and cannot touch the operator.
 * Parallel dialing works because the server holds every leg. And the session
 * survives navigation because none of it lives in the browser.
 *
 * One asymmetry worth knowing: a conference is *created from* an existing leg,
 * which becomes its first participant. There is no way to make an empty one. So
 * the operator leg must be up before the conference exists — that ordering is
 * forced by the API, not a choice.
 */

async function conferenceApi<T = Record<string, unknown>>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY is not set.');

  const res = await fetch(`${TELNYX_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...NO_STORE,
  });

  if (!res.ok) {
    throw new TelnyxCallError(
      `Telnyx ${path} failed (${res.status}): ${telnyxErrorDetail(await res.text())}`,
      res.status,
      path,
    );
  }
  return (await res.json()) as T;
}

export interface Conference {
  id: string;
  name: string;
}

/**
 * Creates the session's conference around the operator's leg.
 *
 * `start_conference_on_create: false` matters. Left true, Telnyx starts the
 * conference the instant it is made and the operator hears hold music into an
 * empty room for the whole session.
 */
export async function createConference(params: {
  callControlId: string;
  name: string;
}): Promise<Conference> {
  const json = await conferenceApi<{ data?: { id?: string; name?: string } }>(
    '/conferences',
    {
      name: params.name,
      call_control_id: params.callControlId,
      start_conference_on_create: false,
      // The operator hears silence between calls, not Telnyx's hold music —
      // Spotify owns their ears between calls (§4).
      hold_audio_url: undefined,
    },
  );

  const id = json.data?.id;
  if (!id) throw new Error('Telnyx created a conference without returning an id.');
  return { id, name: json.data?.name ?? params.name };
}

/**
 * Brings a leg into the conference.
 *
 * `endConferenceOnExit` is never set for a prospect: a prospect hanging up must
 * not tear down the room the operator is sitting in. Only the operator's own
 * leg ends the conference, and the session teardown does that explicitly.
 */
export async function joinConference(params: {
  conferenceId: string;
  callControlId: string;
  /// Join muted — used for the operator between calls, so a prospect being
  /// connected never hears the tail of whatever was being said.
  mute?: boolean;
  /// Join straight onto hold, for a queued owner (§2.2 step 8).
  hold?: boolean;
  /// Played to a participant put on hold at join time.
  holdAudioUrl?: string;
  /// The operator's leg starts the conference; prospects do not.
  startConferenceOnEnter?: boolean;
  clientState?: string;
}): Promise<void> {
  await conferenceApi(`/conferences/${params.conferenceId}/actions/join`, {
    call_control_id: params.callControlId,
    mute: params.mute ?? false,
    hold: params.hold ?? false,
    ...(params.holdAudioUrl ? { hold_audio_url: params.holdAudioUrl } : {}),
    start_conference_on_enter: params.startConferenceOnEnter ?? false,
    // Never true. See the note above.
    end_conference_on_exit: false,
    ...(params.clientState ? { client_state: params.clientState } : {}),
  });
}

export async function leaveConference(params: {
  conferenceId: string;
  callControlId: string;
}): Promise<void> {
  await conferenceApi(`/conferences/${params.conferenceId}/actions/leave`, {
    call_control_id: params.callControlId,
  });
}

export async function muteParticipants(params: {
  conferenceId: string;
  callControlIds: string[];
}): Promise<void> {
  await conferenceApi(`/conferences/${params.conferenceId}/actions/mute`, {
    call_control_ids: params.callControlIds,
  });
}

export async function unmuteParticipants(params: {
  conferenceId: string;
  callControlIds: string[];
}): Promise<void> {
  await conferenceApi(`/conferences/${params.conferenceId}/actions/unmute`, {
    call_control_ids: params.callControlIds,
  });
}

/// Parks a participant. Used for a queued owner who answered while the operator
/// was already talking to somebody else.
export async function holdParticipants(params: {
  conferenceId: string;
  callControlIds: string[];
  audioUrl?: string;
}): Promise<void> {
  await conferenceApi(`/conferences/${params.conferenceId}/actions/hold`, {
    call_control_ids: params.callControlIds,
    ...(params.audioUrl ? { audio_url: params.audioUrl } : {}),
  });
}

export async function unholdParticipants(params: {
  conferenceId: string;
  callControlIds: string[];
}): Promise<void> {
  await conferenceApi(`/conferences/${params.conferenceId}/actions/unhold`, {
    call_control_ids: params.callControlIds,
  });
}

/// Speaks into the conference — or to one participant, when `callControlIds` is
/// given. The hold prompt a queued owner hears goes through here.
export async function speakToConference(params: {
  conferenceId: string;
  text: string;
  callControlIds?: string[];
}): Promise<void> {
  await conferenceApi(`/conferences/${params.conferenceId}/actions/speak`, {
    payload: params.text,
    voice: 'female',
    language: 'en-US',
    ...(params.callControlIds ? { call_control_ids: params.callControlIds } : {}),
  });
}
