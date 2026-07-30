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

  onError?: (message: string) => void;

  get isReady(): boolean {
    return this.ready;
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
      this.onError?.('Spotify Premium is required to play music in the browser.'),
    );

    player.addListener('player_state_changed', (state: any) => {
      if (state && state.paused) this.pausedPositionMs = state.position;
    });

    const connected = await player.connect();
    if (!connected) throw new Error('Could not connect the Spotify player.');

    this.player = player;
  }

  /// Starts (or resumes) music. Called when a call begins ringing.
  async play(): Promise<void> {
    if (!this.ready || !this.deviceId) return;

    try {
      if (!this.started && this.playlistUri) {
        // First play of the session: start the chosen playlist/show.
        await this.transfer();
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

  private async transfer(): Promise<void> {
    await fetch('/api/spotify/play', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: this.deviceId }),
    }).catch(() => {});
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
