'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { cn } from '@/lib/cn';
import { RingbackTone } from '@/integrations/audio/ringback';

interface SpotifyStatus {
  connected: boolean;
  premium: boolean;
  /// Device Spotify is actually routing to, versus the one we registered.
  activeDeviceId?: string | null;
  playbackState?: string | null;
  displayName?: string;
  problem: string | null;
  playlistUri: string;
  playlistName: string;
}

interface PlaylistItem {
  uri: string;
  name: string;
  kind: 'playlist' | 'show';
  trackCount: number;
}

export function AudioSettings() {
  const params = useSearchParams();

  const [musicMode, setMusicMode] = useState(true);
  const [volume, setVolume] = useState(0.5);
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistItem[] | null>(null);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toneRef = useRef<RingbackTone | null>(null);

  useEffect(() => {
    toneRef.current = new RingbackTone(volume);
    return () => {
      toneRef.current?.dispose();
      toneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/spotify/status');
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => {
        setMusicMode(s['audio.musicInsteadOfRinging'] === 'true');
        setVolume(Number(s['audio.ringbackVolume'] ?? 0.5));
      })
      .catch(() => {});
    loadStatus();
  }, [loadStatus]);

  // Surface the outcome of the OAuth round trip.
  useEffect(() => {
    if (params.get('spotify') === 'connected') {
      setNotice('Spotify connected.');
      loadStatus();
    }
    const err = params.get('spotify_error');
    if (err) setError(err);
  }, [params, loadStatus]);

  async function save(patch: Record<string, string>) {
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }

  async function toggleMusic(on: boolean) {
    setMusicMode(on);
    await save({ 'audio.musicInsteadOfRinging': String(on) });
  }

  async function changeVolume(v: number) {
    setVolume(v);
    toneRef.current?.setVolume(v);
    await save({ 'audio.ringbackVolume': String(v) });
  }

  async function loadPlaylists() {
    setLoadingPlaylists(true);
    setError(null);
    try {
      const res = await fetch('/api/spotify/playlists');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load playlists.');
      setPlaylists(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load playlists.');
    } finally {
      setLoadingPlaylists(false);
    }
  }

  async function pickPlaylist(item: PlaylistItem) {
    await fetch('/api/spotify/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: item.uri, name: item.name }),
    });
    setNotice(`Playing "${item.name}" while calls ring.`);
    loadStatus();
  }

  async function disconnect() {
    await fetch('/api/spotify/status', { method: 'DELETE' });
    setNotice('Spotify disconnected.');
    setPlaylists(null);
    loadStatus();
  }

  // Music is on but cannot actually play — the operator must know, because the
  // symptom is simply silence.
  const degraded =
    musicMode && (!status?.connected || !status?.premium || !!status?.problem);


  /**
   * Audio diagnostics (§4.2).
   *
   * Every Spotify failure mode presents identically — silence — so each one is
   * shown as an observed fact rather than left to be inferred. "Connected"
   * covering a device that Spotify is not routing to is exactly how this
   * appeared healthy while producing no sound.
   */
  const diagnostics = [
    { label: 'Signed in', value: status?.connected ? 'yes' : 'no', ok: !!status?.connected },
    { label: 'Premium', value: status?.premium ? 'yes' : 'no — required', ok: !!status?.premium },
    {
      label: 'Active device',
      value: status?.activeDeviceId ? `${status.activeDeviceId.slice(0, 12)}…` : 'none',
      ok: !!status?.activeDeviceId,
    },
    {
      label: 'Playback',
      value: status?.playbackState ?? 'unknown',
      ok: status?.playbackState !== null && status?.playbackState !== undefined,
    },
    { label: 'Last error', value: status?.problem ?? 'none', ok: !status?.problem },
  ];

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">Audio</h2>
        <p className="text-xs text-ink-400">
          What you hear while a call is ringing.
        </p>
      </div>

      {notice && (
        <div className="rounded-lg border border-green-900 bg-green-950/50 px-3 py-2 text-xs text-green-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="panel p-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={musicMode}
            onChange={(e) => toggleMusic(e.target.checked)}
            className="mt-0.5 accent-brand-500"
          />
          <span>
            <span className="block text-sm text-ink-100">
              Play music instead of ringing
            </span>
            <span className="block text-xs text-ink-400">
              Spotify plays while the call rings and pauses the moment someone
              answers. Ringing is suppressed entirely.
            </span>
          </span>
        </label>

        {degraded && (
          <div className="mt-3 rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2">
            <p className="text-xs font-medium text-amber-200">
              Music mode is on, but nothing will play.
            </p>
            <p className="mt-0.5 text-xs text-amber-100/80">
              {status?.problem ??
                (!status?.connected
                  ? 'Spotify is not connected.'
                  : 'Spotify Premium is required.')}{' '}
              Calls will ring <strong>silently</strong> rather than surprising
              you with a tone.
            </p>
          </div>
        )}
      </div>

      {/* --- Spotify --- */}
      <div className="panel p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Spotify
        </h3>

        {!status?.connected ? (
          <div className="flex items-center gap-3">
            <a className="btn-primary py-1.5 text-xs" href="/api/spotify/login">
              Connect Spotify
            </a>
            <span className="text-xs text-ink-500">
              Requires Spotify Premium.
            </span>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              <span className="text-ink-200">
                {status.displayName ?? 'Connected'}
              </span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px]',
                  status.premium
                    ? 'bg-green-950 text-green-300'
                    : 'bg-amber-950 text-amber-300',
                )}
              >
                {status.premium ? 'Premium' : 'Free — cannot play'}
              </span>
              <button
                className="ml-auto text-xs text-red-400 hover:underline"
                onClick={disconnect}
              >
                Disconnect
              </button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-400">
                Playing:{' '}
                <span className="text-ink-200">
                  {status.playlistName || 'nothing selected'}
                </span>
              </span>
              <button
                className="btn-ghost ml-auto py-1 text-xs"
                onClick={loadPlaylists}
                disabled={loadingPlaylists}
              >
                {loadingPlaylists ? 'Loading…' : 'Choose playlist'}
              </button>
            </div>

            {playlists && (
              <div className="scroll-thin max-h-56 overflow-y-auto rounded-lg border border-ink-800">
                {playlists.length === 0 && (
                  <p className="p-3 text-center text-xs text-ink-500">
                    No playlists or shows in your library.
                  </p>
                )}
                {playlists.map((p) => (
                  <button
                    key={p.uri}
                    onClick={() => pickPlaylist(p)}
                    className={cn(
                      'flex w-full items-center gap-2 border-b border-ink-800 px-3 py-2 text-left last:border-0 hover:bg-ink-850',
                      p.uri === status.playlistUri && 'bg-ink-850',
                    )}
                  >
                    <span className="flex-1 truncate text-xs text-ink-200">
                      {p.name}
                    </span>
                    <span className="text-[10px] text-ink-500">
                      {p.kind === 'show' ? 'podcast' : 'playlist'} ·{' '}
                      {p.trackCount}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* --- ringback --- */}
      <div className="panel p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Ringback tone
        </h3>
        <p className="mb-2 text-xs text-ink-500">
          Used when music mode is off. Generated locally, so every call sounds
          identical.
        </p>

        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            className="w-48 accent-brand-500"
          />
          <span className="w-10 text-xs tabular-nums text-ink-400">
            {Math.round(volume * 100)}%
          </span>
          <button
            className="btn-ghost py-1 text-xs"
            onClick={() => toneRef.current?.preview()}
          >
            Preview
          </button>
        </div>
      </div>

      {/* §4.2 — every Spotify failure sounds the same from the operator's
          chair, so show what was actually observed rather than a single
          "connected" that can be true while nothing plays. */}
      <div className="rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-ink-200">Audio diagnostics</p>
          <button className="btn-ghost py-0.5 text-[11px]" onClick={loadStatus}>
            Re-check
          </button>
        </div>
        <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
          {diagnostics.map((d) => (
            <div key={d.label} className="flex items-baseline justify-between gap-2">
              <dt className="text-[11px] text-ink-500">{d.label}</dt>
              <dd
                className={
                  d.ok
                    ? 'truncate font-mono text-[11px] text-ink-300'
                    : 'truncate font-mono text-[11px] text-amber-300'
                }
                title={String(d.value)}
              >
                {d.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-1.5 text-[10px] leading-relaxed text-ink-500">
          Music starts when you press Start session — browsers refuse to play
          audio until you click something, so connecting alone is not enough.
        </p>
      </div>
    </section>
  );
}
