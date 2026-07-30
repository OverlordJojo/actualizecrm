'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  CORE_FIELDS,
  CUSTOM_FIELD_PREFIX,
  type FieldMapping,
  type ImportReport,
  type MappingMode,
} from '@/integrations/import/types';

interface CustomField {
  id: string;
  label: string;
  type: string;
}

interface PreviewResponse {
  fileName: string;
  sheetName: string;
  availableSheets: string[];
  headers: string[];
  preview: Record<string, string>[];
  rows: Record<string, string>[];
  totalRows: number;
  guessedMapping: Record<string, string>;
}

type Step = 'upload' | 'map' | 'done';

export function ImportModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported?: (report: ImportReport) => void;
}) {
  const [step, setStep] = useState<Step>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [data, setData] = useState<PreviewResponse | null>(null);
  const [listName, setListName] = useState('');
  const [mappings, setMappings] = useState<Record<string, FieldMapping>>({});
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [report, setReport] = useState<ImportReport | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStep('upload');
    setBusy(false);
    setError(null);
    setData(null);
    setListName('');
    setMappings({});
    setReport(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    fetch('/api/custom-fields')
      .then((r) => r.json())
      .then(setCustomFields)
      .catch(() => setCustomFields([]));
  }, [open]);

  // Esc closes, but not mid-import — losing a half-written mapping to a stray
  // keypress is infuriating.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy]);

  function handleClose() {
    reset();
    onClose();
  }

  async function uploadFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);

      const res = await fetch('/api/import/preview', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not read that file.');

      const preview = json as PreviewResponse;
      setData(preview);

      // Pre-fill from the guess; anything unguessed starts as Ignore.
      const initial: Record<string, FieldMapping> = {};
      for (const f of CORE_FIELDS) {
        const guessed = preview.guessedMapping[f.key];
        initial[f.key] = guessed
          ? { mode: 'column', column: guessed }
          : { mode: 'ignore' };
      }
      setMappings(initial);

      setListName(file.name.replace(/\.[^.]+$/, ''));
      setStep('map');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listName,
          sourceFile: data.fileName,
          mappings,
          rows: data.rows,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Import failed.');

      setReport(json as ImportReport);
      setStep('done');
      onImported?.(json as ImportReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  async function addCustomField(label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    const res = await fetch('/api/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: trimmed }),
    });
    if (!res.ok) return;
    const field: CustomField = await res.json();

    setCustomFields((prev) =>
      prev.some((f) => f.id === field.id) ? prev : [...prev, field],
    );
    setMappings((prev) => ({
      ...prev,
      [`${CUSTOM_FIELD_PREFIX}${field.id}`]: { mode: 'ignore' },
    }));
  }

  const phoneReady = useMemo(() => {
    const m = mappings.phone;
    return m?.mode === 'column' && !!m.column;
  }, [mappings]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="panel flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between border-b border-ink-800 px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold">Import leads</h2>
            {data && step === 'map' && (
              <p className="text-xs text-ink-400">
                {data.fileName} · {data.totalRows.toLocaleString()} rows
              </p>
            )}
          </div>
          <button
            onClick={handleClose}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100 disabled:opacity-40"
          >
            ✕
          </button>
        </header>

        <div className="scroll-thin flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-4 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}

          {step === 'upload' && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) uploadFile(file);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                'flex h-64 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed transition-colors',
                dragging
                  ? 'border-brand-500 bg-brand-500/5'
                  : 'border-ink-700 hover:border-ink-600 hover:bg-ink-850',
              )}
            >
              <p className="text-sm font-medium text-ink-200">
                {busy ? 'Reading file…' : 'Drop a spreadsheet here'}
              </p>
              <p className="text-xs text-ink-400">
                .csv, .xlsx, or Apple .numbers — or click to browse
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls,.numbers"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadFile(file);
                  e.target.value = '';
                }}
              />
            </div>
          )}

          {step === 'map' && data && (
            <MappingStep
              data={data}
              mappings={mappings}
              setMappings={setMappings}
              customFields={customFields}
              onAddCustomField={addCustomField}
              listName={listName}
              setListName={setListName}
            />
          )}

          {step === 'done' && report && <ReportStep report={report} />}
        </div>

        <footer className="flex shrink-0 items-center justify-between border-t border-ink-800 px-5 py-3">
          <div className="text-xs text-ink-400">
            {step === 'map' && !phoneReady && (
              <span className="text-amber-400">
                Map a column to Phone to continue
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {step === 'map' && (
              <>
                <button className="btn-ghost" onClick={reset} disabled={busy}>
                  Back
                </button>
                <button
                  className="btn-primary"
                  onClick={commit}
                  disabled={busy || !phoneReady || !listName.trim()}
                >
                  {busy ? 'Importing…' : `Import ${data?.totalRows ?? 0} rows`}
                </button>
              </>
            )}
            {step === 'done' && (
              <button className="btn-primary" onClick={handleClose}>
                Done
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MappingStep({
  data,
  mappings,
  setMappings,
  customFields,
  onAddCustomField,
  listName,
  setListName,
}: {
  data: PreviewResponse;
  mappings: Record<string, FieldMapping>;
  setMappings: React.Dispatch<React.SetStateAction<Record<string, FieldMapping>>>;
  customFields: CustomField[];
  onAddCustomField: (label: string) => void;
  listName: string;
  setListName: (v: string) => void;
}) {
  const [newFieldLabel, setNewFieldLabel] = useState('');

  const update = (key: string, patch: Partial<FieldMapping>) =>
    setMappings((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const rows = [
    ...CORE_FIELDS.map((f) => ({
      key: f.key as string,
      label: f.label,
      required: f.required,
    })),
    ...customFields.map((f) => ({
      key: `${CUSTOM_FIELD_PREFIX}${f.id}`,
      label: f.label,
      required: false,
    })),
  ];

  return (
    <div className="space-y-5">
      <div className="max-w-sm">
        <label className="label">List name</label>
        <input
          className="input"
          value={listName}
          onChange={(e) => setListName(e.target.value)}
          placeholder="e.g. Henderson roofers — July"
        />
        <p className="mt-1 text-xs text-ink-500">
          Load this list as a dial session later from the Dialer page.
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Map fields
        </h3>
        <div className="space-y-1.5">
          {rows.map((row) => {
            const mapping = mappings[row.key] ?? { mode: 'ignore' as MappingMode };
            return (
              <div
                key={row.key}
                className="grid grid-cols-[170px_150px_1fr] items-center gap-2 rounded-lg bg-ink-850 px-3 py-2"
              >
                <div className="text-sm text-ink-200">
                  {row.label}
                  {row.required && <span className="ml-1 text-amber-400">*</span>}
                </div>

                <select
                  className="input py-1.5"
                  value={mapping.mode}
                  onChange={(e) =>
                    update(row.key, { mode: e.target.value as MappingMode })
                  }
                >
                  <option value="column">Map to column</option>
                  <option value="ignore">Ignore</option>
                  <option value="fixed">Fixed value</option>
                </select>

                {mapping.mode === 'column' && (
                  <select
                    className="input py-1.5"
                    value={mapping.column ?? ''}
                    onChange={(e) => update(row.key, { column: e.target.value })}
                  >
                    <option value="">Pick a column…</option>
                    {data.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                )}

                {mapping.mode === 'fixed' && (
                  <input
                    className="input py-1.5"
                    placeholder="Written to every lead in this import"
                    value={mapping.fixedValue ?? ''}
                    onChange={(e) => update(row.key, { fixedValue: e.target.value })}
                  />
                )}

                {mapping.mode === 'ignore' && (
                  <span className="text-xs text-ink-500">Left blank</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex gap-2">
          <input
            className="input max-w-xs py-1.5"
            placeholder="New custom field, e.g. Roof Type"
            value={newFieldLabel}
            onChange={(e) => setNewFieldLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onAddCustomField(newFieldLabel);
                setNewFieldLabel('');
              }
            }}
          />
          <button
            className="btn-ghost"
            onClick={() => {
              onAddCustomField(newFieldLabel);
              setNewFieldLabel('');
            }}
            disabled={!newFieldLabel.trim()}
          >
            Add field
          </button>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
          First {data.preview.length} rows
        </h3>
        <div className="scroll-thin overflow-x-auto rounded-lg border border-ink-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-ink-850 text-ink-300">
              <tr>
                {data.headers.map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-ink-400">
              {data.preview.map((row, i) => (
                <tr key={i} className="border-t border-ink-800">
                  {data.headers.map((h) => (
                    <td key={h} className="whitespace-nowrap px-3 py-1.5">
                      {row[h]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ReportStep({ report }: { report: ImportReport }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Added" value={report.added} tone="good" />
        <Stat label="Merged" value={report.merged} tone="neutral" />
        <Stat label="Rejected" value={report.rejected} tone={report.rejected ? 'bad' : 'neutral'} />
      </div>

      <p className="text-sm text-ink-300">
        Imported into list <span className="font-medium text-ink-100">{report.listName}</span>.
      </p>

      {report.rejectedRows.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
            Rejected rows
          </h3>
          <div className="scroll-thin max-h-64 overflow-y-auto rounded-lg border border-ink-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-ink-850 text-ink-300">
                <tr>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="text-ink-400">
                {report.rejectedRows.map((r) => (
                  <tr key={r.rowNumber} className="border-t border-ink-800">
                    <td className="px-3 py-1.5 font-mono">{r.rowNumber}</td>
                    <td className="px-3 py-1.5 font-mono">{r.rawPhone || '—'}</td>
                    <td className="px-3 py-1.5">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'good' | 'bad' | 'neutral';
}) {
  return (
    <div className="rounded-lg bg-ink-850 px-4 py-3">
      <div
        className={cn(
          'text-2xl font-semibold tabular-nums',
          tone === 'good' && 'text-green-400',
          tone === 'bad' && 'text-red-400',
          tone === 'neutral' && 'text-ink-200',
        )}
      >
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-ink-400">{label}</div>
    </div>
  );
}
