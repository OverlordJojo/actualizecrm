import OpenAI from 'openai';

/**
 * DeepInfra client for call extraction, booking verification and analysis
 * (§0.1).
 *
 * One account covers both the reasoning model and speech-to-text, which is why
 * it was chosen over a split Deepgram + LLM stack: two vendors means two keys,
 * two bills, two failure modes and two places to be rate limited.
 *
 * DeepInfra exposes an OpenAI-compatible endpoint, so this is the `openai`
 * package with `baseURL` pointed elsewhere rather than a bespoke HTTP client.
 * That matters beyond convenience — retries, streaming and error shapes all
 * come for free and stay correct.
 *
 * Model slugs live in the environment because vendors rename them, and a rename
 * should be a variable change rather than a deploy.
 */

const BASE_URL = 'https://api.deepinfra.com/v1/openai';

/// Reasoning and extraction. Needs JSON mode and a fast first token at short
/// context — the extraction prompt is small and runs mid-call.
export const LLM_MODEL =
  process.env.DEEPINFRA_LLM_MODEL || 'Qwen/Qwen3-235B-A22B-Instruct-2507';

/// Speech to text, for the post-call transcript.
export const STT_MODEL =
  process.env.DEEPINFRA_STT_MODEL || 'openai/whisper-large-v3-turbo';

let client: OpenAI | null = null;

export function deepinfra(): OpenAI {
  if (!process.env.DEEPINFRA_API_KEY) {
    throw new Error(
      'DEEPINFRA_API_KEY is not set — call extraction and analysis are disabled.',
    );
  }
  client ??= new OpenAI({
    apiKey: process.env.DEEPINFRA_API_KEY,
    baseURL: BASE_URL,
  });
  return client;
}

/**
 * Whether the pipeline can run at all.
 *
 * Asked rather than assumed, because §6.2 requires every number except AI
 * accept rate to be identical with the key removed. Code that throws when the
 * model is absent cannot satisfy that; code that checks can.
 */
export function aiAvailable(): boolean {
  return Boolean(process.env.DEEPINFRA_API_KEY);
}

/**
 * Parses a JSON response, tolerating a model that wrapped it in a code fence.
 *
 * JSON mode is requested on every call and models still occasionally fence
 * their output. Failing a whole extraction over three backticks is a poor
 * trade.
 */
export function parseJsonResponse<T>(raw: string, fallback: T): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

export interface CallResult<T> {
  value: T;
  /// Tokens billed, for the cost column on the Analytics page.
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * One extraction-shaped request.
 *
 * `temperature: 0` and JSON mode on every call, because this is extraction and
 * not writing: the same transcript has to produce the same fields twice, or the
 * suggestion chips flicker between values and the operator stops trusting them.
 *
 * Failures return the fallback rather than throwing. This runs mid-call, and
 * nothing it produces is worth interrupting a conversation for — a missing
 * suggestion is invisible, an unhandled error is not.
 */
export async function complete<T>(
  system: string,
  user: string,
  fallback: T,
  maxTokens = 2048,
): Promise<CallResult<T>> {
  const empty = { value: fallback, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  if (!aiAvailable()) return empty;

  try {
    const res = await deepinfra().chat.completions.create({
      model: LLM_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    return {
      value: parseJsonResponse<T>(res.choices[0]?.message?.content ?? '', fallback),
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      cachedTokens: 0,
    };
  } catch (err) {
    console.error('[ai] extraction failed', err);
    return empty;
  }
}

/**
 * Transcribes an audio file (§5.2).
 *
 * Chunked batch transcription lands segments roughly 3–6 seconds behind live
 * speech. True streaming would be under 500ms but needs a second vendor, and
 * the one-key constraint is deliberate. The lag is acceptable because
 * extraction is post-turn and human-confirmed: an email correction surfacing a
 * few seconds after it was said is fine. It would not be acceptable if the
 * model were driving the conversation.
 *
 * Kept behind one function so swapping to a streaming vendor is a single file.
 */
export async function transcribeAudio(
  audio: File,
  language = 'en',
): Promise<string> {
  if (!aiAvailable()) return '';

  try {
    const res = await deepinfra().audio.transcriptions.create({
      file: audio,
      model: STT_MODEL,
      language,
    });
    return res.text ?? '';
  } catch (err) {
    console.error('[ai] transcription failed', err);
    return '';
  }
}
