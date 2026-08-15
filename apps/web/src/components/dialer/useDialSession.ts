'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useSoftphone,
  setRemoteAudioMuted,
  type LineState,
} from '@/integrations/telnyx/useSoftphone';
import {
  useRingAudio,
  type RingAudioConfig,
} from '@/integrations/audio/useRingAudio';
import type { DispositionValue } from '@/lib/dispositions';
import { DISPOSITION_BY_HOTKEY } from '@/lib/dispositions';
import type { ActiveLead } from './ActiveLeadCard';
import type { SessionStats } from './DialControls';

/**
 * The power-dialer loop, conference-anchored (§2.2).
 *
 * The browser no longer dials. It registers as a phone, answers the one leg the
 * server places to it at session start, and then sits in a conference for the
 * whole session while prospect legs come and go around it.
 *
 * That inversion is the fix for what was reported. Previously the loop called
 * `client.newCall()` for single-line and a server route for multi-line — two
 * engines, and the multi-line one gave the browser no call object at all. Every
 * control was therefore bound to the browser's own line state, so during a burst
 * Hang up was permanently disabled: the legs belonged to the server and the
 * browser had nothing to hang up. Here, **leg state comes from the server** and
 * the browser's SDK state is used only for the operator's own audio.
 *
 * Auto-advance is driven by the server's view of the active leg rather than by
 * an SDK event. The gap between calls is deliberate breathing room; setting a
 * disposition during it does not shorten it, because being yanked into the next
 * call mid-thought is worse than waiting.
 */

interface SessionView {
  id: string;
  status: 'starting' | 'live' | 'paused' | 'ending' | 'ended';
  conferenceId: string | null;
  linesPerBurst: number;
  failureReason: string | null;
  stats: {
    dials: number;
    connects: number;
    ownerConnects: number;
    ownerRate: number;
    booked: number;
    interested: number;
    voicemails: number;
    talkTimeSec: number;
  };
  active: {
    callId: string;
    contactId: string;
    toE164: string;
    bridgedAt: string;
    isVoicemail: boolean;
  } | null;
  ringing: {
    callId: string;
    contactId: string;
    toE164: string;
    amdResult: string | null;
  }[];
  held: { callId: string; contactId: string; toE164: string; heldSeconds: number }[];
  lines: {
    callId: string;
    contactId: string;
    toE164: string;
    state: 'ringing' | 'active' | 'held';
    heldSeconds: number;
  }[];
  resolved: {
    callId: string;
    contactId: string;
    disposition: string | null;
    status: string;
  }[];
}

interface Governor {
  rate: number;
  blocked: boolean;
  allowedLines: number;
  warning: string | null;
}

/**
 * How often the dialer re-reads server state while a session is live.
 *
 * 200ms. The audio path does not wait on this — the conference is joined
 * server-side the moment a leg answers — but everything the operator *sees*
 * does: the burst collapsing to one card, the hang-up button going live, the
 * ringback stopping. A second of lag there reads as the dialer being slow even
 * when the call itself was instant.
 *
 * Five requests a second sounds like a lot and is not: one operator, one
 * session, one small query, and only while a session is actually live.
 *
 * §2.7 asks for a WebSocket push instead. That needs a socket the worker can
 * reach the browser on, which arrives with §5's media streaming; until then this
 * is close enough to be indistinguishable.
 */
const POLL_MS = 200;

/**
 * How long an auto-trashed lead stays undoable (§3.4).
 *
 * The next burst does not begin until this expires. A dropped call, a misdial
 * or a fat-fingered space bar must not silently destroy a lead, and an Undo the
 * operator is dialled away from is not an Undo.
 */
const TRASH_UNDO_MS = 10_000;

interface TrashToast {
  contactId: string;
  stageId: string | null;
  expiresAt: number;
}

export function useDialSession({
  queue,
  gapSeconds,
  audio,
  onCallEnded,
}: {
  queue: ActiveLead[];
  gapSeconds: number;
  audio: RingAudioConfig;
  linesPerBurst?: number;
  onCallEnded?: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [governor, setGovernor] = useState<Governor | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState<string | null>(null);
  const [screenPopContactId, setScreenPopContactId] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [stats, setStats] = useState<SessionStats>({
    dials: 0,
    connects: 0,
    booked: 0,
    talkTimeSec: 0,
    startedAt: null,
  });
  const [suggestedStageId, setSuggestedStageId] = useState<string | null>(null);
  const [stageLocked, setStageLocked] = useState(false);
  const [trashToast, setTrashToast] = useState<TrashToast | null>(null);
  /// True while Start is waiting on the softphone to finish registering.
  const [connectingPhone, setConnectingPhone] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const indexRef = useRef(0);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const advanceTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /// True from session start until the operator's own leg is answered, so the
  /// inbound invite is answered automatically rather than ringing at them.
  const expectingOperatorLeg = useRef(false);
  /// Guards against firing two advances for one call ending.
  const advancingRef = useRef(false);
  /// Guards the mid-call top-up, which polls five times a second.
  const refillingRef = useRef(false);
  /// Read inside async callbacks, which would otherwise close over the line
  /// state as it was when the handler was created.
  const phoneStateRef = useRef<LineState>('offline');

  const ringAudio = useRingAudio(audio);

  /**
   * Waits for the browser to finish registering as a phone.
   *
   * The SDK connects asynchronously and takes a few seconds from a cold page
   * load. Fifteen seconds is generous for a websocket handshake and short
   * enough that a genuinely dead registration is reported rather than hung on.
   */
  const waitForRegistration = useCallback(async (): Promise<boolean> => {
    for (let i = 0; i < 60; i++) {
      if (phoneStateRef.current === 'ready') return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return phoneStateRef.current === 'ready';
  }, []);

  const clearAdvance = useCallback(() => {
    if (advanceTimer.current) clearInterval(advanceTimer.current);
    advanceTimer.current = null;
    setCountdown(null);
  }, []);

  // --- the softphone: registration and the operator's own leg ---------------

  const phone = useSoftphone({
    onIncoming: async ({ callerNumber }) => {
      // The session's operator leg arrives as an inbound invite, showing the
      // operator's own Telnyx number as the caller. The operator already asked
      // for this by starting the session, so making them press Answer would be
      // a second decision about something they already decided.
      if (expectingOperatorLeg.current) {
        console.log('[dialer] operator leg ringing — answering');
        // Retried rather than fired once. The SDK reports `ringing` the moment
        // the invite lands, which can be marginally before the call object is
        // ready to be answered; a single attempt that lands in that window
        // fails silently and leaves the operator staring at their own number
        // ringing them.
        let answered = false;
        for (let i = 0; i < 12 && !answered; i++) {
          try {
            phone.answer();
            answered = true;
          } catch {
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        if (!answered) console.warn('[dialer] could not answer the operator leg');
        // The flag is cleared only on success, so a failed attempt does not
        // turn the retry below into an ordinary inbound call.
        if (answered) expectingOperatorLeg.current = false;
        return;
      }

      // A genuine inbound call. Pop the card before they pick up — the whole
      // value of a screen-pop is knowing who it is while deciding whether to
      // answer.
      try {
        const res = await fetch('/api/contacts/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: callerNumber }),
        });
        if (!res.ok) return;
        const { contact } = await res.json();
        setScreenPopContactId(contact.id);
      } catch {
        // A failed lookup must not stop the phone from ringing.
      }
    },
    onRinging: () => {
      // The operator's own leg ringing is not a prospect ringing, so it does
      // not start the ringback. Ringback follows server leg state below — that
      // is the whole reason the tone used to keep playing after a connect: the
      // browser's SDK state never changes when a *prospect* bridges, so nothing
      // ever told it to stop.
      if (audio.mode === 'music') setRemoteAudioMuted(true);
    },
    onAnswered: () => {
      // The operator is in the conference. Their ears belong to the room now.
      setRemoteAudioMuted(false);
    },
    onEnded: () => {
      setRemoteAudioMuted(false);
      ringAudio.onEnded();
    },
    onError: (message) => setError(message),
  });

  // --- server state ---------------------------------------------------------

  const refresh = useCallback(async () => {
    const id = sessionIdRef.current;
    try {
      const res = await fetch(
        `/api/dialer/session${id ? `?sessionId=${id}` : ''}`,
        { cache: 'no-store' },
      );
      if (!res.ok) return null;
      const json = await res.json();
      setView(json.view ?? null);
      setGovernor(json.governor ?? null);
      return json.view as SessionView | null;
    } catch {
      // A dropped poll is cosmetic; the next tick catches up.
      return null;
    }
  }, []);

  const command = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      const id = sessionIdRef.current;
      if (!id) return null;
      try {
        const res = await fetch('/api/dialer/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, sessionId: id, ...extra }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'That did not work.');
        if (json.view) setView(json.view);
        if (json.governor) setGovernor(json.governor);
        return json;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That did not work.');
        return null;
      }
    },
    [],
  );

  // --- advancing ------------------------------------------------------------

  const advance = useCallback(async () => {
    clearAdvance();
    const next = indexRef.current;
    const lines = view?.linesPerBurst ?? governor?.allowedLines ?? 1;
    const upcoming = queueRef.current.slice(next, next + Math.max(1, lines));

    if (upcoming.length === 0) {
      // Nothing left to dial. The conference stays up so the operator can still
      // finish with whoever is on the line.
      advancingRef.current = false;
      return;
    }

    const result = await command('advance', {
      contactIds: upcoming.map((l) => l.id),
    });
    advancingRef.current = false;

    // A held caller was served instead of a burst, so the pointer does not
    // move — none of the upcoming leads were dialled.
    if (result?.mode === 'burst') {
      /**
       * The pointer moves past exactly the leads that were dialled, and no
       * further.
       *
       * It used to advance by at least one even when the burst opened nothing,
       * which quietly skipped leads: three were handed over, one originated,
       * and the pointer jumped three. Over a session that leaves a trail of
       * numbers nobody ever called and nobody can see were missed.
       *
       * Legs that ring out are not skipped either — a no-answer drops to the
       * bottom of the column rather than being passed over, so the queue is
       * always either ahead of the pointer or already dealt with.
       */
      const legs = result.legs ?? [];
      const dialledIds = new Set(
        legs.filter((l: { callControlId?: string | null }) => l.callControlId)
          .map((l: { contactId: string }) => l.contactId),
      );

      const consumed = upcoming.filter((l) => dialledIds.has(l.id)).length;
      indexRef.current = next + Math.max(consumed, legs.length);
      setIndex(indexRef.current);
      setStats((s) => ({
        ...s,
        dials: s.dials + dialledIds.size,
        startedAt: s.startedAt ?? Date.now(),
      }));
    }
  }, [clearAdvance, command, view?.linesPerBurst, governor?.allowedLines]);

  const startGap = useCallback(() => {
    clearAdvance();
    let remaining = gapSeconds;
    setCountdown(remaining);

    if (remaining <= 0) {
      void advance();
      return;
    }
    advanceTimer.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) void advance();
      else setCountdown(remaining);
    }, 1000);
  }, [advance, clearAdvance, gapSeconds]);

  /**
   * The loop, driven by the server's view rather than an SDK event.
   *
   * Two shapes, and the difference matters at the operator's throughput:
   *
   *   - **Nothing live** → advance after the gap, opening a fresh burst.
   *   - **A call live but lines idle** → top the lines back up *now*, without
   *     waiting for the current call to end.
   *
   * The second is the "keep three on the line" rule. Waiting for a whole burst
   * to resolve before dialling again means that after the first person answers,
   * the other two lines sit empty for the length of the conversation — so a
   * three-line dialer spends most of its time as a one-line dialer.
   */
  useEffect(() => {
    if (!view || view.status !== 'live') return;

    const lines = view.linesPerBurst ?? 1;
    const live = (view.active ? 1 : 0) + view.ringing.length + view.held.length;

    /**
     * Never dial while somebody who answered is waiting.
     *
     * A person on hold has already picked up the phone. Opening new lines
     * around them spends the operator's next free moment on a stranger who has
     * not answered yet, while the one who did drifts toward giving up — and
     * every second they wait counts against the abandonment rate that caps the
     * whole operation.
     *
     * So a queued owner is not merely first in line: while one exists, nothing
     * else is dialled at all.
     */
    const someoneWaiting = (view.held?.length ?? 0) > 0;

    if (view.active && lines > 1 && live < lines && !someoneWaiting && !refillingRef.current) {
      const next = indexRef.current;
      const upcoming = queueRef.current.slice(next, next + (lines - live));
      if (upcoming.length > 0) {
        refillingRef.current = true;
        void command('advance', { contactIds: upcoming.map((l) => l.id) })
          .then((r) => {
            const dialled = (r?.legs ?? []).length;
            if (dialled > 0) {
              indexRef.current = next + dialled;
              setIndex(indexRef.current);
              setStats((s2) => ({ ...s2, dials: s2.dials + dialled }));
            }
          })
          .finally(() => {
            refillingRef.current = false;
          });
      }
    }

    if (view.active || view.ringing.length > 0) {
      advancingRef.current = false;
      clearAdvance();
      return;
    }
    // §3.4: hold the next burst while a trashed lead is still undoable.
    if (trashToast && Date.now() < trashToast.expiresAt) return;
    if (advancingRef.current || advanceTimer.current) return;
    advancingRef.current = true;

    // Somebody on hold does not wait out the gap. The gap is breathing room
    // before dialling a stranger; a queued owner has already been listening to
    // hold music and is a few seconds from giving up. Draining is urgent in a
    // way that dialling is not.
    if ((view.held?.length ?? 0) > 0) {
      clearAdvance();
      void advance();
      return;
    }

    startGap();
  }, [view, startGap, clearAdvance, trashToast, advance, command]);

  // Expire the undo window, which also releases the advance held above.
  useEffect(() => {
    if (!trashToast) return;
    const remaining = Math.max(0, trashToast.expiresAt - Date.now());
    const t = setTimeout(() => setTrashToast(null), remaining);
    return () => clearTimeout(t);
  }, [trashToast]);

  /**
   * Safety net for the operator leg (§2.2 step 1).
   *
   * If the invite is still ringing shortly after it arrived, keep trying to
   * answer it. Autoplay policy and SDK timing can both make the first attempt
   * fail from inside a websocket callback, and the failure mode without this is
   * the worst one available: the operator watches their own number ring them
   * while the dialer does nothing.
   */
  useEffect(() => {
    if (!phone.incoming || !expectingOperatorLeg.current) return;
    const t = setInterval(() => {
      if (!expectingOperatorLeg.current) return;
      try {
        phone.answer();
      } catch {
        // Next tick.
      }
    }, 700);
    const stop = setTimeout(() => clearInterval(t), 8000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone.incoming]);

  // Once the browser is on the call, the leg is answered — stop expecting it.
  useEffect(() => {
    if (phone.state === 'connected') expectingOperatorLeg.current = false;
  }, [phone.state]);

  // Poll while a session exists.
  useEffect(() => {
    if (!sessionId) return;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [sessionId, refresh]);

  /**
   * Ringback and music follow **server leg state**, not the browser's (§4.2).
   *
   * Three states, and each has exactly one correct sound:
   *   - legs ringing, nobody bridged  → ringback (or Spotify in music mode)
   *   - a prospect bridged            → silence, so the operator can talk
   *   - neither                       → idle
   *
   * Driving this from the SDK was the bug behind "the ring tone doesn't turn
   * off when a call connects". The browser sits in the conference unchanged
   * while prospect legs come and go around it, so its own state never moves and
   * nothing ever stopped the tone.
   */
  const audioPhase = useRef<'idle' | 'ringing' | 'connected'>('idle');
  useEffect(() => {
    const phase: 'idle' | 'ringing' | 'connected' = view?.active
      ? 'connected'
      : (view?.ringing.length ?? 0) > 0
        ? 'ringing'
        : 'idle';

    if (phase === audioPhase.current) return;
    const previous = audioPhase.current;
    audioPhase.current = phase;

    if (phase === 'ringing') ringAudio.onRinging();
    else if (phase === 'connected') ringAudio.onAnswered();
    else ringAudio.onEnded();

    // The call is over the moment the bridged leg goes away, whoever ended it.
    if (previous === 'connected' && phase !== 'connected') onCallEnded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.active, view?.ringing.length]);

  // --- session control ------------------------------------------------------

  const startSession = useCallback(async () => {
    const leads = queueRef.current;
    if (leads.length === 0) return;

    // The session is a call *to* this browser, so the browser has to be
    // registered as a phone before there is anywhere to send it.
    //
    // Waited for, not refused. Registration takes a few seconds after a page
    // load, which is exactly when somebody presses Start — telling them to come
    // back later is making the operator do the computer's waiting.
    setError(null);
    if (phoneStateRef.current !== 'ready') {
      setConnectingPhone(true);
      const registered = await waitForRegistration();
      setConnectingPhone(false);
      if (!registered) {
        setError(
          'The dialer could not register as a phone, so there is nowhere to ' +
            'connect calls to. Reload the page; if it keeps happening, check ' +
            'that the browser has microphone permission for this site.',
        );
        return;
      }
    }

    // The browser will not start audio without a user gesture, and this runs
    // inside the Start-session click (§4.2). Initialising Spotify anywhere else
    // leaves the AudioContext suspended and playback silently dead.
    void ringAudio.initSpotify();
    indexRef.current = 0;
    setIndex(0);
    setStats({ dials: 0, connects: 0, booked: 0, talkTimeSec: 0, startedAt: Date.now() });
    expectingOperatorLeg.current = true;

    try {
      const res = await fetch('/api/dialer/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          contactIds: leads.map((l) => l.id),
          sourceType: 'stage',
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not start the session.');
      setSessionId(json.sessionId);
      sessionIdRef.current = json.sessionId;
      if (json.governor) setGovernor(json.governor);
    } catch (e) {
      expectingOperatorLeg.current = false;
      setError(e instanceof Error ? e.message : 'Could not start the session.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitForRegistration]);

  // A session that ends before its conference exists never started. Surface the
  // carrier's reason rather than leaving a dialer that silently did nothing.
  useEffect(() => {
    if (view?.failureReason) {
      setError(view.failureReason);
      setSessionId(null);
      sessionIdRef.current = null;
    }
  }, [view?.failureReason]);

  /**
   * Stops opening new bursts. Anything already ringing rings out.
   *
   * Pausing does not touch live legs, which is the whole point — a prospect
   * mid-sentence must not be dropped because the operator wanted a breather
   * after this call.
   */
  const pauseSession = useCallback(async () => {
    clearAdvance();
    advancingRef.current = false;
    await command('pause');
  }, [clearAdvance, command]);

  const resumeSession = useCallback(async () => {
    advancingRef.current = false;
    await command('resume');
  }, [command]);

  /// P toggles. Without this, pausing was a one-way door: the button said Pause
  /// whether or not it already was, so there was no way back and the dialer
  /// looked broken.
  const togglePause = useCallback(async () => {
    if (view?.status === 'paused') await resumeSession();
    else await pauseSession();
  }, [view?.status, pauseSession, resumeSession]);

  const endSession = useCallback(async () => {
    clearAdvance();
    expectingOperatorLeg.current = false;
    advancingRef.current = false;
    await command('end');
    setSessionId(null);
    sessionIdRef.current = null;
    setView(null);
  }, [clearAdvance, command]);

  /// Releases the prospect and advances. Never touches the operator's leg —
  /// that is the guarantee the conference anchor exists to provide.
  const hangup = useCallback(async () => {
    await command('hangup');
  }, [command]);

  /// Moves the operator to another live line, parking the current one.
  const switchToLine = useCallback(
    async (callId: string) => {
      await command('switch', { callId });
    },
    [command],
  );

  /// Drops one specific line — ringing, parked, or live — without disturbing
  /// the others.
  const hangupLine = useCallback(
    async (callId: string) => {
      await command('hangupCall', { callId });
    },
    [command],
  );

  const hangupAndNext = useCallback(async () => {
    if (view?.active) await hangup();
    else if (view?.status === 'live') await advance();
  }, [view?.active, view?.status, hangup, advance]);

  /**
   * A one-lead session (§2.3).
   *
   * The manual dialer is not a second engine any more. Typing a number opens a
   * session with one lead in it, which is the whole point: one code path, one
   * set of bugs.
   */
  const dialManual = useCallback(
    async (rawPhone: string) => {
      setError(null);
      try {
        const lookup = await fetch('/api/contacts/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: rawPhone }),
        });
        const { contact } = await lookup.json();
        if (!contact?.id) throw new Error('Could not resolve that number.');

        expectingOperatorLeg.current = true;
        const res = await fetch('/api/dialer/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'start',
            contactIds: [contact.id],
            sourceType: 'manual',
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not dial that number.');
        setSessionId(json.sessionId);
        sessionIdRef.current = json.sessionId;
      } catch (e) {
        expectingOperatorLeg.current = false;
        setError(e instanceof Error ? e.message : 'Could not dial that number.');
      }
    },
    [],
  );

  /**
   * Records the outcome and files the lead in one step (§3.5).
   *
   * "Not Interested" trashes the lead, which is destructive enough that the
   * next burst waits for the undo window to close (§3.4). Being yanked into
   * the next call while a ten-second Undo is still on screen makes the Undo
   * decorative.
   */
  const setDisposition = useCallback(
    async (value: DispositionValue) => {
      const callId = view?.active?.callId;
      if (!callId) return;

      if (value === 'booked') setStats((s) => ({ ...s, booked: s.booked + 1 }));

      try {
        const res = await fetch('/api/dialer/outcome', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callId, disposition: value }),
        });
        const result = await res.json();
        if (result?.trashed && result.contactId) {
          setTrashToast({
            contactId: result.contactId,
            stageId: result.previousStageId ?? null,
            expiresAt: Date.now() + TRASH_UNDO_MS,
          });
        }
      } catch {
        setError('The outcome was not saved. Try again before moving on.');
      }

      onCallEnded?.();
      // Setting an outcome while connected means the operator is done talking,
      // so release the prospect — the gap then runs normally.
      await hangup();
    },
    [view?.active?.callId, hangup, onCallEnded],
  );

  const undoTrash = useCallback(async () => {
    const toast = trashToast;
    if (!toast) return;
    setTrashToast(null);
    await fetch('/api/dialer/outcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'undo',
        contactId: toast.contactId,
        stageId: toast.stageId,
      }),
    }).catch(() => {});
    onCallEnded?.();
  }, [trashToast, onCallEnded]);

  const dropVoicemail = useCallback(async () => {
    const callId = view?.active?.callId;
    if (!callId || dropping) return;
    setError(null);
    try {
      const res = await fetch('/api/voicemail/drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not drop voicemail.');
      setDropping(json.recordingName);
      onCallEnded?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not drop voicemail.');
    }
  }, [view?.active?.callId, dropping, onCallEnded]);

  useEffect(() => {
    if (!view?.active) setDropping(null);
  }, [view?.active]);

  // --- AI stage suggestion (§5.6) -------------------------------------------

  const activeContactId = view?.active?.contactId ?? null;

  useEffect(() => {
    if (!activeContactId) {
      setSuggestedStageId(null);
      setStageLocked(false);
      return;
    }
    setStageLocked(false);
    setSuggestedStageId(null);
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const rows: { fieldType: string; value: string | null }[] = await fetch(
          `/api/ai/suggestions?contactId=${activeContactId}`,
        ).then((r) => r.json());
        const stage = rows.find((r) => r.fieldType === 'stage');
        if (!stage?.value) return;
        const stages = await fetch('/api/stages').then((r) => r.json());
        const match = (stages as { id: string; name: string }[]).find(
          (st) => st.name.toLowerCase() === stage.value!.toLowerCase(),
        );
        if (match && !cancelled) setSuggestedStageId(match.id);
      } catch {
        // A missed poll just means the outline appears a few seconds later.
      }
    };
    tick();
    const t = setInterval(tick, 6000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [activeContactId]);

  const lockStageChoice = useCallback(async () => {
    setStageLocked(true);
    setSuggestedStageId(null);
    if (!activeContactId) return;
    try {
      const rows: { id: string; fieldType: string }[] = await fetch(
        `/api/ai/suggestions?contactId=${activeContactId}`,
      ).then((r) => r.json());
      await Promise.all(
        rows
          .filter((r) => r.fieldType === 'stage')
          .map((r) =>
            fetch('/api/ai/suggestions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ suggestionId: r.id, decision: 'dismissed' }),
            }),
          ),
      );
    } catch {
      // The lockout is already in effect locally.
    }
  }, [activeContactId]);

  // --- hotkeys --------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          void hangupAndNext();
          break;
        case '1':
        case '2':
        case '3':
        case '4': {
          const match = DISPOSITION_BY_HOTKEY[e.key];
          if (match) {
            e.preventDefault();
            void setDisposition(match.value);
          }
          break;
        }
        case 'v':
        case 'V':
          e.preventDefault();
          void dropVoicemail();
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          if (sessionIdRef.current) void togglePause();
          else void startSession();
          break;
        case 'Escape':
          e.preventDefault();
          void endSession();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hangupAndNext, setDisposition, togglePause, startSession, endSession, dropVoicemail]);

  useEffect(() => () => clearAdvance(), [clearAdvance]);

  // --- derived UI state -----------------------------------------------------

  phoneStateRef.current = phone.state;

  const activeLead: ActiveLead | null = view?.active
    ? queueRef.current.find((l) => l.id === view.active!.contactId) ?? null
    : null;

  /// Ringing legs, resolved against the queue so §3.7 can show each one's name,
  /// company and title side by side.
  const ringingLeads: ActiveLead[] = (view?.ringing ?? [])
    .map((r) => queueRef.current.find((l) => l.id === r.contactId))
    .filter((l): l is ActiveLead => Boolean(l));

  /// Line state for display. Server truth first — the browser's SDK is a
  /// conference participant and knows nothing about prospect legs.
  const lineState: LineState = view?.active
    ? 'connected'
    : (view?.ringing.length ?? 0) > 0
      ? 'ringing'
      : phone.state;

  return {
    lineState,
    muted: phone.muted,
    isOnCall: Boolean(view?.active),
    phoneError: phone.error,
    error,
    clearError: () => setError(null),

    sessionActive: Boolean(sessionId) && view?.status !== 'ended',
    /// Start pressed, waiting on registration. Distinct from a live session.
    connectingPhone,
    sessionId,
    activeLead,
    ringingLeads,
    /**
     * Drives Hang up. Real leg state from webhooks — never optimistic (§2.4).
     *
     * Enabled whenever *anything* is live, not only when the active pointer is
     * set. The pointer can lag reality by a webhook, and a hang-up button that
     * is greyed out while somebody is talking is the single most frustrating
     * thing this dialer can do.
     */
    canHangup:
      Boolean(view?.active) ||
      (view?.lines ?? []).some((l) => l.state === 'active' || l.state === 'held'),
    /// True while the operator is hearing a machine's greeting, not a person.
    listeningToVoicemail: Boolean(view?.active?.isVoicemail),
    resolved: view?.resolved ?? [],
    callerId: null as string | null,
    activeCallId: view?.active?.callId ?? null,
    suggestedStageId: stageLocked ? null : suggestedStageId,
    stageLocked,
    lockStageChoice,
    incoming: phone.incoming,
    /// True when the ringing invite is this session's own operator leg rather
    /// than a prospect calling in. The UI labels it accordingly — an operator
    /// seeing their own number ring them has no way to know which it is.
    incomingIsOperatorLeg: Boolean(phone.incoming) && expectingOperatorLeg.current,
    burstActive: (view?.ringing.length ?? 0) > 0,
    held: view?.held ?? [],
    lines: view?.lines ?? [],
    switchToLine,
    hangupLine,
    governor,
    answerInbound: phone.answer,
    declineInbound: phone.decline,
    screenPopContactId,
    clearScreenPop: () => setScreenPopContactId(null),
    countdown,
    // Server-counted, from call rows. A browser counter drifts the moment a
    // request fails or the page is reloaded mid-session (§6.2).
    stats: view?.stats
      ? {
          ...stats,
          dials: view.stats.dials,
          connects: view.stats.connects,
          booked: view.stats.booked,
          talkTimeSec: view.stats.talkTimeSec,
        }
      : stats,
    sessionStats: view?.stats ?? null,
    index,
    dropping,
    dropVoicemail,

    startSession,
    pauseSession,
    resumeSession,
    togglePause,
    paused: view?.status === 'paused',
    endSession,
    dialManual,
    hangup,
    hangupAndNext,
    toggleMute: phone.toggleMute,
    setDisposition,
    trashToast,
    undoTrash,
    callControlId: phone.callControlId,

    initSpotify: ringAudio.initSpotify,
    spotifyDiagnostics: ringAudio.spotifyDiagnostics,
    spotifyReady: ringAudio.spotifyReady,
    spotifyProblem: ringAudio.spotifyProblem,
    silentFallback: ringAudio.silentFallback,
  };
}
