import { getSetting, setSettings } from '@/lib/settings';

/**
 * 10DLC registration status — the gate that keeps SMS switched off (§9).
 *
 * The check is live against Telnyx, never a cached flag, because the answer
 * changes without the app being told: a campaign can be revoked, a brand can
 * fail re-vetting, and the operator finds out by having every message silently
 * filtered while still being billed.
 *
 * There is deliberately no bypass flag, no dev override and no "I know what
 * I'm doing" checkbox. A gate that can be flipped off in a hurry is a gate that
 * will be flipped off in a hurry.
 */

const BASE = 'https://api.telnyx.com/v2';

export type A2pState = 'approved' | 'pending' | 'missing' | 'unknown';

export interface A2pStatus {
  approved: boolean;
  state: A2pState;
  /// One sentence naming the specific missing step, not a generic failure.
  reason: string;
  brand: { id?: string; status?: string } | null;
  campaign: { id?: string; status?: string } | null;
  hasMessagingProfile: boolean;
  checkedAt: string;
}

function blocked(
  state: A2pState,
  reason: string,
  extra: Partial<A2pStatus> = {},
): A2pStatus {
  return {
    approved: false,
    state,
    reason,
    brand: null,
    campaign: null,
    hasMessagingProfile: Boolean(process.env.TELNYX_MESSAGING_PROFILE),
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

export async function checkA2pStatus(): Promise<A2pStatus> {
  const key = process.env.TELNYX_API_KEY;
  if (!key) {
    return blocked('unknown', 'TELNYX_API_KEY is not set, so registration cannot be checked.');
  }

  const headers = { Authorization: `Bearer ${key}` };

  let brand: { brandId?: string; identityStatus?: string; status?: string } | undefined;

  try {
    const res = await fetch(`${BASE}/10dlc/brand`, { headers, cache: 'no-store' });
    if (!res.ok) {
      return blocked(
        'unknown',
        `Telnyx returned ${res.status} looking up your brand. Registration status is unknown, so texting stays blocked.`,
      );
    }
    const json = (await res.json()) as {
      records?: { brandId?: string; identityStatus?: string; status?: string }[];
    };
    const records = json.records ?? [];
    if (records.length === 0) {
      return blocked(
        'missing',
        'No 10DLC brand registered yet. Start with the brand — a campaign cannot exist without one.',
      );
    }

    brand = records.find((b) =>
      ['VERIFIED', 'APPROVED', 'OK'].includes(
        String(b.identityStatus ?? b.status ?? '').toUpperCase(),
      ),
    );

    if (!brand) {
      const first = records[0];
      return blocked(
        'pending',
        `Your brand exists but its status is "${first.identityStatus ?? first.status ?? 'unknown'}". Brand vetting usually takes 1–3 business days.`,
        { brand: { id: first.brandId, status: first.identityStatus ?? first.status } },
      );
    }
  } catch (err) {
    return blocked(
      'unknown',
      `Could not reach Telnyx to check registration (${String(err).slice(0, 80)}). Texting stays blocked while the answer is unknown.`,
    );
  }

  let campaign: { campaignId?: string; status?: string } | undefined;

  try {
    const res = await fetch(`${BASE}/10dlc/campaign?brandId=${brand.brandId}`, {
      headers,
      cache: 'no-store',
    });
    if (!res.ok) {
      return blocked('unknown', `Telnyx returned ${res.status} looking up your campaign.`, {
        brand: { id: brand.brandId, status: brand.identityStatus ?? brand.status },
      });
    }
    const json = (await res.json()) as {
      records?: { campaignId?: string; status?: string }[];
    };
    const records = json.records ?? [];

    if (records.length === 0) {
      return blocked(
        'missing',
        'Your brand is approved but you have no campaign. Register one — this is the step that carries the monthly fee.',
        { brand: { id: brand.brandId, status: brand.identityStatus ?? brand.status } },
      );
    }

    campaign = records.find((c) =>
      ['ACTIVE', 'APPROVED'].includes(String(c.status ?? '').toUpperCase()),
    );

    if (!campaign) {
      const first = records[0];
      return blocked(
        'pending',
        `Your campaign status is "${first.status ?? 'unknown'}". Texting unlocks on its own once it is active.`,
        {
          brand: { id: brand.brandId, status: brand.identityStatus ?? brand.status },
          campaign: { id: first.campaignId, status: first.status },
        },
      );
    }
  } catch (err) {
    return blocked(
      'unknown',
      `Could not reach Telnyx to check your campaign (${String(err).slice(0, 80)}).`,
    );
  }

  if (!process.env.TELNYX_MESSAGING_PROFILE) {
    return blocked(
      'missing',
      'Brand and campaign are approved, but TELNYX_MESSAGING_PROFILE is not set — there is no profile to send through.',
      {
        brand: { id: brand.brandId, status: brand.identityStatus ?? brand.status },
        campaign: { id: campaign.campaignId, status: campaign.status },
      },
    );
  }

  return {
    approved: true,
    state: 'approved',
    reason: 'Brand and campaign are approved. Texting is unlocked.',
    brand: { id: brand.brandId, status: brand.identityStatus ?? brand.status },
    campaign: { id: campaign.campaignId, status: campaign.status },
    hasMessagingProfile: true,
    checkedAt: new Date().toISOString(),
  };
}

/// Runs the live check and records the outcome for display. The stored value is
/// never what the gate consults — only what the Settings page last showed.
export async function refreshA2pStatus(): Promise<A2pStatus> {
  const status = await checkA2pStatus();
  await setSettings({
    'messaging.a2pStatus': status.state,
    'messaging.a2pLastCheckedAt': status.checkedAt,
  }).catch(() => {});
  return status;
}

export async function lastCheckedAt(): Promise<string> {
  return getSetting('messaging.a2pLastCheckedAt');
}
