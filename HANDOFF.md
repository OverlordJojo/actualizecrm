# ActualizeCRM — continuation prompt

Paste everything below the line into a fresh Claude Code session in
`/Users/joshx/Desktop/ActualizeCRM`.

---

# CONTEXT

ActualizeCRM is a cold-calling CRM for one operator. A previous session built
roughly half of it. **Read `CLAUDE.md` and `NEXT.md` first** — they carry the
architecture, the env var index, and a list of traps that have already cost
days. Do not re-derive them.

## What is already built, deployed, and tested

- **Infrastructure**: Next.js 14 monorepo (`apps/web`, `apps/worker`,
  `packages/db`). Postgres + Redis on Railway. Web app on Vercel at
  https://actualizecrm.vercel.app. Worker at
  https://worker-production-8c19.up.railway.app/health. Object storage on
  Cloudflare R2. Repo: github.com/OverlordJojo/actualizecrm (private).
- **v1 build steps 1–5**: scaffold + Prisma + PWA shell + four-page nav; lead
  import (csv/xlsx/.numbers, three-mode field mapping, E.164, dedupe); pipeline
  kanban with drag & drop; Telnyx WebRTC power dialer with dispositions and
  hotkeys; synthesized ringback + Spotify.
- **v2 §0**: Postgres migration, monorepo split, BullMQ worker with
  idempotency, retries, dead-letter, health endpoint. 18/18 checks.
- **v2 §1**: New/Callback/Interested/Booked stages, destination-required stage
  deletion, not-interested soft delete, retention sweep. 21/21 + 8/8 checks.
- **v2 §3.2 / §3.3**: live call timer, `CallProvider` in the root layout, mini
  call bar. **Only partially verified — finish this test first (see below).**
- **AI backend**: Claude Haiku 4.5 extraction using the §5.4 prompt verbatim,
  two-pass booking verification, end-of-call analysis, objection auto-tagging,
  accept/dismiss suggestions with confidence + evidence logging. Telnyx
  dual-channel recording → R2 → Deepgram multichannel transcription. **Backend
  and API routes are complete; none of it has UI.**

## Model and cost rules

Use **Claude Haiku 4.5** (`claude-haiku-4-5`) for all AI tasks — extraction,
analysis, booking verification. This is a deliberate cost decision, already
made. Do not switch models.

## The first thing to do

Finish the §3.3 test that was cut short. Start a call, visit Conversations →
Automations → Settings → back to Dialer, hang up. Verify unbroken audio, the
timer still running, and exactly one call record.

**Never place automated test calls to the operator's phone.** Two harnesses
that did this are disabled. Call-path verification is a human step — build it,
then hand the operator the trigger.

---

# WHAT TO BUILD

The operator's original wording follows, limited to what is still outstanding.
Build in the order given. Each section ends with a real end-to-end test before
the next begins.

## 1 — VOICEMAIL DROP (v1 build step 6)

> Settings → upload one audio recording (mp3/wav) stored in data/audio/.
> Multiple recordings selectable, one marked default.
>
> Live drop: hotkey V when a call hits a machine — Telnyx plays the file into
> the call, hangs up, auto-advances.
>
> Bulk mode: select any segment (already called, or never called) and queue
> drops as an automation action. Before enabling bulk-to-never-called, require
> a one-time acknowledgment that bulk/ringless voicemail to US numbers without
> prior consent carries TCPA exposure; log the acknowledgment with a timestamp.
> Build it, gate it, warn clearly.

Note: recordings now live in Cloudflare R2, not `data/audio/` — the app is
hosted and Vercel's filesystem is ephemeral. `integrations/storage/r2.ts` has
`put`/`signedUrl`; Telnyx fetches the drop file by presigned URL.
`integrations/telnyx/recording.ts` already has `playAudio` and `hangup`.
The `VoicemailRecording` and `Acknowledgement` models exist.

## 2 — CONVERSATIONS PAGE (v1 build step 7)

> Unified reverse-chronological activity feed across all contacts: calls (with
> disposition, duration, notes), SMS threads, email threads.
>
> Filter by contact, channel, disposition, date range, tag, list. Full-text
> search over notes and message bodies.
>
> Click any row → contact slide-over with full timeline, editable fields, tags,
> and a stage selector.

Plus, from v2 §1.3:

> Add a "Removed" filter view on the Conversations page to see and restore them.

And from the transcription add-on:

> Transcript renders in the contact slide-over under the call entry. Full-text
> search over transcripts in Conversations.

The `Activity` model already unifies calls, SMS, email, notes, stage changes
and AI analysis into one table — the feed is one query. `Call.transcript` holds
the searchable text.

## 3 — EMAIL + AUTOMATIONS ENGINE (v1 build step 8)

> Visual builder: Trigger → optional Delay → Action(s), chainable.
>
> Triggers: disposition set, pipeline stage changed, tag added, lead imported,
> no-answer N times, call completed.
>
> Actions: send SMS template (A2P-gated), send email template, voicemail drop,
> add/remove tag, move pipeline stage, create callback task.
>
> Email sends go through the user's connected inbox. Per-day send cap setting.
> Every automation has an on/off switch and a run log.

Execution belongs on the **Railway worker**, not the local app — see
`apps/worker/CLAUDE.md`. The `Automation`, `AutomationRun`, `ScheduledJob` and
`FailedJob` models exist, and the worker's job dispatcher has stubs for
`automation.execute`, `sms.send` and `email.send`.

## 4 — MESSAGING + A2P GATE (v1 build step 9)

> Every SMS surface — manual send, automation action, bulk — is disabled in the
> UI and blocked at the API route layer until the app verifies via Telnyx API
> that a 10DLC brand and campaign exist with status = approved. No bypass flag,
> no dev override.
>
> Blocked state renders a checklist explaining exactly how to register
> (sole-proprietor brand ~$4 one-time, campaign fee monthly), with a "Re-check
> status" button.
>
> Once approved: SMS templates with merge fields {{first_name}}, {{company}},
> {{location}}; send from the contact slide-over and from automations.

`apps/web/src/integrations/messaging/CLAUDE.md` documents the gate's intent and
the test that matters: calling the send route directly with a valid body must
return 403.

## 5 — INBOUND CALL HANDLING (add-on A)

> The app currently only dials out. Inbound must work:
>
> - Telnyx webhook `call.initiated` with `direction: incoming` → look up contact
>   by phone → **screen-pop the contact slide-over automatically**
> - Ring the browser softphone; Answer / Decline buttons in Region B
> - If number is unknown → create contact on the fly, mark source `inbound`
> - Inbound calls log to timeline with `direction: inbound`
> - Missed inbound → auto-create Callback task due in 1 hour
> - Settings → Numbers: per-number toggle "Route inbound to browser" (default ON)

`Call.direction` and `Contact.source` already exist. This depends on
`CallProvider`, so do it after the §3.3 test passes.

## 6 — DIALER CARD (v2 §3.1)

> The card must show and allow **inline editing** of:
> - First Name, Last Name
> - Phone Number
> - Email
> - Company Name
> - Address / Location
> - Notes (autosave on keystroke)
> - **Booking panel:** date picker, time picker, timezone display, and a "Book"
>   button that writes to Google Calendar using the §2.4 format
>
> Every field is an editable input, not read-only text. Saves debounce at 500ms
> and write straight to Postgres. Show a subtle saved-state indicator.

## 7 — CALENDAR PAGE (v2 §2)

> Add `Calendar` to the left rail. Nav is now: Dialer · Conversations ·
> Calendar · Automations · Settings.
>
> **Google Calendar connection**: OAuth 2.0, scope
> `https://www.googleapis.com/auth/calendar.events`. Connect from Settings →
> Calendar. Store refresh token encrypted at rest
> (`CALENDAR_ENCRYPTION_KEY`, AES-256-GCM). Let the operator select **which**
> Google calendar to write to if they have several. Operator timezone setting,
> default `America/Los_Angeles` (PST/PDT). All booking math resolves to this.
>
> **Calendar view**: Month / week / day toggle. Bookings render inline with lead
> name, company, and phone. Two-way sync: events created in DialDeck push to
> Google; events edited or deleted in Google reconcile back every 15 minutes via
> the worker's `calendar.reconcile` job.
>
> **Lead picker**: A dropdown listing **every lead that still exists in
> conversation history**, including pipeline-removed ones. Above the dropdown, a
> search box matching against first name, last name, company, phone (raw and
> E.164), email, and location — partial and case-insensitive, debounced 200ms,
> Postgres trigram index (`pg_trgm`) for speed. Click a result to select. Then
> choose date, time, and duration (default 30 min) and create the booking.
>
> **Booking format** (fixed, applies to every booking regardless of origin):
> - **Event title:** `{FirstName}'s Client Acquisition Chat with Josh X`
> - **Attendee:** the lead's email address, invitation sent automatically. If no
>   email on file, create the event without an attendee and flag it visibly in
>   the UI as "no invite sent."
> - **Description:** company, phone, location, and the last 10 lines of call
>   transcript for context.
> - Store `googleEventId` on the booking row so edits and cancellations map
>   cleanly.

Corrections to the above, already settled: the operator's timezone is
**`America/Vancouver`**, exported once as `OPERATOR_TIMEZONE` from
`packages/db` — use it, do not hardcode. The project is **ActualizeCRM**;
"DialDeck" was a hallucinated name. The `pg_trgm` GIN indexes are already
migrated. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`CALENDAR_ENCRYPTION_KEY` are in `.env.local`. The `Booking` model exists and
the worker's `calendar.reconcile` job is registered but is a no-op.

## 8 — ANALYTICS PAGE (v2 §7)

> Nav final order: Dialer · Conversations · Calendar · Analytics · Automations ·
> Settings.
>
> **Period selector**: Calendar-icon dropdown opening a range picker for
> arbitrary custom ranges. Presets: **Today · Yesterday · This Week · Last Week
> · Last 7 Days · Last 4 Weeks · This Month · Last Month.** All boundaries
> computed in `America/Los_Angeles`, not UTC and not the browser's zone.
>
> **Comparison logic**: Every metric displays a delta against **the immediately
> preceding period of identical length**. Show the delta as a signed percentage
> with direction color. For rate metrics, show percentage-point change, not
> percent-of-percent — a connect rate moving 10% → 12% is **+2.0 pts**, not
> +20%. Label it clearly. When the prior period has zero dials, render `—`
> rather than a divide-by-zero or a misleading `+100%`.
>
> **Metrics, rendered top-of-funnel to bottom**: Dials · Connect Rate ·
> Voicemail Rate · Non-Owner Rate · **Owner Connect Rate** (the headline metric;
> render it larger than the rest) · Over-1-Minute Rate · Interested Rate ·
> Booked Rate · Total Talk Time · Telephony Cost · Cost Per Booking · AI
> Suggestion Accept Rate.
>
> Interested is a superset of Booked: every booking counts in both. State this
> in a tooltip so the numbers are not read as contradictory.
>
> **Additional views**: Funnel bar chart (Dials → Connects → Owner Connects →
> Interested → Booked); dials-per-hour-of-day heatmap; per-number table with
> dials, connect rate, and days in service, to catch a number whose connect rate
> has collapsed from spam labeling.
>
> **Performance**: Do not compute these by scanning raw call rows on page load.
> The worker's nightly `analytics.rollup` writes a `DailyMetrics` table keyed by
> date. The page reads rollups and computes today's partial figures live.

Timezone correction: boundaries resolve in `America/Vancouver` via
`OPERATOR_TIMEZONE`. The rollup job and `DailyMetrics` model already exist and
work — only the page is missing. Owner-connect definition is v2 §6 and the
`ownerConnect` / `nonOwnerConnect` columns are already denormalised onto `Call`.

## 9 — VOICE AI UI SURFACES (v2 §5.6)

> - Field extractions above **0.85 confidence** render as an inline suggestion
>   chip next to the relevant field: *"AI heard: josh@company.com — Accept /
>   Dismiss."* One click applies.
> - Below 0.85, the chip renders greyed with the evidence quote visible on hover.
> - Auto-apply is available as an explicit opt-in per field type in Settings,
>   default **off**.
> - **Bookings are never auto-written to Google Calendar.** The verified proposal
>   populates the booking panel with date, time, timezone, and the evidence
>   quote. The operator presses one key to confirm. A Settings toggle allows
>   auto-book with a 15-second visible undo window, default off.
> - **Stage suggestions** highlight the suggested kanban column with a pulsing
>   outline and update live as the call develops (interested → booked). The
>   operator's manual stage choice always wins and locks out further AI
>   suggestions for that call.
> - Every AI suggestion — accepted, dismissed, or ignored — is logged with its
>   confidence and evidence. Surface accept-rate per field type on the Analytics
>   page so the model's reliability is measurable rather than assumed.

Plus a live transcript pane beside the Active Lead Card, and from the
transcription add-on:

> Settings → Transcription: on/off, model picker, retention policy (auto-delete
> audio after N days, default 30).

The backend is done. `GET /api/ai/suggestions?callId=` returns pending
suggestions; `POST` accepts `{suggestionId, decision}`. Suggestions are never
auto-applied server-side — that is a correctness requirement, not a preference.

## 10 — DAILY BRIEF EMAIL (add-on C)

> Every day at a configurable time, email the operator a summary via their own
> SMTP:
> - Dials, connects, connect rate, booked count vs yesterday
> - Best-performing hour block
> - Leads sitting in Callback stage past due
> - Numbers whose connect rate dropped >20% week-over-week (spam-flag early
>   warning)
>
> Settings → Daily Brief: on/off, send time, recipient.

Correction: implement as a **BullMQ job on the Railway worker**, not
`node-cron` in the Next.js process — a redeploy would silently drop every
pending job. The `daily.brief` job type is already declared.

## 11 — MULTI-LINE POWER DIALER (v2 §4) — BUILD THIS LAST

> **Read this before implementing**: Multi-line dialing does **not** reduce spam
> labeling — it increases it, because carrier analytics flag high call volume
> per number and short-duration calls. The genuine mitigation is number rotation
> with area-code matching plus retiring numbers on a schedule, which v1 already
> has. Keep expectations accurate in the UI copy: do not label this feature as
> spam protection.
>
> Separately, dialing more lines than you can answer creates **abandoned calls**.
> US telemarketing rules (47 CFR 64.1200) cap abandonment at 3% of live answers
> measured over 30 days, require a recorded identification message within 2
> seconds of the greeting on abandoned calls, and require retaining records.
> Build the safeguards in §4.4 as non-optional.
>
> **Burst logic**: Setting `linesPerBurst`, range 1–3, default 3, hard cap 3. On
> advance, pop `linesPerBurst` leads from the queue and originate that many
> Telnyx calls **simultaneously, each from a different owned number** (existing
> rotation logic, area-code-matched where possible). Enable Telnyx **premium
> answering machine detection** on every leg.
>
> **Per-leg routing**: No answer/busy/failed → discard leg, write disposition, no
> operator notification. `machine` detected → disposition `Voicemail`; if bulk VM
> drop enabled, play the recording; hang up; **never notify the operator**.
> Detected IVR/automated system/fax → disposition `Automated System`; hang up;
> **never notify the operator**. `human` first in burst → bridge to the
> operator's WebRTC session, unmute, start the AI pipeline. `human` second or
> third → the queued-owner rule below.
>
> **Simultaneous answer handling — the queued-owner rule**: The first human
> connects to the operator. Every additional human immediately hears a short
> pre-recorded hold prompt ("One moment please, connecting you now") followed by
> hold audio. Silence makes people hang up within seconds; the prompt is also
> what satisfies the abandoned-call identification requirement. Park them in
> `HeldOwnerQueue` with an arrival timestamp and mark the lead as owner-verified.
> **On the next advance, do not start a new burst.** Bridge the oldest held call
> to the operator instead. Continue draining `HeldOwnerQueue` before any new
> burst begins. `HOLD_MAX_SECONDS`, default 25, configurable 10–45. If a held
> call exceeds it, play a brief apology, hang up, and record disposition
> `Abandoned`.
>
> **Abandonment governor (non-optional)**: Track rolling 30-day abandonment rate:
> `Abandoned ÷ total human answers`. Display it live in the dialer's session
> stats bar. At **2%**: warn in the UI and automatically reduce `linesPerBurst`
> by one. At **3%**: hard-block new multi-line bursts. Force single-line until
> the rate recovers. No override flag. Log every abandoned call with timestamp,
> number dialed, and hold duration to an exportable table.

`Call.burstId`, `Call.heldSeconds` and `Call.amdResult` exist. The AMD config
helper is `amdParams()` in `integrations/telnyx/recording.ts`.

## 12 — SETTINGS POLISH + PWA (v1 build step 10)

> Sections: Phone Numbers · Audio · Email · Messaging & A2P status · Dialer (gap
> delay, hotkeys, which custom fields show on the Active Lead Card) · Custom
> Fields · Pipelines & Stages · Data (export all to CSV, backup/restore).

Phone Numbers and Audio are built. The rest are not.

---

# DEFINITION OF DONE

> Every feature requires a screenshot of working UI **plus** a logged
> real-world test. For §5, "done" additionally requires a written
> precision/recall table from the 20-call evaluation. Do not mark the AI
> complete on the basis of it working once.

> Rule: all UI copy uses operator language (dials, connects, booked), never
> telecom jargon.
