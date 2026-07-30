import { NextResponse } from 'next/server';
import {
  getBalance,
  listConnections,
  listOutboundVoiceProfiles,
  TelnyxError,
} from '@/integrations/telnyx/client';

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
    if (!process.env.PUBLIC_WEBHOOK_URL) {
      problems.push(
        'No webhook URL yet — run `npm run tunnel` or the dialer will not know when calls are answered.',
      );
    }

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
      webhookUrl: process.env.PUBLIC_WEBHOOK_URL ?? null,
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
