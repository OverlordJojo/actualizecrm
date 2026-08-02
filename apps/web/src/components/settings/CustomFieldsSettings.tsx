'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

interface Field {
  id: string;
  label: string;
  type: string;
  showOnCard: boolean;
  position: number;
}

/**
 * Settings → Custom Fields.
 *
 * Fields are usually created during an import, when the operator maps a column
 * they want to keep. This is where they are renamed, reordered, and chosen for
 * the Active Lead Card — the card has limited room and only a few fields are
 * worth reading mid-call.
 */
export function CustomFieldsSettings() {
  const [fields, setFields] = useState<Field[] | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<'text' | 'number' | 'date'>('text');
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/custom-fields');
    if (res.ok) setFields(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    const label = newLabel.trim();
    if (!label) return;
    setError(null);
    const res = await fetch('/api/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, type: newType }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? 'Could not add that field.');
      return;
    }
    setNewLabel('');
    load();
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setError(null);
    const res = await fetch(`/api/custom-fields/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) setError((await res.json()).error ?? 'Could not save.');
    load();
  }

  async function move(field: Field, delta: number) {
    if (!fields) return;
    const ordered = [...fields].sort((a, b) => a.position - b.position);
    const i = ordered.findIndex((f) => f.id === field.id);
    const j = i + delta;
    if (j < 0 || j >= ordered.length) return;

    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    // Renumber the whole list rather than swapping two values, so a list that
    // has drifted out of sequence heals itself instead of staying wrong.
    await Promise.all(
      ordered.map((f, index) =>
        fetch(`/api/custom-fields/${f.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: index }),
        }),
      ),
    );
    load();
  }

  async function remove(id: string) {
    if (confirmingDelete !== id) {
      setConfirmingDelete(id);
      return;
    }
    setConfirmingDelete(null);
    await fetch(`/api/custom-fields/${id}`, { method: 'DELETE' });
    load();
  }

  const ordered = (fields ?? []).slice().sort((a, b) => a.position - b.position);
  const onCard = ordered.filter((f) => f.showOnCard).length;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">Custom fields</h2>
        <p className="text-xs text-ink-400">
          Extra columns kept from your imports. {onCard} shown on the Active
          Lead Card.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="panel p-3">
        <div className="mb-3 flex gap-1.5">
          <input
            className="input py-1.5 text-xs"
            placeholder="Field name, e.g. Roof Type"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                create();
              }
            }}
          />
          <select
            className="input w-auto py-1.5 text-xs"
            value={newType}
            onChange={(e) => setNewType(e.target.value as typeof newType)}
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
          </select>
          <button
            className="btn-primary shrink-0 py-1.5 text-xs"
            onClick={create}
            disabled={!newLabel.trim()}
          >
            Add
          </button>
        </div>

        {fields === null ? (
          <p className="text-xs text-ink-500">Loading…</p>
        ) : ordered.length === 0 ? (
          <p className="text-xs text-ink-500">
            No custom fields yet. Importing a spreadsheet with an unmapped
            column is the usual way one gets created.
          </p>
        ) : (
          <ul className="divide-y divide-ink-800 rounded-lg border border-ink-800">
            {ordered.map((f, i) => (
              <li key={f.id} className="flex items-center gap-2 px-3 py-2">
                <label
                  className="flex cursor-pointer items-center gap-1.5"
                  title="Show this field on the Active Lead Card during a call"
                >
                  <input
                    type="checkbox"
                    className="accent-brand-500"
                    checked={f.showOnCard}
                    onChange={(e) => patch(f.id, { showOnCard: e.target.checked })}
                  />
                  <span className="text-[10px] text-ink-500">on card</span>
                </label>

                <input
                  defaultValue={f.label}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== f.label) patch(f.id, { label: next });
                  }}
                  className="min-w-0 flex-1 border-none bg-transparent text-xs text-ink-100 focus:outline-none"
                />

                <span className="shrink-0 text-[10px] text-ink-600">{f.type}</span>

                <button
                  className="shrink-0 text-ink-500 hover:text-ink-200 disabled:opacity-30"
                  onClick={() => move(f, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  className="shrink-0 text-ink-500 hover:text-ink-200 disabled:opacity-30"
                  onClick={() => move(f, 1)}
                  disabled={i === ordered.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  className={cn(
                    'shrink-0 text-xs',
                    confirmingDelete === f.id
                      ? 'font-medium text-red-300'
                      : 'text-red-500 hover:text-red-400',
                  )}
                  onClick={() => remove(f.id)}
                  onBlur={() => setConfirmingDelete(null)}
                >
                  {confirmingDelete === f.id ? 'Really delete?' : 'Delete'}
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-2 text-[11px] text-ink-500">
          Deleting a field removes it from the card and from future imports.
          Values already on your leads are left alone.
        </p>
      </div>
    </section>
  );
}
