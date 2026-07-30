/// SQLite has no JSON column type, so several fields are JSON-encoded text.
/// These helpers keep a bad parse from taking down a page render.

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export type CustomFieldValues = Record<string, string>;

export function parseCustomFields(raw: string | null | undefined): CustomFieldValues {
  return parseJson<CustomFieldValues>(raw, {});
}
