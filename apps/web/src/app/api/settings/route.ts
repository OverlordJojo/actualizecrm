import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getSettings,
  setSettings,
  SETTING_DEFAULTS,
  type SettingKey,
} from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getSettings());
}

const bodySchema = z.record(z.string());

/// Partial update. Unknown keys are rejected rather than silently stored, so a
/// typo in a setting name fails loudly instead of quietly doing nothing.
export async function PATCH(request: Request) {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid settings.' }, { status: 400 });
  }

  const known = Object.keys(SETTING_DEFAULTS);
  const unknown = Object.keys(parsed.data).filter((k) => !known.includes(k));
  if (unknown.length) {
    return NextResponse.json(
      { error: `Unknown setting(s): ${unknown.join(', ')}` },
      { status: 400 },
    );
  }

  await setSettings(parsed.data as Partial<Record<SettingKey, string>>);
  return NextResponse.json(await getSettings());
}
