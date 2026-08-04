# ActualizeCRM

A cold-calling CRM for **one operator**. v2.

> The name "DialDeck" appears in some planning documents. It is not a real
> thing — the project is and always was ActualizeCRM.

## The v2 shape, and why

v1 was local-first: SQLite in a file, everything on one machine, works on a
plane. v2 gave that up for exactly one reason — **scheduled automations have to
fire while the MacBook is closed.** A follow-up SMS queued for 9am is worthless
if it only sends when the laptop is next opened.

That single requirement forces the rest: a remote worker needs a remote
database, so SQLite became Postgres, so the repo became two services. This is a
real tradeoff, not an upgrade. The dialer now needs network connectivity to do
anything at all.

There is still no user/org/account model anywhere. Single-operator by design.
**Do not add orgs, roles, invite flows, or a `userId` on anything.** If a change
seems to need a `userId`, it is solving the wrong problem.

### The one exception: the sign-in gate

The app is deployed at a public URL with every lead, recording and transcript
behind it, so there is a single-credential gate — added deliberately, on the
operator's instruction, and scoped so it does not become a user model.

- `AUTH_USERNAME`, `AUTH_PASSWORD_HASH` (`salt:scryptHash`, never plaintext) and
  `AUTH_SECRET` in the environment. No `User` table, no roles, no invites.
- `src/middleware.ts` gates everything except `/login`, the auth routes, PWA
  plumbing, and **`/api/telnyx/webhook`** — Telnyx cannot log in, and gating it
  breaks call records, voicemail drops and inbound calls in a way that reads as
  a telephony fault rather than an auth change.
- APIs answer `401`; pages redirect. A fetch that got an HTML login page with a
  `200` on it would look like success and fail much later.
- `src/lib/session.ts` is Web Crypto only, because middleware runs on the Edge
  runtime. `src/lib/auth.ts` holds the `node:crypto` scrypt verification and is
  imported solely by the login route.

`AppShell` chooses between the shell and the bare login page. Its authenticated
branch is written out once and never varies in shape, so React reconciles
`<CallProvider>` to the same position on every navigation and does not remount
it — see the call-survival rule below.

---

## Layout

```
actualizecrm/
├── packages/
│   ├── db/          ★  Prisma schema + client, shared by both services
│   └── telephony/      Telnyx REST + webhook signature, shared by both
├── apps/
│   ├── web/            Next.js dialer — deployed to Vercel
│   └── worker/      ★  Railway service — automations, sweeps, rollups, and
│                       the Telnyx webhook
├── services/
│   └── voice-ai/    ★  Local Python sidecar — Whisper STT + Ollama extraction
├── scripts/            Telnyx config verifier, SQLite→Postgres import
└── data/               local audio, recordings, v1 SQLite backup (gitignored)
```

★ = has its own `CLAUDE.md` with setup written for a non-developer. Read it
before touching the folder.

Inside `apps/web/src/integrations/` the v1 modules still apply and still have
their own `CLAUDE.md`: `telnyx`, `audio`, `email`, `messaging`, `import`.

## Run commands

```bash
npm run dev            # Next.js on :3000 (the dialer)
npm run voice-ai       # local Whisper/Ollama sidecar on :8787
npm run worker:dev     # worker locally (normally it runs on Railway)
npm run verify-telnyx  # pass/fail table for the Telnyx portal config (§0.4)

npm run db:migrate       # apply schema changes
npm run db:seed          # default pipeline and stages
npm run db:import-sqlite # one-time v1 import
npm run db:studio        # browse data

npm run typecheck    # both services

# Both apps compile against packages/db and packages/telephony's *built*
# output, so every build and typecheck script builds those first. Do not
# remove that.
```

**There is no tunnel.** Call events go to the deployed worker, which registers
its own address with Telnyx on boot — see "Webhook delivery" below.

---

## Env var index

Every key and the folder that owns it. Setup instructions live in the owning
folder's `CLAUDE.md`.

| Key | Owned by |
| --- | --- |
| `DATABASE_URL` | `packages/db` — Postgres. **Public** URL locally, private on Railway |
| `REDIS_URL` | `apps/worker` — BullMQ backing store |
| `WORKER_SHARED_SECRET` | `apps/worker` — auth for `POST /jobs/enqueue` |
| `TELNYX_API_KEY` | `apps/web/src/integrations/telnyx` — **also required on Railway** |
| `TELNYX_CONNECTION_ID` | `apps/web/src/integrations/telnyx` — **also required on Railway** |
| `TELNYX_PUBLIC_KEY` | `apps/worker` — verifies webhook signatures. Not the API key |
| `TELNYX_MESSAGING_PROFILE` | `apps/web/src/integrations/messaging` |
| `SPOTIFY_CLIENT_ID` / `_SECRET` | `apps/web/src/integrations/audio` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | `apps/web` calendar — OAuth, `calendar.events` |
| `CALENDAR_ENCRYPTION_KEY` | `apps/web` calendar — AES-256-GCM, 32 bytes hex |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` | **`apps/worker`** — the worker is the only sender; these must be set on Railway |
| `RESEND_API_KEY` | `apps/worker` — optional fallback |
| `WHISPER_MODEL` `OLLAMA_URL` `OLLAMA_MODEL` | `services/voice-ai` |
| `AUTH_USERNAME` / `AUTH_PASSWORD_HASH` / `AUTH_SECRET` | `apps/web` — the sign-in gate |
| `WORKER_URL` | `apps/web` — **required**; the app derives the webhook URL from it and runs the delivery test through it |
| `APP_URL` | `apps/worker` — where the worker relays events that need R2 or the AI pipeline |
| `WEBHOOK_BASE_URL` | `apps/worker` — local override only. On Railway this comes from `RAILWAY_PUBLIC_DOMAIN` |

`.env.local` holds everything. `.env` holds only `DATABASE_URL`, because the
Prisma CLI does not read `.env.local`. `packages/db/.env` is a **symlink** to
the root `.env` — Prisma looks for it beside the schema.

### The Railway URL trap

Railway issues two URLs per database. The internal one
(`postgres.railway.internal`) resolves **only from inside Railway**. Your
laptop needs the public one (`*.proxy.rlwy.net`), found under the service's
**Variables** tab as `DATABASE_PUBLIC_URL` / `REDIS_PUBLIC_URL`.

`P1001: Can't reach database server at postgres.railway.internal:5432` means
you have the internal URL locally. It is the most common setup mistake here.

---

## Webhook delivery

Telnyx posts call events to **the worker**, at
`https://{RAILWAY_PUBLIC_DOMAIN}/api/telnyx/webhook`. Not to the web app.

v1 tunnelled to the laptop with cloudflared, which handed out a fresh hostname
on every run. That is why Settings grew a check for a stored tunnel URL — and
why that check ended up blocking dialing outright, since a deployed app has no
tunnel and never will. Both are gone.

Four properties, each load-bearing:

- **Self-registering.** The worker PATCHes the connection's `webhook_event_url`
  to its own address on every boot. A redeploy needs no portal clicking. If the
  registered URL is wrong, the worker either has not booted since the deploy or
  registration failed — its log says which, and `npm run verify-telnyx` checks
  it from outside.
- **Signature-verified.** Every delivery is checked against
  `TELNYX_PUBLIC_KEY` (ed25519, over `${timestamp}|${rawBody}`), and timestamps
  older than five minutes are refused. **With that key unset, every event is
  rejected and nothing is recorded.** Verify the raw bytes, never a
  re-serialized object — JSON round-tripping changes key order and the
  signature is over bytes.
- **Idempotent.** Claimed in Redis on Telnyx's event `id`, 24h TTL, `SET NX`.
  Telnyx retries on anything non-2xx and on its own schedule, so redelivery is
  normal. Without this a retried `call.answered` counts a second connect — a
  large share of the analytics double-counting.
- **Asynchronous.** The endpoint answers 200 and hands the event to BullMQ.
  Telnyx times out fast and a slow handler becomes a retry storm.

The worker does everything Postgres alone can do. Events needing R2 presigning
or the AI pipeline are relayed to the app at `/api/telnyx/relay`, authenticated
with `WORKER_SHARED_SECRET`. That seam is temporary — §5 moves the audio path
onto the worker, because media forking needs a persistent process.

Because Telnyx no longer calls the app, **nothing on the app is publicly
reachable any more.** The middleware exemption that used to exist for
`/api/telnyx/webhook` is gone.

### Proving it works

Settings → Phone Numbers → **Test delivery**. It asks Telnyx to place a
few-second call between two of the operator's own numbers and waits up to ten
seconds for the resulting event to arrive back through the verifying receiver.
It goes green on receipt and on nothing else — a configured URL proves nothing,
which is precisely how the old check managed to be both green and wrong.

It never dials a person. Keep it that way.

---

## Rules

### Never mark a feature complete without a real end-to-end test

Code review alone is not "done". Done means you ran it:

- Telephony → a real call to your own cell, audio confirmed both directions
- Audio → Spotify actually paused on answer and resumed on hangup
- Worker → an automation fired **with the laptop shut down**
- Calendar → the event appeared in Google with the right title and invite
- Voice AI → a written precision/recall table from 20 scripted calls

Every feature ships with a screenshot of working UI plus a logged real-world
test.

### All UI copy uses operator language

**dials**, **connects**, **booked**, **no answer**, **callback**.
Never *SIP*, *leg*, *DTMF*, *early media*, *INVITE*, *trunk*, *SDP*.

### Do not describe multi-line dialing as spam protection

It is the opposite: carrier analytics flag high call volume per number and
short-duration calls, so more lines increases labelling risk. The real
mitigation is number rotation with area-code matching plus retiring numbers on
a schedule. Keep the UI copy honest.

### Calls must survive navigation

The Telnyx client, active-call state, media element, timer, and transcript
stream live in `<CallProvider>` in the root layout, above the router outlet.
Anything call-related placed inside a page will be destroyed on navigation and
drop a live call.

---

## Do not place test calls to the operator's phone

Automated tests must never dial the operator. Two harnesses that did have been
disabled. Any call-path verification is a **human-run** step: the operator
places the call themselves and reports what they heard.

This also means the §3.3 acceptance test — one live call surviving navigation
to all five other pages — is only **partially** verified. Confirmed: the call
connected, the timer ran, navigating to Conversations kept it connected with
the mini call bar visible, exactly one call record was written, and no phantom
end events fired. Not yet confirmed in a single unbroken call: all three
remaining pages. Finish that by hand when convenient.

## Testing gotchas that have already cost a day

- **Do Not Disturb / iOS "Silence Unknown Callers"** send test calls straight
  to voicemail with only a missed-call notification. The app-side symptom is a
  call reporting Connected after ~5 seconds with a "Low inbound audio" warning.
  Save your Telnyx number to your contacts before testing.
- **React StrictMode double-invokes effects.** The Telnyx client is a module
  singleton for this reason; constructing it in an effect opens two SIP
  registrations and the older one's call dies the moment the far end answers.
- **The Telnyx SDK emits both `hangup` and `destroy`** for one call. Handling
  both fires `onEnded` twice and silently skips a lead per call.
- **`/connections/{id}` is read-only.** Updating a connection needs the
  type-specific path, e.g. `/credential_connections/{id}`.
