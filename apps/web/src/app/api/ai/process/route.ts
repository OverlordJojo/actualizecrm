import { NextResponse } from 'next/server';
import { z } from 'zod';
import { processCall } from '@/integrations/ai/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/// Transcription plus two model passes; the default 10s serverless cap is not
/// enough.
export const maxDuration = 300;

const bodySchema = z.object({ callId: z.string().min(1) });

/// Runs the post-call pipeline. Called after hangup, and retryable by hand
/// from the contact slide-over if a stage failed.
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'callId is required.' }, { status: 400 });
  }

  try {
    const result = await processCall(parsed.data.callId);
    return NextResponse.json(result);
  } catch (err) {
    // The pipeline degrades internally; reaching here means something outside
    // a stage failed. Never let it surface as a 500 that looks like the call
    // itself was lost.
    return NextResponse.json(
      {
        transcribed: false,
        extracted: false,
        analysed: false,
        suggestionsCreated: 0,
        error: String(err).slice(0, 300),
      },
      { status: 200 },
    );
  }
}
