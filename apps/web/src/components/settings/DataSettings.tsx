'use client';

import { useCallback, useEffect, useState } from 'react';

interface Counts {
  contacts: number;
  calls: number;
  activities: number;
  bookings: number;
  messages: number;
  emails: number;
}

/**
 * Settings → Voice AI, Daily brief and Data.
 *
 * Grouped because they are all "things the operator configures once and then
 * wants to forget", and each is too small to justify its own section.
 */
export function DataSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Counts | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      fetch('/api/settings').then((r) => r.json()),
      fetch('/api/data/counts').then((r) => r.json()).catch(() => null),
    ]);
    setSettings(s);
    if (c) setCounts(c);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: Record<string, string>, label: string) {
    setSettings((s) => ({ ...s, ...patch }));
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    setSaved(label);
    setTimeout(() => setSaved(null), 2000);
  }

  const autoFields = (settings['ai.autoApplyFields'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  function toggleAutoField(field: string, on: boolean) {
    const next = on
      ? Array.from(new Set(autoFields.concat(field)))
      : autoFields.filter((f) => f !== field);
    save({ 'ai.autoApplyFields': next.join(',') }, 'Auto-apply');
  }

  return (
    <>
      {saved && (
        <div className="rounded-lg border border-green-900 bg-green-950/50 px-3 py-2 text-xs text-green-200">
          {saved} saved.
        </div>
      )}

      {/* --- voice AI --- */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Voice AI</h2>
          <p className="text-xs text-ink-400">
            What the model is allowed to do without you clicking.
          </p>
        </div>

        <div className="panel space-y-3 p-3">
          <div>
            <p className="mb-1.5 text-xs text-ink-300">Auto-apply extractions</p>
            <p className="mb-2 text-[11px] text-ink-500">
              Off for everything by default. A wrong auto-write to a lead&rsquo;s
              email costs a deal and is invisible until it does, so each field
              is opted in separately or not at all.
            </p>
            <div className="flex flex-wrap gap-2">
              {['email', 'first_name', 'last_name', 'company', 'address'].map((f) => (
                <label key={f} className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="accent-brand-500"
                    checked={autoFields.includes(f)}
                    onChange={(e) => toggleAutoField(f, e.target.checked)}
                  />
                  <span className="text-[11px] text-ink-300">
                    {f.replace(/_/g, ' ')}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2 border-t border-ink-800 pt-3">
            <input
              type="checkbox"
              className="mt-0.5 accent-brand-500"
              checked={settings['ai.autoBook'] === 'true'}
              onChange={(e) => save({ 'ai.autoBook': String(e.target.checked) }, 'Auto-book')}
            />
            <span>
              <span className="block text-xs text-ink-200">
                Auto-book verified proposals, with a 15-second undo
              </span>
              <span className="block text-[11px] text-ink-500">
                Off by default. A meeting written to a real calendar and an
                invite sent to a prospect is not something you can take back
                quietly.
              </span>
            </span>
          </label>
        </div>
      </section>

      {/* --- transcription --- */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Transcription</h2>
          <p className="text-xs text-ink-400">
            Recording and transcribing calls, and how long the audio is kept.
          </p>
        </div>

        <div className="panel space-y-3 p-3">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 accent-brand-500"
              checked={settings['transcription.enabled'] !== 'false'}
              onChange={(e) =>
                save({ 'transcription.enabled': String(e.target.checked) }, 'Transcription')
              }
            />
            <span>
              <span className="block text-xs text-ink-200">Transcribe calls</span>
              <span className="block text-[11px] text-ink-500">
                Dual-channel recording through Telnyx, transcribed by Deepgram.
                Speaker attribution is structural rather than guessed because
                the two sides are recorded as separate channels.
              </span>
            </span>
          </label>

          <div className="flex items-center gap-3 border-t border-ink-800 pt-3">
            <div>
              <label className="label">Delete audio after</label>
              <input
                type="number"
                min={1}
                max={365}
                className="input w-24 py-1.5 text-xs"
                value={settings['transcription.retentionDays'] ?? '30'}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, 'transcription.retentionDays': e.target.value }))
                }
                onBlur={(e) =>
                  save({ 'transcription.retentionDays': e.target.value }, 'Audio retention')
                }
              />
            </div>
            <span className="mt-4 text-xs text-ink-500">
              Days. The transcript text is kept regardless — it is small, and it
              is what search and the booking context actually use.
            </span>
          </div>
        </div>
      </section>

      {/* --- daily brief --- */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Daily brief</h2>
          <p className="text-xs text-ink-400">
            A summary of yesterday, emailed to you by the worker.
          </p>
        </div>

        <div className="panel space-y-3 p-3">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="accent-brand-500"
              checked={settings['brief.enabled'] === 'true'}
              onChange={(e) => save({ 'brief.enabled': String(e.target.checked) }, 'Daily brief')}
            />
            <span className="text-xs text-ink-200">Send a daily brief</span>
          </label>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="label">Send at</label>
              <input
                type="time"
                className="input py-1.5 text-xs"
                value={settings['brief.sendTime'] ?? '08:00'}
                onChange={(e) => save({ 'brief.sendTime': e.target.value }, 'Send time')}
              />
            </div>
            <div>
              <label className="label">Send to</label>
              <input
                className="input py-1.5 text-xs"
                placeholder="you@example.com"
                defaultValue={settings['brief.recipient'] ?? ''}
                onBlur={(e) => save({ 'brief.recipient': e.target.value }, 'Recipient')}
              />
            </div>
          </div>

          <p className="text-[11px] text-ink-500">
            Covers dials, connects, connect rate and bookings against the day
            before, your best hour, callbacks past due, and any number whose
            connect rate dropped more than 20% week over week — which is usually
            carrier labelling rather than bad luck.
          </p>
        </div>
      </section>

      {/* --- data --- */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Data</h2>
          <p className="text-xs text-ink-400">Export everything, as CSV.</p>
        </div>

        <div className="panel p-3">
          {counts && (
            <p className="mb-2.5 text-xs text-ink-500">
              {counts.contacts.toLocaleString()} leads ·{' '}
              {counts.calls.toLocaleString()} calls ·{' '}
              {counts.activities.toLocaleString()} timeline entries ·{' '}
              {counts.bookings.toLocaleString()} bookings ·{' '}
              {counts.messages.toLocaleString()} texts ·{' '}
              {counts.emails.toLocaleString()} emails
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['contacts', 'Leads'],
                ['calls', 'Calls'],
                ['activities', 'Timeline'],
                ['bookings', 'Bookings'],
                ['messages', 'Texts'],
                ['emails', 'Emails'],
              ] as [string, string][]
            ).map(([kind, label]) => (
              <a
                key={kind}
                className="btn-ghost py-1.5 text-xs"
                href={`/api/data/export?table=${kind}`}
              >
                {label} CSV
              </a>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-500">
            Plain CSV rather than a proprietary backup format, so it opens in
            anything and does not need this app to read it later.
          </p>
        </div>
      </section>
    </>
  );
}
