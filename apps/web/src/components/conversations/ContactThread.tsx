'use client';

import { useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';
import { dispositionLabel } from '@/lib/dispositions';

/**
 * One contact's whole history, as a chat thread (§7.4).
 *
 * Every channel in one stream, laid out like a messaging app: outbound right,
 * inbound left, chronological. That is not decoration — it is the layout the
 * operator already reads fluently, and a call, a text and an email about the
 * same deal belong in the order they happened rather than in three tabs that
 * each tell a third of the story.
 *
 * The left rail is every field, inline-editable, plus a stage selector that can
 * put a contact back on the board — including one that was removed as not
 * interested. People change their minds, and the row was never deleted.
 */

interface Contact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  companyName: string | null;
  companyLocation: string | null;
  phone: string;
  email: string | null;
  address: string | null;
  stageId: string | null;
  stageName: string | null;
  removed: boolean;
  tags: { id: string; name: string; color: string }[];
}

type Item =
  | { kind: 'call'; id: string; at: string; outbound: boolean; callId: string; durationSec: number; disposition: string | null; status: string; hasRecording: boolean; transcript: string | null }
  | { kind: 'sms'; id: string; at: string; outbound: boolean; body: string }
  | { kind: 'email'; id: string; at: string; outbound: boolean; subject: string | null; body: string | null }
  | { kind: 'note'; id: string; at: string; body: string };

const FIELDS: { key: keyof Contact; label: string; mono?: boolean }[] = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'jobTitle', label: 'Job title' },
  { key: 'companyName', label: 'Company' },
  { key: 'phone', label: 'Phone', mono: true },
  { key: 'email', label: 'Email' },
  { key: 'companyLocation', label: 'Location' },
  { key: 'address', label: 'Address' },
];

export function ContactThread({
  contact,
  stages,
  items,
}: {
  contact: Contact;
  stages: { id: string; name: string; color: string }[];
  items: Item[];
}) {
  const [draft, setDraft] = useState<Partial<Record<string, string>>>({});
  const [stageId, setStageId] = useState(contact.stageId ?? '');
  const [saving, setSaving] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const value = (key: keyof Contact) =>
    draft[key] ?? (contact[key] as string | null) ?? '';

  async function saveField(key: string, v: string) {
    setSaving(key);
    await fetch(`/api/contacts/${contact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: v }),
    }).catch(() => {});
    setSaving(null);
  }

  /**
   * Puts the contact into a stage — including one that had been removed.
   *
   * §7.4 is explicit that this must work for a lead trashed as not interested.
   * Nothing was deleted when they were removed, so restoring them is a matter
   * of clearing the removal, and a prospect who says "call me next quarter" a
   * month later should not have to be re-imported.
   */
  async function moveStage(next: string) {
    setStageId(next);
    setSaving('stage');
    await fetch('/api/contacts/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: contact.id, stageId: next || null, position: 0 }),
    }).catch(() => {});
    setSaving(null);
  }

  const name =
    [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
    formatPhone(contact.phone);

  return (
    <div className="flex min-h-0 flex-1">
      {/* --- left rail: the record ------------------------------------- */}
      <aside className="scroll-thin w-[300px] shrink-0 overflow-y-auto border-r border-ink-850 p-4">
        <Link href="/conversations" className="text-xs text-ink-500 hover:text-ink-300">
          ← Conversations
        </Link>

        <h1 className="mt-2 truncate text-lg font-semibold text-ink-100">{name}</h1>
        {contact.removed && (
          <p className="mt-1 rounded bg-ink-850 px-2 py-1 text-[10px] text-ink-400">
            Removed from the pipeline. History is kept — pick a stage below to
            put them back.
          </p>
        )}

        <div className="mt-3 space-y-2">
          {FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-ink-600">
                {f.label}
                {saving === f.key && <span className="ml-1 text-ink-500">saving…</span>}
              </span>
              <input
                className={cn('input py-1 text-xs', f.mono && 'font-mono')}
                value={value(f.key)}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [f.key]: e.target.value }))
                }
                onBlur={(e) => saveField(String(f.key), e.target.value)}
              />
            </label>
          ))}

          <label className="block">
            <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-ink-600">
              Stage
            </span>
            <select
              className="input py-1 text-xs"
              value={stageId}
              onChange={(e) => moveStage(e.target.value)}
            >
              <option value="">Not in a pipeline</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          {contact.tags.length > 0 && (
            <div>
              <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-ink-600">
                Tags
              </span>
              <div className="flex flex-wrap gap-1">
                {contact.tags.map((t) => (
                  <span
                    key={t.id}
                    className="rounded px-1.5 py-0.5 text-[10px]"
                    style={{ color: t.color, backgroundColor: `${t.color}1a` }}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* --- the thread -------------------------------------------------- */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-600">
            Nothing has happened with this contact yet.
          </p>
        ) : (
          <ul className="mx-auto flex max-w-2xl flex-col gap-2">
            {items.map((item) => (
              <li
                key={item.id}
                className={cn(
                  'flex',
                  item.kind === 'note'
                    ? 'justify-center'
                    : item.outbound
                      ? 'justify-end'
                      : 'justify-start',
                )}
              >
                <Bubble item={item} expanded={expanded} setExpanded={setExpanded} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Bubble({
  item,
  expanded,
  setExpanded,
}: {
  item: Item;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
}) {
  const time = new Date(item.at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  // A note is an annotation the operator wrote to themselves, not a message
  // from either side, so it is centred and visually unlike the rest.
  if (item.kind === 'note') {
    return (
      <div className="max-w-md rounded-lg border border-dashed border-ink-700 bg-ink-900/40 px-3 py-1.5 text-center">
        <p className="text-[11px] italic text-ink-300">{item.body}</p>
        <p className="mt-0.5 text-[9px] text-ink-600">{time}</p>
      </div>
    );
  }

  const side = item.outbound
    ? 'bg-brand-950/60 border-brand-900'
    : 'bg-ink-900 border-ink-800';

  if (item.kind === 'call') {
    const isExpanded = expanded.has(item.id);
    return (
      <div className={cn('max-w-md rounded-xl border px-3 py-2', side)}>
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
            {item.outbound ? 'Called' : 'Inbound call'}
          </span>
          <span className="text-[11px] text-ink-300">
            {formatDuration(item.durationSec)}
          </span>
          {item.disposition && (
            <span className="text-[11px] text-ink-400">
              · {dispositionLabel(item.disposition)}
            </span>
          )}
        </div>

        {item.hasRecording && (
          <audio
            controls
            preload="none"
            className="mt-1.5 h-8 w-full"
            src={`/api/calls/${item.callId}/recording`}
          />
        )}

        {item.transcript && (
          <>
            <button
              className="mt-1 text-[10px] text-ink-500 underline"
              onClick={() => {
                const next = new Set(expanded);
                isExpanded ? next.delete(item.id) : next.add(item.id);
                setExpanded(next);
              }}
            >
              {isExpanded ? 'Hide transcript' : 'Transcript'}
            </button>
            {isExpanded && (
              <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-ink-950/60 p-2 text-[10px] leading-relaxed text-ink-300">
                {item.transcript}
              </pre>
            )}
          </>
        )}

        <p className="mt-1 text-[9px] text-ink-600">{time}</p>
      </div>
    );
  }

  if (item.kind === 'email') {
    return (
      <div className={cn('max-w-md rounded-xl border px-3 py-2', side)}>
        <span className="rounded bg-ink-800 px-1 py-0.5 text-[9px] uppercase tracking-wide text-ink-400">
          Email
        </span>
        {item.subject && (
          <p className="mt-1 text-[12px] font-medium text-ink-100">{item.subject}</p>
        )}
        {item.body && (
          <p className="mt-0.5 line-clamp-6 whitespace-pre-wrap text-[11px] leading-relaxed text-ink-300">
            {item.body}
          </p>
        )}
        <p className="mt-1 text-[9px] text-ink-600">{time}</p>
      </div>
    );
  }

  return (
    <div className={cn('max-w-md rounded-xl border px-3 py-2', side)}>
      <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink-100">
        {item.body}
      </p>
      <p className="mt-1 text-[9px] text-ink-600">{time}</p>
    </div>
  );
}

function formatDuration(sec: number): string {
  if (sec <= 0) return 'no answer';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
