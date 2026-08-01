'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';
import { dispositionLabel } from '@/lib/dispositions';

/**
 * The contact slide-over.
 *
 * Opened from a Conversations row, from an inbound screen-pop, and from the
 * calendar. Every field is an input rather than read-only text with an "edit"
 * mode: the operator is usually mid-call when they correct a name, and a mode
 * switch is one interaction too many.
 *
 * Saves debounce at 500ms and write only the field that changed (§3.1), so the
 * dialer card and an open slide-over editing the same lead cannot clobber each
 * other.
 */

const SAVE_DEBOUNCE_MS = 500;

export interface SlideOverContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  email: string | null;
  companyName: string | null;
  companyLocation: string | null;
  address: string | null;
  dealValue: number | null;
  stageId: string | null;
  doNotContact: boolean;
  source: string;
  pipelineRemovedAt: string | null;
  removalReason: string | null;
  dialCount: number;
  connectCount: number;
  lastDisposition: string | null;
  stage: { id: string; name: string; color: string } | null;
  list: { id: string; name: string } | null;
  tags: { id: string; name: string; color: string }[];
}

interface CallRow {
  id: string;
  startedAt: string;
  durationSec: number;
  direction: string;
  disposition: string | null;
  status: string;
  fromE164: string | null;
  toE164: string;
  notes: string | null;
  voicemailDropped: boolean;
  transcript: string | null;
  transcriptStatus: string | null;
  recordingPath: string | null;
}

interface ActivityRow {
  id: string;
  type: string;
  direction: string | null;
  summary: string;
  body: string | null;
  meta: Record<string, unknown>;
  callId: string | null;
  createdAt: string;
}

interface Stage {
  id: string;
  name: string;
  color: string;
}

type EditableField =
  | 'firstName'
  | 'lastName'
  | 'phone'
  | 'email'
  | 'companyName'
  | 'companyLocation'
  | 'address';

export function ContactSlideOver({
  contactId,
  onClose,
  onChanged,
}: {
  contactId: string | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [contact, setContact] = useState<SlideOverContact | null>(null);
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [openTranscript, setOpenTranscript] = useState<string | null>(null);
  const [newTag, setNewTag] = useState('');
  const [note, setNote] = useState('');

  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contactId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load that lead.');
      setContact({ ...json.contact, tags: json.contact.tags });
      setActivities(json.activities);
      setCalls(json.calls);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that lead.');
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    setContact(null);
    setNote('');
    setOpenTranscript(null);
    load();
  }, [contactId, load]);

  useEffect(() => {
    fetch('/api/stages')
      .then((r) => r.json())
      .then(setStages)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!contactId) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape closes, but not while the operator is inside a field — there it
      // means "undo what I just typed".
      const el = e.target as HTMLElement | null;
      const inField =
        el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === 'Escape' && !inField) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contactId, onClose]);

  useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      audioRef.current?.pause();
    };
  }, []);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      if (!contactId) return;
      setSaveState('saving');
      try {
        const res = await fetch(`/api/contacts/${contactId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not save.');
        setSaveState('saved');
        setError(null);
        onChanged?.();
      } catch (e) {
        setSaveState('idle');
        setError(e instanceof Error ? e.message : 'Could not save.');
      }
    },
    [contactId, onChanged],
  );

  function editField(field: EditableField, value: string) {
    setContact((c) => (c ? { ...c, [field]: value } : c));
    setSaveState('saving');

    const timers = saveTimers.current;
    const existing = timers.get(field);
    if (existing) clearTimeout(existing);

    timers.set(
      field,
      setTimeout(() => {
        timers.delete(field);
        patch({ [field]: value });
      }, SAVE_DEBOUNCE_MS),
    );
  }

  async function addTag() {
    const name = newTag.trim();
    if (!name || !contactId) return;
    setNewTag('');
    await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, name }),
    });
    load();
    onChanged?.();
  }

  async function removeTag(tagId: string) {
    if (!contactId) return;
    await fetch('/api/tags', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, tagId }),
    });
    load();
    onChanged?.();
  }

  async function saveNote() {
    if (!note.trim()) return;
    await patch({ notes: note });
    setNote('');
    load();
  }

  async function restore(stageId: string) {
    if (!contactId || !stageId) return;
    await fetch('/api/contacts/remove', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, stageId }),
    });
    load();
    onChanged?.();
  }

  async function playRecording(callId: string) {
    audioRef.current?.pause();
    const res = await fetch(`/api/calls/${callId}/recording`);
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? 'No recording for that call.');
      return;
    }
    const audio = new Audio(json.url);
    audioRef.current = audio;
    audio.play().catch(() => setError('That recording would not play.'));
  }

  if (!contactId) return null;

  const callById = new Map(calls.map((c) => [c.id, c]));
  const name = contact
    ? [contact.firstName, contact.lastName].filter(Boolean).join(' ')
    : '';

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        className="flex-1 bg-black/50"
        onClick={onClose}
        aria-label="Close panel"
      />

      <aside className="flex h-full w-full max-w-[560px] flex-col border-l border-ink-800 bg-ink-900 shadow-2xl">
        <header className="flex shrink-0 items-start gap-3 border-b border-ink-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-ink-100">
              {name || contact?.companyName || formatPhone(contact?.phone) || 'Lead'}
            </h2>
            <p className="truncate text-xs text-ink-400">
              {contact
                ? `${contact.dialCount} dials · ${contact.connectCount} connects · last outcome ${dispositionLabel(contact.lastDisposition)}`
                : 'Loading…'}
            </p>
          </div>
          <span className="shrink-0 pt-0.5 text-[10px] text-ink-500">
            {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved' : ''}
          </span>
          <button
            className="shrink-0 text-ink-500 hover:text-ink-200"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-4">
          {loading && !contact && (
            <p className="text-xs text-ink-500">Loading…</p>
          )}

          {contact && (
            <>
              {contact.pipelineRemovedAt && (
                <div className="rounded-lg border border-amber-900 bg-amber-950/40 p-3">
                  <p className="text-xs font-medium text-amber-200">
                    Removed from the pipeline
                    {contact.removalReason
                      ? ` — ${contact.removalReason.replace(/_/g, ' ')}`
                      : ''}
                    .
                  </p>
                  <p className="mt-0.5 text-xs text-amber-100/80">
                    History is kept for 7 days from removal, then swept.
                  </p>
                  <select
                    className="input mt-2 py-1 text-xs"
                    defaultValue=""
                    onChange={(e) => restore(e.target.value)}
                  >
                    <option value="">Restore to…</option>
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* --- editable fields --- */}
              <div className="grid grid-cols-2 gap-2.5">
                <Field
                  label="First name"
                  value={contact.firstName ?? ''}
                  onChange={(v) => editField('firstName', v)}
                />
                <Field
                  label="Last name"
                  value={contact.lastName ?? ''}
                  onChange={(v) => editField('lastName', v)}
                />
                <Field
                  label="Phone"
                  value={contact.phone}
                  mono
                  onChange={(v) => editField('phone', v)}
                />
                <Field
                  label="Email"
                  value={contact.email ?? ''}
                  onChange={(v) => editField('email', v)}
                />
                <Field
                  label="Company"
                  value={contact.companyName ?? ''}
                  onChange={(v) => editField('companyName', v)}
                />
                <Field
                  label="Location"
                  value={contact.companyLocation ?? ''}
                  onChange={(v) => editField('companyLocation', v)}
                />
                <div className="col-span-2">
                  <Field
                    label="Address"
                    value={contact.address ?? ''}
                    onChange={(v) => editField('address', v)}
                  />
                </div>
              </div>

              {/* --- stage --- */}
              <div>
                <label className="label">Stage</label>
                <select
                  className="input py-1.5 text-xs"
                  value={contact.stageId ?? ''}
                  onChange={(e) => {
                    const stageId = e.target.value || null;
                    setContact((c) => (c ? { ...c, stageId } : c));
                    patch({ stageId });
                  }}
                >
                  <option value="">Not on the board</option>
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* --- tags --- */}
              <div>
                <label className="label">Tags</label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {contact.tags.map((t) => (
                    <span
                      key={t.id}
                      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                      style={{ backgroundColor: `${t.color}22`, color: t.color }}
                    >
                      {t.name}
                      <button
                        className="opacity-60 hover:opacity-100"
                        onClick={() => removeTag(t.id)}
                        aria-label={`Remove ${t.name}`}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  <input
                    className="w-28 rounded-full border border-ink-700 bg-ink-950 px-2 py-0.5 text-[11px] text-ink-100 placeholder:text-ink-600 focus:border-brand-500 focus:outline-none"
                    placeholder="add tag…"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addTag();
                      }
                    }}
                  />
                </div>
              </div>

              <SendPanel
                contact={contact}
                onSent={() => {
                  load();
                  onChanged?.();
                }}
              />

              {/* --- note --- */}
              <div>
                <label className="label">Add a note</label>
                <textarea
                  className="input h-16 resize-none"
                  placeholder="Notes accumulate on the timeline rather than overwriting."
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <button
                  className="btn-ghost mt-1.5 py-1 text-xs"
                  onClick={saveNote}
                  disabled={!note.trim()}
                >
                  Save note
                </button>
              </div>

              {/* --- timeline --- */}
              <div>
                <label className="label">Timeline</label>
                {activities.length === 0 ? (
                  <p className="text-xs text-ink-500">Nothing yet.</p>
                ) : (
                  <ol className="space-y-1.5">
                    {activities.map((a) => {
                      const call = a.callId ? callById.get(a.callId) : null;
                      const expanded = openTranscript === a.id;
                      return (
                        <li
                          key={a.id}
                          className="rounded-lg border border-ink-800 bg-ink-950 px-3 py-2"
                        >
                          <div className="flex items-baseline gap-2">
                            <span
                              className={cn(
                                'shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide',
                                TYPE_TONE[a.type] ?? 'bg-ink-800 text-ink-400',
                              )}
                            >
                              {TYPE_LABEL[a.type] ?? a.type}
                            </span>
                            <span className="min-w-0 flex-1 text-xs text-ink-200">
                              {a.summary}
                            </span>
                            <span className="shrink-0 text-[10px] text-ink-500">
                              {new Date(a.createdAt).toLocaleString()}
                            </span>
                          </div>

                          {a.body && (
                            <p className="mt-1 whitespace-pre-wrap text-xs text-ink-400">
                              {a.body}
                            </p>
                          )}

                          {call && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-ink-500">
                              <span>
                                {call.direction === 'inbound' ? 'Inbound' : 'Outbound'}
                                {call.durationSec > 0
                                  ? ` · ${formatDuration(call.durationSec)}`
                                  : ''}
                                {call.disposition
                                  ? ` · ${dispositionLabel(call.disposition)}`
                                  : ''}
                              </span>
                              {call.recordingPath && (
                                <button
                                  className="text-brand-400 hover:underline"
                                  onClick={() => playRecording(call.id)}
                                >
                                  play recording
                                </button>
                              )}
                              {call.transcript && (
                                <button
                                  className="text-brand-400 hover:underline"
                                  onClick={() =>
                                    setOpenTranscript(expanded ? null : a.id)
                                  }
                                >
                                  {expanded ? 'hide transcript' : 'transcript'}
                                </button>
                              )}
                              {!call.transcript &&
                                call.transcriptStatus &&
                                call.transcriptStatus !== 'done' && (
                                  <span>transcript {call.transcriptStatus}</span>
                                )}
                            </div>
                          )}

                          {call && expanded && call.transcript && (
                            <pre className="scroll-thin mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-ink-800 bg-ink-900 p-2 text-[11px] leading-relaxed text-ink-300">
                              {call.transcript}
                            </pre>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

/**
 * Send an email or a text to this lead.
 *
 * The text side is disabled and explained rather than hidden. A missing button
 * looks like a bug; a disabled one that says "10DLC registration is not
 * approved yet" tells the operator exactly what they are waiting on. The route
 * refuses it either way — this is the courteous half of the gate, not the
 * enforcing half.
 */
function SendPanel({
  contact,
  onSent,
}: {
  contact: SlideOverContact;
  onSent: () => void;
}) {
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [templates, setTemplates] = useState<
    { id: string; name: string; channel: string }[]
  >([]);
  const [templateId, setTemplateId] = useState('');
  const [smsGate, setSmsGate] = useState<{ approved: boolean; reason: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/templates')
      .then((r) => r.json())
      .then((j) => setTemplates(j.templates ?? []))
      .catch(() => {});
    fetch('/api/messaging/status')
      .then((r) => r.json())
      .then(setSmsGate)
      .catch(() => {});
  }, []);

  const options = templates.filter((t) => t.channel === channel);
  const smsBlocked = !smsGate?.approved;

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(channel === 'email' ? '/api/email/send' : '/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: contact.id, templateId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.reason ?? json.error ?? 'Could not send.');
      setResult(
        json.immediate
          ? 'Queued — the worker is sending it now.'
          : 'Queued. The worker will send it within about twenty seconds.',
      );
      setTimeout(onSent, 2500);
    } catch (e) {
      setResult(e instanceof Error ? e.message : 'Could not send.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="label">Send</label>
      <div className="space-y-1.5 rounded-lg border border-ink-800 bg-ink-950 p-2.5">
        <div className="flex items-center gap-1.5">
          {(['email', 'sms'] as const).map((c) => (
            <button
              key={c}
              onClick={() => {
                setChannel(c);
                setTemplateId('');
                setResult(null);
              }}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[11px] transition-colors',
                channel === c
                  ? 'bg-brand-500/15 text-brand-300'
                  : 'text-ink-400 hover:text-ink-200',
              )}
            >
              {c === 'email' ? 'Email' : 'Text'}
            </button>
          ))}
        </div>

        {channel === 'sms' && smsBlocked && (
          <p className="text-[11px] text-amber-300">
            Texting is blocked until 10DLC registration is approved.{' '}
            {smsGate?.reason} See Settings → Messaging.
          </p>
        )}
        {channel === 'email' && !contact.email && (
          <p className="text-[11px] text-amber-300">
            This lead has no email address on file.
          </p>
        )}

        <div className="flex gap-1.5">
          <select
            className="input py-1 text-xs"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            disabled={channel === 'sms' && smsBlocked}
          >
            <option value="">Pick a template…</option>
            {options.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            className="btn-primary shrink-0 py-1 text-xs"
            onClick={send}
            disabled={
              busy ||
              !templateId ||
              (channel === 'sms' && smsBlocked) ||
              (channel === 'email' && !contact.email)
            }
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>

        {result && <p className="text-[11px] text-ink-400">{result}</p>}
      </div>
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  call: 'call',
  sms: 'text',
  email: 'email',
  note: 'note',
  stage_change: 'stage',
  disposition: 'outcome',
  tag: 'tag',
  import: 'import',
  automation: 'auto',
  voicemail_drop: 'voicemail',
};

const TYPE_TONE: Record<string, string> = {
  call: 'bg-brand-500/15 text-brand-300',
  sms: 'bg-sky-500/15 text-sky-300',
  email: 'bg-indigo-500/15 text-indigo-300',
  note: 'bg-ink-800 text-ink-300',
  stage_change: 'bg-emerald-500/15 text-emerald-300',
  disposition: 'bg-amber-500/15 text-amber-300',
  tag: 'bg-fuchsia-500/15 text-fuchsia-300',
  voicemail_drop: 'bg-violet-500/15 text-violet-300',
  automation: 'bg-teal-500/15 text-teal-300',
};

function Field({
  label,
  value,
  onChange,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        className={cn('input py-1.5 text-xs', mono && 'font-mono')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
