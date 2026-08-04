# integrations/telnyx

Owns everything that touches the phone network: buying numbers, registering the
in-browser softphone, placing calls, and running the power-dialer loop.

## What this module does

- **Number provisioning** — search Telnyx inventory by country/state/city or
  area code, show the monthly price, buy with one click, release with one click.
- **Caller ID rotation** — picks which owned number to dial *from*. Default is
  nearest area-code match to the lead (local presence), falling back to
  round-robin across all owned numbers.
- **WebRTC voice** — registers a softphone in the browser tab so the operator
  talks through the MacBook's mic and speakers. No desk phone, no app.
- **Call Control** — server-side commands (answer, hang up, play voicemail
  recording) plus the webhook that tells the app when a call was answered.
- **Dialer engine** — the auto-advance loop: dial → wait → disposition →
  immediately dial the next lead.

## Env vars this folder owns

| Key | What it is |
| --- | --- |
| `TELNYX_API_KEY` | Authenticates every server-side API call |
| `TELNYX_CONNECTION_ID` | The Call Control / WebRTC connection this machine dials through |
| `TELNYX_SIP_USERNAME` | Credential the browser registers with |
| `TELNYX_SIP_PASSWORD` | Password for that credential |

| `TELNYX_PUBLIC_KEY` | Verifies webhook signatures. **Not** the API key |

Telnyx REST calls and signature verification live in `packages/telephony`,
shared with the worker. This folder owns what is app-specific: WebRTC
credentials, caller-ID rotation, number provisioning.

---

## Setup — click by click

You do not need to be a developer to do this. Follow it exactly.

### 1. Make a Telnyx account

1. Go to <https://telnyx.com> and click **Sign up**.
2. Verify your email and phone number.
3. Telnyx will ask a few questions about your use case. Say you are doing
   **outbound sales calling**. Answer honestly — misrepresenting use case is
   how accounts get shut down mid-campaign.
4. Add a payment method under **Billing**. Put ~$20 of credit on it to start.
   Outbound US calling runs about **$0.005/minute**, billed per second, and
   numbers are about **$1/month**.

### 2. Get your API key

1. In the left sidebar click **API Keys**.
2. Click **Create API Key**.
3. Copy the key. **You only see it once.** If you lose it, delete it and make a
   new one — there is no way to view it again.
4. Paste it into `.env.local` as `TELNYX_API_KEY=`.

### 3. Create the connection this machine dials through

1. Left sidebar → **Voice** → **Programmable Voice**.
2. Click **Create Connection** → choose **Credentials** connection type.
3. Name it something you will recognize, e.g. `actualizecrm-<your-name>`.
4. Under **Connection Settings**:
   - **WebRTC** → turn **ON**. This is what lets the browser be the phone.
   - **Webhook API Version** → **API v2**.
   - Leave the webhook URL blank. The worker fills it in on every boot and
     will overwrite whatever you type here anyway.
5. Save. Copy the **Connection ID** shown at the top of the connection page
   into `.env.local` as `TELNYX_CONNECTION_ID=`.
6. On the same connection, open the **Credentials** tab and note the **SIP
   username** and **password**. Put them in `.env.local` as
   `TELNYX_SIP_USERNAME=` and `TELNYX_SIP_PASSWORD=`.

> **Running two instances off one Telnyx account?** Each needs its own
> connection created this way, with its own `TELNYX_CONNECTION_ID`. Sharing one
> means each worker's boot-time registration overwrites the other's webhook URL,
> and one of them silently stops receiving call events.

### 3b. Get the webhook signing key

1. Left sidebar → **Account Settings** → **Keys**.
2. Copy the **Public Key**. This is *not* the API key.
3. Put it in `.env.local` and on Railway as `TELNYX_PUBLIC_KEY=`.

Telnyx signs every webhook with the matching private key, and the worker rejects
anything it cannot verify — that endpoint is open to the internet, so the
signature is the whole of its authentication. **Leave this unset and no call
event is ever processed:** calls still connect, but nothing is recorded, and
`npm run verify-telnyx` is where that shows up.

### 4. Enable outbound calling

1. Left sidebar → **Voice** → **Outbound Voice Profiles**.
2. Click **Create Profile**, name it `actualizecrm`.
3. Set a **daily spend limit** — start at $20 so a bug cannot drain the account.
4. Under **Traffic Type / Destinations**, enable **United States & Canada**.
5. Attach the connection you made in step 3 to this profile.

Without this step calls fail instantly with a billing error.

### 5. Check the whole configuration

```bash
npm run verify-telnyx
```

Prints a pass/fail table covering the balance, the connection, the webhook URL
and signing key, the outbound profile, and your numbers — with the fix named for
anything that fails. Run it whenever calling behaves oddly; several of these
settings fail *silently*, which is exactly why the check exists.

**There is no tunnel step any more.** Telnyx delivers call events to the
deployed worker, which registers its own address on boot. See "Webhook
delivery" in the root `CLAUDE.md`.

### 6. Buy your first number

1. `npm run dev`, then open **Settings → Phone Numbers**.
2. Search by state and city, or by area code.
3. The monthly cost shows before you commit. Click **Buy**.

Prefer numbers in the area code you are dialing into — a local number gets
noticeably higher answer rates than an out-of-state one.

> **Buy through this page, not the Telnyx portal.** The dialer picks caller IDs
> from the `PhoneNumber` table, not from Telnyx, so a number bought in the
> portal is invisible to it — and a multi-line burst silently shrinks to
> however many rows exist here, because it refuses to dial two legs from one
> number. Symptom: you own three numbers and a three-line burst still opens one
> leg. `npm run verify-telnyx` counts Telnyx's numbers, so it reads PASS while
> the app disagrees; compare against Settings → Phone Numbers, which reads the
> table. This has happened once already.

---

## What drives auto-advance — and why that is changing

**Today (single-line):** browser SDK events drive the dialer loop. The WebRTC
SDK reports `active` and `hangup` locally with no network round trip, and the
one thing here with a hard latency budget is pausing Spotify within 300ms of the
prospect answering (see `integrations/audio`). A webhook round trip costs
hundreds of milliseconds — invisible for reporting, audible for that.

**Where §2 takes it:** conference-anchored dialing moves the legs server-side,
so webhooks become authoritative for leg state and hang-up. That spends the
latency this design was avoiding. It is still the right trade, because a browser
cannot hold three ringing legs and cannot run AMD before deciding what reaches
the operator's ears — and a hang-up button driven by browser line state is
exactly what left multi-line with no working hang-up at all.

Until then: browser events drive the loop; the webhook supplies server-side
truth for call records, powers Call Control features like voicemail drop, and
handles inbound.

> **Do not re-add a "no webhook URL" precheck that blocks dialing.** That check
> existed, it read an environment variable rather than testing anything, and it
> produced a false "cannot dial" state on a deployment that was working fine.
> Settings tests delivery live instead.

## What is already provisioned on this machine

Set up on 2026-07-27. Re-run the checks in Settings → Phone Numbers if
anything looks wrong.

| Thing | Value |
| --- | --- |
| Connection | `ActualizeCRM` — credential connection, active, webhook API v2 |
| Number owned | +1 (702) 745-8779 — Nelson, NV, assigned to that connection |
| Outbound voice profile | `ActualizeCRM`, **$5/day spend limit**, US + CA only |
| WebRTC auth | On-demand telephony credential; JWTs minted per session |

**WebRTC uses tokens, not a SIP password.** `src/integrations/telnyx/webrtc.ts`
creates one telephony credential tied to the connection, stores its id in the
`Setting` table, and mints a short-lived JWT from it on each page load. Nothing
sensitive reaches the browser and revoking access means deleting one
credential. `TELNYX_SIP_USERNAME` / `TELNYX_SIP_PASSWORD` in `.env.example` are
only a fallback and are not required.

The $5/day cap is deliberately low: a runaway dial loop is the realistic
failure mode, and $5 is well past a full 7-hour dialing day (~170 talk minutes
≈ $0.85). Raise it in the Telnyx portal if you genuinely outgrow it.

## Testing end to end

Do these in order. Do not skip to the last one.

**1. Number search works**
Settings → Phone Numbers → search area code `702`. Results with prices appear.
No results at all usually means the API key is wrong or has no billing attached.

**2. Buy a number**
Buy one. It appears in the owned-numbers list with its location and purchase
date. Confirm it also shows up in the Telnyx portal under **Numbers**.

**3. The browser registers as a phone**
Load the Dialer page. The status indicator reads **Ready**. If it says
**Offline**, the SIP username/password are wrong or WebRTC is off on the
connection.

> **Before debugging a call that "doesn't ring": check Do Not Disturb, and
> check iOS Settings → Phone → *Silence Unknown Callers*.** Both send calls
> straight to voicemail with only a missed-call notification, which looks
> exactly like carrier filtering or a broken dialer. The app-side symptom is a
> call that reports Connected after ~5 seconds (your voicemail answering) with
> a "Low inbound audio" warning. This cost a full debugging session once
> already. Save the number to your contacts before testing.

**4. Call events are arriving**
Settings → Phone Numbers → **Test delivery**. Green within ten seconds. If it
fails, run `npm run verify-telnyx` — the registered URL and the signing key are
the two things that break this, and the table names which.

**5. A real call to your own cell** ← the one that matters
1. `npm run dev` running.
2. Import a one-row spreadsheet with your own mobile number.
3. Start a dial session. Your phone should ring.
4. Answer it. Talk. Confirm you hear yourself both directions.
5. Hang up from your cell.
6. Confirm the app noticed the hangup and advanced to the next lead on its own.

If the call worked but no record appeared afterwards, that is webhook delivery,
not dialing — go back to step 4.

**6. Caller ID rotation**
Own numbers in two different area codes, then dial a lead whose area code
matches one of them. The Dial Controls region should show that matching number
as the caller ID being used.

---

## Cost notes

- Outbound US: ~$0.005/min, per-second billing.
- Numbers: ~$1/month each, charged whether or not you dial from them. Release
  numbers you are not using — the Settings page has a one-click release.
- A 7-hour day at ~40% talk time is roughly 170 minutes ≈ **$0.85/day** in call
  charges.
