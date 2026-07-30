import { db } from './db';

/// Every Setting key the app uses, with its default. Nothing should read or
/// write the Setting table with a raw string key — add it here instead, so the
/// Settings page and the defaults stay in one place.
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

  // Email
  'email.provider': 'smtp', // "smtp" | "resend"
  'email.fromName': '',
  'email.fromAddress': '',
  'email.dailySendCap': '200',

  // Messaging
  'messaging.a2pStatus': 'unknown', // "unknown" | "approved" | "pending" | "missing"
  'messaging.a2pLastCheckedAt': '',

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
