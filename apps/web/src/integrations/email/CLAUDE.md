# integrations/email

Owns sending email from the operator's **own inbox**, so replies land where
they normally would and the prospect sees a real person's address.

## What this module does

- Connects to the operator's SMTP server via Nodemailer (Gmail, Outlook,
  Fastmail, anything with SMTP).
- Optional **Resend** fallback for when SMTP is unavailable — free tier is
  100 sends/day.
- Sends email templates from the contact slide-over and from automation steps.
- Enforces a **per-day send cap** so a misconfigured automation cannot blast the
  whole list and get the domain blocked.
- Logs every send to the contact timeline, so it appears in Conversations.

## Env vars this folder owns

| Key | What it is |
| --- | --- |
| `SMTP_HOST` | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | `587` for STARTTLS, `465` for implicit TLS |
| `SMTP_USER` | Your full email address |
| `SMTP_PASS` | App password — **not** your login password |
| `RESEND_API_KEY` | Optional fallback |

---

## Setup — click by click

### Gmail (most common)

Gmail will not accept your normal password over SMTP. You need an **App
Password**, which requires 2-Step Verification to be on first.

1. Go to <https://myaccount.google.com/security>.
2. Turn on **2-Step Verification** if it is not already on. You cannot create an
   App Password without it.
3. Go to <https://myaccount.google.com/apppasswords>.
4. Type a name — `ActualizeCRM` — and click **Create**.
5. Google shows a **16-character password** in four groups. Copy it.
   **You only see it once.**
6. Put it in `.env.local`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=you@gmail.com
   SMTP_PASS=abcdefghijklmnop
   ```
   Spaces in the app password are fine either way — they get stripped.
7. Restart `npm run dev`.

**Gmail sending limits:** 500 messages/day on a free account, 2,000/day on
Workspace. Set the app's daily cap below that in **Settings → Email**.

### Outlook / Microsoft 365

```
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
```
Microsoft has been disabling basic SMTP auth on many tenants. If auth fails with
correct credentials, your tenant likely requires OAuth — use the Resend
fallback instead.

### Resend (optional fallback)

1. Sign up at <https://resend.com>.
2. **API Keys** → **Create API Key** → copy into `.env.local` as
   `RESEND_API_KEY=`.
3. To send from your own domain rather than Resend's test address, add the
   domain under **Domains** and set the DNS records it gives you. Without that,
   you can only send to your own verified address.

Free tier: 100 emails/day, 3,000/month.

---

## Deliverability, briefly

Cold email from a fresh setup lands in spam. If this matters to you:

- Send from a domain you have warmed up, not a brand-new one.
- Set **SPF**, **DKIM** and **DMARC** DNS records on that domain.
- Keep daily volume low and steady rather than bursty. The per-day cap in
  Settings exists for this.
- Plain text outperforms heavily formatted HTML for cold outreach.

The app does not and cannot fix a cold domain's reputation.

---

## Testing end to end

**1. Connection test**
Settings → Email → **Send test email**. Enter your own address, send.
Green confirmation, and the message arrives within a minute or two.

Common failures:
- `Invalid login: 535-5.7.8 Username and Password not accepted` — you used your
  normal Google password instead of an App Password.
- `Missing credentials` — `.env.local` was edited but `npm run dev` was not
  restarted.
- Connection timeout on port 465 — switch to 587.

**2. A real send to a real inbox** ← the one that matters
1. Create an email template in Settings with merge fields:
   `Hi {{first_name}}, saw {{company}} is based in {{location}}...`
2. Open a contact in the slide-over, send that template to yourself.
3. Confirm the merge fields resolved to actual values — not `{{first_name}}`
   and not blank.
4. Confirm the send shows in that contact's timeline and on the Conversations
   page.
5. Reply to it from the receiving account and confirm the reply arrives in your
   normal inbox — this app does not intercept replies, and should not.

**3. Automation send**
Build an automation: trigger **disposition set → Booked**, action **send email
template**. Set a disposition of Booked on a test contact. Confirm the email
arrives and the automation's run log shows the send.

**4. Daily cap holds**
Set the cap in Settings to `1`. Send one email successfully, then try a second.
The second must be refused with a clear message, and must be refused at the API
route, not merely hidden in the UI.
