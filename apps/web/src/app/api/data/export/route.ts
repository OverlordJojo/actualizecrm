import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * CSV export (build step 10).
 *
 * Plain CSV rather than a proprietary backup format: it opens in anything, and
 * an export you cannot read without the app that wrote it is not much of a
 * backup. Rows stream out in creation order so repeated exports diff cleanly.
 */

const TABLES = ['contacts', 'calls', 'activities', 'bookings', 'messages', 'emails'] as const;
type Table = (typeof TABLES)[number];

/// RFC 4180: quote anything containing a comma, quote or newline, and double
/// up embedded quotes. A lead called `Smith, Inc "The Best"` must not shift
/// every later column by one.
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(',')),
  ].join('\n');
}

export async function GET(request: Request) {
  const table = new URL(request.url).searchParams.get('table') as Table | null;
  if (!table || !TABLES.includes(table)) {
    return NextResponse.json(
      { error: `Pick one of: ${TABLES.join(', ')}` },
      { status: 400 },
    );
  }

  let rows: Record<string, unknown>[] = [];

  switch (table) {
    case 'contacts':
      rows = await db.contact.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, firstName: true, lastName: true, phone: true, email: true,
          companyName: true, companyLocation: true, address: true, source: true,
          lastDisposition: true, dialCount: true, connectCount: true,
          everConnected: true, doNotContact: true, pipelineRemovedAt: true,
          removalReason: true, createdAt: true,
        },
      });
      break;
    case 'calls':
      rows = await db.call.findMany({
        orderBy: { startedAt: 'asc' },
        select: {
          id: true, contactId: true, direction: true, status: true,
          disposition: true, fromE164: true, toE164: true, startedAt: true,
          answeredAt: true, endedAt: true, durationSec: true, amdResult: true,
          ownerConnect: true, nonOwnerConnect: true, voicemailDropped: true,
          heldSeconds: true, burstId: true, transcriptStatus: true,
        },
      });
      break;
    case 'activities':
      rows = await db.activity.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, contactId: true, type: true, direction: true,
          summary: true, body: true, callId: true, createdAt: true,
        },
      });
      break;
    case 'bookings':
      rows = await db.booking.findMany({
        orderBy: { startsAt: 'asc' },
        select: {
          id: true, contactId: true, startsAt: true, durationMinutes: true,
          title: true, status: true, inviteSent: true, createdByAi: true,
          googleEventId: true, createdAt: true,
        },
      });
      break;
    case 'messages':
      rows = await db.message.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, contactId: true, direction: true, body: true,
          fromE164: true, toE164: true, status: true, error: true, createdAt: true,
        },
      });
      break;
    case 'emails':
      rows = await db.emailMessage.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, contactId: true, direction: true, subject: true,
          fromAddr: true, toAddr: true, status: true, provider: true,
          error: true, createdAt: true,
        },
      });
      break;
  }

  const csv = toCsv(rows as Record<string, unknown>[]);
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv || 'no rows', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="actualizecrm-${table}-${stamp}.csv"`,
    },
  });
}
