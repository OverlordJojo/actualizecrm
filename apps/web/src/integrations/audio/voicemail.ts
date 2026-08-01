import { db } from '@/lib/db';
import * as r2 from '@/integrations/storage/r2';

/**
 * Voicemail recordings — the audio the operator drops into a call that reached
 * a machine.
 *
 * These used to live in `data/audio/`. They cannot any more: the app is hosted
 * and Vercel's filesystem is ephemeral, so a file written by an upload request
 * is gone by the next one. They live in R2 under `voicemail/`, and Telnyx
 * fetches them by presigned URL at drop time.
 */

/// Telnyx will happily fetch a large file, but a voicemail drop that runs
/// longer than a greeting gets cut off by the machine anyway.
export const MAX_BYTES = 10 * 1024 * 1024;

/// Telnyx plays mp3 and wav. Browsers report wav under several names.
const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
};

export function isSupportedAudio(mimeType: string, filename: string): boolean {
  if (EXTENSION_BY_MIME[mimeType.toLowerCase()]) return true;
  // Some browsers send an empty or generic type for a drag-and-dropped file.
  return /\.(mp3|wav)$/i.test(filename);
}

function extensionFor(mimeType: string, filename: string): string {
  return (
    EXTENSION_BY_MIME[mimeType.toLowerCase()] ??
    (/\.wav$/i.test(filename) ? 'wav' : 'mp3')
  );
}

export interface StoredRecording {
  id: string;
  name: string;
  filePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  isDefault: boolean;
  createdAt: Date;
}

export async function listRecordings(): Promise<StoredRecording[]> {
  return db.voicemailRecording.findMany({
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function saveRecording(
  name: string,
  bytes: Buffer,
  mimeType: string,
  filename: string,
): Promise<StoredRecording> {
  const ext = extensionFor(mimeType, filename);
  // Random component rather than the display name: two recordings called
  // "Greeting" must not overwrite one another in the bucket.
  const key = `${r2.PREFIX.voicemail}/${crypto.randomUUID()}.${ext}`;

  await r2.put(key, bytes, ext === 'wav' ? 'audio/wav' : 'audio/mpeg');

  const existing = await db.voicemailRecording.count();

  return db.voicemailRecording.create({
    data: {
      name,
      filePath: key,
      mimeType: ext === 'wav' ? 'audio/wav' : 'audio/mpeg',
      sizeBytes: bytes.byteLength,
      // The first recording uploaded becomes the default, so the operator can
      // press V without having visited Settings twice.
      isDefault: existing === 0,
    },
  });
}

export async function setDefaultRecording(id: string): Promise<void> {
  await db.$transaction([
    db.voicemailRecording.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    }),
    db.voicemailRecording.update({ where: { id }, data: { isDefault: true } }),
  ]);
}

export async function deleteRecording(id: string): Promise<void> {
  const rec = await db.voicemailRecording.findUnique({ where: { id } });
  if (!rec) return;

  await r2.remove(rec.filePath).catch(() => {
    // Losing the bucket object is not a reason to keep a dead row around.
  });
  await db.voicemailRecording.delete({ where: { id } });

  // Never leave the library without a default while recordings still exist —
  // that silently turns hotkey V into a no-op.
  if (rec.isDefault) {
    const next = await db.voicemailRecording.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (next) await setDefaultRecording(next.id);
  }
}

/**
 * Which recording a drop should play.
 *
 * Explicit choice wins, then the marked default, then the most recent upload.
 * The last fallback matters: an operator mid-session who just deleted their
 * default should still be able to drop.
 */
export async function resolveRecording(
  explicitId?: string | null,
): Promise<StoredRecording | null> {
  if (explicitId) {
    const chosen = await db.voicemailRecording.findUnique({
      where: { id: explicitId },
    });
    if (chosen) return chosen;
  }

  const preferred = await db.voicemailRecording.findFirst({
    where: { isDefault: true },
  });
  if (preferred) return preferred;

  return db.voicemailRecording.findFirst({ orderBy: { createdAt: 'desc' } });
}

/**
 * A URL Telnyx can fetch the audio from.
 *
 * Fifteen minutes: long enough that a queued drop originated a few minutes ago
 * still resolves, short enough that a leaked URL is not a standing link to the
 * operator's recordings.
 */
export async function playbackUrl(rec: StoredRecording): Promise<string> {
  return r2.signedUrl(rec.filePath, 15 * 60);
}

// ---------------------------------------------------------------------------
// TCPA acknowledgement (build step 6)
// ---------------------------------------------------------------------------

export const BULK_VOICEMAIL_ACK_KIND = 'bulk_voicemail_never_called';

/**
 * The exact wording the operator has to accept before bulk drops may target
 * numbers that have never been called.
 *
 * Stored verbatim on the acknowledgement row rather than referenced by key, so
 * the audit record still says what was actually agreed to if this copy is
 * later reworded.
 */
export const BULK_VOICEMAIL_ACK_TEXT = [
  'Bulk and ringless voicemail to US numbers without prior express consent',
  'carries TCPA exposure. Statutory damages run $500–$1,500 per message and',
  'this is actively litigated. Courts have treated ringless voicemail as a',
  'call for TCPA purposes. 10DLC or carrier approval does not constitute',
  'consent. I confirm I know where this list came from and that I accept',
  'responsibility for dropping voicemail to numbers that have never been',
  'called.',
].join(' ');

export async function hasBulkAcknowledgement(): Promise<Date | null> {
  const row = await db.acknowledgement.findFirst({
    where: { kind: BULK_VOICEMAIL_ACK_KIND },
    orderBy: { acceptedAt: 'desc' },
  });
  return row?.acceptedAt ?? null;
}

export async function recordBulkAcknowledgement(): Promise<Date> {
  const row = await db.acknowledgement.create({
    data: {
      kind: BULK_VOICEMAIL_ACK_KIND,
      text: BULK_VOICEMAIL_ACK_TEXT,
    },
  });
  return row.acceptedAt;
}
