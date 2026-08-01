import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/session';

/**
 * The single-operator gate.
 *
 * Everything is private except the handful of paths below. The important one
 * is the Telnyx webhook: Telnyx cannot log in, and gating it would break call
 * records, voicemail drops and inbound calls in a way that looks like a
 * telephony fault rather than an auth change. It stays open and is instead
 * treated as untrusted input by its handler.
 */
const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  // Telnyx posts call events here. Must stay reachable without a session.
  '/api/telnyx/webhook',
  // The worker calls this every 15 minutes with the shared secret; there is no
  // operator at a browser when it runs. The route checks the secret itself.
  '/api/calendar/reconcile',
  // PWA plumbing, fetched by the browser before any cookie is attached.
  '/manifest.webmanifest',
  '/sw.js',
  '/workbox',
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`),
  );
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const session = await verifySession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (session) return NextResponse.next();

  // An API call gets a status it can act on; a page gets sent to the login
  // form. Redirecting a fetch() would hand the caller an HTML login page with
  // a 200 on it, which reads as success and fails much later and less clearly.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Not signed in.' },
      { status: 401 },
    );
  }

  const loginUrl = new URL('/login', request.url);
  // Come back where they were headed once they are in.
  if (pathname !== '/') loginUrl.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own build output and static image assets.
     * Those carry no lead data and gating them only costs a redirect on every
     * icon request.
     */
    '/((?!_next/static|_next/image|favicon.ico|icon-192.png|icon-512.png|apple-touch-icon.png).*)',
  ],
};
