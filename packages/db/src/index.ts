import { PrismaClient } from '@prisma/client';

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

/**
 * Shared Prisma client for both services.
 *
 * The web app hot-reloads in dev, and the worker is long-lived; both would
 * otherwise accumulate connections until Postgres refuses new ones. Railway's
 * starter Postgres allows relatively few connections, so this matters more
 * here than it did against local SQLite.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
