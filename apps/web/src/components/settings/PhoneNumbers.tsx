'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';

interface OwnedNumber {
  id: string;
  e164: string;
  locality: string | null;
  region: string | null;
  areaCode: string | null;
  monthlyCost: number | null;
  purchasedAt: string;
  dialsSent: number;
  active: boolean;
  routeInboundToBrowser: boolean;
}

interface SearchResult {
  phoneNumber: string;
  locality?: string;
  region?: string;
  monthlyCost: number;
  upfrontCost: number;
  currency: string;
}

interface TelnyxStatus {
  ok: boolean;
  apiKey: boolean;
  balance?: { available: number; currency: string; balance: number };
  connection?: { id: string; name: string; active: boolean } | null;
  outboundProfiles?: { id: string; name: string; enabled: boolean }[];
  webhookUrl?: string | null;
  registeredWebhookUrl?: string | null;
  problems: string[];
}

interface WebhookTest {
  ok: boolean;
  roundTripMs?: number;
  eventType?: string;
  webhookUrl?: string;
  error?: string;
}

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

export function PhoneNumbers() {
  const [status, setStatus] = useState<TelnyxStatus | null>(null);
  const [owned, setOwned] = useState<OwnedNumber[]>([]);
  const [results, setResults] = useState<SearchResult[] | null>(null);

  const [areaCode, setAreaCode] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');

  const [searching, setSearching] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [webhookTest, setWebhookTest] = useState<WebhookTest | null>(null);
  const [testingWebhook, setTestingWebhook] = useState(false);

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/telnyx/status');
    setStatus(await res.json());
  }, []);

  const loadOwned = useCallback(async () => {
    const res = await fetch('/api/numbers');
    if (res.ok) setOwned(await res.json());
  }, []);

  useEffect(() => {
    loadStatus();
    loadOwned();
  }, [loadStatus, loadOwned]);

  /**
   * Proves Telnyx can reach us right now (§1.2).
   *
   * A brief call between two of the operator's own numbers, hung up the moment
   * its first event arrives. It never rings a person — and it is the only kind
   * of check that means anything, because the URL being configured says nothing
   * about whether events are getting through.
   */
  async function testWebhook() {
    setTestingWebhook(true);
    setWebhookTest(null);
    try {
      const res = await fetch('/api/telnyx/test-webhook', { method: 'POST' });
      setWebhookTest(await res.json());
    } catch (e) {
      setWebhookTest({
        ok: false,
        error: e instanceof Error ? e.message : 'The test could not be run.',
      });
    } finally {
      setTestingWebhook(false);
      loadStatus();
    }
  }

  async function search() {
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const p = new URLSearchParams();
      if (areaCode.trim()) p.set('areaCode', areaCode.trim());
      if (state) p.set('state', state);
      if (city.trim()) p.set('city', city.trim());

      const res = await fetch(`/api/numbers/search?${p.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Search failed.');
      setResults(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed.');
    } finally {
      setSearching(false);
    }
  }

  async function buy(r: SearchResult) {
    const cost = r.monthlyCost
      ? `$${r.monthlyCost.toFixed(2)}/month`
      : 'the listed monthly rate';
    if (
      !window.confirm(
        `Buy ${formatPhone(r.phoneNumber)}?\n\nThis charges your Telnyx account ${cost}.`,
      )
    ) {
      return;
    }

    setBuying(r.phoneNumber);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: r.phoneNumber,
          locality: r.locality,
          region: r.region,
          monthlyCost: r.monthlyCost,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Purchase failed.');

      setNotice(`${formatPhone(r.phoneNumber)} is yours.`);
      setResults((prev) => prev?.filter((x) => x.phoneNumber !== r.phoneNumber) ?? null);
      loadOwned();
      loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Purchase failed.');
    } finally {
      setBuying(null);
    }
  }

  async function release(n: OwnedNumber) {
    if (
      !window.confirm(
        `Release ${formatPhone(n.e164)}?\n\nYou stop being billed for it, and you cannot get this exact number back.`,
      )
    ) {
      return;
    }
    const res = await fetch(`/api/numbers/${n.id}`, { method: 'DELETE' });
    if (res.ok) {
      setNotice(`${formatPhone(n.e164)} released.`);
      loadOwned();
    } else {
      setError((await res.json()).error ?? 'Could not release that number.');
    }
  }

  /// Per-number inbound routing (add-on A). Optimistic: the toggle should feel
  /// instant, and a failed write reloads the true value.
  async function setInboundRouting(n: OwnedNumber, on: boolean) {
    setOwned((prev) =>
      prev.map((x) => (x.id === n.id ? { ...x, routeInboundToBrowser: on } : x)),
    );
    const res = await fetch(`/api/numbers/${n.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeInboundToBrowser: on }),
    }).catch(() => null);
    if (!res?.ok) loadOwned();
  }

  const activeNumbers = owned.filter((n) => n.active);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">Phone Numbers</h2>
        <p className="text-xs text-ink-400">
          Numbers you dial from. A local area code gets answered more often.
        </p>
      </div>

      {status && status.problems.length > 0 && (
        <div className="rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2.5">
          <p className="mb-1 text-xs font-medium text-amber-200">
            Before you can dial:
          </p>
          <ul className="space-y-1">
            {status.problems.map((p) => (
              <li key={p} className="text-xs text-amber-100/80">
                • {p}
              </li>
            ))}
          </ul>
          <button
            className="mt-2 text-xs text-amber-300 underline"
            onClick={loadStatus}
          >
            Re-check
          </button>
        </div>
      )}

      {status?.balance && (
        <div className="flex gap-4 text-xs text-ink-400">
          <span>
            Telnyx balance:{' '}
            <span
              className={cn(
                'font-medium tabular-nums',
                status.balance.available > 0 ? 'text-ink-200' : 'text-amber-400',
              )}
            >
              ${status.balance.available.toFixed(2)} {status.balance.currency}
            </span>
          </span>
          {status.connection && (
            <span>
              Connection:{' '}
              <span className="text-ink-200">{status.connection.name}</span>
            </span>
          )}
        </div>
      )}

      {/* Webhook delivery (§1.2). Not a configuration readout — a live test. */}
      <div className="rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-ink-200">Call event delivery</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-400">
              Telnyx reports what your calls did — answered, hung up, reached a
              machine. The test places a few-second call between two of your own
              numbers and hangs up as soon as the report arrives. It never rings
              anyone.
            </p>
          </div>
          <button
            className="btn-ghost shrink-0 py-1 text-xs"
            onClick={testWebhook}
            disabled={testingWebhook}
          >
            {testingWebhook ? 'Testing…' : 'Test delivery'}
          </button>
        </div>

        {status?.registeredWebhookUrl && (
          <p className="mt-1.5 truncate font-mono text-[10px] text-ink-500">
            {status.registeredWebhookUrl}
          </p>
        )}

        {webhookTest && (
          <div
            className={cn(
              'mt-2 rounded-md px-2.5 py-1.5 text-[11px] leading-relaxed',
              webhookTest.ok
                ? 'border border-green-900 bg-green-950/50 text-green-200'
                : 'border border-red-900 bg-red-950/50 text-red-200',
            )}
          >
            {webhookTest.ok ? (
              <>
                Working — Telnyx reported back in{' '}
                <span className="font-medium tabular-nums">
                  {((webhookTest.roundTripMs ?? 0) / 1000).toFixed(1)}s
                </span>
                .
              </>
            ) : (
              webhookTest.error
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-green-900 bg-green-950/50 px-3 py-2 text-xs text-green-200">
          {notice}
        </div>
      )}

      {/* --- owned --- */}
      <div className="panel p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Your numbers ({activeNumbers.length})
        </h3>

        {activeNumbers.length === 0 ? (
          <p className="py-3 text-center text-xs text-ink-500">
            No numbers yet. Search below and buy one.
          </p>
        ) : (
          <div className="space-y-1">
            {activeNumbers.map((n) => (
              <div
                key={n.id}
                className="flex items-center gap-3 rounded-lg bg-ink-850 px-3 py-2"
              >
                <span className="font-mono text-sm text-ink-100">
                  {formatPhone(n.e164)}
                </span>
                <span className="text-xs text-ink-400">
                  {[n.locality, n.region].filter(Boolean).join(', ') || '—'}
                </span>
                <span className="text-xs text-ink-500">
                  {n.dialsSent.toLocaleString()} dials
                </span>
                <span className="text-xs text-ink-500">
                  bought {new Date(n.purchasedAt).toLocaleDateString()}
                </span>
                <label
                  className="ml-auto flex cursor-pointer items-center gap-1.5"
                  title="When off, calls to this number still get logged and still create a callback task — they just do not ring the browser."
                >
                  <input
                    type="checkbox"
                    className="accent-brand-500"
                    checked={n.routeInboundToBrowser}
                    onChange={(e) => setInboundRouting(n, e.target.checked)}
                  />
                  <span className="text-xs text-ink-400">Route inbound</span>
                </label>
                <button
                  className="text-xs text-red-400 hover:underline"
                  onClick={() => release(n)}
                >
                  Release
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* --- search --- */}
      <div className="panel p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Buy a number
        </h3>

        <div className="flex flex-wrap items-end gap-2">
          <div className="w-28">
            <label className="label">Area code</label>
            <input
              className="input py-1.5"
              placeholder="702"
              value={areaCode}
              onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
              onKeyDown={(e) => e.key === 'Enter' && search()}
            />
          </div>

          <div className="w-24">
            <label className="label">State</label>
            <select
              className="input py-1.5"
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              <option value="">Any</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className="w-40">
            <label className="label">City</label>
            <input
              className="input py-1.5"
              placeholder="Henderson"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
            />
          </div>

          <button className="btn-primary py-1.5" onClick={search} disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>

        {results && (
          <div className="mt-3">
            {results.length === 0 ? (
              <p className="py-3 text-center text-xs text-ink-500">
                Nothing available for that search. Try a wider one.
              </p>
            ) : (
              <div className="space-y-1">
                {results.map((r) => (
                  <div
                    key={r.phoneNumber}
                    className="flex items-center gap-3 rounded-lg bg-ink-850 px-3 py-2"
                  >
                    <span className="font-mono text-sm text-ink-100">
                      {formatPhone(r.phoneNumber)}
                    </span>
                    <span className="text-xs text-ink-400">
                      {[r.locality, r.region].filter(Boolean).join(', ') || '—'}
                    </span>
                    <span className="text-xs tabular-nums text-ink-300">
                      {r.monthlyCost > 0
                        ? `$${r.monthlyCost.toFixed(2)}/mo`
                        : 'price shown at checkout'}
                    </span>
                    <button
                      className="btn-primary ml-auto py-1 text-xs"
                      onClick={() => buy(r)}
                      disabled={buying !== null}
                    >
                      {buying === r.phoneNumber ? 'Buying…' : 'Buy'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
