import { db } from '@/lib/db';
import { areaCodeOf } from '@/lib/phone';
import { getSetting } from '@/lib/settings';

/**
 * Picks which owned number to dial *from*.
 *
 * Default strategy is local presence: a lead in 702 gets called from a 702
 * number, because a matching area code measurably lifts answer rates. When no
 * owned number matches, fall back to round-robin so no single number carries
 * all the traffic — carriers flag numbers with lopsided outbound volume.
 */
export async function pickCallerId(
  leadPhone: string,
): Promise<{ id: string; e164: string } | null> {
  const numbers = await db.phoneNumber.findMany({
    where: { active: true },
    orderBy: { dialsSent: 'asc' },
    select: { id: true, e164: true, areaCode: true, dialsSent: true },
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

  // Round-robin: the list is already sorted by fewest dials sent, so this
  // spreads volume evenly without storing a rotation cursor.
  const next = numbers[0];
  return { id: next.id, e164: next.e164 };
}
