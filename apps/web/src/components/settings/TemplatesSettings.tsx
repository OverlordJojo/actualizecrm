'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

interface Template {
  id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
}

/// Kept in step with packages/db/src/merge.ts, which is what actually renders.
const FIELD_HINT = '{{first_name}} {{last_name}} {{company}} {{location}}';

export function TemplatesSettings() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [draft, setDraft] = useState<{ name: string; subject: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/templates');
    if (res.ok) setTemplates((await res.json()).templates);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!draft) return;
    setError(null);
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: draft.name,
        channel,
        subject: channel === 'email' ? draft.subject : undefined,
        body: draft.body,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? 'Could not save the template.');
      return;
    }
    setDraft(null);
    load();
  }

  async function remove(id: string) {
    await fetch(`/api/templates/${id}`, { method: 'DELETE' });
    load();
  }

  const shown = (templates ?? []).filter((t) => t.channel === channel);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">Templates</h2>
        <p className="text-xs text-ink-400">
          Reusable email and text bodies. Merge fields:{' '}
          <code className="font-mono text-ink-300">{FIELD_HINT}</code>
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="panel p-3">
        <div className="mb-3 flex items-center gap-1.5">
          {(['email', 'sms'] as const).map((c) => (
            <button
              key={c}
              onClick={() => {
                setChannel(c);
                setDraft(null);
              }}
              className={cn(
                'rounded-full px-2.5 py-1 text-[11px] transition-colors',
                channel === c
                  ? 'bg-brand-500/15 text-brand-300'
                  : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200',
              )}
            >
              {c === 'email' ? 'Email' : 'Text'}
            </button>
          ))}
          <button
            className="btn-ghost ml-auto py-1 text-xs"
            onClick={() =>
              setDraft(draft ? null : { name: '', subject: '', body: '' })
            }
          >
            {draft ? 'Cancel' : 'New template'}
          </button>
        </div>

        {draft && (
          <div className="mb-3 space-y-2 rounded-lg border border-ink-800 bg-ink-950 p-3">
            <input
              className="input py-1.5 text-xs"
              placeholder="Template name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            {channel === 'email' && (
              <input
                className="input py-1.5 text-xs"
                placeholder="Subject line"
                value={draft.subject}
                onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              />
            )}
            <textarea
              className="input h-28 resize-none text-xs"
              placeholder={
                channel === 'email'
                  ? 'Hi {{first_name}}, saw {{company}} is based in {{location}}…'
                  : 'Hi {{first_name}} — following up on my call. Reply STOP to opt out.'
              }
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            {channel === 'sms' && (
              <p className="text-[11px] text-ink-500">
                Include your business name and opt-out language — carriers
                require it, and it is what you told them you would send.
              </p>
            )}
            <button
              className="btn-primary py-1.5 text-xs"
              onClick={save}
              disabled={!draft.name.trim() || !draft.body.trim()}
            >
              Save template
            </button>
          </div>
        )}

        {templates === null ? (
          <p className="text-xs text-ink-500">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="text-xs text-ink-500">
            No {channel === 'email' ? 'email' : 'text'} templates yet.
          </p>
        ) : (
          <ul className="divide-y divide-ink-800 rounded-lg border border-ink-800">
            {shown.map((t) => (
              <li key={t.id} className="px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-ink-100">{t.name}</span>
                  {t.subject && (
                    <span className="truncate text-[11px] text-ink-500">
                      {t.subject}
                    </span>
                  )}
                  <button
                    className="ml-auto shrink-0 text-xs text-red-500 hover:text-red-400"
                    onClick={() => remove(t.id)}
                  >
                    Delete
                  </button>
                </div>
                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[11px] text-ink-400">
                  {t.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
