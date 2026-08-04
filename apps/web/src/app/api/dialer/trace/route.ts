import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Softphone trace from the browser.
 *
 * The operator leg has failed three different ways now and every one of them
 * looked identical from the server: a leg that rang and was never answered.
 * The half that decides the outcome runs in a browser I cannot see, so it
 * reports what it did instead of being inferred from the outside.
 *
 * Written as `Activity` rows rather than a new table — they are already the
 * place time-ordered facts live, and this is deliberately temporary
 * instrumentation for one bug.
 */
export async function POST(request: Request) {
  let body: { event?: string; detail?: unknown; sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false });
  }

  if (!body.event) return NextResponse.json({ ok: false });

  await db.activity
    .create({
      data: {
        // Not tied to a contact; this is about the operator's own line.
        contactId: (await db.contact.findFirst({ select: { id: true } }))?.id ?? '',
        type: 'softphone_trace',
        summary: String(body.event).slice(0, 200),
        meta: {
          detail: body.detail ?? null,
          sessionId: body.sessionId ?? null,
          at: new Date().toISOString(),
        },
      },
    })
    .catch(() => {});

  return NextResponse.json({ ok: true });
}
