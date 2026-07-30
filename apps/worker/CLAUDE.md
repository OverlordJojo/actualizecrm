# apps/worker

The Railway-hosted automation service. **No UI, no dialing, no Telnyx voice.**

Its entire reason to exist: the operator closes the MacBook at 6pm, and a
follow-up SMS scheduled for 9am the next morning still has to send.

## What this module does

| Job | Schedule | What it does |
| --- | --- | --- |
| `automation.execute` | on demand | Runs a trigger → delay → action chain |
| `retention.sweep` | 03:00 PT daily | Deletes conversation history per §1.4 |
| `calendar.reconcile` | every 15 min | Pulls Google Calendar edits back into the app |
| `analytics.rollup` | 03:30 PT daily | Writes `DailyMetrics` for the Analytics page |
| `daily.brief` | configurable | Emails the operator a summary of the day |
| `sms.send` / `email.send` | on demand | Scheduled sends |

## Env vars this folder owns

| Key | What it is |
| --- | --- |
| `DATABASE_URL` | Postgres. On Railway use the **private** URL; locally use the public one |
| `REDIS_URL` | Railway Redis, backs the BullMQ queue |
| `WORKER_SHARED_SECRET` | Authenticates `POST /jobs/enqueue` from the local app |
| `PORT` | Railway sets this; defaults to 8080 |

## Design decisions worth not re-litigating

**BullMQ, not node-cron.** An in-process scheduler keeps pending jobs in
memory. Railway redeploys on every push, so an in-memory schedule silently
loses every job that had not yet fired — and the failure is invisible, because
nothing errors. BullMQ persists to Redis, so a job scheduled for 3am survives a
2am deploy.

**Idempotency is mandatory, not defensive.** Railway can restart a container
mid-job, and the queue will redeliver. Without a guard, a restart during an
automation that sends SMS sends it twice: the prospect notices, and it costs
money. Every job carries a deterministic `jobKey`; `src/idempotency.ts` records
it before doing work and refuses to repeat a key that already completed.

**The app never calls the worker.** The local app writes rows to Postgres and
the worker picks them up. This means the worker does not care whether the
MacBook is on, and there is no connection to keep alive. The single exception
is `POST /jobs/enqueue` for "run this now" from the UI.

**Everything is UTC.** The worker's clock is UTC and stays that way. Schedules
are stored in UTC and rendered in `America/Vancouver`. BullMQ's `tz` option
handles DST so we never do date arithmetic against a server clock — that is
how you end up firing everything an hour early for half the year.

**Failures are visible.** Five attempts with exponential backoff, then a row in
`FailedJob` surfaced on the Automations page. A job that dies silently is worse
than one that dies loudly.

## Setup — click by click

### 1. Create the Railway services

1. Go to <https://railway.app>, sign in, **New Project**.
2. **Add Postgres**: New → Database → PostgreSQL.
3. **Add Redis**: New → Database → Redis.
4. **Set the region to US West** for both. Project Settings → Region.
   The operator and Telnyx's media servers are both on the west coast; an
   east-coast database adds latency to every query made during a live call.

### 2. Get the connection URLs — read this carefully

Railway gives each database **two** URLs, and picking the wrong one is the
single most common setup mistake:

- `DATABASE_URL` — hostname ends in **`.railway.internal`**. Only resolvable
  from inside Railway's network. Use this for the deployed worker.
- `DATABASE_PUBLIC_URL` — hostname ends in **`.proxy.rlwy.net`** or similar,
  with a high port number. Reachable from anywhere. **The local MacBook needs
  this one.**

To find it: click the Postgres service → **Variables** tab → copy
`DATABASE_PUBLIC_URL`. Same for Redis → `REDIS_PUBLIC_URL`.

Put the **public** URLs in your local `.env.local`. The deployed worker gets
the **private** ones automatically via Railway's variable references.

> If `npx prisma migrate dev` fails with
> `P1001: Can't reach database server at postgres.railway.internal:5432`,
> you have the internal URL in your local env. That is exactly this mistake.

### 3. Deploy the worker

1. Railway → New → **GitHub Repo** → select this repo.
2. Settings → **Root Directory**: `apps/worker`
3. Settings → **Build Command**: `npm install && npm run build --workspace @actualizecrm/worker`
4. Settings → **Start Command**: `npm run start --workspace @actualizecrm/worker`
5. Variables → reference the database URLs:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `REDIS_URL` = `${{Redis.REDIS_URL}}`
   - `WORKER_SHARED_SECRET` = same 64-char value as your local `.env.local`
6. Settings → Networking → **Generate Domain**. Note the URL.

### 4. Monitor it

Point a free UptimeRobot monitor at `https://<your-worker>.up.railway.app/health`
on a 5-minute interval. `/health` returns 503 when Postgres or Redis is
unreachable, so the monitor catches a broken worker before a missed follow-up
does.

---

## Testing end to end

**1. Laptop-closed execution** ← the one that matters
1. Create an automation scheduled 20 minutes out.
2. **Fully shut down the MacBook**, not just close the lid.
3. Reopen after the scheduled time.
4. Verify from the run log that it executed at the correct time, not on wake.

**2. Survives redeploy**
Schedule a job 10 minutes out. Push a trivial change to trigger a Railway
redeploy while it is pending. Verify it still fires on time.

**3. Idempotency**
```bash
curl -X POST https://<worker>/jobs/enqueue \
  -H "x-worker-secret: $WORKER_SHARED_SECRET" \
  -H "content-type: application/json" \
  -d '{"type":"analytics.rollup","jobKey":"manual-test-1"}'
```
Run it twice. Verify exactly one `AutomationRun` row with that key, and that
the second call logs "already completed — skipping".

**4. Redis interruption**
In the Railway dashboard, restart the Redis service. Watch the worker logs for
about 60 seconds. Jobs must resume, and nothing enqueued during the outage may
be lost.

**5. Health endpoint**
`curl https://<worker>/health` returns queue depth, last success per job type,
and DB connectivity. Stop Postgres and confirm it flips to 503.
