'use client';

import { useState } from 'react';
import { toE164 } from '@/lib/phone';

/**
 * Create Lead (§3.8).
 *
 * Every mappable field, including Job Title, so a lead typed in by hand is not
 * a second-class one missing whatever the import happened to carry. It saves
 * into New, like every other route a lead can arrive by (§3.1).
 *
 * Phone is the only required field, because it is the dedupe key and the only
 * thing you cannot dial without. Everything else can be filled in from the call
 * itself.
 */

interface Fields {
  firstName: string;
  lastName: string;
  jobTitle: string;
  companyName: string;
  companyLocation: string;
  phone: string;
  email: string;
  address: string;
  dealValue: string;
  notes: string;
}

const EMPTY: Fields = {
  firstName: '',
  lastName: '',
  jobTitle: '',
  companyName: '',
  companyLocation: '',
  phone: '',
  email: '',
  address: '',
  dealValue: '',
  notes: '',
};

export function CreateLeadModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [f, setF] = useState<Fields>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));

  const phoneValid = toE164(f.phone) !== null;

  async function save() {
    if (!phoneValid) {
      setError('That phone number is not one we can dial.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...f,
          phone: toE164(f.phone),
          dealValue: f.dealValue ? Number(f.dealValue) : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save that lead.');
      setF(EMPTY);
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that lead.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-ink-700 bg-ink-900 p-5">
        <h2 className="text-sm font-semibold text-ink-100">Create lead</h2>
        <p className="mt-0.5 text-xs text-ink-400">
          Saves into New, at the top of the dial queue.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <Field label="First name" value={f.firstName} onChange={set('firstName')} />
          <Field label="Last name" value={f.lastName} onChange={set('lastName')} />
          <Field label="Job title" value={f.jobTitle} onChange={set('jobTitle')} />
          <Field label="Company" value={f.companyName} onChange={set('companyName')} />
          <Field
            label="Phone"
            value={f.phone}
            onChange={set('phone')}
            required
            invalid={f.phone.length > 0 && !phoneValid}
            mono
          />
          <Field label="Email" value={f.email} onChange={set('email')} />
          <Field label="Location" value={f.companyLocation} onChange={set('companyLocation')} />
          <Field label="Deal value" value={f.dealValue} onChange={set('dealValue')} />
          <div className="col-span-2">
            <Field label="Address" value={f.address} onChange={set('address')} />
          </div>
          <div className="col-span-2">
            <Field label="Notes" value={f.notes} onChange={set('notes')} />
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost text-xs" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn-primary text-xs"
            onClick={save}
            disabled={saving || !phoneValid}
          >
            {saving ? 'Saving…' : 'Create lead'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  invalid,
  mono,
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
  invalid?: boolean;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-ink-500">
        {label}
        {required && <span className="ml-0.5 text-red-400">*</span>}
      </span>
      <input
        className={`input py-1.5 text-xs ${mono ? 'font-mono' : ''} ${
          invalid ? 'border-red-700' : ''
        }`}
        value={value}
        onChange={onChange}
      />
    </label>
  );
}
