'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { ContactSlideOver } from '@/components/contact/ContactSlideOver';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/phone';
import { DISPOSITIONS, dispositionLabel } from '@/lib/dispositions';

/**
 * Conversations — every call, text, email and note across every lead, newest
 * first (build step 7).
 *
 * The feed is one query against `Activity` rather than a union of four tables,
 * and search covers note bodies, message bodies and call transcripts, because
 * what the operator actually remembers is a phrase, not a date.
 */

interface FeedContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  companyLocation: string | null;
  phone: string;
  email: string | null;
  pipelineRemovedAt: string | null;
  removalReason: string | null;
  tags: { id: string; name: string; color: string }[];
}

interface FeedRow {
  id: string;
  type: string;
  direction: string | null;
  summary: string;
  body: string | null;
  meta: Record<string, unknown>;
  callId: string | null;
  createdAt: string;
  contact: FeedContact;
}

interface Filters {
  q: string;
  channel: string;
  disposition: string;
  tagId: string;
  listId: string;
  from: string;
  to: string;
  view: 'all' | 'removed';
}

const EMPTY: Filters = {
  q: '',
  channel: '',
  disposition: '',
  tagId: '',
  listId: '',
  from: '',
  to: '',
  view: 'all',
};

const CHANNELS = [
  ['', 'Everything'],
  ['calls', 'Calls'],
  ['texts', 'Texts'],
  ['email', 'Email'],
  ['notes', 'Notes'],
  ['pipeline', 'Pipeline'],
] as const;

/// Matches the calendar lead picker (§2.3), and is short enough that the feed
/// feels like it is filtering as you type rather than after you stop.
const SEARCH_DEBOUNCE_MS = 200;

export function ConversationsClient({
  lists,
}: {
  lists: { id: string; name: string }[];
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tags, setTags] = useState<{ id: string; name: string; count: number }[]>([]);
  const [openContactId, setOpenContactId] = useState<string | null>(null);

  /// Guards against a slow early request landing after a faster later one and
  /// repainting the feed with stale results.
  const requestSeq = useRef(0);

  const buildQuery = useCallback((f: Filters, after?: string | null) => {
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.channel) p.set('channel', f.channel);
    if (f.disposition) p.set('disposition', f.disposition);
    if (f.tagId) p.set('tagId', f.tagId);
    if (f.listId) p.set('listId', f.listId);
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    if (f.view !== 'all') p.set('view', f.view);
    if (after) p.set('cursor', after);
    return p.toString();
  }, []);

  const load = useCallback(
    async (f: Filters) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      try {
        const res = await fetch(`/api/activities?${buildQuery(f)}`);
        const json = await res.json();
        if (seq !== requestSeq.current) return;
        setRows(json.activities ?? []);
        setCursor(json.nextCursor ?? null);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [buildQuery],
  );

  // Debounced on every filter, not just search: clicking through channels
  // quickly should not fire a request per click.
  useEffect(() => {
    const t = setTimeout(() => load(filters), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filters, load]);

  useEffect(() => {
    fetch('/api/tags')
      .then((r) => r.json())
      .then(setTags)
      .catch(() => {});
  }, []);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/activities?${buildQuery(filters, cursor)}`);
      const json = await res.json();
      setRows((prev) => [...prev, ...(json.activities ?? [])]);
      setCursor(json.nextCursor ?? null);
    } finally {
      setLoadingMore(false);
    }
  }

  function set<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  const activeFilterCount = [
    filters.channel,
    filters.disposition,
    filters.tagId,
    filters.listId,
    filters.from,
    filters.to,
  ].filter(Boolean).length;

  return (
    <>
      <PageHeader
        title="Conversations"
        subtitle={
          filters.view === 'removed'
            ? 'Leads removed from the pipeline'
            : 'Calls, texts and email in one feed'
        }
      >
        <input
          className="input w-64 py-1.5 text-xs"
          placeholder="Search notes, messages, transcripts…"
          value={filters.q}
          onChange={(e) => set('q', e.target.value)}
        />
        <button
          className={cn(
            'btn-ghost py-1.5 text-xs',
            filters.view === 'removed' && 'border-amber-700 text-amber-200',
          )}
          onClick={() =>
            set('view', filters.view === 'removed' ? 'all' : 'removed')
          }
        >
          {filters.view === 'removed' ? 'Showing removed' : 'Removed'}
        </button>
      </PageHeader>

      {/* --- filter bar --- */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-ink-800 px-5 py-2">
        {CHANNELS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => set('channel', value)}
            className={cn(
              'rounded-full px-2.5 py-1 text-[11px] transition-colors',
              filters.channel === value
                ? 'bg-brand-500/15 text-brand-300'
                : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200',
            )}
          >
            {label}
          </button>
        ))}

        <span className="mx-1 h-4 w-px bg-ink-800" />

        <select
          className="input w-auto py-1 text-[11px]"
          value={filters.disposition}
          onChange={(e) => set('disposition', e.target.value)}
        >
          <option value="">Any outcome</option>
          {DISPOSITIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>

        <select
          className="input w-auto py-1 text-[11px]"
          value={filters.tagId}
          onChange={(e) => set('tagId', e.target.value)}
        >
          <option value="">Any tag</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.count})
            </option>
          ))}
        </select>

        <select
          className="input w-auto py-1 text-[11px]"
          value={filters.listId}
          onChange={(e) => set('listId', e.target.value)}
        >
          <option value="">Any list</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>

        <input
          type="date"
          className="input w-auto py-1 text-[11px]"
          value={filters.from}
          onChange={(e) => set('from', e.target.value)}
          title="From"
        />
        <input
          type="date"
          className="input w-auto py-1 text-[11px]"
          value={filters.to}
          onChange={(e) => set('to', e.target.value)}
          title="To"
        />

        {(activeFilterCount > 0 || filters.q) && (
          <button
            className="ml-1 text-[11px] text-ink-400 underline hover:text-ink-200"
            onClick={() => setFilters({ ...EMPTY, view: filters.view })}
          >
            Clear
          </button>
        )}
      </div>

      {/* --- feed --- */}
      <div className="scroll-thin flex-1 overflow-y-auto">
        {loading && rows.length === 0 ? (
          <p className="p-5 text-sm text-ink-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-5 text-sm text-ink-500">
            {filters.q
              ? `Nothing matches “${filters.q}”.`
              : filters.view === 'removed'
                ? 'No leads have been removed from the pipeline.'
                : 'Nothing here yet. Dials, texts and emails all land in this feed.'}
          </p>
        ) : (
          <>
            <ol className="divide-y divide-ink-800">
              {rows.map((r) => {
                const name =
                  [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ') ||
                  r.contact.companyName ||
                  formatPhone(r.contact.phone);
                const disposition = r.meta?.disposition as string | undefined;
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => setOpenContactId(r.contact.id)}
                      className="flex w-full items-start gap-3 px-5 py-2.5 text-left transition-colors hover:bg-ink-900"
                    >
                      <span
                        className={cn(
                          'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide',
                          TYPE_TONE[r.type] ?? 'bg-ink-800 text-ink-400',
                        )}
                      >
                        {TYPE_LABEL[r.type] ?? r.type}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-sm font-medium text-ink-100">
                            {name}
                          </span>
                          {r.contact.companyName && name !== r.contact.companyName && (
                            <span className="truncate text-xs text-ink-500">
                              {r.contact.companyName}
                            </span>
                          )}
                          {r.contact.pipelineRemovedAt && (
                            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-300">
                              removed
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-ink-300">
                          {r.summary}
                        </span>
                        {r.body && (
                          <span className="mt-0.5 block truncate text-xs text-ink-500">
                            {r.body}
                          </span>
                        )}
                      </span>

                      <span className="shrink-0 text-right">
                        <span className="block text-[10px] text-ink-500">
                          {new Date(r.createdAt).toLocaleString()}
                        </span>
                        {disposition && (
                          <span className="mt-0.5 block text-[10px] text-ink-400">
                            {dispositionLabel(disposition)}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>

            {cursor && (
              <div className="p-4 text-center">
                <button
                  className="btn-ghost py-1.5 text-xs"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading…' : 'Load older'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <ContactSlideOver
        contactId={openContactId}
        onClose={() => setOpenContactId(null)}
        onChanged={() => load(filters)}
      />
    </>
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
