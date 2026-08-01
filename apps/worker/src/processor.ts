import type { Job } from 'bullmq';
import type { JobData } from './queue';
import { claim, markDone, markFailed } from './idempotency';
import { runRetentionSweep } from './jobs/retention';
import { rollupDay } from './jobs/analytics';
import { drainScheduledJobs, markScheduledDone } from './jobs/scheduled';
import { runVoicemailDrop, type VoicemailDropPayload } from './jobs/voicemail';
import {
  runAutomation,
  type AutomationExecutePayload,
} from './jobs/automations';
import { sendEmail } from './lib/mailer';
import { sendSms } from './lib/sms';
import { reconcileCalendar } from './jobs/calendar';

/**
 * What the worker actually does with a job.
 *
 * Separated from `index.ts` so it can be exercised without booting the HTTP
 * server or holding a Redis connection open. The dispatch rules here — which
 * jobs dedupe and which do not — are the kind of thing that fails silently, so
 * they need to be testable directly.
 */

/// Last successful run per job type, surfaced on /health.
export const lastSuccess: Record<string, string> = {};

/**
 * Whether this job needs an idempotency record.
 *
 * Repeatable jobs are enqueued once with a **constant** `jobKey` and then fire
 * on a schedule. Claiming against that key meant the first occurrence completed
 * and every later one found a completed run and skipped itself — permanently.
 * The symptom was silent: `calendar.reconcile` is scheduled every 15 minutes
 * and had exactly one run to show for a full day, with nothing in the logs to
 * say the rest had been suppressed.
 *
 * The guard exists for work with real-world side effects — sending an SMS twice
 * costs money and the prospect notices. Scheduled housekeeping is idempotent by
 * construction instead: the rollup upserts by date, the sweep re-queries, and
 * the drain claims each row atomically. So occurrences of a repeatable run
 * unguarded, while anything enqueued on demand (including a manual
 * `analytics.rollup` with its own key) still dedupes exactly as before.
 */
export function needsIdempotencyClaim(jobKey: string, type?: string): boolean {
  // An automation carries its own ledger — the `AutomationRun` row, with the
  // step index it has reached. Claiming here as well would create a *second*
  // run row for the same automation and make the run log lie about how many
  // times it fired.
  if (type === 'automation.execute') return false;
  return !jobKey.startsWith('repeat:');
}

/// The subset of a BullMQ job this processor reads, so tests do not have to
/// fabricate a whole Job instance.
export type ProcessableJob = Pick<Job<JobData>, 'data'> & {
  attemptsMade?: number;
};

export async function processJob(job: ProcessableJob): Promise<unknown> {
  const data = job.data as JobData;
  const { type, jobKey } = data;
  const payload = (data.payload ?? {}) as Record<string, unknown>;
  const scheduledJobId = payload.scheduledJobId as string | undefined;

  // The drain is pure plumbing and runs every 20 seconds; giving it a run log
  // would bury every real automation under thousands of empty rows.
  if (type === 'jobs.drain') {
    const drained = await drainScheduledJobs();
    if (drained.claimed || drained.requeuedStale) {
      console.log(
        `[drain] claimed=${drained.claimed} requeued-stale=${drained.requeuedStale}`,
      );
    }
    lastSuccess[type] = new Date().toISOString();
    return drained;
  }

  console.log(`[job] ${type} key=${jobKey} attempt=${(job.attemptsMade ?? 0) + 1}`);

  const c = needsIdempotencyClaim(jobKey, type)
    ? await claim(jobKey, payload.contactId as string | undefined)
    : null;

  if (c?.alreadyDone) {
    console.log(`[job] ${type} key=${jobKey} already completed — skipping`);
    if (scheduledJobId) await markScheduledDone(scheduledJobId);
    return { skipped: true };
  }

  try {
    let result: unknown = null;

    switch (type) {
      case 'retention.sweep':
        result = await runRetentionSweep();
        break;

      case 'analytics.rollup':
        await rollupDay();
        result = { rolledUp: true };
        break;

      case 'calendar.reconcile':
        result = await reconcileCalendar();
        break;

      case 'voicemail.drop':
        result = await runVoicemailDrop(payload as unknown as VoicemailDropPayload);
        break;

      case 'automation.execute':
        result = await runAutomation(
          payload as unknown as AutomationExecutePayload,
        );
        break;

      case 'email.send':
        result = await sendEmail({
          contactId: payload.contactId as string,
          subject: (payload.subject as string) ?? '(no subject)',
          body: (payload.body as string) ?? '',
          templateName: payload.templateName as string | undefined,
          toOverride: payload.toOverride as string | undefined,
        });
        break;

      case 'sms.send':
        result = await sendSms({
          contactId: payload.contactId as string,
          body: (payload.body as string) ?? '',
          templateName: payload.templateName as string | undefined,
        });
        break;

      case 'daily.brief':
        result = { pending: `${type} handler not yet implemented` };
        break;

      default:
        throw new Error(`Unknown job type: ${type}`);
    }

    if (c) await markDone(c.runId, [{ at: new Date().toISOString(), result }]);
    if (scheduledJobId) await markScheduledDone(scheduledJobId);
    lastSuccess[type] = new Date().toISOString();
    return result;
  } catch (err) {
    if (c) await markFailed(c.runId, err);
    throw err;
  }
}
