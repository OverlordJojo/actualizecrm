import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  playAudio,
  encodeClientState,
} from '@/integrations/telnyx/recording';
import { resolveRecording, playbackUrl } from '@/integrations/audio/voicemail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const dropSchema = z.object({
  callId: z.string().min(1),
  /// Omitted means "use the default recording".
  recordingId: z.string().optional(),
  /// The browser learns the Call Control id shortly after the leg comes up and
  /// may have it before the call row does.
  callControlId: z.string().optional(),
});

/**
 * Live voicemail drop — hotkey V.
 *
 * Plays the recording into the call that is already up. The hangup happens on
 * `call.playback.ended` rather than here, so the message is never truncated;
 * the browser then sees the hangup through its own SDK and auto-advances, the
 * same as any other call ending.
 */
export async function POST(request: Request) {
  const parsed = dropSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid drop request.' }, { status: 400 });
  }

  const { callId, recordingId, callControlId: fromClient } = parsed.data;

  const call = await db.call.findUnique({
    where: { id: callId },
    include: { contact: true },
  });
  if (!call) {
    return NextResponse.json({ error: 'Call not found.' }, { status: 404 });
  }

  const callControlId = call.callControlId ?? fromClient;
  if (!callControlId) {
    return NextResponse.json(
      {
        error:
          'That call is not up yet — give it a second and press V again.',
      },
      { status: 409 },
    );
  }

  if (call.voicemailDropped) {
    return NextResponse.json(
      { error: 'A recording is already playing into this call.' },
      { status: 409 },
    );
  }

  const recording = await resolveRecording(recordingId);
  if (!recording) {
    return NextResponse.json(
      {
        error:
          'No voicemail recording uploaded yet. Add one in Settings → Voicemail.',
      },
      { status: 400 },
    );
  }

  let url: string;
  try {
    url = await playbackUrl(recording);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach storage: ${String(err).slice(0, 200)}` },
      { status: 502 },
    );
  }

  try {
    await playAudio(
      callControlId,
      url,
      encodeClientState({ k: 'vmdrop', callId: call.id, recordingId: recording.id }),
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Telnyx refused the drop: ${String(err).slice(0, 200)}` },
      { status: 502 },
    );
  }

  // Recorded immediately rather than on playback.ended: if the webhook never
  // arrives, the operator should still see that a drop went out.
  await db.call.update({
    where: { id: call.id },
    data: {
      voicemailDropped: true,
      disposition: 'voicemail',
      callControlId,
    },
  });

  await db.contact.update({
    where: { id: call.contactId },
    data: { lastDisposition: 'voicemail', noAnswerStreak: 0 },
  });

  await db.activity.create({
    data: {
      contactId: call.contactId,
      type: 'voicemail_drop',
      direction: 'outbound',
      summary: `Dropped voicemail "${recording.name}"`,
      callId: call.id,
      meta: { recordingId: recording.id, recordingName: recording.name, mode: 'live' },
    },
  });

  return NextResponse.json({
    dropped: true,
    recordingName: recording.name,
  });
}
