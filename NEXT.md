# Where the build stands

Read `CLAUDE.md` first for architecture, env index, and testing rules. This
file is only "what is done, what is left, and what to watch out for".

## Live infrastructure

| Thing | Where | State |
| --- | --- | --- |
| Web app | https://actualizecrm.vercel.app | deployed and **gated** — sign-in required |
| Worker | https://worker-production-8c19.up.railway.app/health | `ok`, current code, drain running |
| Database | Railway Postgres (public URL locally, internal on Railway) | migrated through `20260801020000_inbound_routing` |
| Redis | Railway | BullMQ queue |
| Object storage | Cloudflare R2, bucket `actualizecrm` | read + write verified |
| Repo | github.com/OverlordJojo/actualizecrm | private |

## Deployment state

Both services are deployed and configured.

- **Railway (worker)** — `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`,
  `TELNYX_MESSAGING_PROFILE`, `APP_URL`, the SMTP block and `RESEND_API_KEY`
  are set. Verified live: `jobs.drain` ticks every 20s and
  `calendar.reconcile` fired on schedule **without writing a claim row**, which
  is the repeatable bug staying fixed in production.
- **Vercel (web)** — `AUTH_USERNAME`, `AUTH_PASSWORD_HASH`, `AUTH_SECRET` and
  `WORKER_URL` are set. 16/16 production checks: every page redirects to
  `/login`, every API answers 401, the Telnyx webhook is still reachable, the
  session cookie is HttpOnly **and** Secure, and `/api/sms/send` refuses a
  well-formed body with 403.

**Vercel does not auto-deploy from the GitHub push** — it had not built in five
hours despite commits landing. Deploy explicitly with
`npx vercel deploy --prod --yes --token=$VERCEL_TOKEN`, and remember env vars
are baked at build time.

## Done and tested

- **§0 Architecture** — Postgres, monorepo, BullMQ worker. 18/18 checks.
- **§1 Pipeline** — stages, destination-required deletion, soft delete,
  retention. 21/21 + 8/8 checks.
- **§3.2 / §3.3** — live call timer, `CallProvider`, mini call bar.
  **Still only partially verified** — see the caveat in `CLAUDE.md`.
- **AI pipeline** — Haiku 4.5 extraction, booking verification, analysis,
  objection tagging. Backend complete, **no UI yet** (that is §5.6, below).
- **Recording + transcription** — Telnyx dual-channel → R2 → Deepgram.
- **Sign-in gate** *(new, not in the original spec)* — one operator, one
  credential, no user model. 11/11 checks: pages redirect, APIs 401, forged and
  tampered cookies rejected, the Telnyx webhook stays public.
- **Build step 6 — voicemail drop** — R2 recording library, hotkey V live drop,
  bulk drop through the worker, TCPA acknowledgement gate. 13/13 checks.
- **Build step 7 — Conversations** — unified feed, channel/outcome/tag/list/date
  filters, Removed view, search over notes, message bodies **and transcripts**,
  contact slide-over with inline editing, tags, stage, timeline, transcript and
  recording playback. 20/20 checks.
- **Build step 8 — Email + automations** — visual builder, six triggers, eight
  step types, worker-side execution with a real suspend/resume delay, run log,
  dead letters, templates with merge fields, daily send cap. 24/24 checks.
- **Build step 9 — A2P gate** — live Telnyx brand/campaign check, 403 at the
  route with a valid body, registration checklist with re-check.
- **Add-on A — inbound** — webhook records inbound calls, creates unknown
  callers as leads with `source=inbound`, missed calls become callback tasks due
  in an hour, per-number routing toggle, browser Answer/Decline and screen-pop.
  9/9 checks on the server path.
- **§3.1 — dialer card** — every field an inline input, 500ms debounce, saved
  indicator, errors surfaced without discarding what was typed.
- **§2 Calendar** — Google OAuth with an AES-256-GCM encrypted refresh token,
  calendar picker, month/week/day views, trigram lead picker that includes
  removed leads, the §2.4 booking format, and a real `calendar.reconcile`.
  12/12 checks plus timezone arithmetic verified over 400 consecutive days.
- **§7 Analytics** — twelve metrics with Owner Connect Rate as the headline,
  eight presets plus a custom range, prior-period comparison in percentage
  *points* for rates, funnel, hour heatmap, per-number table, AI accept rate.
  6/6 checks.
- **§5.6 Voice AI surfaces** — suggestion chips split at 0.85 confidence with
  the evidence quote on hover, booking proposals that populate the panel and
  never book, per-field auto-apply opt-in (all off by default).
- **Add-on C — daily brief** — BullMQ job with a send window and a per-day
  marker, week-over-week spam-label warning. 5/5 guard checks; no email sent.
- **§4.4 abandonment governor** — rolling 30-day rate over human answers, 2%
  reduces the burst, 3% hard-blocks, no override, CSV export. 7/7 checks.
- **Build step 10 — Settings** — Dialer, Voice AI, Transcription, Daily brief
  and Data (CSV export for all six tables). 4/4 checks.
- **§5.6 complete** — suggestion chips, booking proposals, the live transcript
  pane (Telnyx streams during the call; Deepgram replaces it afterwards), and
  the pulsing stage outline with a permanent manual-choice lockout. 9/9 checks.
- **Build step 10 — Custom fields** — add, rename, reorder, choose which show
  on the Active Lead Card. Deleting a definition leaves the values on the
  leads. 7/7 checks.
- **§4 Multi-line** — bursts of up to 3 legs, each from a different owned
  number with premium AMD; machines/faxes/IVRs disposed of silently; the first
  human transferred to the softphone; every additional human held behind an
  identification prompt; the oldest hold bridged ahead of any new burst; a
  10-second worker sweep that retires anyone past the limit. 18/18 queue and
  governor checks, plus 16/16 threshold boundaries pinned at 1.99/2.00/2.99/
  3.00%.

## Two bugs found and fixed this session

**Every repeatable worker job ran exactly once, ever.** `claim()` deduped on the
constant `repeat:<type>` key, so the second occurrence found a completed run and
skipped itself — permanently, and silently. `calendar.reconcile` is scheduled
every 15 minutes and had *one* run in a full day. Fixed in
`apps/worker/src/processor.ts`: scheduled occurrences no longer take an
idempotency claim, because housekeeping jobs are idempotent by construction,
while anything enqueued on demand still dedupes exactly as before.

**Nothing drained `ScheduledJob`.** `packages/db` documents the contract as "the
app writes a row here and the worker picks it up", and no code picked them up.
Added `jobs.drain` (every 20s) in `apps/worker/src/jobs/scheduled.ts`, with
stale-claim recovery.

## Not built

Nothing from the original spec is outstanding. Pipelines and stages are managed
from the kanban rather than a Settings section, which is where they are used and
where the operator already edits them.

## Waiting on a human

These cannot be automated — the rule against test calls to the operator is
absolute, and sending real email needs the operator's say-so.

1. **§3.3 acceptance test.** One unbroken call across all five other pages.
2. **Hotkey V live drop.** Upload a recording, dial your own cell, press V,
   confirm the message plays and the call hangs up on its own.
3. **A bulk drop of one lead** to your own number, to prove the worker
   originates and the app plays.
4. **Settings → Email → Send test.** Nothing in this session sent email; the
   whole path is untested against a live SMTP server.
5. **An inbound call to +1 702 745 8779** — confirm the browser rings, the
   slide-over pops, and Answer/Decline work.
6. **Connect Google Calendar** in Settings → Calendar and make one booking.
   Signing into a Google account is yours to do, not something to automate.
   Everything up to the consent screen is tested; the event write is not.
7. **Switch on the daily brief** in Settings and wait one morning. The guards
   are tested; no brief has actually been sent, because that is an email.
8. **A two-line burst.** Set Lines per burst to 2 in Settings → Dialer, load a
   queue containing your own cell plus one other number you control, and start
   a session. Confirm: both ring, the first answer reaches your softphone
   without you pressing Answer, the second hears the identification prompt, the
   held count appears in Region B, and the next advance bridges the held caller
   rather than dialing anyone new. Then let one sit past the hold limit and
   confirm it hangs up with the apology and lands in the abandoned CSV. This is
   the one piece of §4 that only proves out against real simultaneous calls.

## The Google OAuth consent screen

If connecting the calendar reports *"has not completed the Google verification
process… can only be accessed by developer-approved testers"*, the OAuth app is
in **Testing** publishing status. Two fixes, and the second is the one that
lasts:

1. **Add yourself as a test user** — Google Cloud console → APIs & Services →
   OAuth consent screen → Test users → Add. Works immediately, but **Google
   expires refresh tokens after seven days** for apps in Testing, so the
   calendar silently breaks once a week.
2. **Publish the app** — same screen → *Publish app* → status becomes
   *In production*. Verification is only required to remove the "Google hasn't
   verified this app" interstitial, which the sole operator clicks through once
   via **Advanced → Go to actualizecrm.vercel.app**. Refresh tokens then stop
   expiring. This is the right answer for a single-operator app.

The app now notices when Google rejects the stored grant and shows a
**reconnect** state in Settings → Calendar rather than continuing to claim it
is connected — that silent weekly failure is exactly what option 1 causes.

## Traps already paid for

Each of these cost real time. They are also in `CLAUDE.md`.

- **Never place automated test calls to the operator.** Call-path verification
  is a human step.
- **The worker compiles against `packages/db/dist`,** not its source. That dist
  is gitignored and was stale. `apps/worker`'s `dev` and `build` scripts now
  build the shared package first — do not remove that step.
- **Next.js route files may only export handlers.** Exporting a constant from
  `api/automations/route.ts` failed the build with a type error that never named
  the real problem. Shared constants live in `lib/`.
- **Vercel bakes env vars at build time.** Setting one does nothing until a
  build completes.
- **Detached `&` deploys die with the shell.** Use a tracked background task.
- **Prompt caching is a no-op on Haiku 4.5** — 4096-token minimum.
- **Railway gives two URLs per database.** Local needs the `*.proxy.rlwy.net`
  one.
- **Spotify: check the client ID first.** A wrong one reports a redirect_uri
  error and sends you down the wrong path for hours.
- **React StrictMode double-invokes effects.** The Telnyx client is a module
  singleton for this reason.
- **The Telnyx SDK emits both `hangup` and `destroy`.** Handling both fires
  `onEnded` twice and silently skips a lead per call.
- **`/connections/{id}` is read-only.** Updating needs the type-specific path.
- **DND / iOS "Silence Unknown Callers"** send test calls straight to voicemail.
- **This runtime's tzdata has `America/Vancouver` on permanent PDT from
  8 March 2026.** Not a bug and not something the app decides — everything
  resolves through `OPERATOR_TIMEZONE` and stays internally consistent — but do
  not write a test that assumes two DST transitions a year. Assert that the
  helpers agree with tzdata, not what tzdata ought to say.

## Test harnesses

In the session scratchpad, not the repo — they are plain scripts against the
running app and the real database. Every one of them cleans up after itself;
keep that property, because they run against production data.

A CDP screenshot helper lives at `scratchpad/shot.mjs`. It takes
`--login user:pass` because every page is now behind the gate.
