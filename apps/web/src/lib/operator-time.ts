import { OPERATOR_TIMEZONE } from '@actualizecrm/db';

/**
 * Date arithmetic in the operator's timezone.
 *
 * Every boundary in this app — a calendar day, an analytics period, a booking
 * slot — is a boundary in `America/Vancouver`, not in UTC and not in whatever
 * zone the browser happens to be in. Getting this wrong does not throw; it
 * quietly files a 5pm dial on the following day and corrupts every comparison
 * built on top of it.
 *
 * These helpers work in absolute instants and only use the zone to decide where
 * the boundaries fall, so they stay correct across DST.
 */

export { OPERATOR_TIMEZONE };

/// The zone's UTC offset in milliseconds at a given instant, DST included.
function offsetMs(at: Date, tz = OPERATOR_TIMEZONE): number {
  // `hourCycle: 'h23'` rather than `hour12: false`: the latter renders midnight
  // as "24" in several locales, which then needs a modulo to undo. h23 is
  // defined as 0–23, so there is nothing to undo and nothing to get wrong.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(
    n('year'),
    n('month') - 1,
    n('day'),
    n('hour'),
    n('minute'),
    n('second'),
  );
  return asUtc - at.getTime();
}

/// The calendar date in the operator's zone, as `YYYY-MM-DD`.
export function operatorDateKey(at: Date, tz = OPERATOR_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/// Midnight starting the operator's day that contains `at`, as a UTC instant.
export function startOfOperatorDay(at: Date, tz = OPERATOR_TIMEZONE): Date {
  const [y, m, d] = operatorDateKey(at, tz).split('-').map(Number);
  return operatorLocalToUtc(y, m, d, 0, 0, tz);
}

export function endOfOperatorDay(at: Date, tz = OPERATOR_TIMEZONE): Date {
  return new Date(addOperatorDays(startOfOperatorDay(at, tz), 1).getTime() - 1);
}

/**
 * A wall-clock time in the operator's zone, converted to an absolute instant.
 *
 * Two passes: guess with the offset at the naive instant, then re-measure at
 * the result. One pass is wrong for times near a DST transition, which is
 * exactly when a booking made for "9am" would otherwise land at 8 or 10.
 */
export function operatorLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz = OPERATOR_TIMEZONE,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = new Date(naive - offsetMs(new Date(naive), tz));
  return new Date(naive - offsetMs(firstGuess, tz));
}

/**
 * The **start** of the operator's day `days` after the one containing `at`.
 *
 * Note that it normalises to midnight rather than preserving the time of day —
 * the calendar grid and the analytics periods both want day boundaries, and
 * every caller here does. It also steps by calendar date rather than by
 * 86,400,000ms, so the day containing a DST change still advances by exactly
 * one day instead of drifting an hour.
 */
export function addOperatorDays(at: Date, days: number, tz = OPERATOR_TIMEZONE): Date {
  const [y, m, d] = operatorDateKey(at, tz).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return operatorLocalToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    0,
    0,
    tz,
  );
}

/// Monday-based week start, matching how a working week is planned.
export function startOfOperatorWeek(at: Date, tz = OPERATOR_TIMEZONE): Date {
  const start = startOfOperatorDay(at, tz);
  // Derive the weekday from the calendar date arithmetically rather than by
  // matching English weekday abbreviations, which breaks the moment anything
  // formats in another locale.
  const [y, m, d] = operatorDateKey(start, tz).split('-').map(Number);
  const sundayBased = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  // Monday-based: a working week is planned Monday to Friday.
  const mondayBased = (sundayBased + 6) % 7;
  return addOperatorDays(start, -mondayBased, tz);
}

export function startOfOperatorMonth(at: Date, tz = OPERATOR_TIMEZONE): Date {
  const [y, m] = operatorDateKey(at, tz).split('-').map(Number);
  return operatorLocalToUtc(y, m, 1, 0, 0, tz);
}

export function addOperatorMonths(at: Date, months: number, tz = OPERATOR_TIMEZONE): Date {
  const [y, m] = operatorDateKey(at, tz).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1 + months, 1));
  return operatorLocalToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    1,
    0,
    0,
    tz,
  );
}

/// Hour of day (0–23) in the operator's zone.
export function operatorHour(at: Date, tz = OPERATOR_TIMEZONE): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
  }).formatToParts(at);
  return Number(parts.find((p) => p.type === 'hour')!.value);
}

export function formatOperatorTime(at: Date, tz = OPERATOR_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

export function formatOperatorDateTime(at: Date, tz = OPERATOR_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

/// Short zone label for the UI, e.g. "PDT".
export function operatorZoneLabel(at = new Date(), tz = OPERATOR_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'short',
  }).formatToParts(at);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz;
}
