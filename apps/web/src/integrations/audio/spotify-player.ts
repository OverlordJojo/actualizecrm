'use client';

/**
 * Spotify Web Playback SDK wrapper.
 *
 * Two things matter here and nothing else does:
 *   1. pause() must take effect within ~300ms of the prospect answering
 *   2. resume() must continue from the exact position it paused at
 *
 * Everything is local playback through the operator's own speakers. There is
 * no code path from this module into the WebRTC uplink — see CLAUDE.md.
 *
 * ## Why "connected but silent" happened (§4.1)
 *
 * Registering a device is not the same as Spotify routing audio to it. The SDK
 * reports `ready` with a `device_id` and the UI happily says connected, but
 * until `PUT /me/player` names that device, playback commands go to whatever
 * device Spotify last used — often a phone in another room. The symptom is
 * exactly what was reported: everything green, no sound.
 *
 * So transfer happens the moment `ready` fires, not lazily on first play, and
 * it is **verified** by reading the player back until the active device matches.
 * A fire-and-forget PUT that silently failed is indistinguishable from one that
 * worked.
 *
 * The second cause was timing: browsers refuse to start audio without a user
 * gesture, and this was being constructed in a mount effect. The AudioContext
 * stayed suspended and nothing ever said so. `init()` must now be called from
 * inside a click handler — see useRingAudio.
 */

declare global {
  interface Window {
    Spotify?: any;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

let sdkPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.Spotify) return Promise.resolve();
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<void>((resolve, reject) => {
    // The SDK calls this global when it finishes initialising.
    window.onSpotifyWebPlaybackSDKReady = () => resolve();

    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the Spotify player.'));
    document.body.appendChild(script);
  });

  return sdkPromise;
}

export class SpotifyPlayer {
  private player: any = null;
  private deviceId: string | null = null;
  private ready = false;
  /// Position we paused at, so resume continues rather than restarting.
  private pausedPositionMs = 0;
  private playlistUri: string | null = null;
  private started = false;

  // --- diagnostics (§4.2) ---------------------------------------------------
  // Every one of these failure modes presents as silence, so each is recorded
  // rather than inferred, and Settings renders them verbatim.
  private lastError: string | null = null;
  private premium: boolean | null = null;
  private activeDeviceId: string | null = null;
  private transferOk: boolean | null = null;

  onError?: (message: string) => void;

  get isReady(): boolean {
    return this.ready;
  }

  private fail(message: string) {
    this.lastError = message;
    this.onError?.(message);
  }

  /// Everything the audio diagnostic panel shows. Nothing here is derived —
  /// each field is what was actually observed.
  diagnostics() {
    return {
      ready: this.ready,
      registeredDeviceId: this.deviceId,
      activeDeviceId: this.activeDeviceId,
      transferred: this.transferOk,
      premium: this.premium,
      playing: this.started,
      lastError: this.lastError,
    };
  }

  /**
   * Confirms the account can actually use the Playback SDK.
   *
   * Free accounts cannot, at all. Without this the operator gets an
   * `account_error` buried in a listener and a player that never plays, which
   * reads as a bug in this app rather than a plan limitation.
   */
  private async checkPremium(): Promise<void> {
    try {
      const res = await fetch('/api/spotify/status');
      if (!res.ok) return;
      const s = await res.json();
      this.premium = s.premium ?? null;
      if (this.premium === false) {
        this.fail(
          'This Spotify account is not Premium. The Web Playback SDK only works ' +
            'on Premium, so music during calls is unavailable on this plan.',
        );
      }
    } catch {
      // Leave it unknown rather than claiming either way.
    }
  }

  /**
   * Routes Spotify to this browser, then proves it.
   *
   * The verification loop is the point. `PUT /me/player` returns 204 whether or
   * not the transfer takes effect, so the only honest check is reading the
   * player back and comparing device ids.
   */
  private async transferAndVerify(): Promise<boolean> {
    if (!this.deviceId) return false;

    await fetch('/api/spotify/play', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: this.deviceId, play: false }),
    }).catch(() => {});

    // Spotify applies the transfer asynchronously; a couple of seconds is
    // plenty and failing fast beats hanging the session start.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const res = await fetch('/api/spotify/status');
        if (!res.ok) continue;
        const s = await res.json();
        this.activeDeviceId = s.activeDeviceId ?? null;
        if (this.activeDeviceId && this.activeDeviceId === this.deviceId) {
          this.transferOk = true;
          return true;
        }
      } catch {
        // keep trying
      }
    }

    this.transferOk = false;
    this.fail(
      'Spotify connected but would not hand playback to this browser. Open ' +
        'Spotify, start anything playing once, then try again — the account has ' +
        'to have an active session before it can be moved.',
    );
    return false;
  }

  async init(playlistUri: string | null): Promise<void> {
    this.playlistUri = playlistUri;

    await loadSdk();

    const player = new window.Spotify.Player({
      name: 'ActualizeCRM',
      getOAuthToken: async (cb: (t: string) => void) => {
        // Called again whenever the token expires, so this must re-fetch
        // rather than close over a token captured at init.
        const res = await fetch('/api/spotify/token');
        if (!res.ok) {
          this.onError?.('Spotify sign-in expired.');
          return;
        }
        const { token } = await res.json();
        cb(token);
      },
      volume: 0.6,
    });

    player.addListener('ready', ({ device_id }: { device_id: string }) => {
      this.deviceId = device_id;
      // Transfer immediately, not on first play. Registering a device is not
      // the same as Spotify routing to it — see the note at the top.
      void this.transferAndVerify();
      this.ready = true;
    });

    player.addListener('not_ready', () => {
      this.ready = false;
    });

    player.addListener('initialization_error', ({ message }: any) =>
      this.onError?.(message),
    );
    player.addListener('authentication_error', ({ message }: any) =>
      this.onError?.(message),
    );
    player.addListener('account_error', () =>
      this.fail('Spotify Premium is required to play music in the browser.'),
    );

    player.addListener('player_state_changed', (state: any) => {
      if (state && state.paused) this.pausedPositionMs = state.position;
    });

    const connected = await player.connect();
    if (!connected) throw new Error('Could not connect the Spotify player.');

    this.player = player;
    void this.checkPremium();
  }

  /// Starts (or resumes) music. Called when a call begins ringing.
  async play(): Promise<void> {
    if (!this.ready || !this.deviceId) return;

    try {
      if (!this.started && this.playlistUri) {
        // First play of the session: start the chosen playlist/show. Transfer
        // already ran at `ready`; this re-checks only if it had not succeeded.
        if (!this.transferOk) await this.transferAndVerify();
        const res = await fetch('/api/spotify/play', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: this.deviceId,
            contextUri: this.playlistUri,
          }),
        });
        if (res.ok) this.started = true;
        return;
      }

      // Subsequent plays resume exactly where the last pause left it.
      await this.player?.resume();
    } catch {
      // Music failing must never take the call down with it.
    }
  }

  /// Pauses. Must be fast — this runs the instant the prospect answers.
  async pause(): Promise<void> {
    if (!this.ready) return;
    try {
      const state = await this.player?.getCurrentState();
      if (state) this.pausedPositionMs = state.position;
      await this.player?.pause();
    } catch {
      // ignore
    }
  }

  setPlaylist(uri: string | null) {
    if (uri !== this.playlistUri) {
      this.playlistUri = uri;
      this.started = false;
    }
  }

  async setVolume(v: number) {
    try {
      await this.player?.setVolume(Math.min(1, Math.max(0, v)));
    } catch {
      // ignore
    }
  }

  disconnect() {
    try {
      this.player?.disconnect();
    } catch {
      // ignore
    }
    this.player = null;
    this.ready = false;
  }
}
