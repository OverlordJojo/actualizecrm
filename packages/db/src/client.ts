import { PrismaClient } from '@prisma/client';

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
