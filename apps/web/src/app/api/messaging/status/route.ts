import { NextResponse } from 'next/server';
import { checkA2pStatus, refreshA2pStatus } from '@/integrations/messaging/a2p';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Live registration status. Never a cached flag — see integrations/messaging.
export async function GET() {
  return NextResponse.json(await checkA2pStatus());
}

/// "Re-check status" from the Settings checklist. Same live call, but it also
/// records when the operator last looked.
export async function POST() {
  return NextResponse.json(await refreshA2pStatus());
}
