/**
 * Operator settings moved to `packages/db` so the Railway worker reads the same
 * keys and defaults — the daily email cap and the brief's send time are acted
 * on there, not here.
 *
 * This module stays as the app's import point so every route handler that
 * already did `from '@/lib/settings'` kept working, the same way `@/lib/db`
 * survived the monorepo split.
 */
export {
  SETTING_DEFAULTS,
  getSetting,
  getSettings,
  setSetting,
  setSettings,
  asBool,
  asNumber,
  type SettingKey,
} from '@actualizecrm/db';
