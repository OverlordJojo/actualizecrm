'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useDialSession } from '@/components/dialer/useDialSession';
import type { ActiveLead } from '@/components/dialer/ActiveLeadCard';
import type { RingAudioConfig } from '@/integrations/audio/useRingAudio';

/**
 * Owns the live call for the whole app (§3.3).
 *
 * This provider is mounted in the root layout, above the router outlet, and
 * must never unmount. v1 held the Telnyx client inside the Dialer page
 * component, which meant navigating to Settings destroyed the WebRTC session
 * and dropped whatever call was in progress — mid-conversation.
 *
 * Everything call-shaped therefore lives here: the softphone, session state,
 * the timer, the queue, and later the AI transcript stream. Pages read it
 * through `useCall()` and render; they own none of it.
 */

type CallContextValue = ReturnType<typeof useDialSession> & {
  queue: ActiveLead[];
  setQueue: (leads: ActiveLead[]) => void;
  gapSeconds: number;
  linesPerBurst: number;
  audio: RingAudioConfig;
  /// Seconds since the prospect answered. Null when not connected.
  callSeconds: number | null;
  configLoaded: boolean;
};

const CallContext = createContext<CallContextValue | null>(null);

const DEFAULT_AUDIO: RingAudioConfig = {
  mode: 'music',
  ringbackVolume: 0.5,
  playlistUri: null,
};

export function CallProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<ActiveLead[]>([]);
  const [gapSeconds, setGapSeconds] = useState(2);
  const [linesPerBurst, setLinesPerBurst] = useState(1);
  const [audio, setAudio] = useState<RingAudioConfig>(DEFAULT_AUDIO);
  const [configLoaded, setConfigLoaded] = useState(false);

  // The provider sits in the root layout and cannot receive server props, so
  // it fetches its own configuration once on mount.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => {
        if (cancelled) return;
        setGapSeconds(Number(s['dialer.gapDelaySeconds'] ?? 2));
        // Clamped again on the server before anything is originated; this is
        // only what the UI offers.
        setLinesPerBurst(
          Math.min(Math.max(Number(s['dialer.linesPerBurst'] ?? 1), 1), 3),
        );
        setAudio({
          mode: s['audio.musicInsteadOfRinging'] === 'true' ? 'music' : 'ringback',
          ringbackVolume: Number(s['audio.ringbackVolume'] ?? 0.5),
          playlistUri: s['audio.spotifyPlaylistUri'] || null,
        });
      })
      .catch(() => {
        // Defaults are sane; a settings fetch failure must not stop dialing.
      })
      .finally(() => !cancelled && setConfigLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const session = useDialSession({ queue, gapSeconds, audio, linesPerBurst });

  // --- live call timer (§3.2) ----------------------------------------------
  // Starts at answer, not at dial. A timer that counts ringing time tells the
  // operator nothing useful about how long they have been talking.
  const [callSeconds, setCallSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (session.lineState !== 'connected') {
      setCallSeconds(null);
      return;
    }
    const startedAt = Date.now();
    setCallSeconds(0);
    const t = setInterval(
      () => setCallSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [session.lineState]);

  const value = useMemo<CallContextValue>(
    () => ({
      ...session,
      queue,
      setQueue,
      gapSeconds,
      linesPerBurst,
      audio,
      callSeconds,
      configLoaded,
    }),
    [session, queue, gapSeconds, linesPerBurst, audio, callSeconds, configLoaded],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error('useCall must be used inside <CallProvider>.');
  }
  return ctx;
}

/// Formats the live timer as MM:SS, or HH:MM:SS past an hour.
export function formatCallTimer(seconds: number | null): string {
  if (seconds === null) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
