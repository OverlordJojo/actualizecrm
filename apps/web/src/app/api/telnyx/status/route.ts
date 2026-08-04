import { NextResponse } from 'next/server';
import {
  getBalance,
  listConnections,
  listOutboundVoiceProfiles,
  TelnyxError,
} from '@/integrations/telnyx/client';
import { telnyxWebhookUrl } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Everything Settings needs to tell the operator whether they can actually
 * dial yet. Each check maps to a specific thing that silently breaks calling
 * if it is missing, so the UI can name the fix rather than saying
 * "not configured".
 */
export async function GET() {
  const connectionId = process.env.TELNYX_CONNECTION_ID ?? '';

  if (!process.env.TELNYX_API_KEY) {
    return NextResponse.json({
      ok: false,
      apiKey: false,
      problems: ['No Telnyx API key in .env.local.'],
    });
  }

  try {
    const [balance, connections, profiles] = await Promise.all([
      getBalance(),
      listConnections(),
      listOutboundVoiceProfiles(),
    ]);

    const connection = connections.find((c) => String(c.id) === connectionId);
    const available = Number(balance.available_credit ?? 0);
    const problems: string[] = [];

    if (available <= 0) {
      problems.push(
        'Telnyx balance is $0 — buying a number or placing a call will be rejected. Add funds under Billing.',
      );
    }
    if (!connectionId) {
      problems.push('TELNYX_CONNECTION_ID is not set in .env.local.');
    } else if (!connection) {
      problems.push(
        'TELNYX_CONNECTION_ID does not match any connection on this account.',
      );
    }
    if (profiles.length === 0) {
      problems.push(
        'No outbound voice profile — Telnyx rejects outbound calls without one.',
      );
    }

    // Deliberately *not* a webhook check. The old one asked whether a config
    // value was non-empty, which proved nothing and — because it was listed as
    // a problem — blocked dialing whenever the tunnel was not running (§1.1).
    // Webhook delivery is now proven by the live round-trip test below, which
    // is the only thing that can actually establish it.

    return NextResponse.json({
      ok: problems.length === 0,
      apiKey: true,
      balance: {
        available,
        currency: balance.currency,
        balance: Number(balance.balance ?? 0),
      },
      connection: connection
        ? { id: connection.id, name: connection.connection_name, active: connection.active }
        : null,
      outboundProfiles: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
      })),
      // Where events are expected to land, for display only. Whether they
      // actually arrive is what the round-trip test answers.
      webhookUrl: telnyxWebhookUrl(),
      registeredWebhookUrl: connection?.webhook_event_url ?? null,
      problems,
    });
  } catch (err) {
    const message =
      err instanceof TelnyxError ? err.message : 'Could not reach Telnyx.';
    return NextResponse.json(
      { ok: false, apiKey: true, problems: [message] },
      { status: err instanceof TelnyxError ? err.status : 500 },
    );
  }
}
