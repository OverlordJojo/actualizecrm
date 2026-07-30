import type { Prisma } from '@actualizecrm/db';
import { db } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import {
  CORE_FIELDS,
  CUSTOM_FIELD_PREFIX,
  customFieldIdFromKey,
  isCustomFieldKey,
  type FieldMapping,
  type ImportReport,
  type ImportRequest,
  type RejectedRow,
} from './types';

/// Resolve one field's value for one row, honouring the three mapping modes.
function resolveValue(
  mapping: FieldMapping | undefined,
  row: Record<string, string>,
): string {
  if (!mapping) return '';
  switch (mapping.mode) {
    case 'ignore':
      return '';
    case 'fixed':
      // The typed string goes to every lead in the import regardless of what
      // the sheet contains — this is the documented behaviour, not a bug.
      return (mapping.fixedValue ?? '').trim();
    case 'column':
      return mapping.column ? (row[mapping.column] ?? '').trim() : '';
  }
}

/**
 * Execute an import.
 *
 * Dedupes on phone number. An existing contact is merged rather than
 * duplicated, and a merge only fills in fields that are currently blank —
 * the spreadsheet is assumed to be staler than the CRM, because after a few
 * calls it is.
 */
export async function runImport(req: ImportRequest): Promise<ImportReport> {
  const listName = req.listName.trim() || 'Untitled list';

  const list = await db.leadList.create({
    data: { name: listName, sourceFile: req.sourceFile ?? null },
  });

  const rejectedRows: RejectedRow[] = [];
  let added = 0;
  let merged = 0;

  const customKeys = Object.keys(req.mappings).filter(isCustomFieldKey);

  // Phone numbers already seen *within this file*, so a sheet containing the
  // same lead twice reports the second one as merged rather than crashing on
  // the unique constraint.
  const seenInFile = new Set<string>();

  for (let i = 0; i < req.rows.length; i++) {
    const row = req.rows[i];
    // +2: one for the header row, one because operators count from 1.
    const rowNumber = i + 2;

    const rawPhone = resolveValue(req.mappings.phone, row);
    const phone = toE164(rawPhone);

    if (!phone) {
      rejectedRows.push({
        rowNumber,
        rawPhone,
        reason: rawPhone
          ? 'Not a valid phone number'
          : 'No phone number in this row',
      });
      continue;
    }

    const core: Record<string, string> = {};
    for (const f of CORE_FIELDS) {
      if (f.key === 'phone') continue;
      core[f.key] = resolveValue(req.mappings[f.key], row);
    }

    const custom: Record<string, string> = {};
    for (const key of customKeys) {
      const value = resolveValue(req.mappings[key], row);
      if (value) custom[customFieldIdFromKey(key)] = value;
    }

    const existing = await db.contact.findUnique({ where: { phone } });

    if (existing) {
      // Fill blanks only. Never overwrite something the operator has since
      // corrected in the app.
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(core)) {
        if (v && !existing[k as keyof typeof existing]) patch[k] = v;
      }

      // customFields is a real Json column in v2, so it arrives already
      // parsed rather than as text.
      const existingCustom = (existing.customFields ?? {}) as Record<string, string>;
      let customChanged = false;
      for (const [k, v] of Object.entries(custom)) {
        if (v && !existingCustom[k]) {
          existingCustom[k] = v;
          customChanged = true;
        }
      }
      if (customChanged) patch.customFields = existingCustom;

      // Always record the new list membership so the lead shows up in this
      // list's dial session, even when nothing else changed.
      patch.listId = list.id;

      await db.contact.update({ where: { id: existing.id }, data: patch });

      await db.activity.create({
        data: {
          contactId: existing.id,
          type: 'import',
          summary: `Added to list "${listName}"`,
          meta: { listId: list.id, mergedIntoExisting: true },
        },
      });

      merged++;
      seenInFile.add(phone);
      continue;
    }

    if (seenInFile.has(phone)) {
      // Duplicate inside the same file — the first occurrence already created
      // it, so this counts as a merge.
      merged++;
      continue;
    }

    const created = await db.contact.create({
      data: {
        phone,
        firstName: core.firstName || null,
        lastName: core.lastName || null,
        companyName: core.companyName || null,
        companyLocation: core.companyLocation || null,
        email: core.email || null,
        customFields: custom,
        listId: list.id,
      },
    });

    await db.activity.create({
      data: {
        contactId: created.id,
        type: 'import',
        summary: `Imported from "${req.sourceFile ?? listName}"`,
        meta: { listId: list.id },
      },
    });

    added++;
    seenInFile.add(phone);
  }

  await db.leadList.update({
    where: { id: list.id },
    data: {
      addedCount: added,
      mergedCount: merged,
      rejectedCount: rejectedRows.length,
      // Prisma's Json input type does not accept a typed array directly, only
      // its structural JSON equivalent.
      report: rejectedRows as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    listId: list.id,
    listName,
    added,
    merged,
    rejected: rejectedRows.length,
    rejectedRows,
  };
}

export { CUSTOM_FIELD_PREFIX };
