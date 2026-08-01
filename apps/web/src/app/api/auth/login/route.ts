import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyCredentials, isConfigured } from '@/lib/auth';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  signSession,
} from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/// Deliberately slow to brute-force from a single client: the operator logs in
/// a few times a month, so a delay nobody notices costs an attacker everything.
const FAILURE_DELAY_MS = 600;

export async function POST(request: Request) {
  if (!isConfigured()) {
    return NextResponse.json(
      {
        error:
          'Sign-in is not configured. Set AUTH_USERNAME, AUTH_PASSWORD_HASH and AUTH_SECRET.',
      },
      { status: 503 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Enter a username and password.' },
      { status: 400 },
    );
  }

  const ok = await verifyCredentials(parsed.data.username, parsed.data.password);

  if (!ok) {
    await new Promise((r) => setTimeout(r, FAILURE_DELAY_MS));
    // One message for both wrong-username and wrong-password: saying which was
    // wrong confirms half the credential.
    return NextResponse.json(
      { error: 'That username and password do not match.' },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ signedIn: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: await signSession(parsed.data.username),
    httpOnly: true,
    sameSite: 'lax',
    // Vercel is https; local dev over http would silently drop a secure cookie.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return response;
}
