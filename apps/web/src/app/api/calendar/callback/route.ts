import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { exchangeCode } from '@/integrations/calendar/google';
import { appBaseUrl, settingsUrl } from '@/lib/base-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const denied = params.get('error');
  if (denied) {
    return NextResponse.redirect(
      settingsUrl(request, `calendar_error=${encodeURIComponent(denied)}`),
    );
  }

  const code = params.get('code');
  const state = params.get('state');
  const expected = cookies().get('calendar_oauth_state')?.value;

  if (!code || !state || !expected || state !== expected) {
    return NextResponse.redirect(
      settingsUrl(
        request,
        `calendar_error=${encodeURIComponent(
          'That sign-in did not match the request we started. Try connecting again.',
        )}`,
      ),
    );
  }

  try {
    const { email } = await exchangeCode(
      code,
      `${appBaseUrl(request)}/api/calendar/callback`,
    );
    const response = NextResponse.redirect(
      settingsUrl(request, `calendar=connected${email ? `&as=${encodeURIComponent(email)}` : ''}`),
    );
    response.cookies.set({ name: 'calendar_oauth_state', value: '', path: '/', maxAge: 0 });
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not connect Google Calendar.';
    return NextResponse.redirect(
      settingsUrl(request, `calendar_error=${encodeURIComponent(message)}`),
    );
  }
}
