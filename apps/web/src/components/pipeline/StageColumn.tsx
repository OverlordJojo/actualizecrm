'use client';

import { useEffect, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/cn';
import { LeadCard } from './LeadCard';
import { type BoardLead } from './types';

const STAGE_COLORS = [
  '#64748b',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f59e0b',
  '#22c55e',
  '#14b8a6',
];

export function StageColumn({
  id,
  name,
  color,
  leads,
  onCallLeadId,
  aiSuggested,
  caption,
  onOpenLead,
  selectable,
  selectedIds,
  onSelectLead,
  onSelectAll,
  onRemoveSelected,
  showDealValue,
  editable,
  onRename,
  onRecolor,
  onDelete,
}: {
  id: string;
  name: string;
  color: string;
  leads: BoardLead[];
  onCallLeadId?: string | null;
  /// The AI is proposing the lead on the call belongs here (§5.6). Drawn as a
  /// pulsing outline rather than moving anything — the operator decides, and
  /// their choice locks further suggestions out for the call.
  aiSuggested?: boolean;
  /// Small note under the column name — used to mark the dial queue (§3.2).
  caption?: string;
  /// Opens a lead's detail view (§3.6).
  onOpenLead?: (leadId: string) => void;
  /// Bulk selection, offered only on the dial queue (§3.9).
  selectable?: boolean;
  selectedIds?: Set<string>;
  onSelectLead?: (leadId: string, selected: boolean) => void;
  onSelectAll?: () => void;
  onRemoveSelected?: () => void;
  showDealValue: boolean;
  /// The Unassigned column is not a real stage, so it cannot be renamed or
  /// deleted.
  editable: boolean;
  onRename?: (name: string) => void;
  onRecolor?: (color: string) => void;
  onDelete?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(name), [name]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const total = leads.reduce((sum, l) => sum + (l.dealValue ?? 0), 0);

  function commitRename() {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== name) onRename?.(next);
    else setDraft(name);
  }

  return (
    <div
      className={cn(
        'flex h-full w-[236px] shrink-0 flex-col rounded-xl',
        aiSuggested && 'animate-pulse ring-2 ring-violet-500/70 ring-offset-2 ring-offset-ink-950',
      )}
    >
      <header className="mb-2 flex items-center gap-2 px-0.5">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />

        {editing ? (
          <input
            ref={inputRef}
            className="min-w-0 flex-1 rounded border border-brand-500 bg-ink-950 px-1.5 py-0.5 text-[13px] font-medium text-ink-100 focus:outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setDraft(name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            className={cn(
              'min-w-0 flex-1 truncate text-left text-[13px] font-medium text-ink-200',
              editable && 'hover:text-ink-100',
            )}
            onDoubleClick={() => editable && setEditing(true)}
            title={editable ? 'Double-click to rename' : undefined}
          >
            {name}
            {/* §3.2: reordering this column reorders the dial queue, so say
                so — otherwise dragging a card to the top looks cosmetic. */}
            {caption && (
              <span className="block truncate text-[9px] font-normal text-ink-500">
                {caption}
              </span>
            )}
          </button>
        )}

        <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[11px] tabular-nums text-ink-400">
          {leads.length}
        </span>

        {editable && (
          <div className="relative shrink-0">
            <button
              className="rounded px-1 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={`${name} stage options`}
            >
              ⋯
            </button>
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-ink-700 bg-ink-850 p-2 shadow-xl">
                  <button
                    className="w-full rounded px-2 py-1.5 text-left text-xs text-ink-200 hover:bg-ink-800"
                    onClick={() => {
                      setMenuOpen(false);
                      setEditing(true);
                    }}
                  >
                    Rename
                  </button>

                  <div className="mt-1 flex flex-wrap gap-1 px-2 py-1.5">
                    {STAGE_COLORS.map((c) => (
                      <button
                        key={c}
                        className={cn(
                          'h-4 w-4 rounded-full ring-offset-1 ring-offset-ink-850',
                          c === color && 'ring-2 ring-ink-200',
                        )}
                        style={{ backgroundColor: c }}
                        onClick={() => {
                          onRecolor?.(c);
                          setMenuOpen(false);
                        }}
                        aria-label={`Set colour ${c}`}
                      />
                    ))}
                  </div>

                  <button
                    className="w-full rounded px-2 py-1.5 text-left text-xs text-red-400 hover:bg-ink-800"
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete?.();
                    }}
                  >
                    Delete stage
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </header>

      {showDealValue && total > 0 && (
        <div className="mb-1.5 px-0.5 text-[11px] tabular-nums text-brand-400">
          ${total.toLocaleString()}
        </div>
      )}

      <div
        ref={setNodeRef}
        className={cn(
          'scroll-thin flex-1 space-y-1.5 overflow-y-auto rounded-lg border border-dashed p-1.5 transition-colors',
          isOver
            ? 'border-brand-500 bg-brand-500/5'
            : 'border-ink-800 bg-ink-950/40',
        )}
      >
        {/* §3.9 — bulk controls, only while something is selected. A toolbar
            that is always there is a toolbar in the way. */}
        {selectable && (selectedIds?.size ?? 0) > 0 && (
          <div className="sticky top-0 z-10 mb-1 flex items-center gap-2 rounded-lg border border-brand-800 bg-brand-950/80 px-2 py-1.5 backdrop-blur">
            <span className="text-[11px] font-medium text-brand-200">
              {selectedIds?.size} selected
            </span>
            <button
              className="text-[10px] text-brand-300 underline"
              onClick={onSelectAll}
            >
              Select all
            </button>
            <button
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-950/60"
              onClick={onRemoveSelected}
            >
              Remove
            </button>
          </div>
        )}

        {leads.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            isOnCall={lead.id === onCallLeadId}
            onOpen={onOpenLead}
            selectable={selectable}
            selected={selectedIds?.has(lead.id)}
            onSelect={onSelectLead}
          />
        ))}

        {leads.length === 0 && (
          <div className="flex h-16 items-center justify-center text-[11px] text-ink-600">
            {'Drop leads here'}
          </div>
        )}
      </div>
    </div>
  );
}
