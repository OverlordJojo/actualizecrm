
export * from '@prisma/client';

/**
 * The operator's timezone. Vancouver — Pacific.
 *
 * Defined once and shared by both services because it is not a display
 * preference: analytics day boundaries, cron schedules, retention clocks and
 * booking conversions all resolve against it. Two services disagreeing about
 * where midnight falls silently corrupts every period comparison.
 *
 * `America/Vancouver` rather than `America/Los_Angeles`. The two are
 * identical in offset and DST rules, but the calendar this app books into is
 * Vancouver, and one canonical name avoids a reader having to check whether
 * the two ever diverge.
 */
export const OPERATOR_TIMEZONE = 'America/Vancouver';

export * from './client';
export * from './settings';
export * from './merge';
