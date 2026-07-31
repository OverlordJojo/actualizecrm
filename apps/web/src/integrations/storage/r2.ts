import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Cloudflare R2 — call recordings and voicemail audio.
 *
 * R2 rather than S3 for one reason: **zero egress fees**. Recordings get
 * streamed back for playback constantly, and Telnyx fetches voicemail drop
 * files on every drop. On S3 every one of those bytes is billed outbound.
 *
 * R2 speaks the S3 API, so the AWS SDK works unchanged against its endpoint.
 */

let client: S3Client | null = null;

function r2(): S3Client {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      'R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.',
    );
  }

  client ??= new S3Client({
    // R2 is single-region; "auto" is what Cloudflare expects here.
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  return client;
}

function bucket(): string {
  const name = process.env.R2_BUCKET;
  if (!name) throw new Error('R2_BUCKET is not set.');
  return name;
}

export const PREFIX = {
  recordings: 'recordings',
  voicemail: 'voicemail',
} as const;

export async function put(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<string> {
  await r2().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

export async function get(key: string): Promise<Buffer> {
  const res = await r2().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
  );
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) throw new Error(`No such object: ${key}`);
  return Buffer.from(bytes);
}

export async function remove(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export async function list(prefix: string): Promise<string[]> {
  const res = await r2().send(
    new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix }),
  );
  return (res.Contents ?? []).map((o) => o.Key!).filter(Boolean);
}

/**
 * Time-limited public URL.
 *
 * Used for two things: playing a recording back in the browser, and handing
 * Telnyx a voicemail file to fetch. Telnyx needs a URL it can reach without
 * credentials, and a presigned URL gives that without making the bucket
 * public — a public bucket of call recordings is not something to leave lying
 * around.
 */
export async function signedUrl(key: string, expiresSeconds = 3600): Promise<string> {
  return getSignedUrl(
    r2(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: expiresSeconds },
  );
}

export function isConfigured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  );
}
