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
 * **The creating leg is already a participant.** Telnyx puts it in as the first
 * one, so joining it afterwards is not just redundant — it errors, and that
 * error is what stopped the dialer working: the join threw before the
 * conference id had been written down, the job retried, and every retry hit
 * "Conference with given name already exists and it's active" because the
 * first attempt had in fact succeeded. A conference existed on Telnyx that the
 * app had no record of, forever.
 *
 * So this is idempotent. If the name is taken, the existing conference is
 * looked up and returned, which makes a retry harmless rather than fatal.
 *
 * `start_conference_on_create: true` is load-bearing, and I had it backwards.
 *
 * With it false the conference sits in `init` and the operator, though a
 * participant, is not an *active* one. The room only starts when a prospect
 * enters — and when that prospect hangs up it has no active participants left,
 * so Telnyx ends it. Every subsequent leg then failed with "this conference is
 * no longer active and can't receive commands": not bridged, not held, silently
 * dropped mid-session after the first call.
 *
 * True keeps the operator active for the whole session, which is exactly what
 * anchoring on a conference is for. A lone participant in an active conference
 * hears silence, not hold music — hold music is what `false` produces, which is
 * what the old comment had inverted.
 */
export async function createConference(params: {
  callControlId: string;
  name: string;
}): Promise<Conference> {
  try {
    const json = await conferenceApi<{ data?: { id?: string; name?: string } }>(
      '/conferences',
      {
        name: params.name,
        call_control_id: params.callControlId,
        start_conference_on_create: true,
      },
    );

    const id = json.data?.id;
    if (!id) throw new Error('Telnyx created a conference without returning an id.');
    return { id, name: json.data?.name ?? params.name };
  } catch (err) {
    // Already exists — almost always this same session retrying after a failure
    // later in the sequence. Adopt it rather than failing forever.
    const existing = await findConferenceByName(params.name);
    if (existing) return existing;
    throw err;
  }
}

/// Looks a conference up by the name we gave it, so a retry can adopt one that
/// a previous attempt created.
export async function findConferenceByName(name: string): Promise<Conference | null> {
  const key = process.env.TELNYX_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(
      `${TELNYX_API}/conferences?filter[name]=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${key}` }, ...NO_STORE },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { id?: string; name?: string; status?: string }[];
    };
    const found = json.data?.find((c) => c.name === name && c.status !== 'completed');
    return found?.id ? { id: found.id, name: found.name ?? name } : null;
  } catch {
    return null;
  }
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
