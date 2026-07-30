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

`PUBLIC_WEBHOOK_URL` is written by `scripts/tunnel.ts` and consumed here, but
owned by the root.

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
   - Leave the webhook URL blank for now — `npm run tunnel` fills it in.
5. Save. Copy the **Connection ID** shown at the top of the connection page
   into `.env.local` as `TELNYX_CONNECTION_ID=`.
6. On the same connection, open the **Credentials** tab and note the **SIP
   username** and **password**. Put them in `.env.local` as
   `TELNYX_SIP_USERNAME=` and `TELNYX_SIP_PASSWORD=`.

> **Running two instances off one Telnyx account?** Each machine needs its own
> connection created this way, with its own `TELNYX_CONNECTION_ID`. Sharing one
> means `npm run tunnel` overwrites the other person's webhook URL and their
> auto-advance breaks silently. See the clone note in the root `CLAUDE.md`.

### 4. Enable outbound calling

1. Left sidebar → **Voice** → **Outbound Voice Profiles**.
2. Click **Create Profile**, name it `actualizecrm`.
3. Set a **daily spend limit** — start at $20 so a bug cannot drain the account.
4. Under **Traffic Type / Destinations**, enable **United States & Canada**.
5. Attach the connection you made in step 3 to this profile.

Without this step calls fail instantly with a billing error.

### 5. Install the tunnel

Telnyx has to reach your laptop over the public internet to report that a call
was answered. `cloudflared` does that without you configuring a router.

```bash
brew install cloudflared
```

Then, in a second terminal alongside `npm run dev`:

```bash
npm run tunnel
```

It prints a `https://something.trycloudflare.com` URL, writes it to
`.env.local`, and registers it with Telnyx automatically. **The URL changes
every run**, which is why the script re-registers it each time.

### 6. Buy your first number

1. `npm run dev`, then open **Settings → Phone Numbers**.
2. Search by state and city, or by area code.
3. The monthly cost shows before you commit. Click **Buy**.

Prefer numbers in the area code you are dialing into — a local number gets
noticeably higher answer rates than an out-of-state one.

---

## Why the webhook does not drive auto-advance

The obvious design is "Telnyx webhook says answered → app reacts." This app
does not do that, deliberately.

The browser's WebRTC SDK reports `active` and `hangup` **locally**, with no
network round trip. A webhook has to travel Telnyx → cloudflared → localhost,
which adds hundreds of milliseconds. That is invisible for reporting and very
audible for the one thing that has a hard latency budget: pausing Spotify
within 300ms of the prospect answering (see `integrations/audio`).

So:

- **Browser SDK events** drive the dialer loop, auto-advance, and audio.
- **The webhook** supplies server-side truth for call records, powers Call
  Control features like voicemail drop, and handles inbound calls.

A missing or stale webhook therefore degrades *reporting*, not *dialing*. The
Settings page words it that way rather than claiming the dialer is broken.

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

**4. A real call to your own cell** ← the one that matters
1. Both `npm run dev` and `npm run tunnel` running.
2. Import a one-row spreadsheet with your own mobile number.
3. Start a dial session. Your phone should ring.
4. Answer it. Talk. Confirm you hear yourself both directions.
5. Hang up from your cell.
6. Confirm the app noticed the hangup and advanced to the next lead on its own.

If step 6 fails but 1–5 worked, the tunnel is not delivering webhooks. Check
that `npm run tunnel` is still running and that `PUBLIC_WEBHOOK_URL` in
`.env.local` matches the URL it printed.

**5. Caller ID rotation**
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
