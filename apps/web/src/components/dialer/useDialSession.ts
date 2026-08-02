'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useSoftphone,
  setRemoteAudioMuted,
} from '@/integrations/telnyx/useSoftphone';
import {
  useRingAudio,
  type RingAudioConfig,
} from '@/integrations/audio/useRingAudio';
import type { DispositionValue } from '@/lib/dispositions';
import { DISPOSITION_BY_VALUE } from '@/lib/dispositions';
import type { ActiveLead } from './ActiveLeadCard';
import type { SessionStats } from './DialControls';

/**
 * The power-dialer loop.
 *
 * Auto-advance is driven by the browser's call events, not the webhook — see
 * integrations/telnyx/useSoftphone.ts for why. The gap between hangup and the
 * next dial is deliberate breathing room for the operator to set a disposition
 * or drag the card; setting a disposition during the gap does not shorten it,
 * because being yanked into the next call mid-thought is worse than waiting.
 */
export function useDialSession({
  queue,
  gapSeconds,
  audio,
  linesPerBurst = 1,
  onCallEnded,
}: {
  queue: ActiveLead[];
  gapSeconds: number;
  audio: RingAudioConfig;
  /// §4.3. 1 keeps the classic one-at-a-time loop; 2–3 opens a burst.
  linesPerBurst?: number;
  onCallEnded?: () => void;
}) {
  const [sessionActive, setSessionActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [activeLead, setActiveLead] = useState<ActiveLead | null>(null);
  const [callerId, setCallerId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /// Name of the recording currently playing into the call, for Region B.
  const [dropping, setDropping] = useState<string | null>(null);
  /// Contact to screen-pop when an inbound call rings (add-on A).
  const [screenPopContactId, setScreenPopContactId] = useState<string | null>(null);
  /// Multi-line state (§4). `held` is the queued-owner queue.
  const [burstActive, setBurstActive] = useState(false);
  const [held, setHeld] = useState<{ callId: string; toE164: string; heldSeconds: number }[]>([]);
  const [governor, setGovernor] = useState<{
    rate: number;
    blocked: boolean;
    allowedLines: number;
    warning: string | null;
  } | null>(null);

  /// True while a burst is live, so an inbound transfer is auto-answered
  /// instead of ringing as an ordinary inbound call.
  const expectingTransfer = useRef(false);
  const [stats, setStats] = useState<SessionStats>({
    dials: 0,
    connects: 0,
    booked: 0,
    talkTimeSec: 0,
    startedAt: null,
  });

  const callIdRef = useRef<string | null>(null);
  /// Mirrored into state so the live transcript pane can poll for it.
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  /// Stage the AI is suggesting for the lead on screen, and whether the
  /// operator has overridden it (§5.6).
  const [suggestedStageId, setSuggestedStageId] = useState<string | null>(null);
  const [stageLocked, setStageLocked] = useState(false);
  const advanceTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /// Consecutive zero-second "busy" results — see the note where this is read.
  const instantBusyRef = useRef(0);
  // Read inside SDK callbacks, which close over their first render otherwise.
  const sessionRef = useRef(false);
  const indexRef = useRef(0);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const clearAdvance = useCallback(() => {
    if (advanceTimer.current) clearInterval(advanceTimer.current);
    advanceTimer.current = null;
    setCountdown(null);
  }, []);

  const patchCall = useCallback(async (body: Record<string, unknown>) => {
    const id = callIdRef.current;
    if (!id) return;
    await fetch(`/api/calls/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  }, []);

  const ringAudio = useRingAudio(audio);

  const phone = useSoftphone({
    onIncoming: async ({ callerNumber }) => {
      // A burst leg reaches the operator as a *transfer*, which arrives as an
      // inbound invite. The operator already asked for this call by advancing,
      // so making them press Answer would be a second decision about something
      // they already decided — and every second of hesitation is a second the
      // prospect spends listening to nothing.
      if (expectingTransfer.current) {
        expectingTransfer.current = false;
        phone.answer();
      }
      // Pop the card before the operator picks up, not after: the whole value
      // of a screen-pop is knowing who it is while deciding whether to answer.
      try {
        const res = await fetch('/api/contacts/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: callerNumber }),
        });
        if (!res.ok) return;
        const { contact } = await res.json();
        setScreenPopContactId(contact.id);
        setActiveLead({
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          companyName: contact.companyName,
          companyLocation: contact.companyLocation,
          phone: contact.phone,
          dealValue: contact.dealValue,
          lastDisposition: contact.lastDisposition,
          stageId: contact.stageId,
          stagePosition: contact.stagePosition ?? 0,
        });
      } catch {
        // A failed lookup must not stop the phone from ringing.
      }
    },
    onRinging: () => {
      // In music mode the operator hears Spotify, not the carrier's ringback,
      // so the far-end audio is muted locally until they actually answer.
      if (audio.mode === 'music') setRemoteAudioMuted(true);
      ringAudio.onRinging();
    },
    onAnswered: () => {
      // Order matters: unmute the call first so the operator never misses the
      // prospect's opening word, then stop the music.
      setRemoteAudioMuted(false);
      ringAudio.onAnswered();
      setStats((s) => ({ ...s, connects: s.connects + 1 }));
      patchCall({ status: 'answered' });
    },
    onEnded: ({ wasAnswered, durationSec, cause, causeCode }) => {
      setRemoteAudioMuted(false);
      ringAudio.onEnded();
      setStats((s) => ({ ...s, talkTimeSec: s.talkTimeSec + durationSec }));

      // Distinguish "they didn't pick up" from "the carrier refused the call".
      // Only the first is a real no-answer; the rest are configuration or
      // routing problems the operator needs told about.
      const busy = !wasAnswered && cause === 'USER_BUSY';
      const rejected =
        !wasAnswered &&
        cause !== undefined &&
        !['NORMAL_CLEARING', 'ORIGINATOR_CANCEL', 'NO_ANSWER', 'USER_BUSY'].includes(
          cause,
        );

      if (rejected) {
        setError(
          `Carrier refused the call (${cause}${causeCode ? ` ${causeCode}` : ''}). ` +
            'This is not the prospect declining — check Settings for account problems.',
        );
      }

      // A run of instant zero-second "busy" results is almost never a row of
      // genuinely busy prospects — on Telnyx it is what an account-level
      // restriction looks like, so say so rather than letting the operator
      // dial a whole list into a wall.
      if (busy && durationSec === 0) {
        instantBusyRef.current += 1;
        if (instantBusyRef.current === 3) {
          setError(
            'Three calls in a row were refused instantly as "busy". That usually ' +
              'means the Telnyx account is restricted to verified numbers, not that ' +
              'the prospects are busy. Check Verified Numbers in the Telnyx portal.',
          );
        }
      } else if (wasAnswered) {
        instantBusyRef.current = 0;
      }

      patchCall({
        status: wasAnswered
          ? 'completed'
          : rejected
            ? 'failed'
            : busy
              ? 'busy'
              : 'no_answer',
        durationSec,
      }).then(() => {
        const id = callIdRef.current;
        if (id) fetch(`/api/calls/${id}`, { method: 'POST' }).catch(() => {});
      });

      onCallEnded?.();

      if (sessionRef.current) startGap();
    },
    onError: (message) => setError(message),
  });

  // --- dialing -------------------------------------------------------------

  const dialLead = useCallback(
    async (lead: ActiveLead) => {
      setError(null);
      setActiveLead(lead);

      try {
        const res = await fetch('/api/calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactId: lead.id }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not start that call.');

        callIdRef.current = json.callId;
        setActiveCallId(json.callId);
        setCallerId(json.from);
        setStats((s) => ({
          ...s,
          dials: s.dials + 1,
          startedAt: s.startedAt ?? Date.now(),
        }));

        phone.dial(json.to, json.from);

        // The Call Control id only exists once the leg is up; grab it shortly
        // after so voicemail drop has something to target.
        setTimeout(() => {
          const ccid = phone.callControlId();
          if (ccid) patchCall({ callControlId: ccid });
        }, 1500);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not start that call.');
        if (sessionRef.current) startGap();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phone.dial, patchCall],
  );

  const dialManual = useCallback(
    async (rawPhone: string) => {
      setError(null);
      try {
        const res = await fetch('/api/calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: rawPhone }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not dial that number.');

        callIdRef.current = json.callId;
        setActiveCallId(json.callId);
        setCallerId(json.from);
        setActiveLead({
          id: json.contactId,
          firstName: null,
          lastName: null,
          companyName: null,
          companyLocation: null,
          phone: json.to,
          dealValue: null,
          lastDisposition: null,
          stageId: null,
          stagePosition: 0,
        });
        setStats((s) => ({
          ...s,
          dials: s.dials + 1,
          startedAt: s.startedAt ?? Date.now(),
        }));

        phone.dial(json.to, json.from);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not dial that number.');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phone.dial],
  );

  // --- auto-advance --------------------------------------------------------

  /**
   * Opens a burst, or bridges whoever has been on hold longest (§4.3).
   *
   * Draining the held queue takes priority over dialing anybody new — the
   * server decides that, so the two cannot disagree.
   */
  const advanceBurst = useCallback(
    async (startIndex: number) => {
      const upcoming = queueRef.current.slice(startIndex, startIndex + linesPerBurst);
      if (upcoming.length === 0) {
        sessionRef.current = false;
        setSessionActive(false);
        setActiveLead(null);
        return;
      }

      setError(null);
      expectingTransfer.current = true;

      try {
        const res = await fetch('/api/dialer/burst', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactIds: upcoming.map((l) => l.id) }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not open the burst.');

        setGovernor(json.governor ?? null);
        setBurstActive(true);

        if (json.mode === 'bridged_held') {
          // A held caller is coming to the softphone; the queue index does not
          // move, because none of the upcoming leads were dialled.
          indexRef.current = startIndex;
          setIndex(startIndex);
          const lead = queueRef.current.find((l) => l.id === json.bridged?.contactId);
          if (lead) setActiveLead(lead);
          return;
        }

        // Advance past everyone this burst actually dialled.
        const dialled = (json.legs ?? []).length;
        indexRef.current = startIndex + Math.max(dialled, 1);
        setIndex(indexRef.current);
        setActiveLead(upcoming[0] ?? null);
        setStats((s2) => ({
          ...s2,
          dials: s2.dials + dialled,
          startedAt: s2.startedAt ?? Date.now(),
        }));
      } catch (e) {
        expectingTransfer.current = false;
        setError(e instanceof Error ? e.message : 'Could not open the burst.');
        if (sessionRef.current) startGap();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linesPerBurst],
  );

  const advance = useCallback(() => {
    clearAdvance();
    const next = indexRef.current + 1;

    // Multi-line takes a different path entirely: the server originates the
    // legs and the winner is transferred in, so there is nothing for the
    // browser to dial.
    if (linesPerBurst > 1) {
      void advanceBurst(next);
      return;
    }

    indexRef.current = next;
    setIndex(next);

    const lead = queueRef.current[next];
    if (!lead) {
      sessionRef.current = false;
      setSessionActive(false);
      setActiveLead(null);
      return;
    }
    dialLead(lead);
  }, [clearAdvance, dialLead, linesPerBurst, advanceBurst]);

  const startGap = useCallback(() => {
    clearAdvance();
    let remaining = gapSeconds;
    setCountdown(remaining);

    if (remaining <= 0) {
      advance();
      return;
    }

    advanceTimer.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) advance();
      else setCountdown(remaining);
    }, 1000);
  }, [advance, clearAdvance, gapSeconds]);

  // --- session control -----------------------------------------------------

  const startSession = useCallback(() => {
    const lead = queueRef.current[0];
    if (!lead) return;
    indexRef.current = 0;
    setIndex(0);
    sessionRef.current = true;
    setSessionActive(true);
    setStats({ dials: 0, connects: 0, booked: 0, talkTimeSec: 0, startedAt: Date.now() });

    if (linesPerBurst > 1) {
      void advanceBurst(0);
      return;
    }
    dialLead(lead);
  }, [dialLead, linesPerBurst, advanceBurst]);

  const pauseSession = useCallback(() => {
    sessionRef.current = false;
    setSessionActive(false);
    clearAdvance();
  }, [clearAdvance]);

  const endSession = useCallback(() => {
    sessionRef.current = false;
    setSessionActive(false);
    setBurstActive(false);
    expectingTransfer.current = false;
    clearAdvance();
    if (phone.isOnCall) phone.hangup();
    setActiveLead(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearAdvance, phone.isOnCall, phone.hangup]);

  const setDisposition = useCallback(
    async (value: DispositionValue) => {
      if (!callIdRef.current) return;

      if (value === 'booked') {
        setStats((s) => ({ ...s, booked: s.booked + 1 }));
      }

      await patchCall({ disposition: value });

      setActiveLead((l) =>
        l ? { ...l, lastDisposition: value } : l,
      );
      onCallEnded?.();

      // Setting an outcome while still connected means the operator is done
      // talking, so end the call — but let the gap run normally afterwards.
      if (phone.isOnCall) phone.hangup();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchCall, phone.isOnCall, phone.hangup, onCallEnded],
  );

  /**
   * Watches for a stage the AI wants this lead moved to (§5.6).
   *
   * The operator's own choice always wins and permanently locks out further
   * suggestions for this call — a model that keeps re-suggesting a column the
   * operator has already rejected is worse than one that says nothing.
   */
  useEffect(() => {
    const contactId = activeLead?.id;
    if (!contactId) {
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
        const res = await fetch(`/api/ai/suggestions?contactId=${contactId}`);
        if (!res.ok || cancelled) return;
        const rows: { fieldType: string; value: string | null }[] = await res.json();
        const stage = rows.find((r) => r.fieldType === 'stage');
        if (!stage?.value) return;

        // The model names a stage; resolve it to a column on the board.
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
  }, [activeLead?.id]);

  /**
   * The operator moved the lead themselves. That decision is final for this
   * call: the outline goes away and any pending stage suggestions are marked
   * decided so they cannot come back.
   */
  const lockStageChoice = useCallback(async () => {
    setStageLocked(true);
    setSuggestedStageId(null);

    const contactId = activeLead?.id;
    if (!contactId) return;
    try {
      const rows: { id: string; fieldType: string }[] = await fetch(
        `/api/ai/suggestions?contactId=${contactId}`,
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
      // The lockout is already in effect locally; the record catching up
      // matters less than the outline going away immediately.
    }
  }, [activeLead?.id]);

  /**
   * Voicemail drop — hotkey V (build step 6).
   *
   * Telnyx plays the recording into the call and hangs up when the audio
   * actually finishes, which the browser then sees as an ordinary hangup and
   * auto-advances on. Nothing here hangs up directly: cutting the leg while the
   * message is still playing is what leaves half a voicemail.
   */
  const dropVoicemail = useCallback(async () => {
    const id = callIdRef.current;
    if (!id || dropping) return;

    setError(null);
    try {
      const res = await fetch('/api/voicemail/drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callId: id,
          callControlId: phone.callControlId() ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not drop voicemail.');

      setDropping(json.recordingName);
      setActiveLead((l) => (l ? { ...l, lastDisposition: 'voicemail' } : l));
      onCallEnded?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not drop voicemail.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropping, phone.callControlId, onCallEnded]);

  // The drop belongs to one call; clear it when the line frees up so the next
  // lead does not inherit a "playing" badge.
  useEffect(() => {
    if (phone.state === 'ready' || phone.state === 'offline') setDropping(null);
  }, [phone.state]);

  const hangupAndNext = useCallback(() => {
    if (phone.isOnCall) phone.hangup();
    else if (sessionRef.current) advance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone.isOnCall, phone.hangup, advance]);

  // --- hotkeys -------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Never steal keystrokes from the notes box or any other field.
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
          hangupAndNext();
          break;
        case '1':
        case '2':
        case '3':
        case '4':
        case '5': {
          const match = Object.values(DISPOSITION_BY_VALUE).find(
            (d) => d.hotkey === e.key,
          );
          if (match) {
            e.preventDefault();
            setDisposition(match.value);
          }
          break;
        }
        case 'v':
        case 'V':
          e.preventDefault();
          dropVoicemail();
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          if (sessionRef.current) pauseSession();
          else startSession();
          break;
        case 'Escape':
          e.preventDefault();
          endSession();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    hangupAndNext,
    setDisposition,
    pauseSession,
    startSession,
    endSession,
    dropVoicemail,
  ]);

  useEffect(() => () => clearAdvance(), [clearAdvance]);

  // While a burst is live, keep the held queue and the governor in front of the
  // operator. The poll also drives the server-side sweep, so a caller who has
  // waited too long is retired within a couple of seconds rather than whenever
  // the operator next advances.
  useEffect(() => {
    if (!burstActive) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch('/api/dialer/burst');
        if (!res.ok || cancelled) return;
        const json = await res.json();
        setHeld(json.held ?? []);
        setGovernor(json.governor ?? null);
      } catch {
        // A failed poll is cosmetic; the worker sweep is the real backstop.
      }
    };

    tick();
    const t = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [burstActive]);

  return {
    lineState: phone.state,
    muted: phone.muted,
    isOnCall: phone.isOnCall,
    phoneError: phone.error,
    error,
    clearError: () => setError(null),

    sessionActive,
    activeLead,
    callerId,
    activeCallId,
    suggestedStageId: stageLocked ? null : suggestedStageId,
    stageLocked,
    lockStageChoice,
    incoming: phone.incoming,
    burstActive,
    held,
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
    hangup: phone.hangup,
    hangupAndNext,
    toggleMute: phone.toggleMute,
    setDisposition,
    callControlId: phone.callControlId,

    spotifyReady: ringAudio.spotifyReady,
    spotifyProblem: ringAudio.spotifyProblem,
    silentFallback: ringAudio.silentFallback,
  };
}
