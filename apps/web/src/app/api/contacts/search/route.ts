import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The calendar lead picker (§2.3).
 *
 * Searches first name, last name, company, phone, email and location —
 * partial and case-insensitive — and deliberately includes leads that have
 * been removed from the pipeline. Someone marked not-interested in March is
 * exactly who calls back in June wanting a meeting, and not being able to find
 * them to book it would be absurd.
 *
 * Backed by the pg_trgm GIN indexes from the trigram migration; without them
 * every keystroke sequential-scans the contact table.
 */

const LIMIT = 20;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';

  if (q.length < 2) {
    // Two characters is where trigram matching starts being selective; below
    // that this would return an arbitrary slice of the whole table.
    return NextResponse.json([]);
  }

  // Digits typed into the box are a phone number however they were spaced.
  const digits = q.replace(/[^\d]/g, '');

  const contacts = await db.contact.findMany({
    where: {
      OR: [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { companyName: { contains: q, mode: 'insensitive' } },
        { companyLocation: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
      ],
    },
    orderBy: [{ lastDialedAt: 'desc' }, { createdAt: 'desc' }],
    take: LIMIT,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      companyName: true,
      companyLocation: true,
      phone: true,
      email: true,
      pipelineRemovedAt: true,
      stage: { select: { name: true } },
    },
  });

  return NextResponse.json(contacts);
}
