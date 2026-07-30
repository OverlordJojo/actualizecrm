/**
 * Starts a cloudflared quick tunnel to localhost:3000, then points this
 * machine's Telnyx connection at the resulting public URL.
 *
 *   npm run tunnel
 *
 * Telnyx needs a publicly reachable HTTPS URL to deliver call events to, even
 * though this app only ever runs on localhost. Quick tunnels get a fresh
 * random hostname every run, so the webhook URL has to be re-registered each
 * time — that is what this script automates.
 *
 * Leave it running alongside `npm run dev` for the whole dialing session.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const ENV_FILE = resolve(ROOT, '.env.local');
const LOCAL_PORT = 3000;

// ---------------------------------------------------------------------------
// .env.local read/write
// ---------------------------------------------------------------------------

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/// Rewrites a single key in place, preserving comments, ordering and every
/// other value. Never rewrites the whole file from a parsed object — that is
/// how you lose the comments that tell the operator where each key came from.
function writeEnvKey(key: string, value: string) {
  if (!existsSync(ENV_FILE)) {
    console.error(`✗ ${ENV_FILE} does not exist. Copy .env.example first.`);
    process.exit(1);
  }
  const raw = readFileSync(ENV_FILE, 'utf8');
  const lines = raw.split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));

  if (idx === -1) lines.push(`${key}=${value}`);
  else lines[idx] = `${key}=${value}`;

  writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// Telnyx
// ---------------------------------------------------------------------------

async function updateTelnyxWebhook(publicUrl: string) {
  const env = readEnv();
  const apiKey = env.TELNYX_API_KEY;
  const connectionId = env.TELNYX_CONNECTION_ID;

  if (!apiKey || !connectionId) {
    console.warn(
      '\n⚠ TELNYX_API_KEY or TELNYX_CONNECTION_ID missing from .env.local.\n' +
        '  The tunnel is up, but Telnyx was not told about it. Calls will\n' +
        '  dial and never report as answered, so auto-advance will stall.\n',
    );
    return;
  }

  const webhookUrl = `${publicUrl}/api/telnyx/webhook`;

  // /connections/{id} is a read-only view across every connection type.
  // Updating requires the type-specific path, so look up which one this is.
  const lookup = await fetch(
    `https://api.telnyx.com/v2/connections/${connectionId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!lookup.ok) {
    console.error(
      `\n✗ Could not read connection ${connectionId} (HTTP ${lookup.status}).\n` +
        '  Check that TELNYX_CONNECTION_ID and TELNYX_API_KEY are from the\n' +
        '  same Telnyx account.\n',
    );
    return;
  }

  const recordType: string =
    (await lookup.json())?.data?.record_type ?? 'credential_connection';

  const PATH_BY_TYPE: Record<string, string> = {
    credential_connection: 'credential_connections',
    ip_connection: 'ip_connections',
    fqdn_connection: 'fqdn_connections',
    call_control_application: 'call_control_applications',
  };

  const path = PATH_BY_TYPE[recordType];
  if (!path) {
    console.error(
      `\n✗ Connection type "${recordType}" is not one this app knows how to\n` +
        '  update. Set the webhook URL by hand in the Telnyx portal:\n' +
        `  ${webhookUrl}\n`,
    );
    return;
  }

  const res = await fetch(
    `https://api.telnyx.com/v2/${path}/${connectionId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        webhook_event_url: webhookUrl,
        webhook_api_version: '2',
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(
      `\n✗ Telnyx rejected the webhook update (HTTP ${res.status}).\n` +
        `  ${body}\n\n` +
        '  Common causes:\n' +
        '   - TELNYX_CONNECTION_ID is from a different Telnyx account than\n' +
        '     TELNYX_API_KEY\n' +
        '   - the connection id belongs to a SIP connection that does not\n' +
        '     support Call Control webhooks\n',
    );
    return;
  }

  console.log(`✓ Telnyx will send call events to ${webhookUrl}`);
}

// ---------------------------------------------------------------------------
// cloudflared
// ---------------------------------------------------------------------------

function startTunnel() {
  console.log(`Starting cloudflared tunnel to localhost:${LOCAL_PORT} ...`);

  const proc = spawn(
    'cloudflared',
    ['tunnel', '--url', `http://localhost:${LOCAL_PORT}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let resolved = false;

  const onChunk = async (chunk: Buffer) => {
    const text = chunk.toString();
    process.stderr.write(text);

    // cloudflared prints the assigned hostname once, inside a banner.
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !resolved) {
      resolved = true;
      const publicUrl = match[0];

      console.log(`\n✓ Tunnel live at ${publicUrl}`);
      writeEnvKey('PUBLIC_WEBHOOK_URL', publicUrl);
      console.log('✓ PUBLIC_WEBHOOK_URL written to .env.local');

      await updateTelnyxWebhook(publicUrl);

      console.log(
        '\nLeave this running. Restart `npm run dev` if it was already\n' +
          'running, so it picks up the new PUBLIC_WEBHOOK_URL.\n',
      );
    }
  };

  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);

  proc.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(
        '\n✗ cloudflared is not installed.\n\n' +
          '  Install it with:  brew install cloudflared\n',
      );
      process.exit(1);
    }
    throw err;
  });

  proc.on('exit', (code) => {
    console.log(`\ncloudflared exited (${code}). Webhooks are no longer reachable.`);
    process.exit(code ?? 0);
  });

  const stop = () => {
    proc.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

startTunnel();
