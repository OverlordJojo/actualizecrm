'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Registers the browser as a phone and exposes a small imperative API.
 *
 * The Telnyx SDK is imported dynamically because it touches `window` at module
 * scope, which breaks Next's server render.
 *
 * Call lifecycle comes from the SDK rather than our webhook: `active` and
 * `hangup` fire locally with no network round trip, which is what makes the
 * sub-300ms music pause in integrations/audio achievable.
 */

/// Operator-facing line state. Deliberately not SIP vocabulary.
export type LineState =
  | 'offline'
  | 'connecting'
  | 'ready'
  | 'dialing'
  | 'ringing'
  | 'connected'
  | 'ending';

export interface SoftphoneEvents {
  onRinging?: () => void;
  onAnswered?: () => void;
  onEnded?: (info: {
    wasAnswered: boolean;
    durationSec: number;
    /// SIP-level reason when the call never answered, e.g. "CALL_REJECTED".
    cause?: string;
    causeCode?: number;
  }) => void;
  onError?: (message: string) => void;
}

/**
 * One softphone per browser tab, shared across renders.
 *
 * React StrictMode invokes effects twice in development, and an effect that
 * naively constructs a TelnyxRTC client therefore opens **two** SIP
 * registrations on the same credential. Telnyx treats the newer registration
 * as the live one, so the older client's call gets torn down the instant the
 * far end answers — the call rings, then dies as you reach for it.
 *
 * A module singleton makes the second invocation reuse the first client
 * instead of racing it. The client is deliberately NOT disconnected on effect
 * cleanup, only on page unload, because cleanup runs during StrictMode's
 * simulated remount.
 */
let sharedClient: any = null;
let sharedClientPromise: Promise<any> | null = null;

/// The single <audio> element the SDK renders far-end audio into. Owning it
/// ourselves is what makes local-only muting possible.
const REMOTE_AUDIO_ID = 'actualize-remote-audio';

function ensureRemoteAudioElement(): HTMLAudioElement {
  let el = document.getElementById(REMOTE_AUDIO_ID) as HTMLAudioElement | null;
  if (!el) {
    el = document.createElement('audio');
    el.id = REMOTE_AUDIO_ID;
    el.autoplay = true;
    el.style.display = 'none';
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Silences or restores what the operator hears from the far end.
 *
 * Used to suppress carrier ringback during music mode. This only mutes local
 * playback of the inbound stream — the microphone and the outbound stream are
 * untouched, so the prospect never notices.
 */
export function setRemoteAudioMuted(muted: boolean) {
  const el = document.getElementById(REMOTE_AUDIO_ID) as HTMLAudioElement | null;
  if (el) el.muted = muted;
}

async function getSharedClient(): Promise<any> {
  if (sharedClient) return sharedClient;
  if (sharedClientPromise) return sharedClientPromise;

  sharedClientPromise = (async () => {
    const res = await fetch('/api/telnyx/token', { method: 'POST' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Could not get a phone token.');

    const { TelnyxRTC } = await import('@telnyx/webrtc');

    ensureRemoteAudioElement();

    const client = new TelnyxRTC({ login_token: json.token });

    sharedClient = client;
    client.connect();

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        try {
          client.disconnect();
        } catch {
          // Tearing down during unload; nothing useful to do on failure.
        }
      });
    }

    return client;
  })();

  try {
    return await sharedClientPromise;
  } catch (err) {
    // Let the next mount retry rather than caching a failed connection.
    sharedClientPromise = null;
    throw err;
  }
}

export function useSoftphone(events: SoftphoneEvents = {}) {
  const [state, setState] = useState<LineState>('offline');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const clientRef = useRef<any>(null);
  const callRef = useRef<any>(null);
  const answeredAtRef = useRef<number | null>(null);
  /// Call ids already reported as ended — see the hangup/destroy case.
  const endedCallsRef = useRef<Set<string>>(new Set());

  // Keep the latest callbacks without re-registering SDK listeners on every
  // parent render.
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    let cancelled = false;
    let client: any = null;

    const onReady = () => {
      if (!cancelled) {
        setState('ready');
        setError(null);
      }
    };

    const onClientError = (e: any) => {
      if (cancelled) return;
      const message = e?.error?.message ?? e?.message ?? 'Phone error.';
      setError(message);
      eventsRef.current.onError?.(message);
    };

    const onSocketClose = () => {
      if (!cancelled) setState('offline');
    };

    let onNotification: (n: any) => void = () => {};

    (async () => {
      try {
        setState('connecting');

        client = await getSharedClient();
        if (cancelled) return;
        clientRef.current = client;

        // The singleton may already be connected from a previous mount, in
        // which case `telnyx.ready` has long since fired.
        if (client.connected) onReady();

        client.on('telnyx.ready', onReady);
        client.on('telnyx.error', onClientError);
        client.on('telnyx.socket.close', onSocketClose);

        onNotification = (notification: any) => {
          if (cancelled) return;
          if (notification.type !== 'callUpdate') return;

          const call = notification.call;
          callRef.current = call;

          switch (call.state) {
            case 'new':
            case 'requesting':
            case 'trying':
              setState('dialing');
              break;

            case 'ringing':
            case 'early':
              setState('ringing');
              eventsRef.current.onRinging?.();
              break;

            case 'active':
              answeredAtRef.current = Date.now();
              setState('connected');
              eventsRef.current.onAnswered?.();
              break;

            case 'hangup':
            case 'destroy': {
              // The SDK emits BOTH `hangup` and `destroy` for a single call.
              // Handling both would fire onEnded twice: double-counted talk
              // time, a phantom "unanswered" record, and — worst — two
              // auto-advances, silently skipping a lead on every call.
              const callId = call.id ?? 'unknown';
              if (endedCallsRef.current.has(callId)) break;
              endedCallsRef.current.add(callId);
              // Bound the set so a long session cannot grow it without limit.
              if (endedCallsRef.current.size > 200) {
                endedCallsRef.current = new Set(
                  Array.from(endedCallsRef.current).slice(-50),
                );
              }

              const answeredAt = answeredAtRef.current;
              const durationSec = answeredAt
                ? Math.round((Date.now() - answeredAt) / 1000)
                : 0;

              // A call that never answered may have been *rejected* rather
              // than simply unanswered. Without the cause, every failure looks
              // identical to a prospect not picking up, which sends you
              // debugging the wrong thing entirely.
              const cause: string | undefined = call.cause;
              const causeCode: number | undefined = call.causeCode;

              if (!answeredAt && cause) {
                // eslint-disable-next-line no-console
                console.warn(
                  `[softphone] call ended without answer — cause=${cause} code=${causeCode}`,
                );
              }

              answeredAtRef.current = null;
              callRef.current = null;
              setMuted(false);
              setState('ready');

              eventsRef.current.onEnded?.({
                wasAnswered: answeredAt !== null,
                durationSec,
                cause,
                causeCode,
              });
              break;
            }

            default:
              break;
          }
        };

        client.on('telnyx.notification', onNotification);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not start the phone.';
        setError(message);
        setState('offline');
        eventsRef.current.onError?.(message);
      }
    })();

    return () => {
      cancelled = true;
      // Detach this mount's listeners, but leave the shared client connected.
      // Disconnecting here would drop the registration during StrictMode's
      // simulated remount and, worse, mid-call on any incidental re-render.
      try {
        client?.off('telnyx.ready', onReady);
        client?.off('telnyx.error', onClientError);
        client?.off('telnyx.socket.close', onSocketClose);
        client?.off('telnyx.notification', onNotification);
      } catch {
        // Older SDK builds may not expose `off`; a stale listener on a
        // singleton is harmless because `cancelled` gates every handler.
      }
    };
  }, []);

  const dial = useCallback((to: string, from: string) => {
    const client = clientRef.current;
    if (!client) {
      setError('The phone is not ready yet.');
      return null;
    }

    const call = client.newCall({
      destinationNumber: to,
      callerNumber: from,
      // Audio only — this is a phone, not a video app.
      audio: true,
      video: false,
      // Render far-end audio into our own element so music mode can mute it
      // locally during ringing without touching the outbound stream.
      remoteElement: ensureRemoteAudioElement(),
    });

    callRef.current = call;
    setState('dialing');
    return call;
  }, []);

  const hangup = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    setState('ending');
    try {
      call.hangup();
    } catch {
      setState('ready');
    }
  }, []);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    try {
      if (muted) call.unmuteAudio();
      else call.muteAudio();
      setMuted((m) => !m);
    } catch {
      // Muting a call that just ended is harmless.
    }
  }, [muted]);

  /// Telnyx assigns a Call Control id once the leg exists; the server needs it
  /// to issue voicemail drops against this call.
  const callControlId = useCallback((): string | undefined => {
    return callRef.current?.telnyxIDs?.telnyxCallControlId;
  }, []);

  return {
    state,
    error,
    muted,
    dial,
    hangup,
    toggleMute,
    callControlId,
    isOnCall: state === 'dialing' || state === 'ringing' || state === 'connected',
  };
}
