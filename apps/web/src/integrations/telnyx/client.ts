/**
 * Thin typed wrapper over the Telnyx v2 REST API.
 *
 * Deliberately hand-rolled rather than using the `telnyx` npm SDK: we touch
 * five endpoints, and the SDK's types lag the API. Every call goes through
 * `telnyx()` so auth, error shape and logging stay in one place.
 */

const BASE = 'https://api.telnyx.com/v2';

export class TelnyxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'TelnyxError';
  }
}

function apiKey(): string {
  const key = process.env.TELNYX_API_KEY;
  if (!key) {
    throw new TelnyxError(
      'No Telnyx API key. Add TELNYX_API_KEY to .env.local and restart the dev server.',
      500,
    );
  }
  return key;
}

async function telnyx<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    cache: 'no-store',
  });

  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    // Telnyx returns { errors: [{ title, detail, code }] }.
    const first = body?.errors?.[0];
    const message =
      first?.detail ?? first?.title ?? `Telnyx request failed (${res.status})`;
    throw new TelnyxError(message, res.status, body?.errors);
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export interface AvailableNumber {
  phone_number: string;
  region_information?: { region_type: string; region_name: string }[];
  cost_information?: {
    upfront_cost: string;
    monthly_cost: string;
    currency: string;
  };
  features?: { name: string }[];
}

export interface NumberSearchFilters {
  countryCode?: string;
  /// US area code, e.g. "702".
  areaCode?: string;
  /// State code, e.g. "NV".
  state?: string;
  city?: string;
  limit?: number;
}

export async function searchNumbers(
  filters: NumberSearchFilters,
): Promise<AvailableNumber[]> {
  const params = new URLSearchParams();
  params.set('filter[country_code]', filters.countryCode ?? 'US');
  params.set('filter[limit]', String(filters.limit ?? 20));
  // Voice is the whole point; excluding non-voice numbers up front avoids
  // showing the operator numbers they cannot dial from.
  params.append('filter[features][]', 'voice');

  if (filters.areaCode) {
    params.set('filter[national_destination_code]', filters.areaCode);
  }
  if (filters.state) params.set('filter[administrative_area]', filters.state);
  if (filters.city) params.set('filter[locality]', filters.city);

  const res = await telnyx<{ data: AvailableNumber[] }>(
    `/available_phone_numbers?${params.toString()}`,
  );
  return res.data ?? [];
}

export interface OrderedNumber {
  id: string;
  phone_numbers: { phone_number: string; status: string }[];
  status: string;
}

/// Buys a number. This spends money — the caller is responsible for having
/// confirmed with the operator first.
export async function orderNumber(
  phoneNumber: string,
  connectionId?: string,
): Promise<OrderedNumber> {
  const body: Record<string, unknown> = {
    phone_numbers: [{ phone_number: phoneNumber }],
  };
  if (connectionId) body.connection_id = connectionId;

  const res = await telnyx<{ data: OrderedNumber }>('/number_orders', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.data;
}

export interface OwnedNumber {
  id: string;
  phone_number: string;
  status: string;
  connection_id?: string;
}

export async function listOwnedNumbers(): Promise<OwnedNumber[]> {
  const res = await telnyx<{ data: OwnedNumber[] }>(
    '/phone_numbers?page[size]=250',
  );
  return res.data ?? [];
}

/// Releases a number. Telnyx stops billing for it at the end of the cycle.
export async function releaseNumber(numberId: string): Promise<void> {
  await telnyx(`/phone_numbers/${numberId}`, { method: 'DELETE' });
}

/// Points an owned number at our Call Control connection so inbound calls and
/// call events reach this app.
export async function assignNumberToConnection(
  numberId: string,
  connectionId: string,
): Promise<void> {
  await telnyx(`/phone_numbers/${numberId}`, {
    method: 'PATCH',
    body: JSON.stringify({ connection_id: connectionId }),
  });
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface Balance {
  balance: string;
  credit_limit: string;
  available_credit: string;
  currency: string;
}

export async function getBalance(): Promise<Balance> {
  const res = await telnyx<{ data: Balance }>('/balance');
  return res.data;
}

export interface Connection {
  id: string;
  connection_name: string;
  active: boolean;
  record_type: string;
}

export async function listConnections(): Promise<Connection[]> {
  const res = await telnyx<{ data: Connection[] }>(
    '/connections?page[size]=100',
  );
  return res.data ?? [];
}

export interface OutboundVoiceProfile {
  id: string;
  name: string;
  enabled: boolean;
}

export async function listOutboundVoiceProfiles(): Promise<
  OutboundVoiceProfile[]
> {
  const res = await telnyx<{ data: OutboundVoiceProfile[] }>(
    '/outbound_voice_profiles?page[size]=100',
  );
  return res.data ?? [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Pulls locality/state out of the region_information blob, which is an array
/// of differently-typed entries rather than a flat object.
export function regionOf(n: AvailableNumber): {
  locality?: string;
  region?: string;
} {
  const out: { locality?: string; region?: string } = {};
  for (const r of n.region_information ?? []) {
    if (r.region_type === 'location' || r.region_type === 'rate_center') {
      out.locality ??= r.region_name;
    }
    if (r.region_type === 'state') out.region ??= r.region_name;
  }
  return out;
}

export function areaCodeOfE164(e164: string): string | undefined {
  const m = e164.match(/^\+1(\d{3})/);
  return m?.[1];
}
