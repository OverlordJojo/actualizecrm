'use client';

import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';
import type { ActiveLead } from './ActiveLeadCard';

/**
 * The burst in flight (§3.7).
 *
 * While legs are ringing the operator sees every one of them side by side, not
 * just the first. The old dialer showed `upcoming[0]` and nothing else, so a
 * three-line burst looked identical to a single-line one — which is most of why
 * multi-line appeared not to work even before the origination failure was found.
 *
 * The instant one bridges, this is replaced by that lead's full Active Lead
 * Card. Legs that resolved without reaching the operator linger briefly with
 * their outcome visible, so the operator can see what happened to the others
 * rather than watching two cards vanish unexplained.
 */

const RESOLUTION_LABEL: Record<string, string> = {
  voicemail: 'Voicemail',
  automated_system: 'Automated system',
  abandoned: 'Given up — waited too long',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Call failed',
};

export interface ResolvedLeg {
  callId: string;
  contactId: string;
  disposition: string | null;
  status: string;
}

export function BurstCards({
  ringing,
  resolved,
  held,
}: {
  ringing: ActiveLead[];
  resolved: ResolvedLeg[];
  held: { callId: string; contactId: string; toE164: string; heldSeconds: number }[];
}) {
  if (ringing.length === 0 && resolved.length === 0) return null;

  const heldIds = new Set(held.map((h) => h.contactId));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
        <p className="text-xs font-medium text-ink-200">
          {ringing.length > 0
            ? `Ringing ${ringing.length} ${ringing.length === 1 ? 'line' : 'lines'}`
            : 'Burst finished'}
        </p>
      </div>

      <div
        className={cn(
          'grid gap-2',
          ringing.length >= 3 ? 'grid-cols-3' : ringing.length === 2 ? 'grid-cols-2' : 'grid-cols-1',
        )}
      >
        {ringing.map((lead) => (
          <div
            key={lead.id}
            className={cn(
              'rounded-lg border px-3 py-2.5',
              heldIds.has(lead.id)
                ? 'border-amber-800 bg-amber-950/30'
                : 'border-ink-700 bg-ink-900/60',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="truncate text-sm font-semibold text-ink-100">
                {[lead.firstName, lead.lastName].filter(Boolean).join(' ') ||
                  formatPhone(lead.phone)}
              </p>
              <span
                className={cn(
                  'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                  heldIds.has(lead.id) ? 'bg-amber-400' : 'animate-pulse bg-brand-500',
                )}
              />
            </div>

            {lead.jobTitle && (
              <p className="truncate text-[11px] text-ink-300">{lead.jobTitle}</p>
            )}
            {lead.companyName && (
              <p className="truncate text-[11px] text-ink-400">{lead.companyName}</p>
            )}
            {lead.companyLocation && (
              <p className="truncate text-[10px] text-ink-500">{lead.companyLocation}</p>
            )}
            <p className="mt-1 font-mono text-[10px] text-ink-500">
              {formatPhone(lead.phone)}
            </p>

            {heldIds.has(lead.id) && (
              <p className="mt-1 text-[10px] font-medium text-amber-300">
                Answered — holding
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Why the other legs went away. A card that simply disappears reads as a
          bug; a card that says "Voicemail" reads as the system working. */}
      {resolved.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {resolved.slice(0, 4).map((r) => (
            <li
              key={r.callId}
              className="rounded-md bg-ink-850 px-2 py-0.5 text-[10px] text-ink-400"
            >
              {RESOLUTION_LABEL[r.disposition ?? r.status] ?? r.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
