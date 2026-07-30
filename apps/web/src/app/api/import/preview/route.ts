import { NextResponse } from 'next/server';
import { parseSpreadsheet, guessMapping, isAcceptedFilename } from '@/integrations/import/parse';

export const runtime = 'nodejs';

const PREVIEW_ROWS = 20;

/// Parses an uploaded spreadsheet and returns headers, a 20-row preview and a
/// guessed mapping. The full row set comes back too, so committing the import
/// does not require a second upload — lists are small enough (tens of
/// thousands of rows at most) that this stays comfortably in memory.
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file was uploaded.' }, { status: 400 });
    }

    if (!isAcceptedFilename(file.name)) {
      return NextResponse.json(
        { error: 'Upload a .csv, .xlsx or .numbers file.' },
        { status: 400 },
      );
    }

    const sheetName = formData.get('sheetName');
    const buffer = Buffer.from(await file.arrayBuffer());

    const parsed = parseSpreadsheet(
      buffer,
      typeof sheetName === 'string' && sheetName ? sheetName : undefined,
    );

    if (parsed.headers.length === 0) {
      return NextResponse.json(
        { error: 'That sheet is empty — no header row found.' },
        { status: 400 },
      );
    }

    return NextResponse.json({
      fileName: file.name,
      sheetName: parsed.sheetName,
      availableSheets: parsed.availableSheets,
      headers: parsed.headers,
      preview: parsed.rows.slice(0, PREVIEW_ROWS),
      rows: parsed.rows,
      totalRows: parsed.totalRows,
      guessedMapping: guessMapping(parsed.headers),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Could not read that file.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
