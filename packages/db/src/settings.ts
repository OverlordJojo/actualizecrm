import { db } from './client';

/**
 * Operator preferences, shared by both services.
 *
 * This lives in `packages/db` rather than in the web app because the worker
 * reads the same keys — the daily email cap, the brief's send time, the bulk
 * drop spacing — and two copies of the defaults would drift the moment one
 * side gained a key. A setting that means one thing in the dialer and another
 * in the job that acts on it is a bug that only shows up in production.
 *
 * Nothing should read or write the Setting table with a raw string key; add it
 * here instead, so the Settings page and the defaults stay in one place.
 */
export const SETTING_DEFAULTS = {
  // Dialer
  'dialer.gapDelaySeconds': '2',
  'dialer.callerIdStrategy': 'nearest', // "nearest" | "roundRobin" | "fixed"
  'dialer.fixedCallerIdNumberId': '',
  'dialer.activePipelineId': '',

  // Audio
  'audio.musicInsteadOfRinging': 'true',
  'audio.ringbackVolume': '0.5',
  'audio.spotifyPlaylistUri': '',
  'audio.spotifyPlaylistName': '',
  'audio.defaultVoicemailId': '',

  // Voicemail drop
  /// Seconds between originations in a bulk drop. A batch that goes out in one
  /// burst is the shape carrier analytics flag, and one the operator cannot
  /// stop part-way.
  'voicemail.bulkSpacingSeconds': '30',

  // Email
  'email.provider': 'smtp', // "smtp" | "resend"
  'email.fromName': '',
  'email.fromAddress': '',
  'email.dailySendCap': '200',

  // Messaging
  'messaging.a2pStatus': 'unknown', // "unknown" | "approved" | "pending" | "missing"
  'messaging.a2pLastCheckedAt': '',

  // Daily brief (add-on C)
  'brief.enabled': 'false',
  /// 24-hour local time in the operator's zone.
  'brief.sendTime': '08:00',
  'brief.recipient': '',
  /// Written by the worker, not the operator: the local date the last brief
  /// went out, so a five-minute tick cannot send five briefs.
  'brief.lastSentDate': '',

  // Analytics
  /// Telnyx outbound rate per minute, used for the cost metrics.
  'analytics.ratePerMinute': '0.005',

  // Voice AI (§5.6)
  /// Comma-separated field types the operator has opted into auto-applying.
  /// Empty by default — nothing is auto-applied unless explicitly enabled.
  'ai.autoApplyFields': '',
  /// Auto-book with a visible undo window. Off by default; a booking written
  /// to a real calendar without a human deciding is not recoverable politely.
  'ai.autoBook': 'false',
  'transcription.enabled': 'true',
  /// Days before call audio is deleted by the retention sweep.
  'transcription.retentionDays': '30',

  // Multi-line dialing (§4)
  'dialer.linesPerBurst': '1',
  'dialer.holdMaxSeconds': '25',

  // Telephony
  'telnyx.webhookUrl': '',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export async function getSetting(key: SettingKey): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? SETTING_DEFAULTS[key];
}

export async function getSettings(): Promise<Record<SettingKey, string>> {
  const rows = await db.setting.findMany();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(
    Object.entries(SETTING_DEFAULTS).map(([k, v]) => [k, stored[k] ?? v]),
  ) as Record<SettingKey, string>;
}

export async function setSetting(key: SettingKey, value: string) {
  return db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function setSettings(values: Partial<Record<SettingKey, string>>) {
  const entries = Object.entries(values) as [SettingKey, string][];
  await db.$transaction(
    entries.map(([key, value]) =>
      db.setting.upsert({ where: { key }, create: { key, value }, update: { value } }),
    ),
  );
}

export function asBool(value: string): boolean {
  return value === 'true' || value === '1';
}

export function asNumber(value: string, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
