import { db, renderMergeFields } from '@actualizecrm/db';

/**
 * SMS sending — and the send-time half of the 10DLC gate (build step 9).
 *
 * The web app blocks every SMS surface in the UI and refuses the API route
 * with a 403. This is the second, independent check, and it is deliberately
 * not a shared helper with the app's: an automation queued while registration
 * was approved can come due after it lapsed, and the check that matters is the
 * one taken at the moment of sending.
 *
 * There is no bypass flag and no dev override. Unregistered A2P traffic is
 * silently filtered by carriers — the operator keeps paying and the prospect
 * never receives anything — so a gate that can be switched off in a hurry is a
 * gate that will be.
 */

const BASE = 'https://api.telnyx.com/v2';

export interface SmsGateStatus {
  approved: boolean;
  reason: string;
}

/// Cached briefly so a bulk automation does not make one Telnyx call per
/// message, but not so long that a revoked campaign keeps sending for hours.
let cachedGate: { at: number; status: SmsGateStatus } | null = null;
const GATE_CACHE_MS = 5 * 60 * 1000;

export async function a2pGate(): Promise<SmsGateStatus> {
  if (cachedGate && Date.now() - cachedGate.at < GATE_CACHE_MS) {
    return cachedGate.status;
  }

  const status = await checkA2p();
  cachedGate = { at: Date.now(), status };
  return status;
}

async function checkA2p(): Promise<SmsGateStatus> {
  const key = process.env.TELNYX_API_KEY;
  if (!key) return { approved: false, reason: 'TELNYX_API_KEY is not set.' };

  if (!process.env.TELNYX_MESSAGING_PROFILE) {
    return {
      approved: false,
      reason: 'No messaging profile configured — 10DLC registration is not finished.',
    };
  }

  try {
    const headers = { Authorization: `Bearer ${key}` };

    const brandRes = await fetch(`${BASE}/10dlc/brand`, { headers });
    if (!brandRes.ok) {
      return { approved: false, reason: `Telnyx brand lookup returned ${brandRes.status}.` };
    }
    const brands = (await brandRes.json()) as {
      records?: { brandId?: string; identityStatus?: string; status?: string }[];
    };
    const brand = (brands.records ?? []).find((b) =>
      ['VERIFIED', 'APPROVED', 'OK'].includes(
        String(b.identityStatus ?? b.status ?? '').toUpperCase(),
      ),
    );
    if (!brand) return { approved: false, reason: 'No approved 10DLC brand.' };

    const campRes = await fetch(`${BASE}/10dlc/campaign?brandId=${brand.brandId}`, {
      headers,
    });
    if (!campRes.ok) {
      return { approved: false, reason: `Telnyx campaign lookup returned ${campRes.status}.` };
    }
    const campaigns = (await campRes.json()) as {
      records?: { status?: string; campaignId?: string }[];
    };
    const approved = (campaigns.records ?? []).some((c) =>
      ['ACTIVE', 'APPROVED'].includes(String(c.status ?? '').toUpperCase()),
    );

    return approved
      ? { approved: true, reason: 'Brand and campaign approved.' }
      : { approved: false, reason: 'Brand approved but no active campaign.' };
  } catch (err) {
    // An unreachable Telnyx means unknown, and unknown means blocked.
    return {
      approved: false,
      reason: `Could not verify registration: ${String(err).slice(0, 120)}`,
    };
  }
}

export interface SendSmsInput {
  contactId: string;
  body: string;
  templateName?: string;
}

export interface SendSmsResult {
  sent: boolean;
  messageId?: string;
  skipped?: string;
  error?: string;
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const gate = await a2pGate();
  if (!gate.approved) {
    return { sent: false, skipped: `SMS is blocked: ${gate.reason}` };
  }

  const contact = await db.contact.findUnique({ where: { id: input.contactId } });
  if (!contact) return { sent: false, skipped: 'lead no longer exists' };
  if (contact.doNotContact) {
    return { sent: false, skipped: 'lead is marked do-not-contact' };
  }

  const number = await db.phoneNumber.findFirst({
    where: { active: true },
    orderBy: { dialsSent: 'asc' },
  });
  if (!number) return { sent: false, skipped: 'no active number to send from' };

  const body = renderMergeFields(input.body, {
    firstName: contact.firstName,
    lastName: contact.lastName,
    companyName: contact.companyName,
    companyLocation: contact.companyLocation,
    email: contact.email,
    phone: contact.phone,
  });

  const record = await db.message.create({
    data: {
      contactId: contact.id,
      direction: 'outbound',
      body,
      fromE164: number.e164,
      toE164: contact.phone,
      status: 'queued',
    },
  });

  try {
    const res = await fetch(`${BASE}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: number.e164,
        to: contact.phone,
        text: body,
        messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE,
      }),
    });
    const json = (await res.json()) as {
      data?: { id?: string };
      errors?: { detail?: string }[];
    };
    if (!res.ok) {
      throw new Error(json.errors?.[0]?.detail ?? `Telnyx returned ${res.status}`);
    }

    await db.message.update({
      where: { id: record.id },
      data: { status: 'sent', telnyxId: json.data?.id ?? null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.message.update({
      where: { id: record.id },
      data: { status: 'failed', error: message.slice(0, 500) },
    });
    return { sent: false, messageId: record.id, error: message };
  }

  await db.activity.create({
    data: {
      contactId: contact.id,
      type: 'sms',
      direction: 'outbound',
      summary: `Texted "${body.slice(0, 60)}${body.length > 60 ? '…' : ''}"`,
      body,
      messageId: record.id,
      meta: { templateName: input.templateName ?? null },
    },
  });

  return { sent: true, messageId: record.id };
}
