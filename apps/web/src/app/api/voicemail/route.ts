import { NextResponse } from 'next/server';
import * as r2 from '@/integrations/storage/r2';
import {
  listRecordings,
  saveRecording,
  isSupportedAudio,
  MAX_BYTES,
} from '@/integrations/audio/voicemail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const recordings = await listRecordings();
  return NextResponse.json({
    recordings,
    storageConfigured: r2.isConfigured(),
  });
}

/// Uploads one recording. Multipart rather than JSON — the file is binary and
/// base64 in a JSON body would inflate it by a third for no benefit.
export async function POST(request: Request) {
  if (!r2.isConfigured()) {
    return NextResponse.json(
      {
        error:
          'Object storage is not configured, so there is nowhere to keep the recording. Set the R2 keys and try again.',
      },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected a file upload.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was attached.' }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Keep recordings under ${MAX_BYTES / 1024 / 1024} MB — a drop longer than a greeting gets cut off anyway.`,
      },
      { status: 400 },
    );
  }

  if (!isSupportedAudio(file.type, file.name)) {
    return NextResponse.json(
      { error: 'Upload an mp3 or wav file.' },
      { status: 400 },
    );
  }

  const name =
    (form.get('name') as string | null)?.trim() ||
    file.name.replace(/\.[^.]+$/, '');

  const bytes = Buffer.from(await file.arrayBuffer());

  try {
    const saved = await saveRecording(name, bytes, file.type, file.name);
    return NextResponse.json(saved, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not store the recording: ${String(err).slice(0, 200)}` },
      { status: 500 },
    );
  }
}
