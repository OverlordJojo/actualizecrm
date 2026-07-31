import Anthropic from '@anthropic-ai/sdk';

/**
 * Claude client for call extraction, analytics, and booking verification.
 *
 * v2 moved this off a local Ollama model. Running `qwen2.5:7b` on the
 * operator's laptop was free but spiked CPU on every extraction during a call
 * — and once the app moved to hosted, an HTTPS page cannot reach
 * `http://localhost:11434` at all (mixed content).
 */

export const MODEL = 'claude-haiku-4-5';

/**
 * A note on prompt caching, because the obvious assumption is wrong here.
 *
 * `cache_control` is set on the system block below, but **Haiku 4.5's minimum
 * cacheable prefix is 4,096 tokens** and the §5.4 extraction prompt is around
 * 1,200. Below the minimum the API silently declines to cache — no error, just
 * `cache_creation_input_tokens: 0` forever. Verified against the live API.
 *
 * So the marker is a no-op today. It is left in place deliberately: it costs
 * nothing, and it starts working the moment the prompt grows past 4K or the
 * model changes to one with a lower minimum (Opus 5 caches from 512 tokens).
 *
 * Practical consequence: extraction re-bills the full prompt on every segment.
 * That is why the cheap regex gate in prompts.ts matters more than it looks —
 * it, not caching, is what keeps this affordable.
 *
 * Caching is a prefix match, so nothing volatile may appear before the
 * breakpoint. All per-call context goes in the user turn regardless.
 */
let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — call extraction and analytics are disabled.',
    );
  }
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/// Parses a JSON response, tolerating a model that wrapped it in a code fence.
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

/// Pulls the concatenated text out of a response's content blocks.
export function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
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
 * `system` is cached; `user` is not. Keep everything that varies per call in
 * `user` or the cache never hits.
 */
export async function complete<T>(
  system: string,
  user: string,
  fallback: T,
  maxTokens = 2048,
): Promise<CallResult<T>> {
  const message = await anthropic().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: user }],
  });

  return {
    value: parseJsonResponse<T>(textOf(message), fallback),
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cachedTokens: message.usage.cache_read_input_tokens ?? 0,
  };
}
