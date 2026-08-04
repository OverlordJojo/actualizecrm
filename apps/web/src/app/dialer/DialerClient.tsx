'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { ImportModal } from '@/components/import/ImportModal';
import { PipelineBoard } from '@/components/pipeline/PipelineBoard';
import {
  ActiveLeadCard,
  type ActiveLead,
  type VisibleCustomField,
} from '@/components/dialer/ActiveLeadCard';
import { BurstCards } from '@/components/dialer/BurstCards';
import { TrashToast } from '@/components/dialer/TrashToast';
import { CreateLeadModal } from '@/components/dialer/CreateLeadModal';
import { DialControls } from '@/components/dialer/DialControls';
import { SuggestionChips } from '@/components/dialer/SuggestionChips';
import { BookingPanel } from '@/components/dialer/BookingPanel';
import { LiveTranscript } from '@/components/dialer/LiveTranscript';
import { useCall, formatCallTimer } from '@/components/call/CallProvider';
import type { BoardData } from '@/components/pipeline/types';

export interface DialerLead extends ActiveLead {
  listId: string | null;
}

export interface LeadListOption {
  id: string;
  name: string;
  count: number;
}

/**
 * The Dialer page renders the call; it does not own it.
 *
 * All call state lives in <CallProvider> in the root layout (§3.3), so
 * navigating away and back leaves the call untouched.
 */
export function DialerClient({
  leadCount: initialLeadCount,
  board: initialBoard,
  visibleCustomFields,
}: {
  leadCount: number;
  board: BoardData | null;
  visibleCustomFields: VisibleCustomField[];
}) {
  const call = useCall();

  const [importOpen, setImportOpen] = useState(false);
  const [leadCount, setLeadCount] = useState(initialLeadCount);
  const [board, setBoard] = useState(initialBoard);
  const [boardKey, setBoardKey] = useState(0);

  /// Set when an AI booking suggestion is accepted. It populates the booking
  /// panel; it never books (§5.6).
  const [bookingProposal, setBookingProposal] = useState<{
    iso: string;
    evidence: string | null;
  } | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [trashed, setTrashed] = useState<{ contactId: string; name: string; stageId: string | null; expiresAt: number } | null>(null);
  const [loadingQueue, setLoadingQueue] = useState(false);

  const refreshBoard = useCallback(async () => {
    const res = await fetch(
      `/api/board${board ? `?pipelineId=${board.activePipelineId}` : ''}`,
    );
    if (!res.ok) return;
    setBoard(await res.json());
    setBoardKey((k) => k + 1);
  }, [board]);

  // Reflect dispositions and stage moves made during a call — including ones
  // set while the operator was on another page.
  useEffect(() => {
    if (call.lineState === 'ready') refreshBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.lineState]);

  /**
   * The dial queue is the New column, in board order (§3.2).
   *
   * There is no list to load any more. Lists were a second, invisible ordering
   * that could disagree with the board the operator was looking at — they would
   * drag a card to the top of New and the dialer would call somebody else. Now
   * the column *is* the queue, which is why its header says "dial order".
   */
  const loadQueue = useCallback(async () => {
    setLoadingQueue(true);
    try {
      const res = await fetch('/api/queue?stage=New');
      if (res.ok) call.setQueue(await res.json());
    } finally {
      setLoadingQueue(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue, boardKey]);

  /// Inline edits from the Active Lead Card (§3.1). Returns an error message
  /// for the card to show, or null. The card keeps the operator's text either
  /// way — silently reverting what someone just typed mid-call is worse than
  /// showing them why it did not stick.
  const saveField = useCallback(
    async (leadId: string, field: string, value: string): Promise<string | null> => {
      try {
        const res = await fetch(`/api/contacts/${leadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        if (res.ok) return null;
        const json = await res.json().catch(() => null);
        return json?.error ?? 'Could not save that.';
      } catch {
        return 'Could not reach the server to save that.';
      }
    },
    [],
  );

  const saveNotes = useCallback(async (leadId: string, notes: string) => {
    await fetch('/api/contacts/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: leadId, notes }),
    }).catch(() => {});
  }, []);

  const remaining = Math.max(call.queue.length - call.index, 0);
  const banner = call.error ?? call.phoneError;

  const audioWarning =
    call.audio.mode === 'music' && call.silentFallback
      ? `Music mode is on but Spotify is not playing${
          call.spotifyProblem ? ` — ${call.spotifyProblem}` : ''
        }. Calls will ring silently.`
      : null;

  const subtitle = useMemo(() => {
    const parts = [`${leadCount.toLocaleString()} leads`];
    if (call.queue.length) parts.push(`${remaining} in queue`);
    return parts.join(' · ');
  }, [leadCount, call.queue.length, remaining]);

  return (
    <>
      <PageHeader title="Dialer" subtitle={subtitle}>
        {call.lineState === 'connected' && (
          <span className="mr-2 font-mono text-sm tabular-nums text-green-400">
            {formatCallTimer(call.callSeconds)}
          </span>
        )}
        <button className="btn-ghost" onClick={() => setCreateOpen(true)}>
          Create lead
        </button>
        <button className="btn-ghost" onClick={() => setImportOpen(true)}>
          Import leads
        </button>
      </PageHeader>

      {banner && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-red-900 bg-red-950/60 px-3 py-1.5 text-xs text-red-200">
          <span className="flex-1">{banner}</span>
          <button className="underline" onClick={call.clearError}>
            dismiss
          </button>
        </div>
      )}

      {audioWarning && (
        <div className="mx-4 mt-2 rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-100">
          {audioWarning}
        </div>
      )}

      {/* Regions A and B. overflow-hidden matters: Region B must never bleed
          over the board. */}
      <div className="flex h-[320px] shrink-0 gap-5 overflow-hidden px-5 py-4">
        {/* While a burst is ringing the operator sees every leg side by side;
            the instant one bridges this collapses to that lead's full card
            (§3.7). Showing only the first leg is what made a three-line burst
            look identical to a single-line one. */}
        {!call.activeLead && call.ringingLeads.length > 0 ? (
          <div className="flex-1 overflow-y-auto">
            <BurstCards
              ringing={call.ringingLeads}
              resolved={call.resolved}
              held={call.held}
            />
          </div>
        ) : (
        <ActiveLeadCard
          lead={call.activeLead}
          visibleCustomFields={visibleCustomFields}
          onNotesChange={saveNotes}
          onFieldChange={saveField}
          bookingPanel={
            <>
              <SuggestionChips
                callId={null}
                contactId={call.activeLead?.id ?? null}
                onApplied={refreshBoard}
                onBookingProposed={(iso, evidence) =>
                  setBookingProposal({ iso, evidence })
                }
              />
              <BookingPanel
                contactId={call.activeLead?.id ?? null}
                proposal={bookingProposal}
                onBooked={refreshBoard}
              />
            </>
          }
        />
        )}
        <LiveTranscript
          callId={call.activeCallId}
          live={call.lineState === 'connected'}
        />
        <DialControls
          lineState={call.lineState}
          muted={call.muted}
          callerId={call.callerId}
          sessionActive={call.sessionActive}
          queueLength={loadingQueue ? 0 : remaining}
          stats={call.stats}
          gapSeconds={call.gapSeconds}
          countdown={call.countdown}
          callSeconds={call.callSeconds}
          onStartSession={call.startSession}
          onPauseSession={call.pauseSession}
          onEndSession={call.endSession}
          onManualDial={call.dialManual}
          onHangup={call.hangup}
          onToggleMute={call.toggleMute}
          onDisposition={call.setDisposition}
          onVoicemailDrop={call.dropVoicemail}
          dropping={call.dropping}
          incoming={call.incoming}
          onAnswerInbound={call.answerInbound}
          onDeclineInbound={call.declineInbound}
          incomingIsOperatorLeg={call.incomingIsOperatorLeg}
          held={call.held}
          governor={call.governor}
          linesPerBurst={call.linesPerBurst}
          canHangup={call.canHangup}
        />
      </div>

      {/* Region C */}
      {board ? (
        <PipelineBoard
          key={boardKey}
          initial={board}
          onCallLeadId={call.activeLead?.id ?? null}
          aiSuggestedStageId={call.suggestedStageId}
          onManualStageChoice={call.lockStageChoice}
          onTrashed={(info) =>
            setTrashed({ ...info, expiresAt: Date.now() + 10_000 })
          }
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-500">
          No pipelines yet — run <code className="mx-1 font-mono">npm run db:seed</code>
        </div>
      )}

      {/* §3.3 / §3.4 — ten seconds to take it back. Two sources, one toast:
          a card dragged to the trash, and a call that ended with no outcome. */}
      {(trashed || call.trashToast) && (
        <TrashToast
          name={trashed?.name ?? 'that lead'}
          expiresAt={(trashed ?? call.trashToast)!.expiresAt}
          onUndo={async () => {
            if (trashed) {
              await fetch('/api/dialer/outcome', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'undo',
                  contactId: trashed.contactId,
                  stageId: trashed.stageId,
                }),
              }).catch(() => {});
              setTrashed(null);
              refreshBoard();
            } else {
              await call.undoTrash();
              refreshBoard();
            }
          }}
        />
      )}

      <CreateLeadModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setLeadCount((c) => c + 1);
          refreshBoard();
        }}
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(report) => {
          // Imports still record a source label for provenance (§7.1), but a
          // list is no longer a thing you dial — imported leads land in New and
          // the board is the queue.
          setLeadCount((c) => c + report.added);
          refreshBoard();
        }}
      />
    </>
  );
}
