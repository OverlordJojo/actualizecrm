import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

/// Normalize whatever a spreadsheet threw at us into E.164.
/// Returns null when the value cannot be a real dialable number — the import
/// reports those rows rather than storing junk we would later try to dial.
export function toE164(
  raw: unknown,
  defaultCountry: CountryCode = 'US',
): string | null {
  if (raw === null || raw === undefined) return null;

  let s = String(raw).trim();
  if (!s) return null;

  // Spreadsheets love turning phone numbers into floats: 7025551234 -> 7025551234.0
  s = s.replace(/\.0+$/, '');

  // Strip common decorations that libphonenumber tolerates inconsistently.
  s = s.replace(/[^\d+]/g, (c) => (c === '+' ? '+' : ''));

  // A bare 11-digit US number missing its +.
  if (/^1\d{10}$/.test(s)) s = `+${s}`;
  else if (/^\d{10}$/.test(s)) s = `+1${s}`;

  const parsed = parsePhoneNumberFromString(s, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;

  return parsed.number;
}

/// Pretty form for the Active Lead Card: +17025551234 -> (702) 555-1234
export function formatPhone(e164?: string | null): string {
  if (!e164) return '';
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return parsed.country === 'US'
    ? parsed.formatNational()
    : parsed.formatInternational();
}

/// US area code, used for local-presence caller ID matching.
export function areaCodeOf(e164?: string | null): string | null {
  if (!e164) return null;
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed || parsed.country !== 'US') return null;
  return parsed.nationalNumber.toString().slice(0, 3);
}
