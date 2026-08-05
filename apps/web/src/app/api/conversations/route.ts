import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Conversations, one row per **contact** (§7.2).
 *
 * The page this replaces listed one row per interaction, so a lead called three
 * times appeared three times and the list was mostly the same handful of people
 * repeated. What the operator is actually looking for is *who* they have been
 * talking to and what was said last — a contact list ordered by recency, the
 * shape every messaging app uses, because it is the shape that answers the
 * question being asked.
 *
 * Written as one raw query rather than fetching contacts and their activities
 * separately. "Most recent interaction per contact" is a lateral join; doing it
 * in application code means either N+1 queries or pulling every activity into
 * memory to sort it.
 */

interface Row {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  jobTitle: string | null;
  phone: string;
  email: string | null;
  stageName: string | null;
  stageColor: string | null;
  lastDisposition: string | null;
  pipelineRemovedAt: Date | null;
  lastAt: Date | null;
  lastSummary: string | null;
  lastType: string | null;
}

const PAGE_SIZE = 50;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const q = p.get('q')?.trim() ?? '';
  const outcome = p.get('outcome')?.trim() ?? '';
  const tagId = p.get('tagId')?.trim() ?? '';
  const stageId = p.get('stageId')?.trim() ?? '';
  const offset = Math.max(0, Number(p.get('offset') ?? 0));

  // Parameterised throughout — these are operator-typed strings and the query
  // is assembled, which is exactly where injection lives.
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (q) {
    values.push(`%${q.toLowerCase()}%`);
    const i = values.length;
    conditions.push(`(
      lower(coalesce(c."firstName", '')) LIKE $${i}
      OR lower(coalesce(c."lastName", '')) LIKE $${i}
      OR lower(coalesce(c."companyName", '')) LIKE $${i}
      OR lower(coalesce(c."jobTitle", '')) LIKE $${i}
      OR lower(coalesce(c."email", '')) LIKE $${i}
      OR c."phone" LIKE $${i}
    )`);
  }

  if (outcome) {
    values.push(outcome);
    conditions.push(`c."lastDisposition" = $${values.length}`);
  }

  if (stageId) {
    values.push(stageId);
    conditions.push(`c."stageId" = $${values.length}`);
  }

  if (tagId) {
    values.push(tagId);
    conditions.push(
      `EXISTS (SELECT 1 FROM "ContactTag" ct WHERE ct."contactId" = c."id" AND ct."tagId" = $${values.length})`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  values.push(PAGE_SIZE + 1);
  const limitParam = `$${values.length}`;
  values.push(offset);
  const offsetParam = `$${values.length}`;

  const sql = `
    SELECT
      c."id", c."firstName", c."lastName", c."companyName", c."jobTitle",
      c."phone", c."email", c."lastDisposition", c."pipelineRemovedAt",
      s."name"  AS "stageName",
      s."color" AS "stageColor",
      a."createdAt" AS "lastAt",
      a."summary"   AS "lastSummary",
      a."type"      AS "lastType"
    FROM "Contact" c
    LEFT JOIN "PipelineStage" s ON s."id" = c."stageId"
    LEFT JOIN LATERAL (
      SELECT "createdAt", "summary", "type"
      FROM "Activity"
      WHERE "contactId" = c."id"
      ORDER BY "createdAt" DESC
      LIMIT 1
    ) a ON true
    ${where}
    -- Contacts with no interaction yet sort last rather than being dropped:
    -- an imported lead nobody has called is still someone to find.
    ORDER BY a."createdAt" DESC NULLS LAST, c."createdAt" DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const rows = await db.$queryRawUnsafe<Row[]>(sql, ...values);
  const hasMore = rows.length > PAGE_SIZE;

  return NextResponse.json({
    rows: rows.slice(0, PAGE_SIZE).map((r) => ({
      id: r.id,
      name:
        [r.firstName, r.lastName].filter(Boolean).join(' ') || formatPhone(r.phone),
      company: r.companyName,
      jobTitle: r.jobTitle,
      phone: r.phone,
      email: r.email,
      stageName: r.stageName,
      stageColor: r.stageColor,
      removed: r.pipelineRemovedAt !== null,
      lastDisposition: r.lastDisposition,
      lastAt: r.lastAt,
      preview: r.lastSummary,
      lastType: r.lastType,
    })),
    hasMore,
    nextOffset: offset + PAGE_SIZE,
  });
}

/// Local copy: this route is hot and importing the phone module for one
/// fallback is not worth it.
function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
