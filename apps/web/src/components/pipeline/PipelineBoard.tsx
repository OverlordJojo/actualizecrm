'use client';

import { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { LeadCard } from './LeadCard';
import { StageColumn } from './StageColumn';
import { TRASH_ZONE_ID, type BoardData, type BoardLead, type BoardStage } from './types';
import { TrashZone } from '@/components/dialer/TrashToast';
import { ContactSlideOver } from '@/components/contact/ContactSlideOver';

export function PipelineBoard({
  initial,
  onCallLeadId,
  aiSuggestedStageId,
  onManualStageChoice,
  onTrashed,
}: {
  initial: BoardData;
  onCallLeadId?: string | null;
  /// Column the AI wants the lead on the call moved to (§5.6).
  aiSuggestedStageId?: string | null;
  /// Called when the operator moves a lead themselves, which permanently ends
  /// AI stage suggestions for this call.
  onManualStageChoice?: () => void;
  /// Fired when a lead is dragged to the trash, so the page can show the
  /// ten-second Undo (§3.3).
  onTrashed?: (info: { contactId: string; name: string; stageId: string | null }) => void;
}) {
  const [stages, setStages] = useState<BoardStage[]>(initial.stages);
  const [unassigned, setUnassigned] = useState<BoardLead[]>(initial.unassigned);
  const [pipelines, setPipelines] = useState(initial.pipelines);
  const [activeId, setActiveId] = useState(initial.activePipelineId);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);
  /// §3.9 — bulk selection, offered only on the dial queue.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showDealValue, setShowDealValue] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // A small drag distance keeps a click from being read as a drag, so cards
  // stay clickable once the slide-over lands.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const draggingLead = useMemo(() => {
    if (!draggingId) return null;
    return (
      unassigned.find((l) => l.id === draggingId) ??
      stages.flatMap((s) => s.leads).find((l) => l.id === draggingId) ??
      null
    );
  }, [draggingId, stages, unassigned]);

  async function loadPipeline(pipelineId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/board?pipelineId=${pipelineId}`);
      const json: BoardData = await res.json();
      if (!res.ok) throw new Error('Could not load that pipeline.');
      setStages(json.stages);
      setUnassigned(json.unassigned);
      setPipelines(json.pipelines);
      setActiveId(json.activePipelineId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that pipeline.');
    } finally {
      setLoading(false);
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setDraggingId(String(event.active.id));
  }

  /**
   * Dropping on the trash removes the lead from the pipeline (§3.3).
   *
   * Removed, not deleted: the contact and its entire conversation history stay
   * searchable forever, and the ten-second Undo restores the exact column it
   * came from. That is why the previous stage is captured before the optimistic
   * update rather than read back afterwards.
   */
  async function trashLead(leadId: string) {
    const fromStage = stages.find((s) => s.leads.some((l) => l.id === leadId));
    const lead = fromStage?.leads.find((l) => l.id === leadId);
    if (!lead) return;

    setStages((prev) =>
      prev.map((s) =>
        s.id === fromStage?.id
          ? { ...s, leads: s.leads.filter((l) => l.id !== leadId) }
          : s,
      ),
    );

    const res = await fetch('/api/contacts/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: leadId, reason: 'not_interested' }),
    });

    if (!res.ok) {
      setError('Could not remove that lead.');
      loadPipeline(activeId);
      return;
    }

    onTrashed?.({
      contactId: leadId,
      name:
        [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.phone,
      stageId: fromStage?.id ?? null,
    });
  }

  /**
   * Removes everything selected (§3.9).
   *
   * Confirms with the exact count, because this is the one action on the board
   * that touches many leads at once and a misclick on "Select all" is easy.
   * Removed, not deleted — history is kept and every one stays searchable.
   */
  async function removeSelected(columnLeads: BoardLead[]) {
    const ids = columnLeads.filter((l) => selected.has(l.id)).map((l) => l.id);
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Remove ${ids.length} lead${ids.length === 1 ? '' : 's'} from the pipeline?\n\n` +
          'Their conversation history is kept and they stay searchable.',
      )
    ) {
      return;
    }

    setStages((prev) =>
      prev.map((s) => ({ ...s, leads: s.leads.filter((l) => !ids.includes(l.id)) })),
    );
    setSelected(new Set());

    await Promise.all(
      ids.map((contactId) =>
        fetch('/api/contacts/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactId, reason: 'not_interested' }),
        }).catch(() => {}),
      ),
    );
    loadPipeline(activeId);
  }

  async function handleDragEnd(event: DragEndEvent) {
    // The operator moving a lead by hand is a decision. It ends AI stage
    // suggestions for this call rather than letting the model keep proposing a
    // column they have already rejected.
    onManualStageChoice?.();
    const leadId = String(event.active.id);
    setDraggingId(null);

    const destination = event.over ? String(event.over.id) : null;
    if (!destination) return;

    if (destination === TRASH_ZONE_ID) {
      await trashLead(leadId);
      return;
    }

    const targetStageId = destination;

    // Find where the lead currently lives.
    const fromStage = stages.find((s) => s.leads.some((l) => l.id === leadId));
    const currentStageId = fromStage?.id ?? null;
    if (currentStageId === targetStageId) return;

    const lead =
      fromStage?.leads.find((l) => l.id === leadId) ??
      unassigned.find((l) => l.id === leadId);
    if (!lead) return;

    // Optimistic move — a drag that visibly snaps back while a request flies is
    // the kind of thing that makes a dialer feel broken mid-call.
    const moved: BoardLead = { ...lead, stageId: targetStageId };
    const removeFrom = (list: BoardLead[]) => list.filter((l) => l.id !== leadId);

    const prevStages = stages;
    const prevUnassigned = unassigned;

    setStages((prev) =>
      prev.map((s) => {
        if (s.id === currentStageId) return { ...s, leads: removeFrom(s.leads) };
        if (s.id === targetStageId) return { ...s, leads: [moved, ...s.leads] };
        return s;
      }),
    );
    setUnassigned((prev) =>
      currentStageId === null
        ? removeFrom(prev)
        : targetStageId === null
          ? [moved, ...prev]
          : prev,
    );

    try {
      const res = await fetch('/api/contacts/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: leadId, stageId: targetStageId, position: 0 }),
      });
      if (!res.ok) throw new Error('Move failed.');
    } catch {
      // Roll back so the board never disagrees with the database.
      setStages(prevStages);
      setUnassigned(prevUnassigned);
      setError('That move did not save. Put it back and try again.');
    }
  }

  async function addStage() {
    const name = window.prompt('Name the new stage');
    if (!name?.trim()) return;
    const res = await fetch('/api/stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineId: activeId, name: name.trim() }),
    });
    if (res.ok) loadPipeline(activeId);
  }

  async function renameStage(stageId: string, name: string) {
    setStages((prev) => prev.map((s) => (s.id === stageId ? { ...s, name } : s)));
    await fetch(`/api/stages/${stageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  async function recolorStage(stageId: string, color: string) {
    setStages((prev) => prev.map((s) => (s.id === stageId ? { ...s, color } : s)));
    await fetch(`/api/stages/${stageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    });
  }

  async function deleteStage(stageId: string) {
    const stage = stages.find((s) => s.id === stageId);
    if (!stage) return;
    const count = stage.leads.length;
    const message = count
      ? `Delete "${stage.name}"? Its ${count} lead${count === 1 ? '' : 's'} move to Unassigned — nothing is deleted.`
      : `Delete "${stage.name}"?`;
    if (!window.confirm(message)) return;

    const res = await fetch(`/api/stages/${stageId}`, { method: 'DELETE' });
    if (res.ok) loadPipeline(activeId);
    else setError((await res.json()).error ?? 'Could not delete that stage.');
  }

  async function addPipeline() {
    const name = window.prompt('Name the new pipeline');
    if (!name?.trim()) return;
    const res = await fetch('/api/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (res.ok) {
      const created = await res.json();
      loadPipeline(created.id);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-ink-800">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2.5">
        <select
          className="input w-auto py-1.5 text-[13px]"
          value={activeId}
          onChange={(e) => loadPipeline(e.target.value)}
        >
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <button className="btn-ghost py-1.5 text-xs" onClick={addPipeline}>
          New pipeline
        </button>
        <button className="btn-ghost py-1.5 text-xs" onClick={addStage}>
          Add stage
        </button>

        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-400">
          <input
            type="checkbox"
            checked={showDealValue}
            onChange={(e) => setShowDealValue(e.target.checked)}
            className="accent-brand-500"
          />
          Show deal value
        </label>

        {loading && <span className="text-xs text-ink-500">Loading…</span>}
      </div>

      {error && (
        <div className="mx-4 mb-2 rounded-lg border border-red-900 bg-red-950/60 px-3 py-1.5 text-xs text-red-200">
          {error}
          <button
            className="ml-2 underline"
            onClick={() => setError(null)}
          >
            dismiss
          </button>
        </div>
      )}

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {/* No Unassigned column (§3.1). It was never a stage, only the absence
            of one, and leads landed there on import where a dial session that
            walks the board could not see them. Everything starts in New. */}
        <div className="scroll-thin flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4">
          {stages.map((stage, i) => (
            <StageColumn
              key={stage.id}
              id={stage.id}
              name={stage.name}
              color={stage.color}
              leads={stage.leads}
              onCallLeadId={onCallLeadId}
              aiSuggested={aiSuggestedStageId === stage.id}
              showDealValue={showDealValue}
              // The first column is the dial queue, and its order is the order
              // calls go out in. Saying so is what makes dragging a card to the
              // top a deliberate act rather than a tidy-up (§3.2).
              caption={i === 0 ? 'dial order — top first' : undefined}
              onOpenLead={setOpenLeadId}
              // Only the first column. Bulk-removing from Booked is not a
              // thing anybody wants to do quickly.
              selectable={i === 0}
              selectedIds={i === 0 ? selected : undefined}
              onSelectLead={(leadId, on) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  on ? next.add(leadId) : next.delete(leadId);
                  return next;
                })
              }
              onSelectAll={() => setSelected(new Set(stage.leads.map((l) => l.id)))}
              onRemoveSelected={() => removeSelected(stage.leads)}
              editable
              onRename={(name) => renameStage(stage.id, name)}
              onRecolor={(color) => recolorStage(stage.id, color)}
              onDelete={() => deleteStage(stage.id)}
            />
          ))}
        </div>

        <TrashZone active={draggingId !== null} />

        {/* §3.6 — clicking a card opens everything about the lead. */}
        <ContactSlideOver
          contactId={openLeadId}
          onClose={() => setOpenLeadId(null)}
          onChanged={() => loadPipeline(activeId)}
        />

        <DragOverlay dropAnimation={null}>
          {draggingLead && (
            <div className="w-[220px]">
              <LeadCard lead={draggingLead} overlay />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </section>
  );
}
