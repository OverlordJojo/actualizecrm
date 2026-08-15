'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

interface Governor {
  rate: number;
  abandoned: number;
  humanAnswers: number;
  allowedLines: number;
  configuredLines: number;
  blocked: boolean;
  warning: string | null;
  windowDays: number;
  maxLines: number;
}

/**
 * Settings → Dialer, including multi-line (§4).
 *
 * The copy here is deliberately not marketing. Multi-line dialing does **not**
 * reduce spam labelling — it increases it, because carrier analytics flag high
 * call volume per number and short-duration calls. Saying otherwise in the UI
 * would be selling the operator a reason to hurt their own connect rate.
 */
export function DialerSettings() {
  const [gap, setGap] = useState('2');
  const [rate, setRate] = useState('0.005');
  const [hold, setHold] = useState('25');
  const [ring, setRing] = useState('30');
  const [enforceCap, setEnforceCap] = useState(false);
  const [gov, setGov] = useState<Governor | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const loadGovernor = useCallback(async () => {
    const res = await fetch('/api/dialer/abandonment');
    if (res.ok) setGov(await res.json());
  }, []);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => {
        setGap(s['dialer.gapDelaySeconds'] ?? '2');
        setRate(s['analytics.ratePerMinute'] ?? '0.005');
        setHold(s['dialer.holdMaxSeconds'] ?? '25');
        setRing(s['dialer.maxRingSeconds'] ?? '30');
        setEnforceCap(s['dialer.enforceAbandonmentCap'] === 'true');
      })
      .catch(() => {});
    loadGovernor();
  }, [loadGovernor]);

  async function save(patch: Record<string, string>, label: string) {
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    setSaved(label);
    setTimeout(() => setSaved(null), 2000);
  }

  async function setLines(n: number) {
    await fetch('/api/dialer/abandonment', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linesPerBurst: n }),
    });
    loadGovernor();
  }

  const pct = gov ? (gov.rate * 100).toFixed(2) : '—';

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">Dialer</h2>
        <p className="text-xs text-ink-400">
          Pacing, cost assumptions, and how many lines a burst opens.
        </p>
      </div>

      {saved && (
        <div className="rounded-lg border border-green-900 bg-green-950/50 px-3 py-2 text-xs text-green-200">
          {saved} saved.
        </div>
      )}

      <div className="panel space-y-3 p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 accent-brand-500"
            checked={enforceCap}
            onChange={(e) => {
              setEnforceCap(e.target.checked);
              save(
                { 'dialer.enforceAbandonmentCap': String(e.target.checked) },
                'Abandonment enforcement',
              );
            }}
          />
          <span className="text-xs text-ink-400">
            <span className="font-medium text-ink-200">
              Let the dialer clamp lines on abandonment
            </span>
            <br />
            US telemarketing rules cap abandoned calls at 3% of live answers.
            The rate is measured and shown either way — this decides whether the
            dialer acts on it by dropping to a single line, or leaves that to
            you. Off by default, and it will not act below 50 answered calls
            because a percentage over a smaller sample is arithmetic rather than
            a rate.
          </span>
        </label>

        <div className="flex items-center gap-3">
          <div>
            <label className="label">Ring for</label>
            <input
              type="number"
              min={10}
              max={90}
              className="input w-24 py-1.5 text-xs"
              value={ring}
              onChange={(e) => setRing(e.target.value)}
              onBlur={() => save({ 'dialer.maxRingSeconds': ring }, 'Ring limit')}
            />
          </div>
          <span className="mt-4 text-xs text-ink-500">
            Seconds a prospect&rsquo;s phone rings before the dialer gives up.
            Past about 25 the call is going to voicemail anyway, and the line
            could be ringing somebody else. Too short and you hang up on people
            who were walking to the phone.
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div>
            <label className="label">Gap between calls</label>
            <input
              type="number"
              min={0}
              max={30}
              className="input w-24 py-1.5 text-xs"
              value={gap}
              onChange={(e) => setGap(e.target.value)}
              onBlur={() => save({ 'dialer.gapDelaySeconds': gap }, 'Gap delay')}
            />
          </div>
          <span className="mt-4 text-xs text-ink-500">
            Seconds of breathing room after a hangup before the next lead is
            dialed. Setting a disposition during the gap does not shorten it —
            being yanked into the next call mid-thought is worse than waiting.
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div>
            <label className="label">Cost per minute</label>
            <input
              type="number"
              step="0.001"
              min={0}
              className="input w-24 py-1.5 text-xs"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              onBlur={() => save({ 'analytics.ratePerMinute': rate }, 'Rate')}
            />
          </div>
          <span className="mt-4 text-xs text-ink-500">
            Used for the cost metrics on Analytics. Telnyx US outbound is about
            $0.005/min, billed per second.
          </span>
        </div>
      </div>

      {/* --- multi-line --- */}
      <div className="panel p-3">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Multi-line bursts
        </h3>

        <div className="mb-3 rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-[11px] leading-relaxed text-ink-400">
          <p>
            <strong className="text-ink-200">This is not spam protection.</strong>{' '}
            More lines makes labelling <em>more</em> likely, not less — carrier
            analytics flag high call volume per number and short-duration calls.
            What actually helps is number rotation with area-code matching and
            retiring numbers on a schedule, which the dialer already does.
          </p>
          <p className="mt-1.5">
            What it does buy you is throughput, at the cost of abandoned calls
            when more people answer than you can talk to. US rules cap
            abandonment at 3% of live answers over 30 days.
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-ink-400">Lines per burst</span>
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              onClick={() => setLines(n)}
              className={cn(
                'h-7 w-9 rounded-lg border text-xs transition-colors',
                gov?.configuredLines === n
                  ? 'border-brand-500 bg-brand-500/15 text-brand-200'
                  : 'border-ink-700 bg-ink-850 text-ink-300 hover:bg-ink-800',
              )}
            >
              {n}
            </button>
          ))}
          <span className="ml-2 text-[11px] text-ink-500">
            Hard cap 3. Not raisable.
          </span>
        </div>

        {gov && (
          <div
            className={cn(
              'mt-3 rounded-lg border px-3 py-2',
              gov.blocked
                ? 'border-red-800 bg-red-950/40'
                : gov.warning
                  ? 'border-amber-800 bg-amber-950/40'
                  : 'border-ink-800 bg-ink-950',
            )}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-ink-300">
                Abandonment, last {gov.windowDays} days:
              </span>
              <span
                className={cn(
                  'text-sm font-semibold tabular-nums',
                  gov.blocked
                    ? 'text-red-300'
                    : gov.warning
                      ? 'text-amber-300'
                      : 'text-green-400',
                )}
              >
                {pct}%
              </span>
              <span className="text-[11px] text-ink-500">
                {gov.abandoned} abandoned of {gov.humanAnswers} human answers
              </span>
              <a
                className="ml-auto text-[11px] text-brand-400 hover:underline"
                href="/api/dialer/abandonment?export=csv"
              >
                Export log
              </a>
            </div>
            {gov.warning && (
              <p className="mt-1 text-[11px] text-ink-300">{gov.warning}</p>
            )}
            <p className="mt-1 text-[10px] text-ink-600">
              Warns and reduces the burst at 2%; hard-blocks multi-line at 3%.
              There is no override.
            </p>
          </div>
        )}

        <div className="mt-3 flex items-center gap-3">
          <div>
            <label className="label">Max hold seconds</label>
            <input
              type="number"
              min={10}
              max={45}
              className="input w-24 py-1.5 text-xs"
              value={hold}
              onChange={(e) => setHold(e.target.value)}
              onBlur={() => save({ 'dialer.holdMaxSeconds': hold }, 'Hold limit')}
            />
          </div>
          <span className="mt-4 text-xs text-ink-500">
            How long a second or third answerer waits before the call is given
            up as abandoned. 10–45; silence makes people hang up within seconds,
            so they hear a short identification prompt and hold audio, not
            nothing.
          </span>
        </div>
      </div>
    </section>
  );
}
