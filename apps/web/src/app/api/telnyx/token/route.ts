import { NextResponse } from 'next/server';
import { mintWebrtcToken } from '@/integrations/telnyx/webrtc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Issues the JWT the Dialer page uses to register the browser softphone.
export async function POST() {
  try {
    const token = await mintWebrtcToken();
    return NextResponse.json({ token });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Could not get a phone token.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
