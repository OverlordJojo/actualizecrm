import { db, getSetting } from '@actualizecrm/db';
import { TELNYX_API, credentialConnectionId } from '@actualizecrm/telephony';

/**
 * Which number to dial *from*, and where the operator's softphone lives.
 *
 * Both moved here from the app when the engine became shared: the worker
 * originates legs too, and a second copy of the caller-ID strategy would drift
 * from the one the Settings page writes.
 */

/// US area code from an E.164 string. Every number this app stores is E.164 and
/// NANP; anything else has no area code and falls back to round-robin.
function areaCodeOf(e164: string): string | null {
  return /^\+1\d{10}$/.test(e164) ? e164.slice(2, 5) : null;
}

/**
 * Picks which owned number to dial from.
 *
 * Default is local presence: a lead in 702 gets called from a 702 number,
 * because a matching area code measurably lifts answer rates. With no match,
 * round-robin, so no single number carries all the traffic — carriers flag
 * numbers with lopsided outbound volume.
 */
export async function pickCallerId(
  leadPhone: string,
  excludeIds: string[] = [],
): Promise<{ id: string; e164: string } | null> {
  const numbers = await db.phoneNumber.findMany({
    where: { active: true, ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}) },
    orderBy: { dialsSent: 'asc' },
    select: { id: true, e164: true, areaCode: true },
  });
  if (numbers.length === 0) return null;

  const strategy = await getSetting('dialer.callerIdStrategy');

  if (strategy === 'fixed') {
    const fixedId = await getSetting('dialer.fixedCallerIdNumberId');
    const fixed = numbers.find((n) => n.id === fixedId);
    if (fixed) return { id: fixed.id, e164: fixed.e164 };
    // Fixed number was released — fall through rather than failing the dial.
  }

  if (strategy !== 'roundRobin') {
    const leadArea = areaCodeOf(leadPhone);
    if (leadArea) {
      const match = numbers.find((n) => n.areaCode === leadArea);
      if (match) return { id: match.id, e164: match.e164 };
    }
  }

  // Already sorted by fewest dials sent, so this spreads volume without storing
  // a rotation cursor.
  return { id: numbers[0].id, e164: numbers[0].e164 };
}

const CREDENTIAL_SETTING = 'telnyx.webrtcCredentialId';

/**
 * The SIP address the operator's browser is registered at.
 *
 * The session's operator leg is originated *to* this, from the Call Control
 * Application. That crossing is deliberate and is the one part of §2 that the
 * two-connection split makes non-obvious: the softphone registers on the
 * credential connection, but only a Call Control Application can originate, so
 * the leg is placed by the application and delivered to the credential
 * connection's SIP user.
 */
export async function operatorSipUri(): Promise<string | null> {
  const connectionId = credentialConnectionId();
  if (!connectionId) return null;

  const stored = await db.setting.findUnique({ where: { key: CREDENTIAL_SETTING } });
  if (!stored?.value) return null;

  try {
    const res = await fetch(`${TELNYX_API}/telephony_credentials/${stored.value}`, {
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { sip_username?: string } };
    const username = json.data?.sip_username;
    return username ? `sip:${username}@sip.telnyx.com` : null;
  } catch {
    return null;
  }
}
