/// The three things an operator can do with a CRM field on the mapping screen.
export type MappingMode = 'column' | 'ignore' | 'fixed';

export interface FieldMapping {
  mode: MappingMode;
  /// Spreadsheet header, when mode === 'column'.
  column?: string;
  /// Literal written to every lead in this import, when mode === 'fixed'.
  fixedValue?: string;
}

/// Built-in CRM fields, in the order they appear on the mapping screen.
export const CORE_FIELDS = [
  { key: 'firstName', label: 'First Name', required: false },
  { key: 'lastName', label: 'Last Name', required: false },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'companyName', label: 'Company Name', required: false },
  { key: 'companyLocation', label: 'Company Location', required: false },
  { key: 'email', label: 'Email', required: false },
] as const;

export type CoreFieldKey = (typeof CORE_FIELDS)[number]['key'];

export interface ImportRequest {
  listName: string;
  /// Keyed by CoreFieldKey for built-ins, and by `custom:<customFieldId>` for
  /// user-defined fields.
  mappings: Record<string, FieldMapping>;
  rows: Record<string, string>[];
  sourceFile?: string;
}

export interface RejectedRow {
  rowNumber: number;
  reason: string;
  /// Whatever was in the phone cell, so the operator can find it in the sheet.
  rawPhone: string;
}

export interface ImportReport {
  listId: string;
  listName: string;
  added: number;
  merged: number;
  rejected: number;
  rejectedRows: RejectedRow[];
}

export const CUSTOM_FIELD_PREFIX = 'custom:';

export function isCustomFieldKey(key: string): boolean {
  return key.startsWith(CUSTOM_FIELD_PREFIX);
}

export function customFieldIdFromKey(key: string): string {
  return key.slice(CUSTOM_FIELD_PREFIX.length);
}
