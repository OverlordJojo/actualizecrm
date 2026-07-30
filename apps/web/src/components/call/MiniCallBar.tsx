'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';
import { useCall, formatCallTimer } from './CallProvider';
import { leadDisplayName } from '@/components/pipeline/types';

/**
 * Persistent call bar (§3.3).
 *
 * Pinned above every page whenever a call is live, so navigating away from the
 * Dialer never means losing sight of — or control over — the call in progress.
 * Hidden on the Dialer itself, where Region B already provides these controls
 * and a second copy would just be noise.
 */
export function MiniCallBar() {
  const call = useCall();
  const pathname = usePathname();

  const live = ['dialing', 'ringing', 'connected', 'ending'].includes(
    call.lineState,
  );
  if (!live) return null;
  if (pathname.startsWith('/dialer')) return null;

  const lead = call.activeLead;
  const connected = call.lineState === 'connected';

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-brand-700/50 bg-brand-500/10 px-4">
      <span
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          connected ? 'bg-green-400' : 'bg-brand-400 animate-pulse',
        )}
      />

      <span className="text-xs font-medium text-ink-100">
        {connected ? 'On a call' : call.lineState === 'ringing' ? 'Ringing' : 'Dialing'}
      </span>

      {lead && (
        <>
          <span className="truncate text-xs text-ink-200">
            {leadDisplayName(lead)}
          </span>
          {lead.companyName && (
            <span className="truncate text-xs text-ink-400">
              {lead.companyName}
            </span>
          )}
          <span className="shrink-0 font-mono text-xs text-ink-400">
            {formatPhone(lead.phone)}
          </span>
        </>
      )}

      {connected && (
        <span className="shrink-0 font-mono text-sm tabular-nums text-brand-300">
          {formatCallTimer(call.callSeconds)}
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          className="btn-ghost py-1 text-xs"
          onClick={call.toggleMute}
          disabled={!connected}
        >
          {call.muted ? 'Unmute' : 'Mute'}
        </button>
        <button className="btn-danger py-1 text-xs" onClick={call.hangup}>
          Hang up
        </button>
        <Link href="/dialer" className="btn-ghost py-1 text-xs">
          Back to dialer
        </Link>
      </div>
    </div>
  );
}
