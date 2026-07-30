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
  onCallEnded,
}: {
  queue: ActiveLead[];
  gapSeconds: number;
  audio: RingAudioConfig;
  onCallEnded?: () => void;
}) {
  const [sessionActive, setSessionActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [activeLead, setActiveLead] = useState<ActiveLead | null>(null);
  const [callerId, setCallerId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SessionStats>({
    dials: 0,
    connects: 0,
    booked: 0,
    talkTimeSec: 0,
    startedAt: null,
  });

  const callIdRef = useRef<string | null>(null);
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

  const advance = useCallback(() => {
    clearAdvance();
    const next = indexRef.current + 1;
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
  }, [clearAdvance, dialLead]);

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
    dialLead(lead);
  }, [dialLead]);

  const pauseSession = useCallback(() => {
    sessionRef.current = false;
    setSessionActive(false);
    clearAdvance();
  }, [clearAdvance]);

  const endSession = useCallback(() => {
    sessionRef.current = false;
    setSessionActive(false);
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
  }, [hangupAndNext, setDisposition, pauseSession, startSession, endSession]);

  useEffect(() => () => clearAdvance(), [clearAdvance]);

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
    countdown,
    stats,
    index,

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
