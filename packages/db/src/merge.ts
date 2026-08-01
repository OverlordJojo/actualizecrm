/**
 * Merge fields for SMS and email templates.
 *
 * Shared because a template written on the Settings page is rendered by the
 * worker hours later. If the two sides disagreed about what `{{company}}`
 * means, the operator would preview one thing and the prospect would receive
 * another — and nothing would error.
 */

export interface MergeContext {
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  companyLocation?: string | null;
  email?: string | null;
  phone?: string | null;
}

/// The documented set. Anything outside it is left untouched rather than
/// blanked, so a stray brace in body copy survives instead of eating text.
const FIELDS: Record<string, (c: MergeContext) => string | null | undefined> = {
  first_name: (c) => c.firstName,
  last_name: (c) => c.lastName,
  company: (c) => c.companyName,
  location: (c) => c.companyLocation,
  email: (c) => c.email,
  phone: (c) => c.phone,
};

export function renderMergeFields(template: string, contact: MergeContext): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, rawName: string) => {
    const resolve = FIELDS[rawName.toLowerCase()];
    if (!resolve) return whole;
    // An unknown *value* becomes empty rather than the literal placeholder:
    // "Hi ," reads as a missing name, "Hi {{first_name}}," reads as a broken
    // product.
    return (resolve(contact) ?? '').trim();
  });
}

/// Which placeholders a template uses, for the "this will render as" preview.
export function mergeFieldsUsed(template: string): string[] {
  const found: string[] = [];
  template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (FIELDS[key] && !found.includes(key)) found.push(key);
    return whole;
  });
  return found;
}

export const AVAILABLE_MERGE_FIELDS = Object.keys(FIELDS);
