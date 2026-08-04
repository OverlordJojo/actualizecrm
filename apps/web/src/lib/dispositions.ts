/**
 * Call outcomes (§3.5).
 *
 * Exactly four are selectable, and they map one-to-one onto the pipeline
 * stages. That correspondence is the point: an outcome the operator picks is a
 * decision about where the lead goes next, so there is no second step to
 * forget and no way for the outcome and the board to disagree.
 *
 * **"No Answer" and "Voicemail" are deliberately not here.** They are machine
 * facts — AMD verdicts and leg state — not human judgements, and offering them
 * as buttons invited the operator to guess at something the system already
 * knows for certain. They are still recorded, automatically, and still appear
 * in the timeline and in analytics; they are simply not choices.
 *
 * These strings land in `Call.disposition` and `Contact.lastDisposition` and
 * are what automation triggers match against, so add rather than rename — a
 * renamed value orphans every existing row.
 */

export type DispositionValue =
  | 'not_interested'
  | 'callback'
  | 'interested'
  | 'booked'
  // Machine-determined. Never operator-selectable, so none has a hotkey and
  // none appears among the outcome buttons.
  | 'no_answer'
  | 'voicemail'
  | 'automated_system'
  | 'abandoned'
  | 'failed';

export interface Disposition {
  value: DispositionValue;
  /// Operator language. Never telecom jargon.
  label: string;
  hotkey: '1' | '2' | '3' | '4';
  color: string;
  /// Counts as a connect for the connect-rate stat.
  isConnect: boolean;
  /// The stage this outcome moves the lead to. `null` means trash it per §3.3
  /// — removed from the board, history kept forever.
  stageName: string | null;
}

export const DISPOSITIONS: Disposition[] = [
  {
    value: 'not_interested',
    label: 'Not Interested',
    hotkey: '1',
    color: '#ef4444',
    isConnect: true,
    stageName: null,
  },
  {
    value: 'callback',
    label: 'Callback',
    hotkey: '2',
    color: '#f59e0b',
    isConnect: true,
    stageName: 'Callback',
  },
  {
    value: 'interested',
    label: 'Interested',
    hotkey: '3',
    color: '#3b82f6',
    isConnect: true,
    stageName: 'Interested',
  },
  {
    value: 'booked',
    label: 'Booked',
    hotkey: '4',
    color: '#22c55e',
    isConnect: true,
    stageName: 'Booked',
  },
];

/**
 * Outcomes the dialer records on its own.
 *
 * An IVR or a fax tone is not something the operator saw, and an abandoned call
 * is something they must never be notified about mid-session — it happens
 * precisely because they were busy. `failed` exists so a carrier rejection is
 * never mistaken for a prospect saying no (§3.4).
 */
export const SYSTEM_DISPOSITIONS: Disposition[] = [
  {
    value: 'no_answer',
    label: 'No Answer',
    hotkey: '0' as Disposition['hotkey'],
    color: '#64748b',
    isConnect: false,
    stageName: null,
  },
  {
    value: 'voicemail',
    label: 'Voicemail',
    hotkey: '0' as Disposition['hotkey'],
    color: '#8b5cf6',
    isConnect: false,
    stageName: null,
  },
  {
    value: 'automated_system',
    label: 'Automated System',
    hotkey: '0' as Disposition['hotkey'],
    color: '#64748b',
    isConnect: false,
    stageName: null,
  },
  {
    value: 'abandoned',
    label: 'Abandoned',
    hotkey: '0' as Disposition['hotkey'],
    color: '#dc2626',
    isConnect: true,
    stageName: null,
  },
  {
    value: 'failed',
    label: 'Call Failed',
    hotkey: '0' as Disposition['hotkey'],
    color: '#f97316',
    isConnect: false,
    stageName: null,
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

/**
 * Hangup causes that must never auto-trash a lead (§3.4).
 *
 * A dropped call, a misdial or a carrier rejection is not a prospect declining.
 * Auto-trashing on those would quietly destroy leads for reasons that have
 * nothing to do with the prospect, and the operator would have no idea it had
 * happened. These are dispositioned `failed` and left in New for a retry.
 */
const CARRIER_FAILURE_CAUSES = new Set([
  'call_rejected',
  'unallocated_number',
  'invalid_number_format',
  'network_out_of_order',
  'no_route_destination',
  'service_unavailable',
  'recovery_on_timer_expire',
  'destination_out_of_order',
]);

export function isCarrierFailure(cause?: string | null): boolean {
  return cause ? CARRIER_FAILURE_CAUSES.has(cause.toLowerCase()) : false;
}
