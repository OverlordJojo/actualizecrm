import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runImport } from '@/integrations/import/run';

export const runtime = 'nodejs';

const mappingSchema = z.object({
  mode: z.enum(['column', 'ignore', 'fixed']),
  column: z.string().optional(),
  fixedValue: z.string().optional(),
});

const bodySchema = z.object({
  listName: z.string().min(1, 'Give this list a name.'),
  sourceFile: z.string().optional(),
  mappings: z.record(mappingSchema),
  rows: z.array(z.record(z.string())),
});

export async function POST(request: Request) {
  try {
    const parsed = bodySchema.safeParse(await request.json());

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid import request.' },
        { status: 400 },
      );
    }

    const { mappings } = parsed.data;

    // Phone is the identity key for dedupe — an import with no phone mapping
    // would reject every single row, so refuse it up front with a useful
    // message rather than returning a report of all-rejected.
    const phoneMapping = mappings.phone;
    if (!phoneMapping || phoneMapping.mode === 'ignore') {
      return NextResponse.json(
        { error: 'Map a column to Phone — leads without a number cannot be dialed.' },
        { status: 400 },
      );
    }
    if (phoneMapping.mode === 'column' && !phoneMapping.column) {
      return NextResponse.json(
        { error: 'Pick which column holds the phone number.' },
        { status: 400 },
      );
    }
    if (phoneMapping.mode === 'fixed') {
      return NextResponse.json(
        { error: 'Phone cannot be a fixed value — every lead needs its own number.' },
        { status: 400 },
      );
    }

    if (parsed.data.rows.length === 0) {
      return NextResponse.json(
        { error: 'That file has no data rows.' },
        { status: 400 },
      );
    }

    const report = await runImport(parsed.data);
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
