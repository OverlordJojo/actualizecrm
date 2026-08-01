'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { BulkVoicemailModal } from './BulkVoicemailModal';

interface Recording {
  id: string;
  name: string;
  filePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  isDefault: boolean;
  createdAt: string;
}

/**
 * Settings → Voicemail.
 *
 * The recording library, and the entry point to a bulk drop. Bulk lives behind
 * Settings rather than one click from the dialer on purpose: it is rare,
 * irreversible once the queue drains, and legally gated. Friction is the
 * feature.
 */
export function VoicemailSettings() {
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [storageConfigured, setStorageConfigured] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  /// Delete asks once inline rather than through window.confirm — a modal
  /// dialog blocks the page, and the operator may be on a live call.
  const [removingId, setRemovingId] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/voicemail');
    if (!res.ok) return;
    const json = await res.json();
    setRecordings(json.recordings);
    setStorageConfigured(json.storageConfigured);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    setNotice(null);

    const body = new FormData();
    body.append('file', file);

    try {
      const res = await fetch('/api/voicemail', { method: 'POST', body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Upload failed.');
      setNotice(`Uploaded "${json.name}".`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function makeDefault(id: string) {
    await fetch(`/api/voicemail/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    });
    load();
  }

  async function rename(id: string, name: string) {
    await fetch(`/api/voicemail/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    load();
  }

  async function remove(id: string, name: string) {
    if (removingId !== id) {
      setRemovingId(id);
      return;
    }
    setRemovingId(null);
    await fetch(`/api/voicemail/${id}`, { method: 'DELETE' });
    setNotice(`Deleted "${name}".`);
    load();
  }

  async function preview(id: string) {
    audioRef.current?.pause();

    if (playingId === id) {
      setPlayingId(null);
      return;
    }

    setError(null);
    const res = await fetch(`/api/voicemail/${id}`);
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? 'Could not load that recording.');
      return;
    }

    const audio = new Audio(json.url);
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => {
      setError('That recording would not play.');
      setPlayingId(null);
    };
    audioRef.current = audio;
    setPlayingId(id);
    audio.play().catch(() => {
      setError('That recording would not play.');
      setPlayingId(null);
    });
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">Voicemail</h2>
        <p className="text-xs text-ink-400">
          Recordings you drop into a call that reached a machine. Press{' '}
          <kbd className="rounded border border-ink-600 bg-ink-900 px-1 text-[10px]">
            V
          </kbd>{' '}
          on a live call to play the default one.
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

      {!storageConfigured && (
        <div className="rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
          Object storage is not configured, so recordings cannot be uploaded.
          Set the R2 keys in <code className="font-mono">.env.local</code>.
        </div>
      )}

      <div className="panel p-3">
        <div className="flex items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".mp3,.wav,audio/mpeg,audio/wav"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
            }}
          />
          <button
            className="btn-primary py-1.5 text-xs"
            onClick={() => fileInput.current?.click()}
            disabled={uploading || !storageConfigured}
          >
            {uploading ? 'Uploading…' : 'Upload a recording'}
          </button>
          <span className="text-xs text-ink-500">
            mp3 or wav, up to 10 MB. Keep it under about 30 seconds — machines
            cut off anything longer.
          </span>
        </div>

        {recordings === null ? (
          <p className="mt-3 text-xs text-ink-500">Loading…</p>
        ) : recordings.length === 0 ? (
          <p className="mt-3 text-xs text-ink-500">
            No recordings yet. Hotkey V does nothing until you add one.
          </p>
        ) : (
          <div className="mt-3 divide-y divide-ink-800 rounded-lg border border-ink-800">
            {recordings.map((r) => (
              <div key={r.id} className="flex items-center gap-2 px-3 py-2">
                <button
                  onClick={() => makeDefault(r.id)}
                  title={r.isDefault ? 'Default recording' : 'Make default'}
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 rounded-full border transition-colors',
                    r.isDefault
                      ? 'border-brand-400 bg-brand-500'
                      : 'border-ink-600 hover:border-ink-400',
                  )}
                />

                <input
                  defaultValue={r.name}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== r.name) rename(r.id, next);
                  }}
                  className="min-w-0 flex-1 truncate border-none bg-transparent text-xs text-ink-100 focus:outline-none"
                />

                <span className="shrink-0 text-[10px] text-ink-500">
                  {r.sizeBytes ? `${Math.round(r.sizeBytes / 1024)} KB` : ''}
                </span>

                {r.isDefault && (
                  <span className="shrink-0 rounded bg-brand-500/15 px-1.5 py-0.5 text-[10px] text-brand-300">
                    default
                  </span>
                )}

                <button
                  className="shrink-0 text-xs text-ink-400 hover:text-ink-100"
                  onClick={() => preview(r.id)}
                >
                  {playingId === r.id ? 'Stop' : 'Play'}
                </button>

                <button
                  className={cn(
                    'shrink-0 text-xs',
                    removingId === r.id
                      ? 'font-medium text-red-300'
                      : 'text-red-500 hover:text-red-400',
                  )}
                  onClick={() => remove(r.id, r.name)}
                  onBlur={() => setRemovingId(null)}
                >
                  {removingId === r.id ? 'Really delete?' : 'Delete'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* --- bulk --- */}
      <div className="panel p-3">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Bulk drop
        </h3>
        <p className="mb-2.5 text-xs text-ink-500">
          Queue a recording to a whole segment. Drops go out through the
          worker, so the batch keeps running with the laptop shut.
        </p>
        <button
          className="btn-ghost py-1.5 text-xs"
          onClick={() => setBulkOpen(true)}
          disabled={!recordings || recordings.length === 0}
          title={
            recordings && recordings.length === 0
              ? 'Upload a recording first'
              : undefined
          }
        >
          Queue a bulk drop…
        </button>
      </div>

      <BulkVoicemailModal
        open={bulkOpen}
        recordings={recordings ?? []}
        onClose={() => setBulkOpen(false)}
      />
    </section>
  );
}
