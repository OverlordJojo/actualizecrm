import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/session';

/**
 * The single-operator gate.
 *
 * Everything is private except the handful of paths below, and every exception
 * carries its own authentication — an unauthenticated hole would be worse than
 * no gate, because it would look closed.
 *
 * Telnyx used to be the awkward case: it cannot log in, so `/api/telnyx/webhook`
 * had to stay open to the public internet. §1 moved that endpoint to the worker,
 * where it authenticates each delivery by ed25519 signature. Nothing on the app
 * is now reachable by an unauthenticated stranger — what the worker calls here
 * it calls with the shared secret.
 */
const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  // The worker hands over the call events that need R2 or the extraction
  // pipeline. It presents the shared secret, which the route checks itself.
  '/api/telnyx/relay',
  // The worker calls this every 15 minutes with the shared secret; there is no
  // operator at a browser when it runs. The route checks the secret itself.
  '/api/calendar/reconcile',
  // Same shape: the worker calls this to hang up on held callers nobody is
  // left to take. It checks the shared secret itself.
  '/api/dialer/sweep',
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
