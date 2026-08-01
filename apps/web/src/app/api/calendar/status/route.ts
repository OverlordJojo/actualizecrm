import { NextResponse } from 'next/server';
import { connection, disconnect } from '@/integrations/calendar/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Never returns the token itself — only whether one exists.
export async function GET() {
  return NextResponse.json(await connection());
}

export async function DELETE() {
  await disconnect();
  return NextResponse.json({ disconnected: true });
}
