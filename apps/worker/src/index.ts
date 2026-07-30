import http from 'node:http';
import { db } from '@actualizecrm/db';
import {
  makeWorker,
  queue,
  enqueue,
  scheduleRepeatables,
  connection,
  type JobData,
} from './queue';
import { claim, markDone, markFailed } from './idempotency';
import { runRetentionSweep } from './jobs/retention';
import { rollupDay } from './jobs/analytics';

/**
 * ActualizeCRM automation worker.
 *
 * Runs on Railway, 24/7, so scheduled work happens whether or not the
 * operator's MacBook is open. It does no dialing and has no UI — the local app
 * owns everything interactive.
 */

const PORT = Number(process.env.PORT ?? 8080);

/// Last successful run per job type, surfaced on /health.
const lastSuccess: Record<string, string> = {};

const worker = makeWorker(async (job) => {
  const data = job.data as JobData;
  const { type, jobKey } = data;

  console.log(`[job] ${type} key=${jobKey} attempt=${job.attemptsMade + 1}`);

  const c = await claim(jobKey, data.payload?.contactId as string | undefined);
  if (c.alreadyDone) {
    console.log(`[job] ${type} key=${jobKey} already completed — skipping`);
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
        // Implemented alongside §2; a no-op until the operator connects a
        // Google account, rather than a hard failure that fills the DLQ.
        result = { skipped: 'calendar not connected' };
        break;

      case 'automation.execute':
      case 'sms.send':
      case 'email.send':
      case 'daily.brief':
        result = { pending: `${type} handler not yet implemented` };
        break;

      default:
        throw new Error(`Unknown job type: ${type}`);
    }

    await markDone(c.runId, [{ at: new Date().toISOString(), result }]);
    lastSuccess[type] = new Date().toISOString();
    return result;
  } catch (err) {
    await markFailed(c.runId, err);
    throw err;
  }
});

// Exhausted retries go to a dead-letter table the Automations page reads.
worker.on('failed', async (job, err) => {
  if (!job) return;
  const attemptsAllowed = job.opts.attempts ?? 1;
  if (job.attemptsMade < attemptsAllowed) return;

  console.error(`[dlq] ${job.name} exhausted retries: ${err.message}`);
  await db.failedJob
    .create({
      data: {
        type: job.data.type,
        jobKey: job.data.jobKey,
        payload: (job.data.payload ?? {}) as never,
        error: err.message,
        stackTrace: err.stack ?? null,
        attempts: job.attemptsMade,
      },
    })
    .catch((e) => console.error('[dlq] could not record failure', e));
});

worker.on('error', (err) => console.error('[worker] error', err));

// --- health -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    let dbOk = false;
    let dbError: string | null = null;
    try {
      // $queryRawUnsafe with a literal, not a tagged template: the tagged form
      // is rewritten by the transpiler in a way that Prisma rejects here, and
      // a swallowed error made this report "unreachable" while every real
      // query in the same process succeeded.
      await db.$queryRawUnsafe('SELECT 1');
      dbOk = true;
    } catch (e) {
      dbError = e instanceof Error ? e.message.split('\n')[0] : String(e);
    }

    const counts = await queue
      .getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
      .catch(() => null);

    const healthy = dbOk && counts !== null;

    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          status: healthy ? 'ok' : 'degraded',
          database: dbOk ? 'connected' : `unreachable: ${dbError}`,
          redis: counts ? 'connected' : 'unreachable',
          queue: counts,
          lastSuccess,
          uptimeSeconds: Math.round(process.uptime()),
        },
        null,
        2,
      ),
    );
    return;
  }

  // "Run this now" from the UI. The only path where the app talks to the
  // worker directly; everything else goes through Postgres rows.
  if (req.url === '/jobs/enqueue' && req.method === 'POST') {
    const secret = req.headers['x-worker-secret'];
    if (!secret || secret !== process.env.WORKER_SHARED_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body) as JobData;
        if (!parsed.type || !parsed.jobKey) {
          throw new Error('type and jobKey are required');
        }
        await enqueue(parsed);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enqueued: true, jobKey: parsed.jobKey }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

async function main() {
  await scheduleRepeatables();
  server.listen(PORT, () => {
    console.log(`[worker] health on :${PORT}/health`);
  });
}

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} — draining`);
  // Let in-flight jobs finish so a deploy does not abandon half-done work.
  await worker.close();
  await queue.close();
  await connection.quit().catch(() => {});
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  console.error('[worker] failed to start', err);
  process.exit(1);
});
