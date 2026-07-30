/**
 * The Prisma client moved to packages/db in v2 so the Railway worker can share
 * the same schema and connection handling.
 *
 * This module stays as the app's import point, so every route handler and
 * server component that already did `import { db } from '@/lib/db'` kept
 * working across the monorepo split.
 */
export { db } from '@actualizecrm/db';
