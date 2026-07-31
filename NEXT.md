# Where the build stands

Read `CLAUDE.md` first for architecture, env index, and testing rules. This
file is only "what is done, what is left, and what to watch out for".

## Live infrastructure

| Thing | Where | State |
| --- | --- | --- |
| Web app | https://actualizecrm.vercel.app | deployed, all routes 200 |
| Worker | https://worker-production-8c19.up.railway.app/health | `ok` |
| Database | Railway Postgres (public URL locally, internal on Railway) | v1 data migrated, 18/18 tables |
| Redis | Railway | BullMQ queue, 3 repeatables scheduled |
| Object storage | Cloudflare R2, bucket `actualizecrm` | read + write verified |
| Repo | github.com/OverlordJojo/actualizecrm | private |

## Done and tested

- **§0 Architecture** — Postgres migration, monorepo, BullMQ worker. 18/18 checks
  (health, auth, idempotency, dead-letter, retention sweep, analytics rollup).
- **§1 Pipeline** — New/Callback/Interested/Booked, destination-required stage
  deletion, not-interested soft delete, retention rules. 21/21 + 8/8 checks.
- **§3.2 / §3.3** — live call timer, `CallProvider` in the root layout, mini
  call bar. **Partially verified** — see the caveat in `CLAUDE.md`.
- **AI pipeline** — Haiku 4.5 extraction (§5.4 prompt verbatim), two-pass
  booking verification, end-of-call analysis, objection auto-tagging,
  accept/dismiss suggestions. Backend complete, **no UI**.
- **Recording + transcription** — Telnyx dual-channel → R2 → Deepgram
  multichannel. Wired to the `call.recording.saved` webhook.
- **Import, kanban drag & drop, ringback synthesis, Spotify** — from v1, all
  tested.

## Not built

| Section | Notes |
| --- | --- |
| **§2 Calendar** | Google OAuth creds are in `.env.local`. `Booking` model exists. Needs: OAuth routes, calendar page, searchable lead picker (pg_trgm indexes are already migrated), §2.4 booking format, `calendar.reconcile` job body — the job is registered and currently a no-op. |
| **§7 Analytics UI** | `DailyMetrics` model and the nightly rollup job both exist and work. Only the page is missing: period selector, comparison math (percentage *points* for rate metrics), funnel, heatmap, per-number table. |
| **§4 Multi-line** | Highest risk, spec says build last. `Call.burstId` / `heldSeconds` / `amdResult` columns exist. AMD config helper is in `integrations/telnyx/recording.ts`. |
| **§5 UI surfaces** | Transcript pane, suggestion chips, stage-suggestion pulse. Backend and API routes are done — `/api/ai/suggestions` GET and POST. |
| **ADD-ON A** | Inbound calls. `Call.direction` exists. Depends on `CallProvider`. |
| **ADD-ON C** | Daily brief email. Belongs on the worker as a BullMQ job, not `node-cron` (see `apps/worker/CLAUDE.md`). |

## Traps already paid for

Each of these cost real time. They are also in `CLAUDE.md`.

- **Never place automated test calls to the operator.** Two harnesses that did
  are disabled. Call-path verification is a human step.
- **Vercel bakes env vars at build time.** Setting a variable does nothing
  until a build completes. Use `vercel redeploy <url>` — it rebuilds with
  current env vars and needs no upload.
- **Detached `&` deploys die with the shell.** Three deploys hung in `UNKNOWN`
  this way. Use a tracked background task.
- **Prompt caching is a no-op on Haiku 4.5** — 4096-token minimum, the §5.4
  prompt is ~1200. The regex gate in `integrations/ai/prompts.ts` is what keeps
  cost down, not caching.
- **Railway gives two URLs per database.** `.railway.internal` resolves only
  inside Railway; local needs the `*.proxy.rlwy.net` public one.
- **Spotify needs the client ID checked first.** A wrong client ID produces
  `redirect_uri: Not matching configuration`, which reads as a URI problem and
  sends you down the wrong path for hours. Compare the dashboard's client ID
  against `.env.local` before touching redirect URIs.
- **React StrictMode double-invokes effects.** The Telnyx client is a module
  singleton for this reason.
- **The Telnyx SDK emits both `hangup` and `destroy`.** Handling both fires
  `onEnded` twice and silently skips a lead per call.
- **`/connections/{id}` is read-only.** Updating needs the type-specific path.
- **DND / iOS "Silence Unknown Callers"** send test calls straight to
  voicemail. Symptom is a call reporting Connected after ~5s.

## Test harnesses

In the session scratchpad, not the repo. Re-create as needed — they are all
plain Node scripts hitting the running app:
`test-import.js`, `test-drag.js`, `test-pipeline-v2.js`, `test-retention.js`,
`test-worker.js`, `test-ringback.js`, `test-ai-stack.js`.
The two disabled call-placing ones are prefixed `DISABLED-`.
