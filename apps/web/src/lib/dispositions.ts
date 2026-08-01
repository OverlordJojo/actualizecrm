/// The five outcomes the operator can set, in hotkey order (1-5).
/// These strings are what land in Call.disposition and Contact.lastDisposition,
/// and what automation triggers match against — changing a `value` here
/// orphans existing rows, so add rather than rename.

export type DispositionValue =
  | 'no_answer'
  | 'voicemail'
  | 'not_interested'
  | 'callback'
  | 'booked'
  // Set by the multi-line dialer, never by the operator, so neither has a
  // hotkey and neither appears among the outcome buttons.
  | 'automated_system'
  | 'abandoned';

export interface Disposition {
  value: DispositionValue;
  /// Operator language. Never telecom jargon.
  label: string;
  hotkey: '1' | '2' | '3' | '4' | '5';
  color: string;
  /// Counts as a connect for the connect-rate stat.
  isConnect: boolean;
}

export const DISPOSITIONS: Disposition[] = [
  {
    value: 'no_answer',
    label: 'No Answer',
    hotkey: '1',
    color: '#64748b',
    isConnect: false,
  },
  {
    value: 'voicemail',
    label: 'Voicemail',
    hotkey: '2',
    color: '#8b5cf6',
    isConnect: false,
  },
  {
    value: 'not_interested',
    label: 'Not Interested',
    hotkey: '3',
    color: '#ef4444',
    isConnect: true,
  },
  {
    value: 'callback',
    label: 'Callback',
    hotkey: '4',
    color: '#f59e0b',
    isConnect: true,
  },
  {
    value: 'booked',
    label: 'Booked',
    hotkey: '5',
    color: '#22c55e',
    isConnect: true,
  },
];

/**
 * Outcomes the dialer records on its own (§4.3).
 *
 * An IVR or a fax tone is not something the operator saw, and an abandoned
 * call is something they must never be notified about mid-session — it happens
 * precisely because they were busy. Both still need a name in the timeline and
 * in analytics, so they exist here without a hotkey and are filtered out of
 * the outcome buttons.
 */
export const SYSTEM_DISPOSITIONS: Disposition[] = [
  {
    value: 'automated_system',
    label: 'Automated System',
    hotkey: '0' as Disposition['hotkey'],
    color: '#64748b',
    isConnect: false,
  },
  {
    value: 'abandoned',
    label: 'Abandoned',
    hotkey: '0' as Disposition['hotkey'],
    color: '#dc2626',
    isConnect: true,
  },
];

export const DISPOSITION_BY_VALUE: Record<DispositionValue, Disposition> =
  Object.fromEntries(
    [...DISPOSITIONS, ...SYSTEM_DISPOSITIONS].map((d) => [d.value, d]),
  ) as Record<DispositionValue, Disposition>;

export const DISPOSITION_BY_HOTKEY: Record<string, Disposition> =
  Object.fromEntries(DISPOSITIONS.map((d) => [d.hotkey, d]));

export function dispositionLabel(value?: string | null): string {
  if (!value) return '—';
  return DISPOSITION_BY_VALUE[value as DispositionValue]?.label ?? value;
}

export function isDisposition(value: string): value is DispositionValue {
  return value in DISPOSITION_BY_VALUE;
}
