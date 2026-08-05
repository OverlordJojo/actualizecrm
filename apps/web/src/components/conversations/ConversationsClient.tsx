'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/PageHeader';
import { cn } from '@/lib/cn';
import { DISPOSITIONS, dispositionLabel } from '@/lib/dispositions';

/**
 * Conversations — one tab, one row per contact (§7.1, §7.2).
 *
 * The tabs are gone. Everything / Calls / Texts / Emails / Notes / Pipelines
 * split one question into six answers, and the operator's question is never
 * "show me my texts" — it is "who have I been talking to, and what happened
 * last". A single list ordered by recency answers that, and a channel filter
 * would only put it back.
 *
 * List-based filtering is gone entirely, including the idea. An import still
 * carries a source label for provenance, but "which spreadsheet did this come
 * from" is not a dimension anybody works along.
 *
 * Three filters remain — outcome, tag, stage — plus search. That is not a
 * reduction for tidiness: each of the three answers a question the operator
 * actually asks, and every one removed was answering a question they do not.
 */

interface Row {
  id: string;
  name: string;
  company: string | null;
  jobTitle: string | null;
  phone: string;
  email: string | null;
  stageName: string | null;
  stageColor: string | null;
  removed: boolean;
  lastDisposition: string | null;
  lastAt: string | null;
  preview: string | null;
  lastType: string | null;
}

const SEARCH_DEBOUNCE_MS = 200;

export function ConversationsClient() {
  const [q, setQ] = useState('');
  const [outcome, setOutcome] = useState('');
  const [tagId, setTagId] = useState('');
  const [stageId, setStageId] = useState('');

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);

  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [stages, setStages] = useState<{ id: string; name: string }[]>([]);

  /// Guards against a slow early request landing after a faster later one and
  /// repainting the list with stale results.
  const seq = useRef(0);

  const load = useCallback(
    async (offset: number, append: boolean) => {
      const mine = ++seq.current;
      if (append) setLoadingMore(true);
      else setLoading(true);

      const p = new URLSearchParams();
      if (q) p.set('q', q);
      if (outcome) p.set('outcome', outcome);
      if (tagId) p.set('tagId', tagId);
      if (stageId) p.set('stageId', stageId);
      if (offset) p.set('offset', String(offset));

      try {
        const res = await fetch(`/api/conversations?${p}`);
        if (!res.ok || mine !== seq.current) return;
        const json = await res.json();
        setRows((prev) => (append ? [...prev, ...json.rows] : json.rows));
        setHasMore(json.hasMore);
        setNextOffset(json.nextOffset);
      } finally {
        if (mine === seq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [q, outcome, tagId, stageId],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(0, false), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    fetch('/api/tags')
      .then((r) => r.json())
      .then((t) => setTags(Array.isArray(t) ? t : []))
      .catch(() => {});
    fetch('/api/stages')
      .then((r) => r.json())
      .then((s) => setStages(Array.isArray(s) ? s : []))
      .catch(() => {});
  }, []);

  const filtered = Boolean(q || outcome || tagId || stageId);

  return (
    <>
      <PageHeader
        title="Conversations"
        subtitle="Everyone you have spoken to, most recent first"
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5">
        <input
          className="input w-64 py-1.5 text-xs"
          placeholder="Search name, company, title, phone, email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        <select
          className="input w-auto py-1.5 text-xs"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
        >
          <option value="">Any outcome</option>
          {DISPOSITIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
          <option value="voicemail">Voicemail</option>
          <option value="no_answer">No Answer</option>
        </select>

        <select
          className="input w-auto py-1.5 text-xs"
          value={stageId}
          onChange={(e) => setStageId(e.target.value)}
        >
          <option value="">Any stage</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <select
          className="input w-auto py-1.5 text-xs"
          value={tagId}
          onChange={(e) => setTagId(e.target.value)}
        >
          <option value="">Any tag</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>

        {filtered && (
          <button
            className="text-xs text-ink-500 underline"
            onClick={() => {
              setQ('');
              setOutcome('');
              setTagId('');
              setStageId('');
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <p className="py-8 text-center text-sm text-ink-600">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-600">
            {filtered ? 'Nobody matches those filters.' : 'No conversations yet.'}
          </p>
        ) : (
          <ul className="divide-y divide-ink-850">
            {rows.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/conversations/${r.id}`}
                  className="flex items-center gap-3 px-1 py-2.5 transition-colors hover:bg-ink-900/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium text-ink-100">
                        {r.name}
                      </span>
                      {r.company && (
                        <span className="truncate text-xs text-ink-500">
                          {r.company}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-ink-500">
                      {r.preview ?? 'No interactions yet'}
                    </p>
                  </div>

                  {r.lastDisposition && (
                    <span className="shrink-0 text-[10px] text-ink-500">
                      {dispositionLabel(r.lastDisposition)}
                    </span>
                  )}

                  {/* Stage, or the fact that they were removed. A trashed lead
                      is still searchable forever (§7.6) and the badge is how
                      the operator knows which they are looking at. */}
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                      r.removed
                        ? 'bg-ink-850 text-ink-500'
                        : 'bg-ink-800 text-ink-300',
                    )}
                    style={
                      !r.removed && r.stageColor
                        ? { color: r.stageColor, backgroundColor: `${r.stageColor}1a` }
                        : undefined
                    }
                  >
                    {r.removed ? 'Removed' : (r.stageName ?? 'No stage')}
                  </span>

                  <span className="w-16 shrink-0 text-right text-[10px] tabular-nums text-ink-600">
                    {relative(r.lastAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {hasMore && (
          <button
            className="btn-ghost mt-3 w-full py-1.5 text-xs"
            onClick={() => void load(nextOffset, true)}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </>
  );
}

/// Relative time, coarse on purpose. "3d" is what the operator needs; the exact
/// timestamp is one click away in the thread.
function relative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}
