import { Queue, Worker, type JobsOptions, type Processor } from 'bullmq';
import IORedis from 'ioredis';
import { OPERATOR_TIMEZONE } from '@actualizecrm/db';

/**
 * BullMQ setup.
 *
 * Why not node-cron: an in-process scheduler loses every pending job on
 * redeploy, and Railway redeploys on every push. BullMQ persists the queue in
 * Redis, so a job scheduled for 3am still fires after a 2am deploy.
 */

export const QUEUE_NAME = 'actualizecrm';

export type JobType =
  | 'automation.execute'
  | 'retention.sweep'
  | 'calendar.reconcile'
  | 'analytics.rollup'
  | 'daily.brief'
  | 'sms.send'
  | 'email.send';

export interface JobData {
  type: JobType;
  /// Deterministic key; the processor exits early if this key already ran.
  jobKey: string;
  payload?: Record<string, unknown>;
}

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      'REDIS_URL is not set. The worker cannot schedule anything without Redis.',
    );
  }
  return url;
}

/// BullMQ requires maxRetriesPerRequest: null on the blocking connection.
export const connection = new IORedis(redisUrl(), {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Keep retrying rather than throwing; a 60-second Redis blip must not kill
  // the worker or lose jobs.
  retryStrategy: (times) => Math.min(times * 500, 10_000),
});

export const queue = new Queue<JobData>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 60 * 60 * 24 * 7, count: 5_000 },
    // Keep failures around; they are surfaced on the Automations page.
    removeOnFail: false,
  },
});

export function makeWorker(processor: Processor<JobData>) {
  return new Worker<JobData>(QUEUE_NAME, processor, {
    connection,
    concurrency: 4,
  });
}

export async function enqueue(
  data: JobData,
  opts: JobsOptions = {},
): Promise<void> {
  await queue.add(data.type, data, {
    // BullMQ dedupes on job id, which gives us a second layer of idempotency
    // on top of the AutomationRun check inside the processor.
    jobId: data.jobKey,
    ...opts,
  });
}

/**
 * Registers the recurring jobs.
 *
 * Cron expressions run in UTC because the worker's clock is UTC. The comments
 * give the America/Vancouver equivalent, which shifts by an hour across DST —
 * `tz` makes BullMQ handle that rather than us doing date maths.
 */
export async function scheduleRepeatables(): Promise<void> {
  const TZ = OPERATOR_TIMEZONE;

  const repeatables: Array<{ type: JobType; pattern: string; note: string }> = [
    { type: 'retention.sweep', pattern: '0 3 * * *', note: '03:00 PT daily' },
    { type: 'analytics.rollup', pattern: '30 3 * * *', note: '03:30 PT daily' },
    { type: 'calendar.reconcile', pattern: '*/15 * * * *', note: 'every 15 min' },
  ];

  for (const r of repeatables) {
    await queue.add(
      r.type,
      { type: r.type, jobKey: `repeat:${r.type}` },
      {
        repeat: { pattern: r.pattern, tz: TZ },
        jobId: `repeat:${r.type}`,
      },
    );
    console.log(`[queue] scheduled ${r.type} — ${r.note}`);
  }
}
