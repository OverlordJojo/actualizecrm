import { DeepgramClient } from '@deepgram/sdk';
import type { TranscriptTurn } from '@/integrations/ai/extract';

/**
 * Post-call transcription via Deepgram, over the dual-channel recording.
 *
 * Speaker attribution here is **structural, not inferred**. Telnyx records the
 * call with `channels: "dual"` — channel 0 is the operator, channel 1 is the
 * prospect — and Deepgram's `multichannel` mode keeps them separate. No
 * diarization guesswork, which matters most exactly when it is hardest: during
 * crosstalk, where "the operator read the email back" and "the prospect gave
 * the email" are different facts.
 *
 * This replaced a local faster-whisper sidecar. Whisper ran continuously for
 * the whole call on the operator's laptop; this runs once, elsewhere, after
 * the call is already over.
 */

const CHANNEL_SPEAKER: Record<number, TranscriptTurn['speaker']> = {
  0: 'operator',
  1: 'prospect',
};

export interface TranscriptionResult {
  turns: TranscriptTurn[];
  /// Flat text, for full-text search on the Conversations page.
  text: string;
  durationSec: number;
}

export function isConfigured(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY);
}

function deepgram(): DeepgramClient {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set.');
  return new DeepgramClient({ apiKey });
}

/// Options shared by both entry points. `multichannel` is the important one.
const LISTEN_OPTIONS = {
  model: 'nova-3',
  language: 'en',
  // The whole point: keep the two legs apart rather than guessing.
  multichannel: true,
  punctuate: true,
  smart_format: true,
  utterances: true,
} as const;

/// Transcribes a recording already stored in R2, given a presigned URL.
export async function transcribeUrl(url: string): Promise<TranscriptionResult> {
  const result = await deepgram().listen.v1.media.transcribeUrl({
    url,
    ...LISTEN_OPTIONS,
  } as never);

  return toTurns(result);
}

/// Transcribes raw audio bytes (used when the file is already in hand).
export async function transcribeBuffer(
  audio: Buffer,
): Promise<TranscriptionResult> {
  const result = await deepgram().listen.v1.media.transcribeFile(
    audio as never,
    LISTEN_OPTIONS as never,
  );

  return toTurns(result);
}

/**
 * Flattens Deepgram's per-channel utterances into one chronological,
 * speaker-tagged transcript.
 *
 * Deepgram returns each channel separately; interleaving by start time is what
 * turns two monologues back into a conversation. Without the sort, the model
 * sees the operator's whole side followed by the prospect's whole side, and
 * every "they answered X after I asked Y" inference breaks.
 */
function toTurns(result: unknown): TranscriptionResult {
  const r = result as {
    results?: {
      utterances?: { channel: number; transcript: string; start: number; end: number }[];
      channels?: { alternatives?: { transcript?: string }[] }[];
    };
    metadata?: { duration?: number };
  };

  const utterances = r.results?.utterances ?? [];

  if (utterances.length > 0) {
    const turns: TranscriptTurn[] = utterances
      .slice()
      .sort((a, b) => a.start - b.start)
      .filter((u) => u.transcript.trim().length > 0)
      .map((u) => ({
        speaker: CHANNEL_SPEAKER[u.channel] ?? 'prospect',
        text: u.transcript.trim(),
      }));

    return {
      turns,
      text: turns.map((t) => `${t.speaker}: ${t.text}`).join('\n'),
      durationSec: Math.round(r.metadata?.duration ?? 0),
    };
  }

  // Fallback: a mono recording, or utterances disabled. One turn per channel,
  // which loses interleaving but is better than losing the transcript.
  const turns: TranscriptTurn[] = (r.results?.channels ?? [])
    .map((ch, i) => ({
      speaker: CHANNEL_SPEAKER[i] ?? 'prospect',
      text: (ch.alternatives?.[0]?.transcript ?? '').trim(),
    }))
    .filter((t) => t.text.length > 0);

  return {
    turns,
    text: turns.map((t) => `${t.speaker}: ${t.text}`).join('\n'),
    durationSec: Math.round(r.metadata?.duration ?? 0),
  };
}
