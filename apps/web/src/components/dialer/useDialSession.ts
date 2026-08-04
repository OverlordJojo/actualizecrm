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
  active: {
    callId: string;
    contactId: string;
    toE164: string;
    bridgedAt: string;
  } | null;
  ringing: {
    callId: string;
    contactId: string;
    toE164: string;
    amdResult: string | null;
  }[];
  held: { callId: string; contactId: string; toE164: string; heldSeconds: number }[];
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

/// How often the dialer re-reads server state while a session is live.
///
/// One second. The visible cost is the moment a burst collapses to a single
/// lead card, and a second of lag there is noticeable but not harmful. §2.7 asks
/// for a WebSocket push; that needs a socket the worker can reach the browser
/// on, which is §5's media-stream work. Polling is the honest interim and it is
/// marked as such rather than quietly left.
const POLL_MS = 1000;

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

  const ringAudio = useRingAudio(audio);

  const clearAdvance = useCallback(() => {
    if (advanceTimer.current) clearInterval(advanceTimer.current);
    advanceTimer.current = null;
    setCountdown(null);
  }, []);

  // --- the softphone: registration and the operator's own leg ---------------

  const phone = useSoftphone({
    onIncoming: async ({ callerNumber }) => {
      // The session's operator leg arrives as an inbound invite. The operator
      // already asked for this by starting the session, so making them press
      // Answer would be a second decision about something they already decided.
      if (expectingOperatorLeg.current) {
        expectingOperatorLeg.current = false;
        phone.answer();
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
      if (audio.mode === 'music') setRemoteAudioMuted(true);
      ringAudio.onRinging();
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

    // A held caller was served instead of a burst, so the queue pointer does
    // not move — none of the upcoming leads were dialled.
    if (result?.mode === 'burst') {
      const dialled = (result.legs ?? []).length;
      indexRef.current = next + Math.max(dialled, 1);
      setIndex(indexRef.current);
      setStats((s) => ({
        ...s,
        dials: s.dials + dialled,
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

  // The loop. When the server says nothing is active and nothing is ringing,
  // it is time for the next burst — driven by the server's view rather than an
  // SDK event, because the legs are the server's.
  useEffect(() => {
    if (!view || view.status !== 'live') return;
    if (view.active || view.ringing.length > 0) {
      advancingRef.current = false;
      clearAdvance();
      return;
    }
    // §3.4: hold the next burst while a trashed lead is still undoable.
    if (trashToast && Date.now() < trashToast.expiresAt) return;
    if (advancingRef.current || advanceTimer.current) return;
    advancingRef.current = true;
    startGap();
  }, [view, startGap, clearAdvance, trashToast]);

  // Expire the undo window, which also releases the advance held above.
  useEffect(() => {
    if (!trashToast) return;
    const remaining = Math.max(0, trashToast.expiresAt - Date.now());
    const t = setTimeout(() => setTrashToast(null), remaining);
    return () => clearTimeout(t);
  }, [trashToast]);

  // Poll while a session exists.
  useEffect(() => {
    if (!sessionId) return;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [sessionId, refresh]);

  // Pause and resume Spotify against the *bridged leg*, not the browser's line
  // state — §4.2. The prospect is in the operator's ear the moment the server
  // says the leg bridged.
  const wasActive = useRef(false);
  useEffect(() => {
    const active = Boolean(view?.active);
    if (active === wasActive.current) return;
    wasActive.current = active;
    if (active) ringAudio.onAnswered();
    else ringAudio.onEnded();
    if (!active) onCallEnded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.active]);

  // --- session control ------------------------------------------------------

  const startSession = useCallback(async () => {
    const leads = queueRef.current;
    if (leads.length === 0) return;

    setError(null);
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
  }, []);

  const pauseSession = useCallback(async () => {
    clearAdvance();
    await command('pause');
  }, [clearAdvance, command]);

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
          if (sessionIdRef.current) void pauseSession();
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
  }, [hangupAndNext, setDisposition, pauseSession, startSession, endSession, dropVoicemail]);

  useEffect(() => () => clearAdvance(), [clearAdvance]);

  // --- derived UI state -----------------------------------------------------

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
    sessionId,
    activeLead,
    ringingLeads,
    /// Drives Hang up. Real leg state from webhooks — never optimistic (§2.4).
    canHangup: Boolean(view?.active),
    resolved: view?.resolved ?? [],
    callerId: null as string | null,
    activeCallId: view?.active?.callId ?? null,
    suggestedStageId: stageLocked ? null : suggestedStageId,
    stageLocked,
    lockStageChoice,
    incoming: phone.incoming,
    burstActive: (view?.ringing.length ?? 0) > 0,
    held: view?.held ?? [],
    governor,
    answerInbound: phone.answer,
    declineInbound: phone.decline,
    screenPopContactId,
    clearScreenPop: () => setScreenPopContactId(null),
    countdown,
    stats,
    index,
    dropping,
    dropVoicemail,

    startSession,
    pauseSession,
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
