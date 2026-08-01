'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

interface SegmentOption {
  id: string;
  name: string;
  count: number;
}

interface BulkInfo {
  lists: SegmentOption[];
  stages: SegmentOption[];
  neverCalled: number;
  alreadyCalled: number;
  acknowledgedAt: string | null;
  acknowledgementText: string;
}

type SegmentKind = 'list' | 'stage' | 'never_called' | 'already_called';

interface QueuedResult {
  queued: number;
  skippedAlreadyQueuedToday: number;
  neverCalledCount: number;
  recordingName: string;
  spacingSeconds: number;
  finishesAboutAt: string;
}

/**
 * Queues a bulk voicemail drop.
 *
 * The acknowledgement is a separate, deliberate step rather than a checkbox on
 * the send button. The route refuses the batch outright and hands back the
 * wording; the operator accepts it here, and only then can they send. Bundling
 * consent into the same click as the action is how a legal gate becomes a
 * speed bump nobody reads.
 */
export function BulkVoicemailModal({
  open,
  recordings,
  onClose,
}: {
  open: boolean;
  recordings: { id: string; name: string; isDefault: boolean }[];
  onClose: () => void;
}) {
  const [info, setInfo] = useState<BulkInfo | null>(null);
  const [segment, setSegment] = useState<SegmentKind>('already_called');
  const [segmentId, setSegmentId] = useState('');
  const [recordingId, setRecordingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueuedResult | null>(null);

  /// Set when the route refuses the batch for want of an acknowledgement.
  const [gate, setGate] = useState<{ text: string; neverCalled: number } | null>(
    null,
  );
  const [gateAccepted, setGateAccepted] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/voicemail/bulk');
    if (res.ok) setInfo(await res.json());
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setResult(null);
    setGate(null);
    setGateAccepted(false);
    load();
    const def = recordings.find((r) => r.isDefault) ?? recordings[0];
    setRecordingId(def?.id ?? '');
  }, [open, load, recordings]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const targetCount =
    segment === 'never_called'
      ? (info?.neverCalled ?? 0)
      : segment === 'already_called'
        ? (info?.alreadyCalled ?? 0)
        : ((segment === 'list' ? info?.lists : info?.stages)?.find(
            (o) => o.id === segmentId,
          )?.count ?? 0);

  async function acknowledge() {
    setBusy(true);
    try {
      const res = await fetch('/api/acknowledgements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'bulk_voicemail_never_called' }),
      });
      if (!res.ok) throw new Error('Could not record the acknowledgement.');
      setGate(null);
      setGateAccepted(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function queue() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/voicemail/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segment, segmentId: segmentId || undefined, recordingId }),
      });
      const json = await res.json();

      if (res.status === 403 && json.requiresAcknowledgement) {
        setGate({
          text: json.acknowledgementText,
          neverCalled: json.neverCalledCount,
        });
        return;
      }
      if (!res.ok) throw new Error(json.error ?? 'Could not queue the drop.');

      setResult(json);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not queue the drop.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="panel flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between border-b border-ink-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-100">
            Queue a bulk voicemail drop
          </h2>
          <button
            className="text-ink-500 hover:text-ink-200"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-4">
          {error && (
            <div className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          {result ? (
            <div className="space-y-2">
              <div className="rounded-lg border border-green-900 bg-green-950/50 px-3 py-2 text-xs text-green-200">
                Queued <strong>{result.queued}</strong> drops of &ldquo;
                {result.recordingName}&rdquo;, one every{' '}
                {result.spacingSeconds}s. Expect the batch to finish around{' '}
                {new Date(result.finishesAboutAt).toLocaleTimeString()}.
              </div>
              {result.skippedAlreadyQueuedToday > 0 && (
                <p className="text-xs text-ink-400">
                  {result.skippedAlreadyQueuedToday} lead
                  {result.skippedAlreadyQueuedToday === 1 ? ' was' : 's were'}{' '}
                  already queued today and {' '}
                  {result.skippedAlreadyQueuedToday === 1 ? 'was' : 'were'}{' '}
                  skipped, so nobody gets the same message twice.
                </p>
              )}
              <button className="btn-ghost py-1.5 text-xs" onClick={onClose}>
                Done
              </button>
            </div>
          ) : gate ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-amber-800 bg-amber-950/50 p-3">
                <p className="text-xs font-semibold text-amber-200">
                  {gate.neverCalled} of these leads have never been called.
                </p>
                <p className="mt-2 text-xs leading-relaxed text-amber-100/90">
                  {gate.text}
                </p>
              </div>

              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={gateAccepted}
                  onChange={(e) => setGateAccepted(e.target.checked)}
                  className="mt-0.5 accent-brand-500"
                />
                <span className="text-xs text-ink-200">
                  I have read the above and accept it. Recorded with a
                  timestamp.
                </span>
              </label>

              <div className="flex gap-2">
                <button
                  className="btn-primary py-1.5 text-xs"
                  disabled={!gateAccepted || busy}
                  onClick={acknowledge}
                >
                  Record acknowledgement
                </button>
                <button className="btn-ghost py-1.5 text-xs" onClick={onClose}>
                  Cancel
                </button>
              </div>
              <p className="text-[11px] text-ink-500">
                Recording the acknowledgement does not send anything. You will
                come back to this screen and choose to queue.
              </p>
            </div>
          ) : (
            <>
              <div>
                <label className="label">Recording</label>
                <select
                  className="input"
                  value={recordingId}
                  onChange={(e) => setRecordingId(e.target.value)}
                >
                  {recordings.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label">Who gets it</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ['already_called', `Already called (${info?.alreadyCalled ?? '…'})`],
                      ['never_called', `Never called (${info?.neverCalled ?? '…'})`],
                      ['list', 'A list'],
                      ['stage', 'A pipeline stage'],
                    ] as [SegmentKind, string][]
                  ).map(([kind, label]) => (
                    <button
                      key={kind}
                      onClick={() => {
                        setSegment(kind);
                        setSegmentId('');
                      }}
                      className={cn(
                        'rounded-lg border px-2.5 py-2 text-left text-xs transition-colors',
                        segment === kind
                          ? 'border-brand-500 bg-brand-500/10 text-brand-200'
                          : 'border-ink-700 bg-ink-850 text-ink-300 hover:bg-ink-800',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {(segment === 'list' || segment === 'stage') && (
                <div>
                  <label className="label">
                    {segment === 'list' ? 'Which list' : 'Which stage'}
                  </label>
                  <select
                    className="input"
                    value={segmentId}
                    onChange={(e) => setSegmentId(e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {(segment === 'list' ? info?.lists : info?.stages)?.map(
                      (o) => (
                        <option key={o.id} value={o.id}>
                          {o.name} ({o.count})
                        </option>
                      ),
                    )}
                  </select>
                </div>
              )}

              <div className="rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-300">
                About <strong className="text-ink-100">{targetCount}</strong>{' '}
                leads. Do-not-contact leads are excluded and are not counted
                here. Anyone already queued today is skipped.
              </div>

              {info?.acknowledgedAt && (
                <p className="text-[11px] text-ink-500">
                  Bulk-to-never-called acknowledged{' '}
                  {new Date(info.acknowledgedAt).toLocaleString()}.
                </p>
              )}

              <div className="flex gap-2">
                <button
                  className="btn-primary py-1.5 text-xs"
                  onClick={queue}
                  disabled={
                    busy ||
                    !recordingId ||
                    targetCount === 0 ||
                    ((segment === 'list' || segment === 'stage') && !segmentId)
                  }
                >
                  {busy ? 'Queueing…' : `Queue ${targetCount} drops`}
                </button>
                <button className="btn-ghost py-1.5 text-xs" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
