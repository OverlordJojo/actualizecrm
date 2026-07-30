'use client';

import { useEffect, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/cn';
import { LeadCard } from './LeadCard';
import { UNASSIGNED, type BoardLead } from './types';

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
    <div className="flex h-full w-[236px] shrink-0 flex-col">
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
        {leads.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            isOnCall={lead.id === onCallLeadId}
          />
        ))}

        {leads.length === 0 && (
          <div className="flex h-16 items-center justify-center text-[11px] text-ink-600">
            {id === UNASSIGNED ? 'No unassigned leads' : 'Drop leads here'}
          </div>
        )}
      </div>
    </div>
  );
}
