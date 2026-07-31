/**
 * Prompts for call extraction, verification, and analysis.
 *
 * EXTRACTION_SYSTEM is the §5.4 prompt verbatim. It is cached, so it must stay
 * byte-stable — editing it invalidates the cache and re-bills the full prompt
 * on the next call. Change it deliberately, not casually.
 */

export const EXTRACTION_SYSTEM = `You extract structured facts from a live B2B cold call transcript. You output JSON only. No prose, no markdown, no code fences.

CONTEXT PROVIDED TO YOU:
- current_datetime_operator_tz: the exact current date and time in the operator's timezone
- operator_timezone: IANA timezone of the operator's calendar
- prospect_area_code: the area code of the number being dialed
- prospect_inferred_timezone: timezone derived from that area code
- lead_on_file: the currently stored first_name, last_name, email, company, address
- transcript_window: the last 8 speaker-tagged turns

ABSOLUTE RULES:
1. Extract ONLY what the PROSPECT explicitly stated. Never extract from OPERATOR turns. The operator reading an email address aloud to confirm it is NOT the prospect providing it.
2. If a fact was not explicitly stated, output null. Never infer, never complete, never guess a plausible value.
3. For every non-null field you MUST populate "evidence" with the prospect's literal words that justify it. If you cannot quote them, the field must be null.
4. Output a confidence between 0.0 and 1.0 for every non-null field. Be harsh. Audio is noisy and mistakes are expensive.
5. Only report a field as changed if it MEANINGFULLY differs from lead_on_file. Ignore casing, punctuation, and whitespace differences.

EMAIL RULES:
- Reconstruct spelled-out addresses: "j-o-s-h at gmail dot com" becomes "josh@gmail.com".
- "dot" becomes ".", "at" becomes "@", "underscore" becomes "_", "dash" and "hyphen" become "-".
- Only report an email correction if the prospect is supplying a DIFFERENT address, not confirming the existing one. "Yes that's right" is a confirmation — output null.
- Validate the result is a syntactically valid address. If not, output null.

DATETIME RULES:
- Resolve relative expressions against current_datetime_operator_tz. "Next Tuesday" means the Tuesday of the following week, not the coming Tuesday, unless the prospect clarifies.
- Determine the prospect's timezone in this priority order: (a) they explicitly state one, (b) prospect_inferred_timezone from area code, (c) operator_timezone. Report which method you used in timezone_source.
- Convert the agreed time INTO operator_timezone and output it in that zone as an ISO 8601 string with offset.
- Ambiguous AM/PM: business hours assumption only for 8-11 (AM) and 1-6 (PM). For 12 or 7, output null and set needs_clarification true.
- A time is only a booking if the prospect AGREED to it. A time the operator proposed and the prospect did not accept is not a booking.

STAGE RULES — choose exactly one:
- "booked": prospect agreed to a specific date AND time
- "interested": positive signal, wants information, asked substantive questions, but no time agreed
- "callback": asked to be contacted at a later unspecified time, or said now is bad
- "not_interested": explicit rejection, asked to be removed, or hostile
- "new": no clear signal yet
Do not report "booked" without a resolvable datetime.

OUTPUT SCHEMA — return exactly this shape:
{
  "email": {"value": string|null, "evidence": string|null, "confidence": number},
  "first_name": {"value": string|null, "evidence": string|null, "confidence": number},
  "last_name": {"value": string|null, "evidence": string|null, "confidence": number},
  "company": {"value": string|null, "evidence": string|null, "confidence": number},
  "address": {"value": string|null, "evidence": string|null, "confidence": number},
  "booking": {
    "datetime_operator_tz": string|null,
    "prospect_stated_time": string|null,
    "timezone_source": "explicit"|"area_code"|"operator_default"|null,
    "duration_minutes": number|null,
    "needs_clarification": boolean,
    "evidence": string|null,
    "confidence": number
  },
  "stage": {"value": string, "evidence": string|null, "confidence": number},
  "is_gatekeeper": boolean,
  "is_voicemail_or_automated": boolean
}`;

export const VERIFY_SYSTEM = `You are verifying a proposed appointment extraction. Given the transcript window, the current datetime in the operator's timezone, and the proposed booking, answer:
1. Did the prospect explicitly agree to this specific date and time?
2. Is the timezone conversion arithmetic correct?
3. Is the resolved date in the future and within the next 90 days?
Output JSON only: {"verified": boolean, "reason": string, "corrected_datetime": string|null}`;

/**
 * End-of-call analysis. Runs once per call over the full transcript, so it can
 * afford a wider view than the live extraction pass.
 *
 * Kept deliberately separate from EXTRACTION_SYSTEM: they cache independently,
 * and mixing them would mean the long analysis prompt gets re-read on every
 * mid-call extraction.
 */
export const ANALYSIS_SYSTEM = `You analyse a completed B2B cold call from its speaker-tagged transcript. You output JSON only. No prose, no markdown, no code fences.

You are writing for the operator who made the call. Be specific and useful, not encouraging. Point at what actually happened, quoting the prospect where it matters. A vague observation is worse than none.

RULES:
1. Judge only what is in the transcript. Do not speculate about what the prospect was thinking.
2. Quote the prospect's literal words in every "evidence" field. If you cannot quote it, leave the field null.
3. "talk_ratio_operator" is the share of words spoken by the operator, 0.0 to 1.0. Compute it, do not estimate.
4. Objections are things the prospect raised as reasons not to proceed. A question is not an objection.
5. "coaching" must name a specific moment and a specific alternative, not general advice. Maximum three items, fewest is better. If the call gave you nothing concrete, return an empty array.
6. "outcome" must match what actually happened, not what the operator hoped.

OUTPUT SCHEMA — return exactly this shape:
{
  "summary": string,
  "outcome": "booked"|"interested"|"callback"|"not_interested"|"no_contact"|"gatekeeper"|"voicemail",
  "talk_ratio_operator": number,
  "objections": [{"type": string, "quote": string, "handled": boolean}],
  "buying_signals": [{"signal": string, "quote": string}],
  "coaching": [{"moment": string, "what_happened": string, "try_instead": string}],
  "next_step": string|null,
  "sentiment": "positive"|"neutral"|"negative",
  "prospect_engaged": boolean
}`;

/**
 * Cheap gate before calling the model (§5.3).
 *
 * Most turns contain nothing extractable. Running the model on every segment
 * would multiply cost for no benefit, so these heuristics decide whether a
 * segment is even worth asking about. An unconditional pass still runs at call
 * end as a safety net.
 */
const EMAIL_HINTS =
  /@|at gmail|at yahoo|at outlook|at hotmail|dot com|dot net|dot org|dot co/i;
const SPELLED = /\b(?:[a-z][\s,.-]+){3,}/i;
const TIME_HINTS =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|morning|afternoon|evening|noon|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\s*(?:am|pm)|\d{1,2}:\d{2})\b/i;
const INTENT =
  /\b(not interested|remove me|take me off|call me back|reach me|send me|sounds good|let'?s do it|no thanks|stop calling)\b/i;
const PHONE_SHAPED = /(?:\d[\s-]?){7,}/;

export function worthExtracting(text: string): boolean {
  return (
    EMAIL_HINTS.test(text) ||
    SPELLED.test(text) ||
    TIME_HINTS.test(text) ||
    INTENT.test(text) ||
    PHONE_SHAPED.test(text)
  );
}
