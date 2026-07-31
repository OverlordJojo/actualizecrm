import { db } from '@/lib/db';
import * as r2 from '@/integrations/storage/r2';
import * as deepgram from '@/integrations/transcribe/deepgram';
import {
  extractFromWindow,
  verifyBooking,
  analyseCall,
  type TranscriptTurn,
  type Extraction,
} from './extract';

/**
 * Post-call pipeline: recording → transcript → extraction → analysis.
 *
 * Runs once per call, after hangup. Every stage degrades independently — a
 * missing Deepgram key costs you the transcript but not the call record, and a
 * failed analysis costs you the coaching notes but not the extraction. None of
 * them may throw far enough to lose the call itself.
 */

export interface PipelineResult {
  transcribed: boolean;
  extracted: boolean;
  analysed: boolean;
  suggestionsCreated: number;
  error?: string;
}

/**
 * Fetches the Telnyx recording and stores it in R2.
 *
 * Telnyx keeps recordings for a limited window and charges for storage, so the
 * copy in R2 is the durable one. The key is derived from the call id, which
 * makes the operation idempotent — a retried webhook overwrites rather than
 * duplicating.
 */
export async function archiveRecording(
  callId: string,
  telnyxRecordingUrl: string,
): Promise<string | null> {
  if (!r2.isConfigured()) return null;

  const res = await fetch(telnyxRecordingUrl);
  if (!res.ok) return null;

  const audio = Buffer.from(await res.arrayBuffer());
  const key = `${r2.PREFIX.recordings}/${callId}.mp3`;

  await r2.put(key, audio, 'audio/mpeg');
  await db.call.update({
    where: { id: callId },
    data: { recordingPath: key },
  });

  return key;
}

/// Full post-call processing for one call.
export async function processCall(callId: string): Promise<PipelineResult> {
  const result: PipelineResult = {
    transcribed: false,
    extracted: false,
    analysed: false,
    suggestionsCreated: 0,
  };

  const call = await db.call.findUnique({
    where: { id: callId },
    include: { contact: true },
  });
  if (!call) return { ...result, error: 'Call not found.' };

  // --- 1. transcribe -------------------------------------------------------
  let turns: TranscriptTurn[] = [];

  if (call.recordingPath && deepgram.isConfigured() && r2.isConfigured()) {
    await db.call.update({
      where: { id: callId },
      data: { transcriptStatus: 'running' },
    });

    try {
      const url = await r2.signedUrl(call.recordingPath, 3600);
      const transcription = await deepgram.transcribeUrl(url);
      turns = transcription.turns;

      await db.call.update({
        where: { id: callId },
        data: {
          transcript: transcription.text,
          transcriptSegments: turns as never,
          transcriptStatus: 'done',
        },
      });
      result.transcribed = true;
    } catch (err) {
      await db.call.update({
        where: { id: callId },
        data: { transcriptStatus: 'failed' },
      });
      result.error = `Transcription: ${String(err).slice(0, 200)}`;
    }
  } else {
    await db.call.update({
      where: { id: callId },
      data: { transcriptStatus: 'skipped' },
    });
  }

  if (turns.length === 0) return result;

  // --- 2. extract ----------------------------------------------------------
  // The unconditional safety-net pass from §5.3: the live gate skips most
  // segments, so one pass over the whole transcript catches anything missed.
  let extraction: Extraction | null = null;
  try {
    extraction = await extractFromWindow(
      turns,
      {
        first_name: call.contact.firstName,
        last_name: call.contact.lastName,
        email: call.contact.email,
        company: call.contact.companyName,
        address: call.contact.address,
      },
      call.toE164,
      { force: true },
    );
    result.extracted = extraction !== null;
  } catch (err) {
    result.error = `Extraction: ${String(err).slice(0, 200)}`;
  }

  if (extraction) {
    result.suggestionsCreated = await recordSuggestions(
      callId,
      call.contactId,
      extraction,
      turns,
    );
  }

  // --- 3. analyse ----------------------------------------------------------
  try {
    const analysis = await analyseCall(turns, {
      durationSec: call.durationSec,
      disposition: call.disposition,
    });

    if (analysis) {
      await db.activity.create({
        data: {
          contactId: call.contactId,
          type: 'call',
          direction: 'outbound',
          summary: analysis.summary.slice(0, 200),
          body: analysis.summary,
          callId,
          meta: analysis as never,
        },
      });
      await applyObjectionTags(call.contactId, analysis.objections);
      result.analysed = true;
    }
  } catch (err) {
    result.error = `Analysis: ${String(err).slice(0, 200)}`;
  }

  return result;
}

/**
 * Turns an extraction into operator-facing suggestions.
 *
 * Nothing is written to the contact here — §5.6 is explicit that a wrong
 * auto-write to a lead's email costs a deal. Every field becomes an
 * accept/dismiss chip instead, logged with its confidence and evidence so the
 * model's reliability is measurable rather than assumed.
 */
async function recordSuggestions(
  callId: string,
  contactId: string,
  extraction: Extraction,
  turns: TranscriptTurn[],
): Promise<number> {
  const rows: {
    fieldType: string;
    value: string | null;
    evidence: string | null;
    confidence: number;
    verified?: boolean;
    verifyReason?: string;
  }[] = [];

  const simple = ['email', 'first_name', 'last_name', 'company', 'address'] as const;
  for (const field of simple) {
    const f = extraction[field];
    if (f?.value) {
      rows.push({
        fieldType: field,
        value: f.value,
        evidence: f.evidence,
        confidence: f.confidence ?? 0,
      });
    }
  }

  if (extraction.stage?.value && extraction.stage.value !== 'new') {
    rows.push({
      fieldType: 'stage',
      value: extraction.stage.value,
      evidence: extraction.stage.evidence,
      confidence: extraction.stage.confidence ?? 0,
    });
  }

  // Bookings get the second pass before they are ever shown (§5.5).
  const proposed = extraction.booking?.datetime_operator_tz;
  if (proposed) {
    let verified = false;
    let reason = 'Verification did not run.';
    try {
      const v = await verifyBooking(turns, proposed);
      verified = v.verified;
      reason = v.reason;
      rows.push({
        fieldType: 'booking',
        value: v.corrected_datetime || proposed,
        evidence: extraction.booking.evidence,
        confidence: extraction.booking.confidence ?? 0,
        verified,
        verifyReason: reason,
      });
    } catch {
      rows.push({
        fieldType: 'booking',
        value: proposed,
        evidence: extraction.booking.evidence,
        confidence: extraction.booking.confidence ?? 0,
        verified: false,
        verifyReason: 'Verification errored.',
      });
    }
  }

  if (rows.length === 0) return 0;

  await db.aiSuggestion.createMany({
    data: rows.map((r) => ({
      callId,
      contactId,
      fieldType: r.fieldType,
      value: r.value,
      evidence: r.evidence,
      confidence: r.confidence,
      verified: r.verified ?? null,
      verifyReason: r.verifyReason ?? null,
      outcome: 'pending',
    })),
  });

  return rows.length;
}

/// Auto-tags the contact when a configured objection phrase appears.
async function applyObjectionTags(
  contactId: string,
  objections: { type: string; quote: string }[],
): Promise<void> {
  if (objections.length === 0) return;

  const phrases = await db.objectionPhrase.findMany({ where: { enabled: true } });
  if (phrases.length === 0) return;

  const haystack = objections
    .map((o) => `${o.type} ${o.quote}`)
    .join(' ')
    .toLowerCase();

  for (const p of phrases) {
    if (!haystack.includes(p.phrase.toLowerCase())) continue;

    const tag = await db.tag.upsert({
      where: { name: p.tagName },
      create: { name: p.tagName, color: '#f59e0b' },
      update: {},
    });

    await db.contactTag
      .create({ data: { contactId, tagId: tag.id } })
      .catch(() => {
        // Already tagged — the composite primary key rejects the duplicate.
      });
  }
}
