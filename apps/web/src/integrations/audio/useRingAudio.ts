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
  useEffect(() => {
    if (config.mode !== 'music') return;

    let cancelled = false;
    const player = new SpotifyPlayer();
    player.onError = (m) => {
      if (!cancelled) setSpotifyProblem(m);
    };

    player
      .init(config.playlistUri)
      .then(() => {
        if (cancelled) return;
        spotifyRef.current = player;
        // `ready` arrives asynchronously from the SDK.
        const poll = setInterval(() => {
          if (cancelled) return clearInterval(poll);
          if (player.isReady) {
            setSpotifyReady(true);
            setSpotifyProblem(null);
            clearInterval(poll);
          }
        }, 250);
        setTimeout(() => clearInterval(poll), 15000);
      })
      .catch((e) => {
        if (!cancelled) {
          setSpotifyProblem(
            e instanceof Error ? e.message : 'Could not start Spotify.',
          );
        }
      });

    return () => {
      cancelled = true;
      player.disconnect();
      spotifyRef.current = null;
      setSpotifyReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.mode]);

  useEffect(() => {
    spotifyRef.current?.setPlaylist(config.playlistUri);
  }, [config.playlistUri]);

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
    spotifyReady,
    spotifyProblem,
    /// True when music was asked for but cannot play, so the UI can say so.
    silentFallback:
      config.mode === 'music' && !spotifyReady && spotifyProblem !== null,
  };
}
