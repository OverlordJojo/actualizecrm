'use client';

import { useRef } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';
import { dispositionLabel, DISPOSITION_BY_VALUE, type DispositionValue } from '@/lib/dispositions';
import { leadDisplayName, type BoardLead } from './types';

export function LeadCard({
  lead,
  isOnCall,
  isRinging,
  overlay,
  onOpen,
  selectable,
  selected,
  onSelect,
}: {
  lead: BoardLead;
  /// The lead currently on the phone keeps a persistent outline so it stays
  /// findable on a crowded board while the operator is talking.
  isOnCall?: boolean;
  /// Ringing in the open burst but not yet connected. Drawn more faintly and
  /// pulsing, so all three are visible at once and the one that answers is
  /// unmistakably different from the two that have not (§3.7).
  isRinging?: boolean;
  /// Rendered inside the drag overlay rather than in a column.
  overlay?: boolean;
  /// Opens the full detail view (§3.6).
  onOpen?: (leadId: string) => void;
  /// Bulk selection in the New column (§3.9).
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (leadId: string, selected: boolean) => void;
}) {
  /// Where the pointer went down, so a drag can be told from a click.
  const pressRef = useRef<{ x: number; y: number; at: number } | null>(null);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
    disabled: overlay,
  });

  const disposition = lead.lastDisposition
    ? DISPOSITION_BY_VALUE[lead.lastDisposition as DispositionValue]
    : undefined;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ transform: CSS.Translate.toString(transform) }}
      /**
       * Opens the lead only on a deliberate, stationary click.
       *
       * `isDragging` is false again by the time the click fires at the end of a
       * drag, so relying on it alone meant dropping a card also opened it —
       * which is why a contact kept appearing uninvited after moving one, and
       * after the board re-rendered under the cursor mid-session.
       *
       * Measuring the pointer's own movement is the only thing that actually
       * distinguishes the two gestures.
       */
      onPointerDown={(e) => {
        pressRef.current = { x: e.clientX, y: e.clientY, at: Date.now() };
        // **Hand the event on.** `{...listeners}` above supplies dnd-kit's own
        // onPointerDown, and declaring one after the spread replaces it rather
        // than adding to it — which is how dragging stopped working entirely.
        // The spread has to stay before this, so the delegation is explicit.
        listeners?.onPointerDown?.(e);
      }}
      onClick={(e) => {
        if (overlay || isDragging) return;
        const press = pressRef.current;
        pressRef.current = null;
        if (!press) return;

        const moved =
          Math.abs(e.clientX - press.x) > 4 || Math.abs(e.clientY - press.y) > 4;
        // A long hold is a drag the operator thought better of, not a click.
        const held = Date.now() - press.at > 400;
        if (moved || held) return;

        onOpen?.(lead.id);
      }}
      className={cn(
        'group relative cursor-grab select-none rounded-lg border bg-ink-900 px-2.5 py-2 active:cursor-grabbing',
        isOnCall
          ? 'border-brand-500 ring-2 ring-brand-500'
          : isRinging
            ? 'animate-pulse border-brand-700/70 ring-1 ring-brand-700/40'
            : 'border-ink-800 hover:border-ink-700',
        // The original stays in place but dimmed while the overlay follows the
        // cursor, so the operator can see where it came from.
        isDragging && !overlay && 'opacity-30',
        overlay && 'rotate-1 shadow-2xl shadow-black/50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-[13px] font-medium leading-tight text-ink-100">
          {leadDisplayName(lead)}
        </span>
        {lead.dealValue != null && (
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-brand-400">
            ${lead.dealValue.toLocaleString()}
          </span>
        )}
      </div>

      {lead.companyName && (
        <div className="mt-0.5 truncate text-[11px] text-ink-400">
          {lead.companyName}
        </div>
      )}

      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-ink-500">
          {formatPhone(lead.phone)}
        </span>
        {disposition && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              color: disposition.color,
              backgroundColor: `${disposition.color}1a`,
            }}
          >
            {dispositionLabel(lead.lastDisposition)}
          </span>
        )}
      </div>
    </div>
  );
}
