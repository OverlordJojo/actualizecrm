/**
 * Checks the Telnyx account against what the dialer needs (§0.4).
 *
 *   npm run verify-telnyx
 *
 * The point is to answer "is the portal set up correctly?" without clicking
 * through the portal. Several of these settings fail *silently* — a connection
 * on webhook API v1 delivers events with the fields the handler reads simply
 * missing, and a missing outbound voice profile rejects calls with a billing
 * error that reads like an empty balance. Each check below names the fix rather
 * than the symptom.
 *
 * Exits non-zero when anything required fails, so it can gate a deploy.
 */

const BASE = 'https://api.telnyx.com/v2';

type Level = 'required' | 'advisory';

interface Check {
  name: string;
  level: Level;
  ok: boolean;
  detail: string;
  /// What to do about it, in operator language.
  fix?: string;
}

const checks: Check[] = [];

function record(c: Check): void {
  checks.push(c);
}

async function telnyx<T = any>(path: string): Promise<T> {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY is not set.');

  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text)?.errors?.[0]?.detail ?? text;
    } catch {
      // keep raw
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function main(): Promise<void> {
  // --- credentials ---------------------------------------------------------

  if (!process.env.TELNYX_API_KEY) {
    record({
      name: 'API key',
      level: 'required',
      ok: false,
      detail: 'TELNYX_API_KEY is not set.',
      fix: 'Telnyx portal → API Keys → Create API Key, then put it in .env.local.',
    });
    report();
    return;
  }

  let balance: any = null;
  try {
    balance = (await telnyx('/balance')).data;
    const available = Number(balance.available_credit ?? 0);
    record({
      name: 'API key + balance',
      level: 'required',
      ok: available > 0,
      detail: `$${available.toFixed(2)} ${balance.currency} available`,
      fix:
        available > 0
          ? undefined
          : 'Add funds under Billing. At $0 Telnyx rejects both number purchases and calls.',
    });
  } catch (err) {
    record({
      name: 'API key',
      level: 'required',
      ok: false,
      detail: String(err),
      fix: 'The key is wrong, revoked, or has no billing attached.',
    });
    report();
    return;
  }

  // --- the connection ------------------------------------------------------

  const connectionId = process.env.TELNYX_CONNECTION_ID;
  if (!connectionId) {
    record({
      name: 'Connection',
      level: 'required',
      ok: false,
      detail: 'TELNYX_CONNECTION_ID is not set.',
      fix: 'Copy the Connection ID from the connection page into .env.local.',
    });
    report();
    return;
  }

  let connection: any = null;
  try {
    connection = (await telnyx(`/connections/${connectionId}`)).data;
  } catch (err) {
    record({
      name: 'Connection',
      level: 'required',
      ok: false,
      detail: String(err),
      fix: 'TELNYX_CONNECTION_ID does not match any connection on this account.',
    });
    report();
    return;
  }

  record({
    name: 'Connection',
    level: 'required',
    ok: connection.active !== false,
    detail: `${connection.connection_name ?? connection.application_name ?? connection.id} (${connection.record_type})`,
    fix: connection.active === false ? 'The connection is disabled. Enable it.' : undefined,
  });

  // v1 events omit fields the handler reads, and nothing errors — the symptom
  // is call records that are simply blank.
  record({
    name: 'Webhook API version',
    level: 'required',
    ok: String(connection.webhook_api_version ?? '') === '2',
    detail: `v${connection.webhook_api_version ?? 'unset'}`,
    fix:
      String(connection.webhook_api_version ?? '') === '2'
        ? undefined
        : 'Set the connection to API v2. The worker sets this at boot; if it is still v1, registration is failing.',
  });

  // §1.2: the worker registers this on every boot. A mismatch means either the
  // worker has not booted since deploy, or registration failed.
  const expected = process.env.WORKER_URL
    ? `${process.env.WORKER_URL.replace(/\/+$/, '')}/api/telnyx/webhook`
    : null;
  record({
    name: 'Webhook URL registered',
    level: 'required',
    ok: Boolean(connection.webhook_event_url) && (!expected || connection.webhook_event_url === expected),
    detail: connection.webhook_event_url ?? 'unset',
    fix:
      connection.webhook_event_url && (!expected || connection.webhook_event_url === expected)
        ? undefined
        : `Expected ${expected ?? 'the worker URL'}. The worker registers this at boot — redeploy it, then check its logs for "[telnyx] webhook".`,
  });

  record({
    name: 'Webhook signing key',
    level: 'required',
    ok: Boolean(process.env.TELNYX_PUBLIC_KEY),
    detail: process.env.TELNYX_PUBLIC_KEY ? 'set' : 'TELNYX_PUBLIC_KEY is not set',
    fix: process.env.TELNYX_PUBLIC_KEY
      ? undefined
      : 'Telnyx portal → Account Settings → Keys → Public Key. Without it every incoming event is rejected as unsigned.',
  });

  // WebRTC is what lets the browser be the phone. Only credential connections
  // carry the flag; a call control application does not and does not need to.
  if (connection.record_type === 'credential_connection') {
    record({
      name: 'WebRTC enabled',
      level: 'required',
      ok: connection.webrtc_enabled !== false,
      detail: connection.webrtc_enabled === false ? 'off' : 'on',
      fix:
        connection.webrtc_enabled === false
          ? 'Turn WebRTC on for this connection, or the dialer cannot register as a phone.'
          : undefined,
    });
  }

  // --- outbound calling ----------------------------------------------------

  try {
    const profiles = (await telnyx('/outbound_voice_profiles?page[size]=100')).data ?? [];
    const enabled = profiles.filter((p: any) => p.enabled !== false);
    record({
      name: 'Outbound voice profile',
      level: 'required',
      ok: enabled.length > 0,
      detail:
        enabled.length > 0
          ? enabled.map((p: any) => p.name).join(', ')
          : 'none enabled',
      fix:
        enabled.length > 0
          ? undefined
          : 'Voice → Outbound Voice Profiles → create one, enable US & Canada, and attach this connection. Without it every call fails instantly with a billing error.',
    });

    const withLimit = enabled.filter((p: any) => p.daily_spend_limit_enabled);
    record({
      name: 'Daily spend limit',
      level: 'advisory',
      ok: withLimit.length > 0,
      detail:
        withLimit.length > 0
          ? withLimit.map((p: any) => `$${p.daily_spend_limit}`).join(', ')
          : 'no limit set',
      fix:
        withLimit.length > 0
          ? undefined
          : 'Set a daily spend limit on the outbound profile. A runaway dial loop is the realistic failure mode here.',
    });
  } catch (err) {
    record({
      name: 'Outbound voice profile',
      level: 'required',
      ok: false,
      detail: String(err),
    });
  }

  // --- numbers -------------------------------------------------------------

  try {
    const numbers = (await telnyx('/phone_numbers?page[size]=100')).data ?? [];
    const active = numbers.filter((n: any) => n.status === 'active');
    record({
      name: 'Phone numbers',
      level: 'required',
      ok: active.length > 0,
      detail: `${active.length} active`,
      fix: active.length > 0 ? undefined : 'Buy one under Settings → Phone Numbers.',
    });

    // §2.2 dials each burst leg from a *different* number; running out caps the
    // burst rather than doubling up, which quietly makes multi-line single-line.
    record({
      name: 'Numbers for multi-line',
      level: 'advisory',
      ok: active.length >= 3,
      detail: `${active.length} active, 3 recommended`,
      fix:
        active.length >= 3
          ? undefined
          : 'A three-line burst needs three numbers — two concurrent calls from one number is the most obvious pattern carrier analytics look for. With fewer, bursts silently shrink.',
    });

    const misrouted = active.filter(
      (n: any) => n.connection_id && String(n.connection_id) !== String(connectionId),
    );
    record({
      name: 'Numbers on this connection',
      level: 'advisory',
      ok: misrouted.length === 0,
      detail:
        misrouted.length === 0
          ? 'all assigned correctly'
          : `${misrouted.length} on a different connection`,
      fix:
        misrouted.length === 0
          ? undefined
          : 'Inbound calls to those numbers will not reach this app. Reassign them to this connection.',
    });
  } catch (err) {
    record({
      name: 'Phone numbers',
      level: 'required',
      ok: false,
      detail: String(err),
    });
  }

  // --- per-call capabilities ----------------------------------------------
  //
  // AMD, recording, media streaming and conferences are all set per call in the
  // API rather than being flags on the connection, so there is nothing to read
  // back. What can be checked is that the account is on Call Control v2 at all
  // — everything above depends on it, and a connection that is not shows up
  // here rather than as a confusing 422 mid-call.

  record({
    name: 'Call Control v2',
    level: 'required',
    ok: ['credential_connection', 'call_control_application', 'ip_connection', 'fqdn_connection'].includes(
      connection.record_type,
    ),
    detail: connection.record_type,
    fix: undefined,
  });

  report();
}

function report(): void {
  const pad = (s: string, n: number) => s.padEnd(n);
  const width = Math.max(...checks.map((c) => c.name.length), 20);

  console.log('');
  console.log(`  ${pad('CHECK', width)}  RESULT   DETAIL`);
  console.log(`  ${'-'.repeat(width)}  -------  ${'-'.repeat(40)}`);

  for (const c of checks) {
    const mark = c.ok ? 'PASS' : c.level === 'required' ? 'FAIL' : 'WARN';
    console.log(`  ${pad(c.name, width)}  ${pad(mark, 7)}  ${c.detail}`);
  }

  const problems = checks.filter((c) => !c.ok);
  if (problems.length > 0) {
    console.log('');
    console.log('  What to do:');
    for (const c of problems) {
      if (c.fix) console.log(`    • ${c.name}: ${c.fix}`);
    }
  }

  const failed = checks.filter((c) => !c.ok && c.level === 'required');
  console.log('');
  console.log(
    failed.length === 0
      ? `  All required checks passed (${checks.filter((c) => !c.ok).length} advisory).`
      : `  ${failed.length} required check(s) failed.`,
  );
  console.log('');

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-telnyx-config failed:', err);
  process.exit(1);
});
