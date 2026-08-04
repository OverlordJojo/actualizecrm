import { google, type calendar_v3 } from 'googleapis';
import { OPERATOR_TIMEZONE } from '@actualizecrm/db';
import { db } from '@/lib/db';
import { encrypt, decrypt, isConfigured as cryptoConfigured } from './crypto';
import { DEFAULT_BOOKING_MINUTES } from '@/lib/operator-time';

/**
 * Google Calendar (§2).
 *
 * Only `calendar.events` is requested. That is enough to create, edit and read
 * the operator's bookings and nothing else — a scope that could delete
 * calendars is not needed to put a meeting on one.
 *
 * The refresh token is encrypted at rest (see ./crypto). Access tokens are not
 * stored at all: they last an hour, and refreshing on demand is cheaper than
 * reasoning about a cache that can be stale in ways that only show up when a
 * booking silently fails.
 */

/// Setting keys this module owns. Encrypted values carry the `enc:` shape from
/// ./crypto and must never be returned to the browser.
const KEY = {
  refreshToken: 'calendar.refreshTokenEnc',
  calendarId: 'calendar.selectedCalendarId',
  calendarName: 'calendar.selectedCalendarName',
  account: 'calendar.accountEmail',
  connectedAt: 'calendar.connectedAt',
  /// Set when Google rejects our refresh token. See `noteTokenRejected`.
  invalidAt: 'calendar.tokenInvalidAt',
  invalidReason: 'calendar.tokenInvalidReason',
} as const;

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

export function isConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      cryptoConfigured(),
  );
}

function oauthClient(redirectUri: string) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );
}

export function authUrl(redirectUri: string, state: string): string {
  return oauthClient(redirectUri).generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    // Without this, Google only returns a refresh token the *first* time an
    // account authorises. Reconnecting after a revoke would then succeed and
    // leave us unable to refresh — which fails hours later, not at connect
    // time, and looks like a Google outage.
    prompt: 'consent',
    include_granted_scopes: true,
    state,
  });
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<{ email: string | null }> {
  const client = oauthClient(redirectUri);
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Remove ActualizeCRM from your ' +
        'Google account permissions and connect again.',
    );
  }

  client.setCredentials(tokens);

  let email: string | null = null;
  try {
    const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    email = info.data.email ?? null;
  } catch {
    // The address is only used for display; failing to read it is not a
    // reason to reject a working connection.
  }

  await db.$transaction([
    upsert(KEY.refreshToken, encrypt(tokens.refresh_token)),
    upsert(KEY.account, email ?? ''),
    upsert(KEY.connectedAt, new Date().toISOString()),
  ]);
  // A fresh grant clears any previous rejection.
  await clearTokenRejection();

  return { email };
}

function upsert(key: string, value: string) {
  return db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

async function readSetting(key: string): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? '';
}

/// An authenticated client, or null when the operator has not connected.
export async function client(): Promise<calendar_v3.Calendar | null> {
  if (!isConfigured()) return null;

  const stored = await readSetting(KEY.refreshToken);
  if (!stored) return null;

  let refreshToken: string;
  try {
    refreshToken = decrypt(stored);
  } catch {
    // A key change or a corrupted value. Treat as disconnected rather than
    // throwing on every page that touches the calendar.
    return null;
  }

  const auth = oauthClient('');
  auth.setCredentials({ refresh_token: refreshToken });

  return google.calendar({ version: 'v3', auth });
}

export interface Connection {
  connected: boolean;
  configured: boolean;
  accountEmail: string;
  calendarId: string;
  calendarName: string;
  connectedAt: string;
  timezone: string;
  /// True when a token exists but Google has stopped accepting it. The
  /// difference matters: "not connected" means connect, "needs reconnect"
  /// means something revoked or expired what you already had.
  needsReconnect: boolean;
  reconnectReason: string;
}

/**
 * Records that Google rejected our refresh token.
 *
 * The failure mode this exists for: an OAuth app left in **Testing** publishing
 * status has its refresh tokens expired by Google after seven days. Bookings
 * then fail silently a week after everything looked fine, which is exactly the
 * kind of quiet breakage that gets discovered by a prospect not receiving an
 * invite. Recording it turns that into a visible "reconnect" state.
 */
export async function noteTokenRejected(reason: string): Promise<void> {
  await db.$transaction([
    upsert(KEY.invalidAt, new Date().toISOString()),
    upsert(KEY.invalidReason, reason.slice(0, 300)),
  ]).catch(() => {});
}

async function clearTokenRejection(): Promise<void> {
  await db.setting
    .deleteMany({ where: { key: { in: [KEY.invalidAt, KEY.invalidReason] } } })
    .catch(() => {});
}

/// Google reports both an expired and a revoked grant as `invalid_grant`.
export function isAuthFailure(err: unknown): boolean {
  const text = String(
    (err as { response?: { data?: unknown } })?.response?.data ??
      (err as Error)?.message ??
      err,
  ).toLowerCase();
  return (
    text.includes('invalid_grant') ||
    text.includes('token has been expired or revoked') ||
    text.includes('unauthorized_client')
  );
}

export async function connection(): Promise<Connection> {
  const [token, account, calendarId, calendarName, connectedAt, invalidAt, invalidReason] =
    await Promise.all([
      readSetting(KEY.refreshToken),
      readSetting(KEY.account),
      readSetting(KEY.calendarId),
      readSetting(KEY.calendarName),
      readSetting(KEY.connectedAt),
      readSetting(KEY.invalidAt),
      readSetting(KEY.invalidReason),
    ]);

  return {
    needsReconnect: Boolean(token && invalidAt),
    reconnectReason: invalidReason,
    connected: Boolean(token),
    configured: isConfigured(),
    accountEmail: account,
    // "primary" is Google's alias for the account's default calendar and is a
    // safe target before the operator picks one.
    calendarId: calendarId || 'primary',
    calendarName: calendarName || 'Primary calendar',
    connectedAt,
    timezone: OPERATOR_TIMEZONE,
  };
}

export async function disconnect(): Promise<void> {
  await db.setting.deleteMany({
    where: { key: { in: Object.values(KEY) } },
  });
}

/// Calendars the operator can write to, for the picker in Settings.
export async function listCalendars(): Promise<
  { id: string; name: string; primary: boolean }[]
> {
  const cal = await client();
  if (!cal) return [];

  let res;
  try {
    res = await cal.calendarList.list({ maxResults: 100 });
    await clearTokenRejection();
  } catch (err) {
    if (isAuthFailure(err)) {
      await noteTokenRejected(
        'Google rejected the saved authorisation. If the OAuth app is still in Testing, Google expires refresh tokens after seven days.',
      );
    }
    throw err;
  }
  return (res.data.items ?? [])
    // Only calendars we can actually create events on; a read-only subscribed
    // calendar in the list would just fail at booking time.
    .filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer')
    .map((c) => ({
      id: c.id!,
      name: c.summary ?? c.id!,
      primary: Boolean(c.primary),
    }));
}

export async function selectCalendar(id: string, name: string): Promise<void> {
  await db.$transaction([upsert(KEY.calendarId, id), upsert(KEY.calendarName, name)]);
}

export async function selectedCalendarId(): Promise<string> {
  return (await readSetting(KEY.calendarId)) || 'primary';
}

// ---------------------------------------------------------------------------
// The §2.4 booking format — fixed, and applied to every booking regardless of
// where it came from.
// ---------------------------------------------------------------------------

export interface BookingContact {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  companyLocation: string | null;
  email: string | null;
  phone: string;
}

export function bookingTitle(contact: BookingContact): string {
  const first = contact.firstName?.trim() || contact.companyName?.trim() || 'Client';
  return `${first}'s Client Acquisition Chat with Josh X`;
}

/**
 * Company, phone, location, and the last 10 lines of transcript for context.
 *
 * The transcript tail is the part that earns its place: walking into a booked
 * call remembering how the last one ended is the difference between a warm
 * follow-up and starting over.
 */
export function bookingDescription(
  contact: BookingContact,
  transcript?: string | null,
): string {
  const lines: string[] = [];
  if (contact.companyName) lines.push(`Company: ${contact.companyName}`);
  lines.push(`Phone: ${contact.phone}`);
  if (contact.companyLocation) lines.push(`Location: ${contact.companyLocation}`);
  if (contact.email) lines.push(`Email: ${contact.email}`);

  if (transcript?.trim()) {
    const tail = transcript.trim().split('\n').slice(-10).join('\n');
    lines.push('', 'Last 10 lines of the call:', tail);
  }

  lines.push('', 'Booked from ActualizeCRM.');
  return lines.join('\n');
}

export interface CreateEventInput {
  contact: BookingContact;
  startsAt: Date;
  durationMinutes: number;
  transcript?: string | null;
}

export interface CreatedEvent {
  googleEventId: string;
  googleCalendarId: string;
  title: string;
  description: string;
  /// False when the lead had no email, so the UI can flag "no invite sent".
  inviteSent: boolean;
}

export async function createEvent(input: CreateEventInput): Promise<CreatedEvent> {
  const cal = await client();
  if (!cal) throw new Error('Google Calendar is not connected.');

  const calendarId = await selectedCalendarId();
  const title = bookingTitle(input.contact);
  const description = bookingDescription(input.contact, input.transcript);
  const end = new Date(input.startsAt.getTime() + input.durationMinutes * 60_000);

  const hasEmail = Boolean(input.contact.email?.trim());

  const res = await cal.events.insert({
    calendarId,
    // Only send an invitation when there is somebody to invite; asking Google
    // to notify an empty attendee list is an error, not a no-op.
    sendUpdates: hasEmail ? 'all' : 'none',
    requestBody: {
      summary: title,
      description,
      start: { dateTime: input.startsAt.toISOString(), timeZone: OPERATOR_TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: OPERATOR_TIMEZONE },
      ...(hasEmail ? { attendees: [{ email: input.contact.email!.trim() }] } : {}),
    },
  });

  if (!res.data.id) throw new Error('Google did not return an event id.');
  await clearTokenRejection();

  return {
    googleEventId: res.data.id,
    googleCalendarId: calendarId,
    title,
    description,
    inviteSent: hasEmail,
  };
}

export async function updateEvent(
  googleEventId: string,
  calendarId: string,
  startsAt: Date,
  durationMinutes: number,
): Promise<void> {
  const cal = await client();
  if (!cal) throw new Error('Google Calendar is not connected.');

  const end = new Date(startsAt.getTime() + durationMinutes * 60_000);
  await cal.events.patch({
    calendarId,
    eventId: googleEventId,
    sendUpdates: 'all',
    requestBody: {
      start: { dateTime: startsAt.toISOString(), timeZone: OPERATOR_TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: OPERATOR_TIMEZONE },
    },
  });
}

export async function cancelEvent(
  googleEventId: string,
  calendarId: string,
): Promise<void> {
  const cal = await client();
  if (!cal) throw new Error('Google Calendar is not connected.');

  await cal.events.delete({ calendarId, eventId: googleEventId, sendUpdates: 'all' });
}

/// One event as Google currently sees it, for reconciliation.
export async function getEvent(
  googleEventId: string,
  calendarId: string,
): Promise<{ status: string; startsAt: Date | null; durationMinutes: number } | null> {
  const cal = await client();
  if (!cal) return null;

  try {
    const res = await cal.events.get({ calendarId, eventId: googleEventId });
    const start = res.data.start?.dateTime ?? res.data.start?.date;
    const end = res.data.end?.dateTime ?? res.data.end?.date;

    const startsAt = start ? new Date(start) : null;
    const durationMinutes =
      startsAt && end
        ? Math.max(Math.round((new Date(end).getTime() - startsAt.getTime()) / 60_000), 1)
        : 30;

    return { status: res.data.status ?? 'confirmed', startsAt, durationMinutes };
  } catch (err) {
    // 404/410 means the operator deleted it in Google.
    const status = (err as { code?: number }).code;
    if (status === 404 || status === 410) {
      return { status: 'cancelled', startsAt: null, durationMinutes: DEFAULT_BOOKING_MINUTES };
    }
    throw err;
  }
}
