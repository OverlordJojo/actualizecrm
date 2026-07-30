# integrations/messaging

Owns SMS, and owns the **hard gate** that keeps SMS switched off until 10DLC
registration is actually approved.

## What this module does

- Verifies via the Telnyx API that a 10DLC **brand** and **campaign** exist and
  are `approved`.
- Blocks every SMS surface until then — manual send, automation action, bulk.
- Once approved: SMS templates with merge fields, sending from the contact
  slide-over and from automation steps.
- Logs every message to the contact timeline so it appears in Conversations.

## The gate is not a suggestion

Every SMS path is disabled in the UI **and** blocked at the API route layer.
There is deliberately:

- no bypass flag,
- no dev override,
- no "I know what I'm doing" checkbox.

If the API route is called directly with a valid payload while registration is
unapproved, it returns `403` and sends nothing.

This is not the app being precious. Sending A2P traffic over unregistered
10DLC gets messages silently filtered by carriers — you keep paying and the
prospect never receives anything — and it exposes you to carrier fines. A gate
that can be flipped off in a hurry is a gate that will be flipped off in a
hurry.

## Env vars this folder owns

| Key | What it is |
| --- | --- |
| `TELNYX_MESSAGING_PROFILE` | The messaging profile ID. Leave blank until approved. |

`TELNYX_API_KEY` is owned by `integrations/telnyx` and read here.

---

## Setup — click by click

Registration takes **1–3 business days**. Start it early; the rest of the app
works fine while you wait.

### 1. Register your brand

1. Telnyx portal → **Messaging** → **10DLC** → **Brands** → **Create Brand**.
2. Choose brand type:
   - **Sole Proprietor** — one person, no EIN. About **$4 one-time**. Capped at
     roughly 3,000 messages/day and one campaign. Fine for one operator.
   - **Standard** — a registered business with an EIN. Higher limits, more
     vetting, higher fees.
3. Fill in your legal details exactly as they appear on official records. A
   mismatched address or phone is the most common rejection reason.
4. Submit and pay the one-time fee.

### 2. Register your campaign

1. **Messaging** → **10DLC** → **Campaigns** → **Create Campaign**.
2. Select your approved brand.
3. **Use case**: choose the one that honestly matches. For cold outbound
   B2B follow-up this is usually **Low Volume Mixed** or **Marketing**.
4. You must provide:
   - **Sample messages** — real text you will actually send. Include your
     business name and the opt-out language.
   - **Opt-in description** — how the recipient consented. Be truthful. If you
     have no prior consent, say so; do not invent a web form that does not
     exist. Fabricating opt-in flow is fraud and gets the campaign revoked.
   - **Opt-out handling** — confirm you honor STOP.
5. Submit and pay the monthly campaign fee (typically ~$1.50–$10/month
   depending on use case).

### 3. Attach numbers and profile

1. **Messaging** → **Messaging Profiles** → create one, attach it to the
   approved campaign.
2. Assign your purchased numbers to that profile.
3. Copy the messaging profile ID into `.env.local` as
   `TELNYX_MESSAGING_PROFILE=`.

### 4. Unlock in the app

**Settings → Messaging & A2P** → **Re-check status**. Once Telnyx reports the
brand and campaign as approved, the SMS surfaces unlock on their own. There is
nothing else to flip.

---

## What "approved" means here

The app checks, via the Telnyx API:

1. A brand exists and its status is approved.
2. A campaign exists under that brand and its status is approved.

Anything else — pending, failed, missing, or an API error — leaves SMS blocked
and renders the checklist with a **Re-check status** button.

---

## Legal, in one paragraph

Cold SMS to US mobile numbers without prior express consent is a TCPA problem
regardless of 10DLC registration. 10DLC approval is a **carrier** requirement,
not legal consent — passing it does not make unconsented messaging lawful.
Statutory damages run $500–$1,500 per message, and this is actively litigated.
Know where your list came from. This applies equally to the bulk voicemail drop
feature, which carries its own acknowledgement gate.

---

## Testing end to end

**1. Gate holds while unapproved**
Before registration completes:
- Contact slide-over → SMS box is disabled with an explanation, not a dead
  button that silently fails.
- Automations → "send SMS" action is selectable but shows the blocked state.
- Call the send API route directly with a well-formed body. It must return
  `403`. If it sends, the gate is broken and that is a ship-blocking bug.

**2. Checklist is actually useful**
Settings → Messaging shows the specific missing step — "no brand" vs "brand
approved, campaign pending" — not a generic "not configured."

**3. Re-check works**
Click **Re-check status**. It should hit Telnyx live, not read a cached value,
and update the timestamp shown.

**4. A real text to your own cell** ← the one that matters, after approval
1. Send yourself a templated message with merge fields from the slide-over.
2. Confirm it arrives, and that `{{first_name}}` resolved to a real name.
3. Confirm it appears in that contact's timeline and in Conversations.
4. Reply **STOP** from your cell, then confirm the app blocks further sends to
   that number.
