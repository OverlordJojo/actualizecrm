/**
 * WebRTC credentials for the in-browser softphone.
 *
 * Rather than putting a SIP password in .env.local and shipping it to the
 * browser, we create one long-lived "telephony credential" tied to the
 * connection and mint a short-lived JWT from it per session. The browser only
 * ever sees the JWT, and revoking access means deleting one credential.
 */
import { db } from '@/lib/db';

const BASE = 'https://api.telnyx.com/v2';
const CREDENTIAL_NAME = 'ActualizeCRM browser softphone';
/// Setting key holding the credential id, so we reuse one rather than
/// creating a new credential on every server restart.
const CREDENTIAL_SETTING = 'telnyx.webrtcCredentialId';

async function telnyx(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text)?.errors?.[0]?.detail ?? text;
    } catch {}
    throw new Error(`Telnyx ${res.status}: ${detail}`);
  }
  // The token endpoint answers with a bare JWT rather than JSON, so parsing
  // is best-effort — callers that need `json` know they are hitting a JSON
  // endpoint.
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { text, json };
}

/// Returns the id of our telephony credential, creating it on first use.
async function ensureCredential(connectionId: string): Promise<string> {
  const stored = await db.setting.findUnique({
    where: { key: CREDENTIAL_SETTING },
  });

  if (stored?.value) {
    // Confirm it still exists — a credential deleted in the portal would
    // otherwise fail token minting with a confusing 404.
    try {
      await telnyx(`/telephony_credentials/${stored.value}`);
      return stored.value;
    } catch {
      // fall through and make a new one
    }
  }

  const created = await telnyx('/telephony_credentials', {
    method: 'POST',
    body: JSON.stringify({
      connection_id: connectionId,
      name: CREDENTIAL_NAME,
    }),
  });

  const id: string = created.json.data.id;
  await db.setting.upsert({
    where: { key: CREDENTIAL_SETTING },
    create: { key: CREDENTIAL_SETTING, value: id },
    update: { value: id },
  });

  return id;
}

/// Mints a short-lived JWT the browser uses to register the softphone.
export async function mintWebrtcToken(): Promise<string> {
  const connectionId = process.env.TELNYX_CONNECTION_ID;
  if (!connectionId) {
    throw new Error(
      'TELNYX_CONNECTION_ID is not set — the browser cannot register as a phone.',
    );
  }

  const credentialId = await ensureCredential(connectionId);

  // This endpoint returns the raw JWT as text/plain, not JSON.
  const { text } = await telnyx(`/telephony_credentials/${credentialId}/token`, {
    method: 'POST',
  });

  return text.trim();
}

/**
 * The SIP address the operator's browser is registered at.
 *
 * Multi-line bursts originate prospect legs server-side, so the winning leg has
 * to be sent *to* the operator rather than dialled *by* them. Transferring to
 * this URI rings the same softphone the dialer already owns, which is why the
 * burst needs no second audio path.
 */
export async function operatorSipUri(): Promise<string | null> {
  const connectionId = process.env.TELNYX_CONNECTION_ID;
  if (!connectionId) return null;

  try {
    const credentialId = await ensureCredential(connectionId);
    const { json } = await telnyx(`/telephony_credentials/${credentialId}`);
    const username: string | undefined = json?.data?.sip_username;
    return username ? `sip:${username}@sip.telnyx.com` : null;
  } catch {
    return null;
  }
}
