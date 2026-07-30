'use client';

import { useCallback, useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { ImportModal } from '@/components/import/ImportModal';
import { PipelineBoard } from '@/components/pipeline/PipelineBoard';
import { ActiveLeadCard, type ActiveLead, type VisibleCustomField } from '@/components/dialer/ActiveLeadCard';
import { DialControls } from '@/components/dialer/DialControls';
import { useDialSession } from '@/components/dialer/useDialSession';
import type { BoardData } from '@/components/pipeline/types';
import type { RingAudioConfig } from '@/integrations/audio/useRingAudio';

export interface DialerLead extends ActiveLead {
  listId: string | null;
}

export interface LeadListOption {
  id: string;
  name: string;
  count: number;
}

export function DialerClient({
  leadCount: initialLeadCount,
  board: initialBoard,
  lists,
  visibleCustomFields,
  gapSeconds,
  audio,
}: {
  leadCount: number;
  board: BoardData | null;
  lists: LeadListOption[];
  visibleCustomFields: VisibleCustomField[];
  gapSeconds: number;
  audio: RingAudioConfig;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [leadCount, setLeadCount] = useState(initialLeadCount);
  const [board, setBoard] = useState(initialBoard);
  const [boardKey, setBoardKey] = useState(0);

  const [listOptions, setListOptions] = useState(lists);
  const [selectedListId, setSelectedListId] = useState('');
  const [queue, setQueue] = useState<DialerLead[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);

  const refreshBoard = useCallback(async () => {
    const res = await fetch(
      `/api/board${board ? `?pipelineId=${board.activePipelineId}` : ''}`,
    );
    if (!res.ok) return;
    setBoard(await res.json());
    setBoardKey((k) => k + 1);
  }, [board]);

  const session = useDialSession({
    queue,
    gapSeconds,
    audio,
    onCallEnded: refreshBoard,
  });

  async function loadQueue(listId: string) {
    setSelectedListId(listId);
    if (!listId) {
      setQueue([]);
      return;
    }
    setLoadingQueue(true);
    try {
      const res = await fetch(`/api/queue?listId=${listId}`);
      if (res.ok) setQueue(await res.json());
    } finally {
      setLoadingQueue(false);
    }
  }

  const saveNotes = useCallback(async (leadId: string, notes: string) => {
    await fetch('/api/contacts/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: leadId, notes }),
    }).catch(() => {});
  }, []);

  const remaining = Math.max(queue.length - session.index, 0);
  const banner = session.error ?? session.phoneError;

  // Music was asked for but cannot play. Calls will ring silently, which is
  // the intended fallback but is indistinguishable from a broken dialer unless
  // we say so.
  const audioWarning =
    audio.mode === 'music' && session.silentFallback
      ? `Music mode is on but Spotify is not playing${
          session.spotifyProblem ? ` — ${session.spotifyProblem}` : ''
        }. Calls will ring silently.`
      : null;

  const subtitle = useMemo(() => {
    const parts = [`${leadCount.toLocaleString()} leads`];
    if (queue.length) parts.push(`${remaining} in queue`);
    return parts.join(' · ');
  }, [leadCount, queue.length, remaining]);

  return (
    <>
      <PageHeader title="Dialer" subtitle={subtitle}>
        <select
          className="input w-auto py-1.5 text-xs"
          value={selectedListId}
          onChange={(e) => loadQueue(e.target.value)}
          disabled={session.sessionActive}
        >
          <option value="">Load a list…</option>
          {listOptions.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.count})
            </option>
          ))}
        </select>
        <button className="btn-ghost" onClick={() => setImportOpen(true)}>
          Import leads
        </button>
      </PageHeader>

      {banner && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-red-900 bg-red-950/60 px-3 py-1.5 text-xs text-red-200">
          <span className="flex-1">{banner}</span>
          <button className="underline" onClick={session.clearError}>
            dismiss
          </button>
        </div>
      )}

      {/* Regions A and B */}
      {audioWarning && (
        <div className="mx-4 mt-2 rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-100">
          {audioWarning}
        </div>
      )}

      {/* overflow-hidden matters: Region B must never bleed over the board */}
      <div className="flex h-[320px] shrink-0 gap-5 overflow-hidden px-5 py-4">
        <ActiveLeadCard
          lead={session.activeLead}
          visibleCustomFields={visibleCustomFields}
          onNotesChange={saveNotes}
        />
        <DialControls
          lineState={session.lineState}
          muted={session.muted}
          callerId={session.callerId}
          sessionActive={session.sessionActive}
          queueLength={loadingQueue ? 0 : remaining}
          stats={session.stats}
          gapSeconds={gapSeconds}
          countdown={session.countdown}
          onStartSession={session.startSession}
          onPauseSession={session.pauseSession}
          onEndSession={session.endSession}
          onManualDial={session.dialManual}
          onHangup={session.hangup}
          onToggleMute={session.toggleMute}
          onDisposition={session.setDisposition}
          onVoicemailDrop={() => {
            /* build step 6 */
          }}
        />
      </div>

      {/* Region C */}
      {board ? (
        <PipelineBoard
          key={boardKey}
          initial={board}
          onCallLeadId={session.activeLead?.id ?? null}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-500">
          No pipelines yet — run <code className="mx-1 font-mono">npm run db:seed</code>
        </div>
      )}

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(report) => {
          setLeadCount((c) => c + report.added);
          setListOptions((prev) => [
            { id: report.listId, name: report.listName, count: report.added + report.merged },
            ...prev,
          ]);
          refreshBoard();
        }}
      />
    </>
  );
}
