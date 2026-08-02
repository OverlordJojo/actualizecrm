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
import { UNASSIGNED, type BoardData, type BoardLead, type BoardStage } from './types';

export function PipelineBoard({
  initial,
  onCallLeadId,
  aiSuggestedStageId,
  onManualStageChoice,
}: {
  initial: BoardData;
  onCallLeadId?: string | null;
  /// Column the AI wants the lead on the call moved to (§5.6).
  aiSuggestedStageId?: string | null;
  /// Called when the operator moves a lead themselves, which permanently ends
  /// AI stage suggestions for this call.
  onManualStageChoice?: () => void;
}) {
  const [stages, setStages] = useState<BoardStage[]>(initial.stages);
  const [unassigned, setUnassigned] = useState<BoardLead[]>(initial.unassigned);
  const [pipelines, setPipelines] = useState(initial.pipelines);
  const [activeId, setActiveId] = useState(initial.activePipelineId);
  const [draggingId, setDraggingId] = useState<string | null>(null);
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

  async function handleDragEnd(event: DragEndEvent) {
    // The operator moving a lead by hand is a decision. It ends AI stage
    // suggestions for this call rather than letting the model keep proposing a
    // column they have already rejected.
    onManualStageChoice?.();
    const leadId = String(event.active.id);
    setDraggingId(null);

    const destination = event.over ? String(event.over.id) : null;
    if (!destination) return;

    const targetStageId = destination === UNASSIGNED ? null : destination;

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
        <div className="scroll-thin flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4">
          <StageColumn
            id={UNASSIGNED}
            name="Unassigned"
            color="#434a59"
            leads={unassigned}
            onCallLeadId={onCallLeadId}
            aiSuggested={false}
            showDealValue={showDealValue}
            editable={false}
          />

          {stages.map((stage) => (
            <StageColumn
              key={stage.id}
              id={stage.id}
              name={stage.name}
              color={stage.color}
              leads={stage.leads}
              onCallLeadId={onCallLeadId}
              aiSuggested={aiSuggestedStageId === stage.id}
              showDealValue={showDealValue}
              editable
              onRename={(name) => renameStage(stage.id, name)}
              onRecolor={(color) => recolorStage(stage.id, color)}
              onDelete={() => deleteStage(stage.id)}
            />
          ))}
        </div>

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
