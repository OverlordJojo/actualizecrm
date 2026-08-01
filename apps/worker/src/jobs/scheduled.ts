import { db } from '@actualizecrm/db';
import { enqueue, type JobType } from '../queue';

/**
 * Moves due `ScheduledJob` rows into the BullMQ queue.
 *
 * This is the missing half of the contract described in `packages/db`: the app
 * "writes a row here and the worker picks it up". Nothing was picking them up.
 * The app deliberately does not call the worker — that is what lets the worker
 * not care whether the MacBook is on — so something has to poll, and this is it.
 *
 * Rows are claimed one at a time with a status guard rather than in a single
 * `updateMany`, so two overlapping drains cannot both enqueue the same row: the
 * loser's update matches zero rows and it moves on.
 */

const BATCH = 200;

/// A claim older than this is assumed to belong to a worker that died between
/// claiming the row and enqueueing it, and is returned to the pool.
const STALE_CLAIM_MS = 10 * 60 * 1000;

/// Matches BullMQ's own retry budget; past this the row stops being retried
/// rather than cycling forever.
const MAX_ATTEMPTS = 5;

export interface DrainResult {
  claimed: number;
  requeuedStale: number;
}

export async function drainScheduledJobs(): Promise<DrainResult> {
  const result: DrainResult = { claimed: 0, requeuedStale: 0 };

  // Recover anything stranded mid-claim before looking for new work, so a
  // crashed deploy's jobs go out on the next tick rather than never.
  const stale = await db.scheduledJob.updateMany({
    where: {
      status: 'claimed',
      attempts: { lt: MAX_ATTEMPTS },
      createdAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) },
    },
    data: { status: 'pending' },
  });
  result.requeuedStale = stale.count;

  const due = await db.scheduledJob.findMany({
    where: { status: 'pending', runAt: { lte: new Date() } },
    orderBy: { runAt: 'asc' },
    take: BATCH,
  });

  for (const row of due) {
    const won = await db.scheduledJob.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'claimed', attempts: { increment: 1 } },
    });
    if (won.count === 0) continue;

    try {
      await enqueue({
        type: row.type as JobType,
        jobKey: row.jobKey,
        payload: {
          ...((row.payload ?? {}) as Record<string, unknown>),
          // Lets the processor close the row out when the work succeeds.
          scheduledJobId: row.id,
        },
      });
      result.claimed++;
    } catch (err) {
      // Could not reach Redis. Put it back rather than losing it; the next
      // drain will try again.
      await db.scheduledJob.updateMany({
        where: { id: row.id, status: 'claimed' },
        data: { status: 'pending' },
      });
      throw err;
    }
  }

  return result;
}

/// Called by the processor once the underlying work actually succeeded.
export async function markScheduledDone(scheduledJobId: string): Promise<void> {
  await db.scheduledJob
    .update({
      where: { id: scheduledJobId },
      data: { status: 'done', completedAt: new Date() },
    })
    .catch(() => {
      // The row may have been swept; the work is done either way.
    });
}

/// Called when retries are exhausted, so a dead job is visible as dead rather
/// than sitting in `claimed` looking like it is still running.
export async function markScheduledFailed(scheduledJobId: string): Promise<void> {
  await db.scheduledJob
    .update({
      where: { id: scheduledJobId },
      data: { status: 'failed', completedAt: new Date() },
    })
    .catch(() => {});
}
