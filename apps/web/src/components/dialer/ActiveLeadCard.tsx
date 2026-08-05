'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { parseCustomFields } from '@/lib/json';
import type { BoardLead } from '@/components/pipeline/types';

export interface ActiveLead extends BoardLead {
  customFields?: string;
  email?: string | null;
  address?: string | null;
}

export interface VisibleCustomField {
  id: string;
  label: string;
}

type EditableField =
  | 'firstName'
  | 'lastName'
  | 'phone'
  | 'email'
  | 'companyName'
  | 'companyLocation'
  | 'address';

/// §3.1 — saves debounce at 500ms and write straight to Postgres.
const SAVE_DEBOUNCE_MS = 500;
/// Notes are typed continuously mid-call, so they get their own slightly
/// longer window; every keystroke otherwise queues a write.
const NOTES_DEBOUNCE_MS = 600;

/**
 * Region A — the Active Lead Card.
 *
 * Sized to be read mid-call from a lean-back posture, in the order an operator
 * actually needs it: who am I talking to, what company, where, then the number.
 *
 * Every field is an editable input rather than read-only text with an edit
 * mode (§3.1). Prospects correct their own details constantly — "it's actually
 * spelt Katharine", "that's the old address" — and the operator is typing with
 * one hand while talking. A mode switch is one interaction too many, and a
 * correction that does not get captured is a correction that never happened.
 */
export function ActiveLeadCard({
  lead,
  visibleCustomFields,
  onNotesChange,
  onFieldChange,
  bookingPanel,
  onRemove,
}: {
  lead: ActiveLead | null;
  visibleCustomFields: VisibleCustomField[];
  onNotesChange: (leadId: string, notes: string) => void;
  onFieldChange: (leadId: string, field: EditableField, value: string) => Promise<string | null>;
  /// The booking panel (§2.4) is supplied by the page so this component does
  /// not need to know about Google Calendar.
  bookingPanel?: React.ReactNode;
  /// Removes the lead from the pipeline (§3.3). Undoable for ten seconds.
  onRemove?: (lead: ActiveLead) => void;
}) {
  const [draft, setDraft] = useState<Partial<Record<EditableField, string>>>({});
  const [notes, setNotes] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const leadIdRef = useRef<string | null>(null);

  // Reset when the dialer advances. Carrying one lead's half-typed edits onto
  // the next would write them to the wrong prospect.
  useEffect(() => {
    if (lead?.id !== leadIdRef.current) {
      leadIdRef.current = lead?.id ?? null;
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
      setDraft({});
      setNotes('');
      setSaveState('idle');
      setFieldError(null);
    }
  }, [lead?.id]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const scheduleSave = useCallback(
    (field: EditableField, value: string, leadId: string) => {
      const existing = timers.current.get(field);
      if (existing) clearTimeout(existing);

      setSaveState('saving');
      timers.current.set(
        field,
        setTimeout(async () => {
          timers.current.delete(field);
          const error = await onFieldChange(leadId, field, value);
          if (error) {
            setFieldError(error);
            setSaveState('idle');
          } else {
            setFieldError(null);
            setSaveState('saved');
          }
        }, SAVE_DEBOUNCE_MS),
      );
    },
    [onFieldChange],
  );

  function edit(field: EditableField, value: string) {
    setDraft((d) => ({ ...d, [field]: value }));
    if (lead) scheduleSave(field, value, lead.id);
  }

  function handleNotes(value: string) {
    setNotes(value);
    if (!lead) return;
    setSaveState('saving');

    const existing = timers.current.get('notes');
    if (existing) clearTimeout(existing);
    const id = lead.id;
    timers.current.set(
      'notes',
      setTimeout(() => {
        timers.current.delete('notes');
        onNotesChange(id, value);
        setSaveState('saved');
      }, NOTES_DEBOUNCE_MS),
    );
  }

  if (!lead) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-ink-800 text-sm text-ink-600">
        No lead on deck — load a list or dial a number
      </div>
    );
  }

  const value = (field: EditableField, fallback: string | null | undefined) =>
    draft[field] !== undefined ? draft[field]! : (fallback ?? '');

  const custom = parseCustomFields(lead.customFields);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Name — the largest thing on screen, and still an input. */}
      <div className="flex items-baseline gap-2">
        <input
          value={value('firstName', lead.firstName)}
          onChange={(e) => edit('firstName', e.target.value)}
          placeholder="First"
          className="min-w-0 flex-1 truncate border-none bg-transparent p-0 text-lead-name font-semibold text-ink-100 placeholder:text-ink-700 focus:outline-none"
        />
        <input
          value={value('lastName', lead.lastName)}
          onChange={(e) => edit('lastName', e.target.value)}
          placeholder="Last"
          className="min-w-0 flex-1 truncate border-none bg-transparent p-0 text-lead-name font-semibold text-ink-100 placeholder:text-ink-700 focus:outline-none"
        />
        <span
          className={cn(
            'shrink-0 text-[10px]',
            saveState === 'saving' ? 'text-ink-500' : 'text-ink-600',
          )}
        >
          {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved' : ''}
        </span>

        {/* Removing the lead in front of you should not require finding it on
            the board and dragging it — mid-call, that is a gesture nobody has a
            spare hand for. Undoable for ten seconds either way (§3.3). */}
        {onRemove && (
          <button
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-500 transition-colors hover:bg-red-950/60 hover:text-red-300"
            onClick={() => onRemove(lead)}
            title="Remove this lead from the pipeline — history is kept and it stays searchable"
          >
            Remove
          </button>
        )}
      </div>

      {fieldError && (
        <p className="mt-1 text-xs text-red-300">{fieldError}</p>
      )}

      <div className="mt-1 grid grid-cols-2 gap-x-4">
        <input
          value={value('companyName', lead.companyName)}
          onChange={(e) => edit('companyName', e.target.value)}
          placeholder="Company"
          className="min-w-0 truncate border-none bg-transparent p-0 text-lead-sub text-ink-300 placeholder:text-ink-700 focus:outline-none"
        />
        <input
          value={value('companyLocation', lead.companyLocation)}
          onChange={(e) => edit('companyLocation', e.target.value)}
          placeholder="Location"
          className="min-w-0 truncate border-none bg-transparent p-0 text-lead-sub text-ink-400 placeholder:text-ink-700 focus:outline-none"
        />
      </div>

      <input
        value={value('phone', lead.phone)}
        onChange={(e) => edit('phone', e.target.value)}
        placeholder="Phone"
        className="mt-1.5 min-w-0 border-none bg-transparent p-0 font-mono text-lead-phone text-brand-400 placeholder:text-ink-700 focus:outline-none"
      />

      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
        <label className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-[11px] text-ink-500">Email</span>
          <input
            value={value('email', lead.email)}
            onChange={(e) => edit('email', e.target.value)}
            placeholder="—"
            className="min-w-0 flex-1 truncate border-none bg-transparent p-0 text-sm text-ink-200 placeholder:text-ink-700 focus:outline-none"
          />
        </label>
        <label className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-[11px] text-ink-500">Address</span>
          <input
            value={value('address', lead.address)}
            onChange={(e) => edit('address', e.target.value)}
            placeholder="—"
            className="min-w-0 flex-1 truncate border-none bg-transparent p-0 text-sm text-ink-200 placeholder:text-ink-700 focus:outline-none"
          />
        </label>
      </div>

      {visibleCustomFields.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          {visibleCustomFields.map((f) => {
            const v = custom[f.id];
            if (!v) return null;
            return (
              <span key={f.id} className="text-sm">
                <span className="text-ink-500">{f.label}: </span>
                <span className="text-ink-200">{v}</span>
              </span>
            );
          })}
        </div>
      )}

      {bookingPanel}

      <div className="relative mt-2 flex min-h-0 flex-1 flex-col">
        <textarea
          value={notes}
          onChange={(e) => handleNotes(e.target.value)}
          placeholder="Notes — saved as you type"
          className="scroll-thin min-h-0 flex-1 resize-none rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600 focus:border-brand-500 focus:outline-none"
        />
      </div>
    </div>
  );
}
