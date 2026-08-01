'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { cn } from '@/lib/cn';
import {
  AutomationBuilder,
  type AutomationDraft,
  type Step,
} from './AutomationBuilder';

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  steps: Step[];
  createdAt: string;
  _count?: { runs: number };
}

interface Run {
  id: string;
  status: string;
  runAt: string;
  stepIndex: number;
  createdAt: string;
  completedAt: string | null;
  log: unknown;
  contact: { id: string; firstName: string | null; lastName: string | null; phone: string } | null;
}

interface FailedJob {
  id: string;
  type: string;
  error: string;
  failedAt: string;
  attempts: number;
}

const TRIGGER_LABEL: Record<string, string> = {
  disposition_set: 'Outcome set',
  stage_changed: 'Stage changed',
  tag_added: 'Tag added',
  lead_imported: 'Lead imported',
  no_answer_n_times: 'No answer N times',
  call_completed: 'Call completed',
};

const emptyDraft = (): AutomationDraft => ({
  name: '',
  triggerType: 'disposition_set',
  triggerConfig: {},
  steps: [],
  enabled: false,
});

export function AutomationsClient() {
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRunsFor, setOpenRunsFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [failed, setFailed] = useState<FailedJob[]>([]);

  const [options, setOptions] = useState({
    stages: [] as { id: string; name: string }[],
    templates: [] as { id: string; name: string; channel: string }[],
    recordings: [] as { id: string; name: string }[],
    lists: [] as { id: string; name: string }[],
    smsBlocked: true,
    smsBlockedReason: '',
  });

  const load = useCallback(async () => {
    const res = await fetch('/api/automations');
    if (res.ok) setAutomations(await res.json());
  }, []);

  useEffect(() => {
    load();

    Promise.all([
      fetch('/api/stages').then((r) => r.json()).catch(() => []),
      fetch('/api/templates').then((r) => r.json()).catch(() => ({ templates: [] })),
      fetch('/api/voicemail').then((r) => r.json()).catch(() => ({ recordings: [] })),
      fetch('/api/lists').then((r) => r.json()).catch(() => []),
      fetch('/api/messaging/status').then((r) => r.json()).catch(() => null),
    ]).then(([stages, templates, voicemail, lists, messaging]) => {
      setOptions({
        stages: stages ?? [],
        templates: templates.templates ?? [],
        recordings: voicemail.recordings ?? [],
        lists: lists ?? [],
        smsBlocked: !messaging?.approved,
        smsBlockedReason: messaging?.reason ?? '',
      });
    });

    fetch('/api/automations/failed')
      .then((r) => r.json())
      .then(setFailed)
      .catch(() => {});
  }, [load]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const url = draft.id ? `/api/automations/${draft.id}` : '/api/automations';
      const res = await fetch(url, {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name,
          triggerType: draft.triggerType,
          triggerConfig: draft.triggerConfig,
          steps: draft.steps,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save.');
      setDraft(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(a: Automation) {
    await fetch(`/api/automations/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !a.enabled }),
    });
    load();
  }

  async function remove(a: Automation) {
    await fetch(`/api/automations/${a.id}`, { method: 'DELETE' });
    if (openRunsFor === a.id) setOpenRunsFor(null);
    load();
  }

  async function openRuns(a: Automation) {
    if (openRunsFor === a.id) {
      setOpenRunsFor(null);
      return;
    }
    setOpenRunsFor(a.id);
    const res = await fetch(`/api/automations/${a.id}`);
    if (res.ok) setRuns((await res.json()).runs ?? []);
  }

  return (
    <>
      <PageHeader
        title="Automations"
        subtitle="Trigger, delay, action — executed on the worker, so they run with the laptop shut"
      >
        {!draft && (
          <button
            className="btn-primary py-1.5 text-xs"
            onClick={() => setDraft(emptyDraft())}
          >
            New automation
          </button>
        )}
      </PageHeader>

      <div className="scroll-thin flex-1 overflow-y-auto p-5">
        <div className="max-w-4xl space-y-4">
          {error && (
            <div className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          {draft && (
            <AutomationBuilder
              draft={draft}
              options={options}
              onChange={setDraft}
              onSave={save}
              onCancel={() => setDraft(null)}
              saving={saving}
            />
          )}

          {automations === null ? (
            <p className="text-sm text-ink-500">Loading…</p>
          ) : automations.length === 0 && !draft ? (
            <p className="text-sm text-ink-500">
              No automations yet. They run on the Railway worker, so a follow-up
              queued at 5pm still sends at 9am with the laptop shut.
            </p>
          ) : (
            <ul className="space-y-2">
              {automations.map((a) => (
                <li key={a.id} className="panel p-3">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => toggle(a)}
                      title={a.enabled ? 'Switch off' : 'Switch on'}
                      className={cn(
                        'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                        a.enabled ? 'bg-brand-500' : 'bg-ink-700',
                      )}
                    >
                      <span
                        className={cn(
                          'absolute top-0.5 h-4 w-4 rounded-full bg-ink-950 transition-all',
                          a.enabled ? 'left-[18px]' : 'left-0.5',
                        )}
                      />
                    </button>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-100">
                        {a.name}
                      </p>
                      <p className="truncate text-xs text-ink-500">
                        {TRIGGER_LABEL[a.triggerType] ?? a.triggerType} ·{' '}
                        {a.steps.length} step{a.steps.length === 1 ? '' : 's'}
                        {a._count ? ` · ${a._count.runs} runs` : ''}
                      </p>
                    </div>

                    <button
                      className="shrink-0 text-xs text-ink-400 hover:text-ink-100"
                      onClick={() => openRuns(a)}
                    >
                      {openRunsFor === a.id ? 'Hide log' : 'Run log'}
                    </button>
                    <button
                      className="shrink-0 text-xs text-ink-400 hover:text-ink-100"
                      onClick={() =>
                        setDraft({
                          id: a.id,
                          name: a.name,
                          triggerType: a.triggerType,
                          triggerConfig: a.triggerConfig ?? {},
                          steps: a.steps ?? [],
                          enabled: a.enabled,
                        })
                      }
                    >
                      Edit
                    </button>
                    <button
                      className="shrink-0 text-xs text-red-500 hover:text-red-400"
                      onClick={() => remove(a)}
                    >
                      Delete
                    </button>
                  </div>

                  {openRunsFor === a.id && (
                    <div className="mt-3 border-t border-ink-800 pt-2">
                      {runs.length === 0 ? (
                        <p className="text-xs text-ink-500">
                          Never run yet.
                        </p>
                      ) : (
                        <ol className="space-y-1">
                          {runs.map((r) => (
                            <li
                              key={r.id}
                              className="flex items-baseline gap-2 text-[11px]"
                            >
                              <span
                                className={cn(
                                  'w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[9px] uppercase',
                                  RUN_TONE[r.status] ?? 'bg-ink-800 text-ink-400',
                                )}
                              >
                                {r.status}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-ink-300">
                                {r.contact
                                  ? [r.contact.firstName, r.contact.lastName]
                                      .filter(Boolean)
                                      .join(' ') || r.contact.phone
                                  : 'no lead'}
                                {' — step '}
                                {r.stepIndex}
                                {lastLogLine(r.log) ? ` · ${lastLogLine(r.log)}` : ''}
                              </span>
                              <span className="shrink-0 text-ink-600">
                                {new Date(r.createdAt).toLocaleString()}
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* --- dead letters --- */}
          {failed.length > 0 && (
            <section>
              <h2 className="mb-1.5 text-sm font-semibold text-ink-100">
                Failed jobs
              </h2>
              <p className="mb-2 text-xs text-ink-500">
                Jobs that exhausted their retries. A job that dies silently is
                worse than one that dies loudly.
              </p>
              <ul className="space-y-1">
                {failed.map((f) => (
                  <li
                    key={f.id}
                    className="rounded-lg border border-red-950 bg-red-950/30 px-3 py-2"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[11px] text-red-300">
                        {f.type}
                      </span>
                      <span className="ml-auto text-[10px] text-ink-500">
                        {new Date(f.failedAt).toLocaleString()} · {f.attempts}{' '}
                        attempts
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-400">{f.error}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

const RUN_TONE: Record<string, string> = {
  completed: 'bg-green-500/15 text-green-300',
  running: 'bg-brand-500/15 text-brand-300',
  pending: 'bg-ink-800 text-ink-400',
  failed: 'bg-red-500/15 text-red-300',
  skipped: 'bg-amber-500/15 text-amber-300',
};

/// The most recent thing the worker recorded about a run, for the one-line
/// summary in the log.
function lastLogLine(log: unknown): string {
  if (!Array.isArray(log) || log.length === 0) return '';
  const last = log[log.length - 1] as Record<string, unknown>;
  if (typeof last.outcome === 'string') return last.outcome;
  if (typeof last.error === 'string') return `error: ${last.error}`;
  if (typeof last.skipped === 'string') return `skipped: ${last.skipped}`;
  if (typeof last.resumesAt === 'string') {
    return `waiting until ${new Date(last.resumesAt).toLocaleString()}`;
  }
  if (last.completed) return 'finished';
  if (typeof last.trigger === 'string') return `triggered by ${last.trigger}`;
  return '';
}
