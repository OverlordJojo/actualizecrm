import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listCalendars, selectCalendar } from '@/integrations/calendar/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Writable calendars only — §2 lets the operator pick which one to book into
/// when they have several.
export async function GET() {
  try {
    return NextResponse.json(await listCalendars());
  } catch (err) {
    return NextResponse.json(
      { error: `Could not read your calendars: ${String(err).slice(0, 160)}` },
      { status: 502 },
    );
  }
}

const pickSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });

export async function POST(request: Request) {
  const parsed = pickSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Pick a calendar.' }, { status: 400 });
  }
  await selectCalendar(parsed.data.id, parsed.data.name);
  return NextResponse.json({ selected: true });
}
