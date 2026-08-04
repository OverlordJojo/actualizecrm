import {
  registerWebhookUrl,
  webhookUrl,
  callControlAppId,
  credentialConnectionId,
} from '@actualizecrm/telephony';

/**
 * Webhook self-registration on boot (§1.2).
 *
 * The point is that a redeploy needs no portal clicking. Under the tunnel this
 * was a manual step nobody remembered: the hostname changed on every run, and
 * forgetting to paste the new one broke call records in a way that looked like
 * a telephony fault rather than a stale config value. Railway's hostname is
 * stable, so registration is a no-op after the first boot — but running it
 * every time is what makes it *true*, rather than assumed.
 *
 * Never fatal. The worker's reason to exist is firing automations while the
 * laptop is shut; a Telnyx API blip at boot must not stop that.
 */

export interface RegistrationRecord {
  at: string;
  ok: boolean;
  url?: string;
  changed?: boolean;
  previousUrl?: string | null;
  recordType?: string;
  error?: string;
}

/// Surfaced on /health and alongside the Settings test, so "did it register?"
/// is answerable without reading logs.
export let lastRegistration: RegistrationRecord | null = null;

/**
 * Registers on **both** connections, because events arrive on both.
 *
 * Outbound legs are originated from the Call Control Application, so their
 * events come from it. Inbound calls route to the credential connection the
 * numbers are assigned to, so theirs come from that. Registering only one leaves
 * half the call events going nowhere — and the half that breaks is whichever one
 * nobody tested.
 */
export async function registerWebhook(): Promise<RegistrationRecord> {
  const results: RegistrationRecord[] = [];

  for (const id of [callControlAppId(), credentialConnectionId()]) {
    if (id) results.push(await registerOne(id));
  }

  if (results.length === 0) {
    lastRegistration = {
      at: new Date().toISOString(),
      ok: false,
      error:
        'Neither TELNYX_CALL_CONTROL_APP_ID nor TELNYX_CONNECTION_ID is set, so ' +
        'Telnyx has nowhere to send call events.',
    };
    console.warn(`[telnyx] ${lastRegistration.error}`);
    return lastRegistration;
  }

  // The Call Control App is the one that matters for dialing, so it fronts the
  // health readout; a credential-connection failure is logged either way.
  lastRegistration = results[0];
  return lastRegistration;
}

async function registerOne(connectionId: string): Promise<RegistrationRecord> {
  const at = new Date().toISOString();
  const url = webhookUrl();

  if (!url) {
    lastRegistration = {
      at,
      ok: false,
      error:
        'No public webhook URL. On Railway this comes from RAILWAY_PUBLIC_DOMAIN; ' +
        'locally set WEBHOOK_BASE_URL.',
    };
    console.warn(`[telnyx] webhook not registered — ${lastRegistration.error}`);
    return lastRegistration;
  }

  if (!connectionId || !process.env.TELNYX_API_KEY) {
    lastRegistration = {
      at,
      ok: false,
      url,
      error: 'TELNYX_API_KEY and TELNYX_CONNECTION_ID must both be set.',
    };
    console.warn(`[telnyx] webhook not registered — ${lastRegistration.error}`);
    return lastRegistration;
  }

  try {
    const result = await registerWebhookUrl({ connectionId, webhookUrl: url });
    lastRegistration = {
      at,
      ok: true,
      url: result.url,
      changed: result.changed,
      previousUrl: result.previousUrl,
      recordType: result.recordType,
    };
    console.log(
      result.changed
        ? `[telnyx] webhook registered → ${result.url} (was ${result.previousUrl ?? 'unset'})`
        : `[telnyx] webhook already correct → ${result.url}`,
    );
  } catch (err) {
    lastRegistration = {
      at,
      ok: false,
      url,
      error: err instanceof Error ? err.message : String(err),
    };
    console.error(`[telnyx] webhook registration failed — ${lastRegistration.error}`);
  }

  return lastRegistration;
}
