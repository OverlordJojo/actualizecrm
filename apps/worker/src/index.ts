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
import { markScheduledFailed } from './jobs/scheduled';
import { processJob, lastSuccess } from './processor';
import { handleTelnyxWebhook } from './telnyx/receiver';
import { runWebhookProbe } from './telnyx/probe';
import { registerWebhook, lastRegistration } from './telnyx/register';
import {
  WEBHOOK_PATH,
  webhookUrl,
  signingKeyStatus,
} from '@actualizecrm/telephony';

/**
 * ActualizeCRM automation worker.
 *
 * Runs on Railway, 24/7, so scheduled work happens whether or not the
 * operator's MacBook is open. It does no dialing and has no UI — the local app
 * owns everything interactive.
 *
 * This file is wiring only: queue, health endpoint, shutdown. What a job
 * actually does lives in `processor.ts`, which is importable without opening a
 * Redis connection or binding a port.
 */

const PORT = Number(process.env.PORT ?? 8080);

const worker = makeWorker((job) => processJob(job));

// Exhausted retries go to a dead-letter table the Automations page reads.
worker.on('failed', async (job, err) => {
  if (!job) return;
  const attemptsAllowed = job.opts.attempts ?? 1;
  if (job.attemptsMade < attemptsAllowed) return;

  console.error(`[dlq] ${job.name} exhausted retries: ${err.message}`);

  // A dead job must not sit in `claimed` looking like it is still running.
  const scheduledJobId = job.data.payload?.scheduledJobId as string | undefined;
  if (scheduledJobId) await markScheduledFailed(scheduledJobId);

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
  // Telnyx call events (§1.2). First, because it is the highest-volume route
  // here and the only one with a latency budget — Telnyx times out fast and
  // retries anything slow. The handler authenticates by ed25519 signature; it
  // is deliberately not behind the shared secret, because Telnyx cannot send
  // one.
  if (req.url === WEBHOOK_PATH && req.method === 'POST') {
    await handleTelnyxWebhook(req, res);
    return;
  }

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
          // Whether Telnyx knows where to send events, without reading logs.
          telnyxWebhook: lastRegistration,
          // Whether this process can verify a signature at all. Reports the
          // key's state, never the key. "I already set it" is usually true and
          // set somewhere that is not this service, so make it checkable from
          // outside rather than arguable.
          telnyxSigningKey: signingKeyStatus(),
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

  // The Settings round-trip test (§1.2). Secret-gated: it originates a real
  // leg, so it must not be something the public internet can trigger.
  if (req.url === '/telnyx/test-webhook' && req.method === 'POST') {
    if (req.headers['x-worker-secret'] !== process.env.WORKER_SHARED_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const result = await runWebhookProbe().catch((err) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));

    // 200 either way: the request succeeded, and the *test* result is the body.
    // A non-2xx here would be indistinguishable from the app failing to reach
    // the worker at all, which is a different problem with a different fix.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...result, registration: lastRegistration }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

async function main() {
  await scheduleRepeatables();

  // Point Telnyx at this deployment before serving (§1.2). Deliberately not
  // fatal: a Telnyx outage at boot must not stop the worker from running
  // automations, which is what it exists for. The failure is logged and
  // surfaced by the Settings test rather than crash-looping the service.
  await registerWebhook();

  server.listen(PORT, () => {
    console.log(`[worker] health on :${PORT}/health`);
    console.log(`[worker] telnyx events on :${PORT}${WEBHOOK_PATH}`);
    const url = webhookUrl();
    if (!url) {
      console.warn(
        '[worker] no public webhook URL — set WEBHOOK_BASE_URL locally, or ' +
          'expect RAILWAY_PUBLIC_DOMAIN in a Railway deploy.',
      );
    }
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
