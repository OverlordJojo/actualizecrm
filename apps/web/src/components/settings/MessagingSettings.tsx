'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

interface A2pStatus {
  approved: boolean;
  state: 'approved' | 'pending' | 'missing' | 'unknown';
  reason: string;
  brand: { id?: string; status?: string } | null;
  campaign: { id?: string; status?: string } | null;
  hasMessagingProfile: boolean;
  checkedAt: string;
}

/**
 * Settings → Messaging & A2P.
 *
 * When blocked, this renders the specific missing step rather than a generic
 * "not configured" — "brand approved, campaign pending" and "no brand at all"
 * are completely different problems with completely different next actions,
 * and the operator is waiting on a 1–3 day process either way.
 */
export function MessagingSettings() {
  const [status, setStatus] = useState<A2pStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (live: boolean) => {
    setChecking(true);
    try {
      const res = await fetch('/api/messaging/status', {
        method: live ? 'POST' : 'GET',
      });
      if (res.ok) setStatus(await res.json());
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const steps = [
    {
      done: Boolean(status?.brand),
      title: 'Register a 10DLC brand',
      detail:
        'Telnyx portal → Messaging → 10DLC → Brands → Create Brand. Sole Proprietor is about $4 one-time and is enough for one operator. Use your legal details exactly as they appear on official records — a mismatched address is the most common rejection.',
      status: status?.brand?.status,
    },
    {
      done: Boolean(status?.campaign),
      title: 'Register a campaign',
      detail:
        'Messaging → 10DLC → Campaigns. This is the one with the monthly fee, typically $1.50–$10. You will be asked for sample messages and an opt-in description — answer truthfully; inventing a web form that does not exist gets the campaign revoked.',
      status: status?.campaign?.status,
    },
    {
      done: Boolean(status?.hasMessagingProfile),
      title: 'Attach a messaging profile',
      detail:
        'Create a messaging profile against the approved campaign, assign your numbers to it, and put its id in TELNYX_MESSAGING_PROFILE.',
    },
  ];

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">Messaging &amp; A2P</h2>
        <p className="text-xs text-ink-400">
          Texting stays switched off until carriers have approved your
          registration.
        </p>
      </div>

      <div
        className={cn(
          'panel p-3',
          status?.approved ? 'border-green-900' : 'border-amber-900',
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              status?.approved ? 'bg-green-500' : 'bg-amber-500',
            )}
          />
          <span className="text-xs font-medium text-ink-100">
            {status
              ? status.approved
                ? 'Texting is unlocked'
                : 'Texting is blocked'
              : 'Checking…'}
          </span>
          <button
            className="btn-ghost ml-auto py-1 text-xs"
            onClick={() => load(true)}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Re-check status'}
          </button>
        </div>

        {status && (
          <p className="mt-1.5 text-xs text-ink-400">{status.reason}</p>
        )}
        {status?.checkedAt && (
          <p className="mt-0.5 text-[10px] text-ink-600">
            Checked live against Telnyx at{' '}
            {new Date(status.checkedAt).toLocaleTimeString()}. This is never
            read from a cached flag.
          </p>
        )}
      </div>

      {status && !status.approved && (
        <div className="panel p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
            How to register
          </h3>
          <ol className="space-y-2.5">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-2.5">
                <span
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px]',
                    s.done
                      ? 'bg-green-500/20 text-green-300'
                      : 'bg-ink-800 text-ink-500',
                  )}
                >
                  {s.done ? '✓' : i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink-200">
                    {s.title}
                    {s.status && (
                      <span className="ml-1.5 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">
                        {s.status}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">
                    {s.detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-3 rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-[11px] leading-relaxed text-ink-400">
            Registration takes 1–3 business days. Everything else in the app
            works while you wait. Note that 10DLC approval is a{' '}
            <strong className="text-ink-200">carrier</strong> requirement, not
            legal consent — cold SMS to US mobiles without prior express consent
            is a TCPA problem whether or not you are registered.
          </p>
        </div>
      )}
    </section>
  );
}
