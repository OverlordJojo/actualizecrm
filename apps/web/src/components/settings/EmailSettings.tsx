'use client';

import { useCallback, useEffect, useState } from 'react';

interface Config {
  provider: string;
  fromName: string;
  fromAddress: string;
  dailySendCap: string;
  sentToday: number;
  transport: { configured: boolean; provider: string; detail: string };
}

/**
 * Settings → Email.
 *
 * The test send goes through the worker rather than being sent from here on
 * purpose: the worker is what sends every automation email, so testing its
 * configuration is the test that actually predicts whether automations will
 * work. A test that passes in the browser and fails on Railway is worse than
 * no test.
 */
export function EmailSettings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/email/config');
    if (res.ok) setConfig(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: Record<string, string>) {
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    load();
  }

  async function sendTest() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch('/api/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not queue the test.');

      // Poll rather than assume: the point of a test send is to surface the
      // SMTP error, and that only exists once the worker has tried.
      const deadline = Date.now() + 30_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const s = await fetch(`/api/email/send?jobId=${json.jobId}`).then((r) => r.json());
        if (s.message?.status === 'sent') {
          setNotice(`Sent to ${s.message.toAddr}. Check that inbox.`);
          break;
        }
        if (s.message?.status === 'failed') {
          setError(`The worker could not send it: ${s.message.error}`);
          break;
        }
        if (Date.now() > deadline) {
          setError(
            json.immediate
              ? 'The worker accepted the job but has not reported back in 30 seconds. Check the worker logs.'
              : 'Could not reach the worker directly, and it has not drained the job yet. Confirm the worker is running.',
          );
          break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the test.');
    } finally {
      setBusy(false);
      load();
    }
  }

  const cap = Number(config?.dailySendCap ?? 200);
  const remaining = Math.max(cap - (config?.sentToday ?? 0), 0);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">Email</h2>
        <p className="text-xs text-ink-400">
          Sends go out from your own inbox, so replies land where they normally
          would.
        </p>
      </div>

      {notice && (
        <div className="rounded-lg border border-green-900 bg-green-950/50 px-3 py-2 text-xs text-green-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="panel space-y-3 p-3">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`h-2 w-2 rounded-full ${
              config?.transport.configured ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-ink-200">
            {config?.transport.detail ?? 'Checking…'}
          </span>
        </div>

        {config && !config.transport.configured && (
          <p className="rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
            No SMTP credentials are set <strong>on the worker</strong>. Email
            automations will queue and then fail. Set{' '}
            <code className="font-mono">SMTP_HOST</code>,{' '}
            <code className="font-mono">SMTP_USER</code> and{' '}
            <code className="font-mono">SMTP_PASS</code> in the Railway
            service&rsquo;s variables, not only in{' '}
            <code className="font-mono">.env.local</code>.
          </p>
        )}

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className="label">From name</label>
            <input
              className="input py-1.5 text-xs"
              defaultValue={config?.fromName ?? ''}
              onBlur={(e) => save({ 'email.fromName': e.target.value })}
              placeholder="Josh X"
            />
          </div>
          <div>
            <label className="label">From address</label>
            <input
              className="input py-1.5 text-xs"
              defaultValue={config?.fromAddress ?? ''}
              onBlur={(e) => save({ 'email.fromAddress': e.target.value })}
              placeholder="you@example.com"
            />
          </div>
        </div>

        <div>
          <label className="label">Daily send cap</label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={0}
              className="input w-24 py-1.5 text-xs"
              defaultValue={config?.dailySendCap ?? '200'}
              onBlur={(e) => save({ 'email.dailySendCap': e.target.value })}
            />
            <span className="text-xs text-ink-500">
              {config?.sentToday ?? 0} sent today · {remaining} left. Enforced
              when the worker sends, not just hidden in the UI. Keep this below
              your provider&rsquo;s own limit — Gmail allows 500/day on a free
              account.
            </span>
          </div>
        </div>
      </div>

      <div className="panel p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Test send
        </h3>
        <div className="flex gap-1.5">
          <input
            className="input py-1.5 text-xs"
            placeholder="your-own@address.com"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
          />
          <button
            className="btn-primary shrink-0 py-1.5 text-xs"
            onClick={sendTest}
            disabled={busy || !testTo.includes('@')}
          >
            {busy ? 'Sending…' : 'Send test'}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-500">
          Goes through the worker, the same path automations use, and does not
          count against the daily cap.
        </p>
      </div>
    </section>
  );
}
