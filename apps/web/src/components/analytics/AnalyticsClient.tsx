'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';
import {
  addOperatorDays,
  operatorDateKey,
  operatorZoneLabel,
  startOfOperatorDay,
  startOfOperatorMonth,
  startOfOperatorWeek,
} from '@/lib/operator-time';

interface Totals {
  dials: number;
  connects: number;
  voicemails: number;
  ownerConnects: number;
  nonOwnerConnects: number;
  overOneMinute: number;
  interested: number;
  booked: number;
  abandoned: number;
  talkTimeSec: number;
  billedSec: number;
  telephonyCost: number;
}

interface Payload {
  range: { from: string; to: string; days: number };
  previousRange: { from: string; to: string };
  current: Totals;
  previous: Totals;
  dialsByHour: Record<string, number>;
  numbers: {
    id: string;
    e164: string;
    active: boolean;
    daysInService: number;
    dials: number;
    connects: number;
  }[];
  aiAcceptRate: Record<string, { accepted: number; dismissed: number; pending: number }>;
}

type Preset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'last_7'
  | 'last_4_weeks'
  | 'this_month'
  | 'last_month'
  | 'custom';

const PRESETS: [Preset, string][] = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['this_week', 'This Week'],
  ['last_week', 'Last Week'],
  ['last_7', 'Last 7 Days'],
  ['last_4_weeks', 'Last 4 Weeks'],
  ['this_month', 'This Month'],
  ['last_month', 'Last Month'],
];

/// All boundaries computed in the operator's zone, never UTC and never the
/// browser's (§7.1).
function rangeFor(preset: Preset): { from: Date; to: Date } {
  const now = new Date();
  const today = startOfOperatorDay(now);

  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addOperatorDays(today, -1);
      return { from: y, to: y };
    }
    case 'this_week':
      return { from: startOfOperatorWeek(now), to: today };
    case 'last_week': {
      const thisWeek = startOfOperatorWeek(now);
      return { from: addOperatorDays(thisWeek, -7), to: addOperatorDays(thisWeek, -1) };
    }
    case 'last_7':
      return { from: addOperatorDays(today, -6), to: today };
    case 'last_4_weeks':
      return { from: addOperatorDays(today, -27), to: today };
    case 'this_month':
      return { from: startOfOperatorMonth(now), to: today };
    case 'last_month': {
      const thisMonth = startOfOperatorMonth(now);
      return {
        from: startOfOperatorMonth(addOperatorDays(thisMonth, -1)),
        to: addOperatorDays(thisMonth, -1),
      };
    }
    default:
      return { from: today, to: today };
  }
}

export function AnalyticsClient() {
  const [preset, setPreset] = useState<Preset>('last_7');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const range = useMemo(() => {
    if (preset === 'custom' && customFrom && customTo) {
      return { from: new Date(customFrom), to: new Date(customTo) };
    }
    return rangeFor(preset === 'custom' ? 'today' : preset);
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({
        from: operatorDateKey(range.from),
        to: operatorDateKey(range.to),
      });
      const res = await fetch(`/api/analytics?${q}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  const label =
    preset === 'custom' && customFrom && customTo
      ? `${customFrom} → ${customTo}`
      : (PRESETS.find(([p]) => p === preset)?.[1] ?? 'Custom');

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle={`${label} · boundaries in ${operatorZoneLabel()} · compared with the period immediately before`}
      >
        <div className="relative">
          <button
            className="btn-ghost py-1.5 text-xs"
            onClick={() => setPickerOpen((o) => !o)}
          >
            <CalendarGlyph /> {label}
          </button>
          {pickerOpen && (
            <div className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-ink-700 bg-ink-900 p-2 shadow-xl">
              <div className="grid grid-cols-2 gap-1">
                {PRESETS.map(([p, l]) => (
                  <button
                    key={p}
                    onClick={() => {
                      setPreset(p);
                      setPickerOpen(false);
                    }}
                    className={cn(
                      'rounded px-2 py-1 text-left text-[11px] transition-colors',
                      preset === p
                        ? 'bg-brand-500/15 text-brand-300'
                        : 'text-ink-300 hover:bg-ink-850',
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <div className="mt-2 border-t border-ink-800 pt-2">
                <p className="mb-1 text-[10px] uppercase tracking-wide text-ink-500">
                  Custom range
                </p>
                <div className="flex items-center gap-1">
                  <input
                    type="date"
                    className="input py-1 text-[11px]"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                  <input
                    type="date"
                    className="input py-1 text-[11px]"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </div>
                <button
                  className="btn-primary mt-1.5 w-full py-1 text-[11px]"
                  disabled={!customFrom || !customTo}
                  onClick={() => {
                    setPreset('custom');
                    setPickerOpen(false);
                  }}
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>
      </PageHeader>

      <div className="scroll-thin flex-1 overflow-y-auto p-5">
        {loading && !data ? (
          <p className="text-sm text-ink-500">Loading…</p>
        ) : !data ? (
          <p className="text-sm text-ink-500">No data.</p>
        ) : (
          <Body data={data} />
        )}
      </div>
    </>
  );
}

function Body({ data }: { data: Payload }) {
  const c = data.current;
  const p = data.previous;

  const rate = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);

  const ownerConnectRate = rate(c.ownerConnects, c.dials);
  const prevOwnerConnectRate = rate(p.ownerConnects, p.dials);

  const metrics: {
    label: string;
    value: string;
    delta: React.ReactNode;
    tip?: string;
  }[] = [
    {
      label: 'Dials',
      value: c.dials.toLocaleString(),
      delta: <CountDelta now={c.dials} before={p.dials} />,
    },
    {
      label: 'Connect Rate',
      value: fmtRate(rate(c.connects, c.dials)),
      delta: <PointDelta now={rate(c.connects, c.dials)} before={rate(p.connects, p.dials)} />,
    },
    {
      label: 'Voicemail Rate',
      value: fmtRate(rate(c.voicemails, c.dials)),
      delta: <PointDelta now={rate(c.voicemails, c.dials)} before={rate(p.voicemails, p.dials)} />,
    },
    {
      label: 'Non-Owner Rate',
      value: fmtRate(rate(c.nonOwnerConnects, c.dials)),
      delta: (
        <PointDelta
          now={rate(c.nonOwnerConnects, c.dials)}
          before={rate(p.nonOwnerConnects, p.dials)}
        />
      ),
    },
    {
      label: 'Over 1 Minute',
      value: fmtRate(rate(c.overOneMinute, c.dials)),
      delta: <PointDelta now={rate(c.overOneMinute, c.dials)} before={rate(p.overOneMinute, p.dials)} />,
    },
    {
      label: 'Interested Rate',
      value: fmtRate(rate(c.interested, c.dials)),
      delta: <PointDelta now={rate(c.interested, c.dials)} before={rate(p.interested, p.dials)} />,
      tip: 'Interested is a superset of Booked — every booking is counted in both, so these do not add up to 100% and are not meant to.',
    },
    {
      label: 'Booked Rate',
      value: fmtRate(rate(c.booked, c.dials)),
      delta: <PointDelta now={rate(c.booked, c.dials)} before={rate(p.booked, p.dials)} />,
      tip: 'Every booking also counts as Interested.',
    },
    {
      label: 'Total Talk Time',
      value: fmtDuration(c.talkTimeSec),
      delta: <CountDelta now={c.talkTimeSec} before={p.talkTimeSec} />,
    },
    {
      label: 'Telephony Cost',
      value: `$${c.telephonyCost.toFixed(2)}`,
      delta: <CountDelta now={c.telephonyCost} before={p.telephonyCost} invert />,
    },
    {
      label: 'Cost Per Booking',
      value: c.booked > 0 ? `$${(c.telephonyCost / c.booked).toFixed(2)}` : '—',
      delta:
        c.booked > 0 && p.booked > 0 ? (
          <CountDelta
            now={c.telephonyCost / c.booked}
            before={p.telephonyCost / p.booked}
            invert
          />
        ) : (
          <span className="text-[10px] text-ink-600">—</span>
        ),
    },
  ];

  const acceptTotals = Object.values(data.aiAcceptRate).reduce(
    (a, v) => ({ accepted: a.accepted + v.accepted, decided: a.decided + v.accepted + v.dismissed }),
    { accepted: 0, decided: 0 },
  );

  return (
    <div className="max-w-6xl space-y-6">
      {/* --- headline --- */}
      <div className="panel p-5">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] uppercase tracking-wide text-ink-400">
            Owner Connect Rate
          </span>
          <span className="text-[10px] text-ink-600">
            the one that matters — a human decision-maker actually spoken to
          </span>
        </div>
        <div className="mt-1 flex items-baseline gap-4">
          <span className="text-[56px] font-semibold leading-none tabular-nums text-ink-100">
            {fmtRate(ownerConnectRate)}
          </span>
          <PointDelta now={ownerConnectRate} before={prevOwnerConnectRate} large />
          <span className="ml-auto text-xs text-ink-500">
            {c.ownerConnects.toLocaleString()} owner connects from{' '}
            {c.dials.toLocaleString()} dials
          </span>
        </div>
      </div>

      {/* --- metric grid --- */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {metrics.map((m) => (
          <div key={m.label} className="panel p-3" title={m.tip}>
            <div className="text-[10px] uppercase tracking-wide text-ink-500">
              {m.label}
              {m.tip && <span className="ml-1 text-ink-600">ⓘ</span>}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-100">
              {m.value}
            </div>
            <div className="mt-0.5">{m.delta}</div>
          </div>
        ))}
      </div>

      {/* --- funnel --- */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-100">Funnel</h2>
        <div className="panel space-y-1.5 p-4">
          {(
            [
              ['Dials', c.dials],
              ['Connects', c.connects],
              ['Owner Connects', c.ownerConnects],
              ['Interested', c.interested],
              ['Booked', c.booked],
            ] as [string, number][]
          ).map(([label, value]) => (
            <div key={label} className="flex items-center gap-3">
              <span className="w-32 shrink-0 text-xs text-ink-400">{label}</span>
              <div className="h-6 flex-1 overflow-hidden rounded bg-ink-950">
                <div
                  className="h-full rounded bg-brand-500/70"
                  style={{ width: c.dials > 0 ? `${(value / c.dials) * 100}%` : '0%' }}
                />
              </div>
              <span className="w-20 shrink-0 text-right text-xs tabular-nums text-ink-200">
                {value.toLocaleString()}
              </span>
              <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-ink-500">
                {c.dials > 0 ? `${((value / c.dials) * 100).toFixed(1)}%` : '—'}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* --- heatmap --- */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-100">Dials by hour</h2>
        <div className="panel p-4">
          <Heatmap dialsByHour={data.dialsByHour} />
        </div>
      </section>

      {/* --- per number --- */}
      <section>
        <h2 className="mb-1 text-sm font-semibold text-ink-100">Per number</h2>
        <p className="mb-2 text-xs text-ink-500">
          A number whose connect rate has collapsed relative to the others is
          usually being spam-labelled, not unlucky.
        </p>
        <div className="panel overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-ink-800 text-ink-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Number</th>
                <th className="px-3 py-2 text-right font-medium">Dials</th>
                <th className="px-3 py-2 text-right font-medium">Connects</th>
                <th className="px-3 py-2 text-right font-medium">Connect rate</th>
                <th className="px-3 py-2 text-right font-medium">Days in service</th>
              </tr>
            </thead>
            <tbody>
              {data.numbers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-3 text-center text-ink-500">
                    No numbers yet.
                  </td>
                </tr>
              )}
              {data.numbers.map((n) => {
                const r = n.dials > 0 ? (n.connects / n.dials) * 100 : null;
                return (
                  <tr key={n.id} className="border-b border-ink-850 last:border-0">
                    <td className="px-3 py-2 font-mono text-ink-100">
                      {formatPhone(n.e164)}
                      {!n.active && (
                        <span className="ml-1.5 text-[10px] text-ink-600">released</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-200">
                      {n.dials.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-200">
                      {n.connects.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-200">
                      {fmtRate(r)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-400">
                      {n.daysInService}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* --- AI accept rate --- */}
      <section>
        <h2 className="mb-1 text-sm font-semibold text-ink-100">
          AI suggestion accept rate
        </h2>
        <p className="mb-2 text-xs text-ink-500">
          Measured, not assumed. Overall{' '}
          {acceptTotals.decided > 0
            ? `${((acceptTotals.accepted / acceptTotals.decided) * 100).toFixed(0)}% of ${acceptTotals.decided} decided`
            : 'nothing decided yet'}
          .
        </p>
        <div className="panel p-4">
          {Object.keys(data.aiAcceptRate).length === 0 ? (
            <p className="text-xs text-ink-500">
              No suggestions in this period.
            </p>
          ) : (
            <div className="space-y-1.5">
              {Object.entries(data.aiAcceptRate).map(([field, v]) => {
                const decided = v.accepted + v.dismissed;
                const pct = decided > 0 ? (v.accepted / decided) * 100 : null;
                return (
                  <div key={field} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-xs text-ink-400">
                      {field.replace(/_/g, ' ')}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-ink-950">
                      <div
                        className="h-full rounded bg-violet-500/60"
                        style={{ width: pct === null ? '0%' : `${pct}%` }}
                      />
                    </div>
                    <span className="w-28 shrink-0 text-right text-[10px] tabular-nums text-ink-500">
                      {fmtRate(pct)} of {decided}
                      {v.pending > 0 ? ` · ${v.pending} open` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Heatmap({ dialsByHour }: { dialsByHour: Record<string, number> }) {
  const max = Math.max(1, ...Object.values(dialsByHour));
  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <div className="flex gap-1">
      {hours.map((h) => {
        const n = dialsByHour[String(h)] ?? 0;
        return (
          <div key={h} className="flex flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded"
              style={{
                height: 56,
                backgroundColor:
                  n === 0 ? 'rgb(22 26 38)' : `rgba(217, 188, 113, ${0.15 + (n / max) * 0.85})`,
              }}
              title={`${n} dials at ${h}:00`}
            />
            <span className="text-[9px] tabular-nums text-ink-600">{h}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Percentage-**point** change for a rate (§7.2).
 *
 * A connect rate moving 10% → 12% is +2.0 pts, not +20%. Showing the
 * percent-of-percent makes small absolute changes look enormous and is the
 * single easiest way to talk yourself into a conclusion the data does not
 * support.
 */
function PointDelta({
  now,
  before,
  large,
}: {
  now: number | null;
  before: number | null;
  large?: boolean;
}) {
  if (now === null || before === null) {
    return (
      <span
        className={cn('text-ink-600', large ? 'text-sm' : 'text-[10px]')}
        title="No dials in the comparison period, so there is nothing to compare against."
      >
        —
      </span>
    );
  }
  const diff = now - before;
  const sign = diff > 0 ? '+' : '';
  return (
    <span
      className={cn(
        'tabular-nums',
        large ? 'text-sm' : 'text-[10px]',
        diff > 0 ? 'text-green-400' : diff < 0 ? 'text-red-400' : 'text-ink-500',
      )}
    >
      {sign}
      {diff.toFixed(1)} pts
    </span>
  );
}

/// Signed percentage change for a count. `invert` marks metrics where down is
/// good — cost, mainly.
function CountDelta({
  now,
  before,
  invert,
}: {
  now: number;
  before: number;
  invert?: boolean;
}) {
  if (before === 0) {
    return (
      <span
        className="text-[10px] text-ink-600"
        title="Nothing in the comparison period, so a percentage change would be meaningless."
      >
        —
      </span>
    );
  }
  const pct = ((now - before) / before) * 100;
  const good = invert ? pct < 0 : pct > 0;
  return (
    <span
      className={cn(
        'text-[10px] tabular-nums',
        pct === 0 ? 'text-ink-500' : good ? 'text-green-400' : 'text-red-400',
      )}
    >
      {pct > 0 ? '+' : ''}
      {pct.toFixed(1)}%
    </span>
  );
}

function fmtRate(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

function CalendarGlyph() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 10h18M8 2v4M16 2v4" />
    </svg>
  );
}
