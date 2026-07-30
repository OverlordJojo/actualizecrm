import * as XLSX from 'xlsx';

/// A parsed spreadsheet, reduced to what the mapping UI needs.
export interface ParsedSheet {
  /// Column headers, in sheet order. Blank headers become "Column 3" etc.
  headers: string[];
  /// Every data row as { header: cellValue }. Values are already strings.
  rows: Record<string, string>[];
  totalRows: number;
  sheetName: string;
  /// Other sheets in the workbook, if the operator picked the wrong one.
  availableSheets: string[];
}

export const ACCEPTED_EXTENSIONS = ['.csv', '.xlsx', '.xls', '.numbers'] as const;

export function isAcceptedFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/// Cell values arrive as strings, numbers, dates or booleans depending on how
/// the sheet was authored. Everything becomes a trimmed string so the mapping
/// layer has exactly one type to reason about.
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/**
 * Parse a spreadsheet buffer. Handles .csv, .xlsx/.xls and Apple .numbers —
 * SheetJS reads all of them from the same entry point, so there is no
 * per-format branch here.
 *
 * @param sheetName pick a specific sheet; defaults to the first one.
 */
export function parseSpreadsheet(
  buffer: ArrayBuffer | Buffer,
  sheetName?: string,
): ParsedSheet {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    // Keep dates as Date objects rather than Excel serial numbers.
    cellDates: true,
    // We never use formulas, and skipping them speeds up large lists.
    cellFormula: false,
  });

  if (workbook.SheetNames.length === 0) {
    throw new Error('That file has no sheets in it.');
  }

  const chosen = sheetName ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[chosen];
  if (!sheet) {
    throw new Error(`The file has no sheet named "${chosen}".`);
  }

  // header: 1 gives us raw rows so we can handle duplicate and blank headers
  // ourselves — the object form silently drops duplicate columns.
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: '',
  });

  if (matrix.length === 0) {
    return {
      headers: [],
      rows: [],
      totalRows: 0,
      sheetName: chosen,
      availableSheets: workbook.SheetNames,
    };
  }

  const rawHeaders = matrix[0].map(cellToString);
  const seen = new Map<string, number>();
  const headers = rawHeaders.map((h, i) => {
    let name = h || `Column ${i + 1}`;
    // Duplicate headers would collide in the row objects.
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) name = `${name} (${count + 1})`;
    return name;
  });

  const rows: Record<string, string>[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const rowArr = matrix[r] ?? [];
    const row: Record<string, string> = {};
    let hasAnyValue = false;

    headers.forEach((header, c) => {
      const v = cellToString(rowArr[c]);
      row[header] = v;
      if (v) hasAnyValue = true;
    });

    // A row of entirely empty cells is spreadsheet padding, not a lead.
    if (hasAnyValue) rows.push(row);
  }

  return {
    headers,
    rows,
    totalRows: rows.length,
    sheetName: chosen,
    availableSheets: workbook.SheetNames,
  };
}

/// Guess which spreadsheet column belongs to which CRM field, so the operator
/// usually just confirms rather than mapping seven dropdowns by hand.
export function guessMapping(headers: string[]): Record<string, string> {
  const patterns: Record<string, RegExp[]> = {
    firstName: [/^first\s*_?name$/i, /^first$/i, /^fname$/i, /^given/i],
    lastName: [/^last\s*_?name$/i, /^last$/i, /^lname$/i, /^surname$/i, /^family/i],
    phone: [/phone/i, /^mobile$/i, /^cell$/i, /^tel$/i, /number/i],
    companyName: [/^company/i, /^business/i, /^organization/i, /^org$/i, /^account/i],
    companyLocation: [/location/i, /^city$/i, /^address/i, /^market/i, /^region$/i],
    email: [/e-?mail/i],
  };

  const guessed: Record<string, string> = {};
  const taken = new Set<string>();

  // Exact-ish matches win before loose ones, so a sheet with both "Phone" and
  // "Phone Type" does not map the wrong one.
  for (const [field, regexes] of Object.entries(patterns)) {
    for (const re of regexes) {
      const hit = headers.find((h) => !taken.has(h) && re.test(h.trim()));
      if (hit) {
        guessed[field] = hit;
        taken.add(hit);
        break;
      }
    }
  }

  return guessed;
}
