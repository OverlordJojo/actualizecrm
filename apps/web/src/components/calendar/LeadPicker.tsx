'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';

export interface PickedLead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  companyLocation: string | null;
  phone: string;
  email: string | null;
  pipelineRemovedAt: string | null;
  stage: { name: string } | null;
}

/// §2.3 — debounced 200ms, matching the responsiveness the spec asks for
/// without firing a query per keystroke.
const DEBOUNCE_MS = 200;

/**
 * Search box over every lead that still exists, including pipeline-removed
 * ones (§2.3).
 *
 * Removed leads are shown with a badge rather than hidden. Someone marked
 * not-interested in March is exactly who calls back in June wanting a meeting,
 * and not being able to find them to book it would be absurd.
 */
export function LeadPicker({
  selected,
  onSelect,
}: {
  selected: PickedLead | null;
  onSelect: (lead: PickedLead | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickedLead[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }

    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        // A slower earlier request must not overwrite a faster later one.
        if (mine === seq.current) {
          setResults(json);
          setOpen(true);
        }
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(t);
  }, [query]);

  if (selected) {
    const name =
      [selected.firstName, selected.lastName].filter(Boolean).join(' ') ||
      selected.companyName ||
      formatPhone(selected.phone);
    return (
      <div className="flex items-center gap-2 rounded-lg border border-brand-700 bg-brand-500/10 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-brand-200">{name}</p>
          <p className="truncate text-[11px] text-ink-400">
            {[selected.companyName, formatPhone(selected.phone), selected.email]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {!selected.email && (
            <p className="text-[11px] text-amber-300">
              No email on file — the booking will be created without an invite.
            </p>
          )}
        </div>
        <button
          className="shrink-0 text-xs text-ink-400 hover:text-ink-100"
          onClick={() => {
            onSelect(null);
            setQuery('');
            setResults([]);
          }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        className="input py-1.5 text-xs"
        placeholder="Search name, company, phone, email or location…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
      />

      {query.trim().length >= 2 && open && (
        <div className="scroll-thin absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 shadow-xl">
          {searching && results.length === 0 && (
            <p className="p-3 text-xs text-ink-500">Searching…</p>
          )}
          {!searching && results.length === 0 && (
            <p className="p-3 text-xs text-ink-500">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          )}
          {results.map((r) => {
            const name =
              [r.firstName, r.lastName].filter(Boolean).join(' ') ||
              r.companyName ||
              formatPhone(r.phone);
            return (
              <button
                key={r.id}
                onClick={() => {
                  onSelect(r);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-baseline gap-2 border-b border-ink-800 px-3 py-2 text-left last:border-0 hover:bg-ink-850',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-ink-100">{name}</span>
                  <span className="block truncate text-[11px] text-ink-500">
                    {[r.companyName, formatPhone(r.phone), r.companyLocation]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {r.pipelineRemovedAt ? (
                  <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-300">
                    removed
                  </span>
                ) : r.stage ? (
                  <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[9px] text-ink-400">
                    {r.stage.name}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
