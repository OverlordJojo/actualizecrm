import { OPERATOR_TIMEZONE } from '@actualizecrm/db';
import { complete } from './client';
import {
  EXTRACTION_SYSTEM,
  VERIFY_SYSTEM,
  ANALYSIS_SYSTEM,
  worthExtracting,
} from './prompts';
import { areaCodeOf } from '@/lib/phone';

export interface Field<T = string> {
  value: T | null;
  evidence: string | null;
  confidence: number;
}

export interface BookingField {
  datetime_operator_tz: string | null;
  prospect_stated_time: string | null;
  timezone_source: 'explicit' | 'area_code' | 'operator_default' | null;
  duration_minutes: number | null;
  needs_clarification: boolean;
  evidence: string | null;
  confidence: number;
}

export interface Extraction {
  email: Field;
  first_name: Field;
  last_name: Field;
  company: Field;
  address: Field;
  booking: BookingField;
  stage: Field;
  is_gatekeeper: boolean;
  is_voicemail_or_automated: boolean;
}

export interface TranscriptTurn {
  speaker: 'operator' | 'prospect';
  text: string;
}

export interface LeadOnFile {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  company?: string | null;
  address?: string | null;
}

const EMPTY_FIELD: Field = { value: null, evidence: null, confidence: 0 };

const EMPTY_EXTRACTION: Extraction = {
  email: EMPTY_FIELD,
  first_name: EMPTY_FIELD,
  last_name: EMPTY_FIELD,
  company: EMPTY_FIELD,
  address: EMPTY_FIELD,
  booking: {
    datetime_operator_tz: null,
    prospect_stated_time: null,
    timezone_source: null,
    duration_minutes: null,
    needs_clarification: false,
    evidence: null,
    confidence: 0,
  },
  stage: { value: 'new', evidence: null, confidence: 0 },
  is_gatekeeper: false,
  is_voicemail_or_automated: false,
};

/// Rough area-code → IANA zone map for the NANP zones an operator actually
/// dials. Anything unlisted falls back to the operator's own timezone, which
/// the prompt is told to report as `operator_default`.
const AREA_CODE_TZ: Record<string, string> = {
  // Pacific
  '206': 'America/Los_Angeles', '213': 'America/Los_Angeles', '236': 'America/Vancouver',
  '250': 'America/Vancouver', '310': 'America/Los_Angeles', '323': 'America/Los_Angeles',
  '408': 'America/Los_Angeles', '415': 'America/Los_Angeles', '503': 'America/Los_Angeles',
  '509': 'America/Los_Angeles', '604': 'America/Vancouver', '619': 'America/Los_Angeles',
  '702': 'America/Los_Angeles', '714': 'America/Los_Angeles', '778': 'America/Vancouver',
  '858': 'America/Los_Angeles', '925': 'America/Los_Angeles',
  // Mountain
  '303': 'America/Denver', '385': 'America/Denver', '480': 'America/Phoenix',
  '505': 'America/Denver', '602': 'America/Phoenix', '720': 'America/Denver',
  '801': 'America/Denver', '403': 'America/Edmonton', '587': 'America/Edmonton',
  // Central
  '214': 'America/Chicago', '281': 'America/Chicago', '312': 'America/Chicago',
  '512': 'America/Chicago', '612': 'America/Chicago', '713': 'America/Chicago',
  '773': 'America/Chicago', '832': 'America/Chicago', '204': 'America/Winnipeg',
  // Eastern
  '212': 'America/New_York', '215': 'America/New_York', '305': 'America/New_York',
  '404': 'America/New_York', '416': 'America/Toronto', '617': 'America/New_York',
  '646': 'America/New_York', '703': 'America/New_York', '718': 'America/New_York',
  '813': 'America/New_York', '905': 'America/Toronto',
};

function timezoneForAreaCode(phone: string | null): {
  areaCode: string | null;
  tz: string;
} {
  const areaCode = phone ? areaCodeOf(phone) : null;
  return {
    areaCode,
    tz: (areaCode && AREA_CODE_TZ[areaCode]) || OPERATOR_TIMEZONE,
  };
}

/**
 * Live extraction over the trailing transcript window.
 *
 * Returns null when the segment does not clear the cheap gate — the caller
 * should treat that as "nothing to show", not as a failure.
 */
export async function extractFromWindow(
  window: TranscriptTurn[],
  leadOnFile: LeadOnFile,
  prospectPhone: string | null,
  opts: { force?: boolean } = {},
): Promise<Extraction | null> {
  const lastProspect = [...window]
    .reverse()
    .find((t) => t.speaker === 'prospect');

  if (!opts.force) {
    if (!lastProspect) return null;
    if (!worthExtracting(lastProspect.text)) return null;
  }

  const { areaCode, tz } = timezoneForAreaCode(prospectPhone);

  const payload = {
    current_datetime_operator_tz: new Date().toLocaleString('sv-SE', {
      timeZone: OPERATOR_TIMEZONE,
    }),
    operator_timezone: OPERATOR_TIMEZONE,
    prospect_area_code: areaCode,
    prospect_inferred_timezone: tz,
    lead_on_file: leadOnFile,
    transcript_window: window.slice(-8),
  };

  const { value } = await complete<Extraction>(
    EXTRACTION_SYSTEM,
    JSON.stringify(payload),
    EMPTY_EXTRACTION,
  );

  return value;
}

export interface Verification {
  verified: boolean;
  reason: string;
  corrected_datetime: string | null;
}

/**
 * Second pass over a proposed booking (§5.5).
 *
 * A mis-parsed timezone puts a meeting in the wrong hour and the prospect is
 * gone, so a proposal is only surfaced once a fresh call agrees with it. The
 * date-window check is enforced here in code rather than trusted to the model,
 * because arithmetic is the part it is worst at.
 */
export async function verifyBooking(
  window: TranscriptTurn[],
  proposedIso: string,
): Promise<Verification> {
  const payload = {
    current_datetime_operator_tz: new Date().toLocaleString('sv-SE', {
      timeZone: OPERATOR_TIMEZONE,
    }),
    operator_timezone: OPERATOR_TIMEZONE,
    proposed_booking: proposedIso,
    transcript_window: window.slice(-8),
  };

  const { value } = await complete<Verification>(
    VERIFY_SYSTEM,
    JSON.stringify(payload),
    { verified: false, reason: 'Verification failed to parse.', corrected_datetime: null },
    512,
  );

  const candidate = value.corrected_datetime || proposedIso;
  const when = new Date(candidate);
  const now = Date.now();
  const ninetyDays = now + 90 * 24 * 60 * 60 * 1000;

  if (Number.isNaN(when.getTime())) {
    return {
      verified: false,
      reason: 'Could not parse the resolved datetime.',
      corrected_datetime: null,
    };
  }
  if (when.getTime() <= now || when.getTime() > ninetyDays) {
    return {
      verified: false,
      reason: 'Resolved date is in the past or beyond 90 days.',
      corrected_datetime: null,
    };
  }

  return value;
}

export interface CallAnalysis {
  summary: string;
  outcome:
    | 'booked' | 'interested' | 'callback' | 'not_interested'
    | 'no_contact' | 'gatekeeper' | 'voicemail';
  talk_ratio_operator: number;
  objections: { type: string; quote: string; handled: boolean }[];
  buying_signals: { signal: string; quote: string }[];
  coaching: { moment: string; what_happened: string; try_instead: string }[];
  next_step: string | null;
  sentiment: 'positive' | 'neutral' | 'negative';
  prospect_engaged: boolean;
}

const EMPTY_ANALYSIS: CallAnalysis = {
  summary: '',
  outcome: 'no_contact',
  talk_ratio_operator: 0,
  objections: [],
  buying_signals: [],
  coaching: [],
  next_step: null,
  sentiment: 'neutral',
  prospect_engaged: false,
};

/// End-of-call analysis over the whole transcript. Runs once per call.
export async function analyseCall(
  transcript: TranscriptTurn[],
  meta: { durationSec: number; disposition?: string | null },
): Promise<CallAnalysis | null> {
  // A transcript this short has nothing to analyse and would only produce
  // confident-sounding noise.
  if (transcript.length < 2) return null;

  const payload = {
    duration_seconds: meta.durationSec,
    operator_disposition: meta.disposition ?? null,
    transcript,
  };

  const { value } = await complete<CallAnalysis>(
    ANALYSIS_SYSTEM,
    JSON.stringify(payload),
    EMPTY_ANALYSIS,
    3072,
  );

  return value;
}
