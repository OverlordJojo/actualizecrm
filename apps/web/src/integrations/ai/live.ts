import { db } from '@/lib/db';
import { extractFromWindow, verifyBooking, type TranscriptTurn } from './extract';
import { aiAvailable } from './client';

/**
 * Extraction during a live call (§5.3, §5.6).
 *
 * Runs on a completed **prospect** turn, never on the operator's — the operator
 * reading an email address back to confirm it is not the prospect providing
 * one, and treating it as such would write the app's own guess back onto the
 * lead as if it were fact.
 *
 * Gated by a cheap regex first. Calling the model on every segment would cost a
 * request per sentence for the many that contain nothing worth extracting, and
 * that gate — not prompt caching — is what keeps this affordable.
 *
 * Nothing here writes to the lead. Suggestions are recorded and surfaced; the
 * operator accepts them (§5.6). A model that silently edited a record would be
 * indistinguishable from a bug the first time it was wrong.
 */

/// Confidence below which a suggestion is shown greyed rather than offered.
const ACCEPT_THRESHOLD = 0.85;

const FIELD_KEYS = [
  'email',
  'first_name',
  'last_name',
  'job_title',
  'company',
  'address',
] as const;

export interface LiveExtractionResult {
  ran: boolean;
  suggestions: number;
  reason?: string;
}

export async function runLiveExtraction(params: {
  callId: string;
  contactId: string;
}): Promise<LiveExtractionResult> {
  if (!aiAvailable()) return { ran: false, suggestions: 0, reason: 'no api key' };

  const call = await db.call.findUnique({
    where: { id: params.callId },
    select: { transcriptSegments: true, toE164: true, contactId: true },
  });
  if (!call) return { ran: false, suggestions: 0, reason: 'no call' };

  const segments = Array.isArray(call.transcriptSegments)
    ? (call.transcriptSegments as unknown as {
        speaker: string;
        text: string;
      }[])
    : [];
  if (segments.length === 0) return { ran: false, suggestions: 0, reason: 'no transcript' };

  const window: TranscriptTurn[] = segments.slice(-8).map((s) => ({
    speaker: s.speaker === 'Prospect' ? 'prospect' : 'operator',
    text: s.text,
  }));

  const contact = await db.contact.findUnique({ where: { id: call.contactId } });
  if (!contact) return { ran: false, suggestions: 0, reason: 'no contact' };

  const extraction = await extractFromWindow(
    window,
    {
      first_name: contact.firstName,
      last_name: contact.lastName,
      job_title: contact.jobTitle,
      email: contact.email,
      company: contact.companyName,
      address: contact.address,
    },
    call.toE164,
  );

  // Null means the regex gate declined, which is the common case and not a
  // failure.
  if (!extraction) return { ran: false, suggestions: 0, reason: 'nothing worth extracting' };

  let written = 0;

  for (const key of FIELD_KEYS) {
    const field = (extraction as unknown as Record<string, {
      value: string | null;
      evidence: string | null;
      confidence: number;
    }>)[key];
    if (!field?.value) continue;

    // Rule 3 of the prompt: no evidence, no field. Enforced here as well,
    // because a model that ignores an instruction should not be able to write
    // an unsupported value into the operator's record.
    if (!field.evidence) continue;

    written += await recordSuggestion({
      callId: params.callId,
      contactId: params.contactId,
      fieldType: key,
      value: field.value,
      evidence: field.evidence,
      confidence: field.confidence ?? 0,
    });
  }

  // Outcome drives the highlighted stage on the outcome panel (§3.5, §5.6).
  if (extraction.outcome?.value && extraction.outcome.value !== 'unknown') {
    written += await recordSuggestion({
      callId: params.callId,
      contactId: params.contactId,
      fieldType: 'stage',
      value: stageForOutcome(extraction.outcome.value),
      evidence: extraction.outcome.evidence ?? null,
      confidence: extraction.outcome.confidence ?? 0,
    });
  }

  /**
   * A proposed booking gets a second opinion before it is shown at all (§5.5).
   *
   * The first pass is reading a noisy phone transcript and doing timezone
   * arithmetic; both are error-prone, and a wrong meeting time is a missed
   * meeting the operator does not find out about until nobody joins. Verified
   * bookings populate the panel; unverified ones are shown greyed with the
   * reason, never hidden — the operator can still hear what was said.
   */
  const booking = extraction.booking;
  if (booking?.datetime_operator_tz) {
    const verification = await verifyBooking(window, booking.datetime_operator_tz);
    written += await recordSuggestion({
      callId: params.callId,
      contactId: params.contactId,
      fieldType: 'booking',
      value: verification.corrected_datetime ?? booking.datetime_operator_tz,
      evidence: booking.evidence ?? null,
      confidence: verification.verified ? (booking.confidence ?? 0) : 0,
      note: verification.verified ? null : verification.reason,
    });
  }

  return { ran: true, suggestions: written };
}

/// §3.5 maps outcomes one-to-one onto stages, and the model speaks in outcomes.
function stageForOutcome(outcome: string): string {
  switch (outcome) {
    case 'booked':
      return 'Booked';
    case 'interested':
      return 'Interested';
    case 'callback':
      return 'Callback';
    case 'not_interested':
      return 'Not Interested';
    default:
      return 'New';
  }
}

/**
 * Records one suggestion, replacing any earlier one for the same field.
 *
 * Replacing rather than appending: the model revises as a call develops, and a
 * list of six superseded guesses at an email address is worse than one current
 * guess. A suggestion the operator has already decided on is left alone — being
 * re-offered something you dismissed is how a feature gets switched off.
 */
async function recordSuggestion(params: {
  callId: string;
  contactId: string;
  fieldType: string;
  value: string;
  evidence: string | null;
  confidence: number;
  note?: string | null;
}): Promise<number> {
  const decided = await db.aiSuggestion.findFirst({
    where: {
      contactId: params.contactId,
      fieldType: params.fieldType,
      outcome: { not: 'pending' },
    },
  });
  if (decided) return 0;

  const existing = await db.aiSuggestion.findFirst({
    where: { callId: params.callId, fieldType: params.fieldType, outcome: 'pending' },
  });

  const data = {
    callId: params.callId,
    contactId: params.contactId,
    fieldType: params.fieldType,
    value: params.value,
    evidence: params.evidence,
    confidence: params.confidence,
    // A booking that failed verification carries the reason so the chip can
    // show it greyed rather than silently vanish (§5.5).
    ...(params.fieldType === 'booking'
      ? { verified: params.confidence >= ACCEPT_THRESHOLD, verifyReason: params.note ?? null }
      : {}),
  };

  if (existing) {
    if (existing.value === params.value) return 0;
    await db.aiSuggestion.update({ where: { id: existing.id }, data });
    return 1;
  }

  await db.aiSuggestion.create({ data });
  return 1;
}
