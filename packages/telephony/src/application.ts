import { TELNYX_API, telnyxErrorDetail, NO_STORE } from './call-control';

/**
 * Reading and reconfiguring the Telnyx connection this deployment dials
 * through — the machinery behind webhook self-registration (§1.2) and
 * `scripts/verify-telnyx-config.ts` (§0.4).
 *
 * The one trap here is documented in the root CLAUDE.md and cost real time:
 * **`/connections/{id}` is read-only.** It is a polymorphic view over several
 * concrete resources, and a PATCH against it fails in a way that reads like a
 * permissions problem. Writing requires the type-specific path, which is why
 * every write below routes through `writePathFor()` rather than guessing.
 */

/// The concrete Telnyx resources `/connections/{id}` can be a view over, mapped
/// to the path that accepts a PATCH.
const WRITE_PATHS: Record<string, string> = {
  credential_connection: 'credential_connections',
  ip_connection: 'ip_connections',
  fqdn_connection: 'fqdn_connections',
  call_control_application: 'call_control_applications',
};

export interface TelnyxConnection {
  id: string;
  /// e.g. `credential_connection`, `call_control_application`.
  recordType: string;
  name: string | null;
  active: boolean | null;
  webhookEventUrl: string | null;
  webhookApiVersion: string | null;
  /// Present on call control applications; absent on credential connections.
  dtmfType: string | null;
  /// True when the connection can host the in-browser softphone.
  webrtcEnabled: boolean | null;
  /// The whole payload, for checks that need a field this interface omits.
  raw: Record<string, unknown>;
}

async function telnyxJson(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY is not set.');

  const res = await fetch(`${TELNYX_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    ...NO_STORE,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Telnyx ${path} (${res.status}): ${telnyxErrorDetail(text)}`);
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function toConnection(data: Record<string, unknown>): TelnyxConnection {
  const anyData = data as Record<string, any>;
  return {
    id: String(anyData.id),
    recordType: String(anyData.record_type ?? 'unknown'),
    name: anyData.connection_name ?? anyData.application_name ?? null,
    active: anyData.active ?? null,
    webhookEventUrl: anyData.webhook_event_url ?? null,
    webhookApiVersion: anyData.webhook_api_version ?? null,
    dtmfType: anyData.dtmf_type ?? null,
    webrtcEnabled: anyData.webrtc_enabled ?? null,
    raw: data,
  };
}

/// Reads the connection through the polymorphic view, which works for every
/// concrete type and tells us which one we actually have.
export async function getConnection(
  connectionId: string,
): Promise<TelnyxConnection> {
  const json = await telnyxJson(`/connections/${encodeURIComponent(connectionId)}`);
  return toConnection((json.data ?? {}) as Record<string, unknown>);
}

export function writePathFor(recordType: string): string | null {
  return WRITE_PATHS[recordType] ?? null;
}

export interface RegistrationResult {
  changed: boolean;
  url: string;
  previousUrl: string | null;
  recordType: string;
}

/**
 * Points the connection's webhook at this deployment (§1.2).
 *
 * Runs on worker boot, which is what makes a redeploy self-configuring: the
 * old design required opening the Telnyx portal and pasting a fresh tunnel URL
 * every single time, and forgetting to do it broke call records silently.
 *
 * A no-op when the URL already matches, so the common case costs one GET and
 * leaves an audit trail free of pointless changes.
 */
export async function registerWebhookUrl(params: {
  connectionId: string;
  webhookUrl: string;
}): Promise<RegistrationResult> {
  const connection = await getConnection(params.connectionId);
  const writePath = writePathFor(connection.recordType);

  if (!writePath) {
    throw new Error(
      `Connection ${params.connectionId} is a ${connection.recordType}, which has no known ` +
        'write path. Add it to WRITE_PATHS in packages/telephony/src/application.ts.',
    );
  }

  if (connection.webhookEventUrl === params.webhookUrl) {
    return {
      changed: false,
      url: params.webhookUrl,
      previousUrl: connection.webhookEventUrl,
      recordType: connection.recordType,
    };
  }

  await telnyxJson(`/${writePath}/${encodeURIComponent(params.connectionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      webhook_event_url: params.webhookUrl,
      // v1 events omit the fields the handler reads. Pinning it here means a
      // connection created by hand in the portal cannot silently be on v1.
      webhook_api_version: '2',
    }),
  });

  return {
    changed: true,
    url: params.webhookUrl,
    previousUrl: connection.webhookEventUrl,
    recordType: connection.recordType,
  };
}
