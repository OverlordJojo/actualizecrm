'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { DISPOSITIONS } from '@/lib/dispositions';

/**
 * Trigger → optional Delay → Action(s), chainable (build step 8).
 *
 * Steps are an ordered list rather than a graph. A branching editor is a much
 * larger thing to build and to reason about, and every automation this operator
 * has described is linear: something happens, wait, do a few things.
 */

export interface Step {
  type:
    | 'delay'
    | 'send_email'
    | 'send_sms'
    | 'voicemail_drop'
    | 'add_tag'
    | 'remove_tag'
    | 'move_stage'
    | 'create_task';
  seconds?: number;
  templateId?: string;
  recordingId?: string;
  tag?: string;
  stageId?: string;
  dueInMinutes?: number;
  note?: string;
}

export interface AutomationDraft {
  id?: string;
  name: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  steps: Step[];
  enabled: boolean;
}

interface Options {
  stages: { id: string; name: string }[];
  templates: { id: string; name: string; channel: string }[];
  recordings: { id: string; name: string }[];
  lists: { id: string; name: string }[];
  smsBlocked: boolean;
  smsBlockedReason: string;
}

const TRIGGERS: [string, string, string][] = [
  ['disposition_set', 'Outcome set', 'When the operator marks a call'],
  ['stage_changed', 'Stage changed', 'When a lead moves on the board'],
  ['tag_added', 'Tag added', 'When a tag lands on a lead'],
  ['lead_imported', 'Lead imported', 'When new leads finish importing'],
  ['no_answer_n_times', 'No answer N times', 'After a run of unanswered dials'],
  ['call_completed', 'Call completed', 'After every dial, answered or not'],
];

const ACTIONS: [Step['type'], string][] = [
  ['delay', 'Wait'],
  ['send_email', 'Send email'],
  ['send_sms', 'Send text'],
  ['voicemail_drop', 'Drop voicemail'],
  ['add_tag', 'Add tag'],
  ['remove_tag', 'Remove tag'],
  ['move_stage', 'Move stage'],
  ['create_task', 'Create callback'],
];

/// Offered delays, in seconds. Round numbers an operator actually thinks in.
const DELAY_CHOICES: [number, string][] = [
  [300, '5 minutes'],
  [3600, '1 hour'],
  [14400, '4 hours'],
  [86400, '1 day'],
  [259200, '3 days'],
  [604800, '1 week'],
];

export function AutomationBuilder({
  draft,
  options,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  draft: AutomationDraft;
  options: Options;
  onChange: (draft: AutomationDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  function setStep(index: number, patch: Partial<Step>) {
    const steps = draft.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange({ ...draft, steps });
  }

  function addStep(type: Step['type']) {
    const step: Step =
      type === 'delay'
        ? { type, seconds: 3600 }
        : type === 'create_task'
          ? { type, dueInMinutes: 60 }
          : { type };
    onChange({ ...draft, steps: [...draft.steps, step] });
  }

  function removeStep(index: number) {
    onChange({ ...draft, steps: draft.steps.filter((_, i) => i !== index) });
  }

  function moveStep(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    onChange({ ...draft, steps });
  }

  const emailTemplates = options.templates.filter((t) => t.channel === 'email');
  const smsTemplates = options.templates.filter((t) => t.channel === 'sms');

  return (
    <div className="panel space-y-4 p-4">
      <div className="flex items-center gap-2">
        <input
          className="input flex-1"
          placeholder="Name this automation"
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
        <button className="btn-ghost py-1.5 text-xs" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn-primary py-1.5 text-xs"
          onClick={onSave}
          disabled={saving || !draft.name.trim() || draft.steps.length === 0}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* --- trigger --- */}
      <div>
        <label className="label">When this happens</label>
        <div className="grid grid-cols-3 gap-1.5">
          {TRIGGERS.map(([value, label, hint]) => (
            <button
              key={value}
              onClick={() =>
                onChange({ ...draft, triggerType: value, triggerConfig: {} })
              }
              className={cn(
                'rounded-lg border px-2.5 py-2 text-left transition-colors',
                draft.triggerType === value
                  ? 'border-brand-500 bg-brand-500/10'
                  : 'border-ink-700 bg-ink-850 hover:bg-ink-800',
              )}
            >
              <span
                className={cn(
                  'block text-xs font-medium',
                  draft.triggerType === value ? 'text-brand-200' : 'text-ink-200',
                )}
              >
                {label}
              </span>
              <span className="block text-[10px] text-ink-500">{hint}</span>
            </button>
          ))}
        </div>

        <div className="mt-2">
          <TriggerConfig draft={draft} options={options} onChange={onChange} />
        </div>
      </div>

      {/* --- steps --- */}
      <div>
        <label className="label">Then do this, in order</label>

        {draft.steps.length === 0 && (
          <p className="mb-2 text-xs text-ink-500">
            No steps yet. An automation with no steps never does anything, so
            it cannot be saved.
          </p>
        )}

        <ol className="space-y-1.5">
          {draft.steps.map((step, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-950 px-3 py-2"
            >
              <span className="w-4 shrink-0 text-[10px] text-ink-600">{i + 1}</span>
              <span className="w-24 shrink-0 text-xs font-medium text-ink-200">
                {ACTIONS.find(([t]) => t === step.type)?.[1] ?? step.type}
              </span>

              <div className="min-w-0 flex-1">
                {step.type === 'delay' && (
                  <select
                    className="input py-1 text-xs"
                    value={step.seconds ?? 3600}
                    onChange={(e) => setStep(i, { seconds: Number(e.target.value) })}
                  >
                    {DELAY_CHOICES.map(([s, label]) => (
                      <option key={s} value={s}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}

                {step.type === 'send_email' && (
                  <select
                    className="input py-1 text-xs"
                    value={step.templateId ?? ''}
                    onChange={(e) => setStep(i, { templateId: e.target.value })}
                  >
                    <option value="">Pick an email template…</option>
                    {emailTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}

                {step.type === 'send_sms' && (
                  <div className="space-y-1">
                    <select
                      className="input py-1 text-xs"
                      value={step.templateId ?? ''}
                      onChange={(e) => setStep(i, { templateId: e.target.value })}
                      disabled={options.smsBlocked}
                    >
                      <option value="">Pick a text template…</option>
                      {smsTemplates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    {options.smsBlocked && (
                      <p className="text-[10px] text-amber-300">
                        Texting is blocked until 10DLC registration is
                        approved. {options.smsBlockedReason} This step will be
                        skipped, not sent.
                      </p>
                    )}
                  </div>
                )}

                {step.type === 'voicemail_drop' && (
                  <select
                    className="input py-1 text-xs"
                    value={step.recordingId ?? ''}
                    onChange={(e) => setStep(i, { recordingId: e.target.value })}
                  >
                    <option value="">Default recording</option>
                    {options.recordings.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                )}

                {(step.type === 'add_tag' || step.type === 'remove_tag') && (
                  <input
                    className="input py-1 text-xs"
                    placeholder="Tag name"
                    value={step.tag ?? ''}
                    onChange={(e) => setStep(i, { tag: e.target.value })}
                  />
                )}

                {step.type === 'move_stage' && (
                  <select
                    className="input py-1 text-xs"
                    value={step.stageId ?? ''}
                    onChange={(e) => setStep(i, { stageId: e.target.value })}
                  >
                    <option value="">Pick a stage…</option>
                    {options.stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}

                {step.type === 'create_task' && (
                  <div className="flex gap-1.5">
                    <select
                      className="input w-auto py-1 text-xs"
                      value={step.dueInMinutes ?? 60}
                      onChange={(e) =>
                        setStep(i, { dueInMinutes: Number(e.target.value) })
                      }
                    >
                      <option value={60}>due in 1 hour</option>
                      <option value={240}>due in 4 hours</option>
                      <option value={1440}>due tomorrow</option>
                      <option value={4320}>due in 3 days</option>
                    </select>
                    <input
                      className="input py-1 text-xs"
                      placeholder="Note (optional)"
                      value={step.note ?? ''}
                      onChange={(e) => setStep(i, { note: e.target.value })}
                    />
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  className="text-ink-500 hover:text-ink-200 disabled:opacity-30"
                  onClick={() => moveStep(i, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  className="text-ink-500 hover:text-ink-200 disabled:opacity-30"
                  onClick={() => moveStep(i, 1)}
                  disabled={i === draft.steps.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  className="text-red-500 hover:text-red-400"
                  onClick={() => removeStep(i)}
                  aria-label="Remove step"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {ACTIONS.map(([type, label]) => (
            <button
              key={type}
              className="rounded-full border border-ink-700 bg-ink-850 px-2.5 py-1 text-[11px] text-ink-300 hover:bg-ink-800"
              onClick={() => addStep(type)}
            >
              + {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TriggerConfig({
  draft,
  options,
  onChange,
}: {
  draft: AutomationDraft;
  options: Options;
  onChange: (draft: AutomationDraft) => void;
}) {
  const config = draft.triggerConfig;
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...draft, triggerConfig: { ...config, ...patch } });

  switch (draft.triggerType) {
    case 'disposition_set':
      return (
        <select
          className="input py-1.5 text-xs"
          value={(config.disposition as string) ?? ''}
          onChange={(e) => set({ disposition: e.target.value })}
        >
          <option value="">Any outcome</option>
          {DISPOSITIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      );

    case 'stage_changed':
      return (
        <select
          className="input py-1.5 text-xs"
          value={(config.stageId as string) ?? ''}
          onChange={(e) => set({ stageId: e.target.value })}
        >
          <option value="">Any stage</option>
          {options.stages.map((s) => (
            <option key={s.id} value={s.id}>
              Moved to {s.name}
            </option>
          ))}
        </select>
      );

    case 'tag_added':
      return (
        <input
          className="input py-1.5 text-xs"
          placeholder="Any tag, or name one"
          value={(config.tag as string) ?? ''}
          onChange={(e) => set({ tag: e.target.value })}
        />
      );

    case 'lead_imported':
      return (
        <select
          className="input py-1.5 text-xs"
          value={(config.listId as string) ?? ''}
          onChange={(e) => set({ listId: e.target.value })}
        >
          <option value="">Any list</option>
          {options.lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      );

    case 'no_answer_n_times':
      return (
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-400">After</span>
          <input
            type="number"
            min={1}
            max={20}
            className="input w-16 py-1.5 text-xs"
            value={(config.count as number) ?? 3}
            onChange={(e) => set({ count: Number(e.target.value) })}
          />
          <span className="text-xs text-ink-400">
            unanswered dials in a row. Fires once, on that dial — not on every
            one after it.
          </span>
        </div>
      );

    default:
      return null;
  }
}
