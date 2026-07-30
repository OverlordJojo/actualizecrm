'use client';

import { useEffect, useRef, useState } from 'react';
import { formatPhone } from '@/lib/phone';
import { parseCustomFields } from '@/lib/json';
import type { BoardLead } from '@/components/pipeline/types';

export interface ActiveLead extends BoardLead {
  customFields?: string;
}

export interface VisibleCustomField {
  id: string;
  label: string;
}

/**
 * Region A. Sized to be read mid-call from a lean-back posture, in the order
 * an operator actually needs it: who am I talking to, what company, where,
 * then the number.
 */
export function ActiveLeadCard({
  lead,
  visibleCustomFields,
  onNotesChange,
}: {
  lead: ActiveLead | null;
  visibleCustomFields: VisibleCustomField[];
  onNotesChange: (leadId: string, notes: string) => void;
}) {
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leadIdRef = useRef<string | null>(null);

  // Reset the box when the dialer advances, and never carry one lead's notes
  // onto the next.
  useEffect(() => {
    if (lead?.id !== leadIdRef.current) {
      leadIdRef.current = lead?.id ?? null;
      setNotes('');
      setSaved(true);
    }
  }, [lead?.id]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function handleNotes(value: string) {
    setNotes(value);
    setSaved(false);
    if (!lead) return;

    // Autosave on keystroke, debounced — the operator is typing while talking
    // and must never have to think about saving.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const id = lead.id;
    saveTimer.current = setTimeout(() => {
      onNotesChange(id, value);
      setSaved(true);
    }, 600);
  }

  if (!lead) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-ink-800 text-sm text-ink-600">
        No lead on deck — load a list or dial a number
      </div>
    );
  }

  const custom = parseCustomFields(lead.customFields);
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="min-w-0">
        <h2 className="truncate text-lead-name font-semibold text-ink-100">
          {name || lead.companyName || 'Unknown'}
        </h2>

        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          {lead.companyName && name && (
            <span className="truncate text-lead-sub text-ink-300">
              {lead.companyName}
            </span>
          )}
          {lead.companyLocation && (
            <span className="truncate text-lead-sub text-ink-400">
              {lead.companyLocation}
            </span>
          )}
        </div>

        <div className="mt-1.5 font-mono text-lead-phone text-brand-400">
          {formatPhone(lead.phone)}
        </div>

        {visibleCustomFields.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {visibleCustomFields.map((f) => {
              const value = custom[f.id];
              if (!value) return null;
              return (
                <span key={f.id} className="text-sm">
                  <span className="text-ink-500">{f.label}: </span>
                  <span className="text-ink-200">{value}</span>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="relative mt-2 flex min-h-0 flex-1 flex-col">
        <textarea
          value={notes}
          onChange={(e) => handleNotes(e.target.value)}
          placeholder="Notes — saved as you type"
          className="scroll-thin min-h-0 flex-1 resize-none rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600 focus:border-brand-500 focus:outline-none"
        />
        <span className="pointer-events-none absolute bottom-1.5 right-2.5 text-[10px] text-ink-600">
          {saved ? 'saved' : 'saving…'}
        </span>
      </div>
    </div>
  );
}
