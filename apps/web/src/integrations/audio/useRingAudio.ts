'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RingbackTone } from './ringback';
import { SpotifyPlayer } from './spotify-player';

/**
 * What the operator hears while a call is ringing.
 *
 * Music mode (default): Spotify plays, and remote call audio is suppressed so
 * no ringback reaches the operator at all. On answer, music pauses and call
 * audio comes back.
 *
 * Ringback mode: a locally synthesized tone instead.
 *
 * Fallback: if music mode is on but Spotify cannot play — not connected, not
 * Premium, dead token — fall back to **silence**, never to a sudden ring.
 * Being startled by unexpected ringing in headphones, hours into a session,
 * is worse than hearing nothing.
 */

export type RingMode = 'music' | 'ringback';

export interface RingAudioConfig {
  mode: RingMode;
  ringbackVolume: number;
  playlistUri: string | null;
  /// Music mode is requested but unavailable; we are silent instead.
  degraded?: boolean;
}

export function useRingAudio(config: RingAudioConfig) {
  const [spotifyProblem, setSpotifyProblem] = useState<string | null>(null);
  const [spotifyReady, setSpotifyReady] = useState(false);

  const ringbackRef = useRef<RingbackTone | null>(null);
  const spotifyRef = useRef<SpotifyPlayer | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  // --- ringback ------------------------------------------------------------
  useEffect(() => {
    ringbackRef.current = new RingbackTone(config.ringbackVolume);
    return () => {
      ringbackRef.current?.dispose();
      ringbackRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    ringbackRef.current?.setVolume(config.ringbackVolume);
  }, [config.ringbackVolume]);

  // --- spotify -------------------------------------------------------------

  /**
   * Starts the Spotify player. **Must be called from a click handler** (§4.2).
   *
   * Browsers refuse to start audio without a user gesture. This used to run in
   * a mount effect, so the AudioContext stayed suspended and playback silently
   * never began — connection succeeded, everything looked healthy, and no sound
   * came out. "Start session" is the natural gesture and is where this is
   * called from.
   *
   * Idempotent: a second session start reuses the player rather than opening a
   * second one.
   */
  const initSpotify = useCallback(async () => {
    if (config.mode !== 'music') return;
    if (spotifyRef.current) return;

    const player = new SpotifyPlayer();
    player.onError = (m) => setSpotifyProblem(m);
    spotifyRef.current = player;

    try {
      await player.init(config.playlistUri);
      for (let i = 0; i < 60; i++) {
        if (player.isReady) {
          setSpotifyReady(true);
          setSpotifyProblem(null);
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      setSpotifyProblem('Spotify did not finish starting up.');
    } catch (e) {
      spotifyRef.current = null;
      setSpotifyProblem(
        e instanceof Error ? e.message : 'Could not start Spotify.',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.mode, config.playlistUri]);

  // Tear down only on unmount or when music mode is switched off. Deliberately
  // not keyed on anything that changes mid-session.
  useEffect(() => {
    if (config.mode === 'music') return;
    spotifyRef.current?.disconnect();
    spotifyRef.current = null;
    setSpotifyReady(false);
  }, [config.mode]);

  useEffect(
    () => () => {
      spotifyRef.current?.disconnect();
      spotifyRef.current = null;
    },
    [],
  );

  useEffect(() => {
    spotifyRef.current?.setPlaylist(config.playlistUri);
  }, [config.playlistUri]);

  /// Live state for the Settings audio panel (§4.2).
  const spotifyDiagnostics = useCallback(
    () => spotifyRef.current?.diagnostics() ?? null,
    [],
  );

  // --- lifecycle hooks called by the dialer --------------------------------

  /// Call has started ringing.
  const onRinging = useCallback(() => {
    const cfg = configRef.current;

    if (cfg.mode === 'ringback') {
      void ringbackRef.current?.start();
      return;
    }

    const player = spotifyRef.current;
    if (player?.isReady) {
      void player.play();
    }
    // else: silence, deliberately. See the note at the top of this file.
  }, []);

  /// Prospect answered. This is the latency-critical path.
  const onAnswered = useCallback(() => {
    // Synchronous stop — the tone dies in milliseconds.
    ringbackRef.current?.stop();
    // Fire and forget; awaiting would delay nothing useful.
    void spotifyRef.current?.pause();
  }, []);

  /// Call ended.
  const onEnded = useCallback(() => {
    ringbackRef.current?.stop();
    void spotifyRef.current?.pause();
  }, []);

  /// Resume music between calls, so the gap is not silent.
  const onIdle = useCallback(() => {
    const cfg = configRef.current;
    if (cfg.mode === 'music' && spotifyRef.current?.isReady) {
      void spotifyRef.current.play();
    }
  }, []);

  const previewRingback = useCallback(async () => {
    await ringbackRef.current?.preview();
  }, []);

  return {
    onRinging,
    onAnswered,
    onEnded,
    onIdle,
    previewRingback,
    /// Call from a click handler before the first call of a session (§4.2).
    initSpotify,
    spotifyDiagnostics,
    spotifyReady,
    spotifyProblem,
    /// True when music was asked for but cannot play, so the UI can say so.
    silentFallback:
      config.mode === 'music' && !spotifyReady && spotifyProblem !== null,
  };
}
