import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const response = NextResponse.json({ signedOut: true });
  // Expire rather than delete so a stale copy in the browser cannot be replayed.
  response.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return response;
}
