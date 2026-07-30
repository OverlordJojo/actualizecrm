/**
 * One-time import of the v1 SQLite database into Postgres.
 *
 *   npm run db:import-sqlite
 *
 * Reads data/actualizecrm.db directly with node:sqlite (Node 22+ built-in, no
 * dependency) and bulk-inserts through Prisma. Idempotent: rows are upserted
 * by primary key, so a partial run can be repeated safely.
 *
 * The SQLite file is never modified. Keep it as a backup.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '@actualizecrm/db';

const SQLITE_PATH = resolve(__dirname, '..', 'data', 'actualizecrm.db');

/// v1 stored JSON as text; v2 uses real Json columns.
function parseJson(raw: unknown, fallback: unknown) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/// SQLite has no boolean or date types.
const bool = (v: unknown) => v === 1 || v === true || v === '1';
const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | number));
const req = (v: unknown) => new Date(v as string | number);

async function main() {
  if (!existsSync(SQLITE_PATH)) {
    console.error(`No SQLite database at ${SQLITE_PATH} — nothing to import.`);
    process.exit(1);
  }

  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  const all = (table: string): any[] => {
    try {
      return sqlite.prepare(`SELECT * FROM "${table}"`).all() as any[];
    } catch {
      // Table may not exist in an older v1 database.
      return [];
    }
  };

  const counts: Record<string, { source: number; imported: number }> = {};
  const track = async (name: string, rows: any[], fn: (r: any) => Promise<void>) => {
    let ok = 0;
    for (const r of rows) {
      try {
        await fn(r);
        ok++;
      } catch (e) {
        console.error(`  ${name} ${r.id ?? ''} failed: ${String(e).slice(0, 160)}`);
      }
    }
    counts[name] = { source: rows.length, imported: ok };
    console.log(`  ${name.padEnd(20)} ${ok}/${rows.length}`);
  };

  console.log(`Importing from ${SQLITE_PATH}\n`);

  // Order matters: parents before children, or foreign keys reject the insert.

  await track('Pipeline', all('Pipeline'), async (r) => {
    await db.pipeline.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        name: r.name,
        isDefault: bool(r.isDefault),
        position: r.position ?? 0,
        createdAt: req(r.createdAt),
      },
      update: {},
    });
  });

  await track('PipelineStage', all('PipelineStage'), async (r) => {
    await db.pipelineStage.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        pipelineId: r.pipelineId,
        name: r.name,
        color: r.color,
        position: r.position ?? 0,
        createdAt: req(r.createdAt),
      },
      update: {},
    });
  });

  await track('LeadList', all('LeadList'), async (r) => {
    await db.leadList.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        name: r.name,
        sourceFile: r.sourceFile,
        addedCount: r.addedCount ?? 0,
        mergedCount: r.mergedCount ?? 0,
        rejectedCount: r.rejectedCount ?? 0,
        report: parseJson(r.report, []) as never,
        createdAt: req(r.createdAt),
      },
      update: {},
    });
  });

  await track('CustomField', all('CustomField'), async (r) => {
    await db.customField.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        label: r.label,
        type: r.type,
        showOnCard: bool(r.showOnCard),
        position: r.position ?? 0,
        createdAt: req(r.createdAt),
      },
      update: {},
    });
  });

  await track('Tag', all('Tag'), async (r) => {
    await db.tag.upsert({
      where: { id: r.id },
      create: { id: r.id, name: r.name, color: r.color, createdAt: req(r.createdAt) },
      update: {},
    });
  });

  await track('PhoneNumber', all('PhoneNumber'), async (r) => {
    await db.phoneNumber.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        e164: r.e164,
        telnyxId: r.telnyxId,
        countryCode: r.countryCode ?? 'US',
        region: r.region,
        locality: r.locality,
        areaCode: r.areaCode,
        monthlyCost: r.monthlyCost,
        purchasedAt: req(r.purchasedAt),
        dialsSent: r.dialsSent ?? 0,
        active: bool(r.active),
      },
      update: {},
    });
  });

  await track('Contact', all('Contact'), async (r) => {
    await db.contact.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        phone: r.phone,
        companyName: r.companyName,
        companyLocation: r.companyLocation,
        email: r.email,
        customFields: parseJson(r.customFields, {}) as never,
        stageId: r.stageId,
        stagePosition: r.stagePosition ?? 0,
        dealValue: r.dealValue,
        lastDisposition: r.lastDisposition,
        lastDialedAt: date(r.lastDialedAt),
        dialCount: r.dialCount ?? 0,
        connectCount: r.connectCount ?? 0,
        noAnswerStreak: r.noAnswerStreak ?? 0,
        everConnected: bool(r.everConnected),
        doNotContact: bool(r.doNotContact),
        listId: r.listId,
        createdAt: req(r.createdAt),
        updatedAt: req(r.updatedAt),
      },
      update: {},
    });
  });

  await track('ContactTag', all('ContactTag'), async (r) => {
    await db.contactTag.upsert({
      where: { contactId_tagId: { contactId: r.contactId, tagId: r.tagId } },
      create: {
        contactId: r.contactId,
        tagId: r.tagId,
        createdAt: req(r.createdAt),
      },
      update: {},
    });
  });

  await track('Call', all('Call'), async (r) => {
    await db.call.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        contactId: r.contactId,
        callControlId: r.callControlId,
        callSessionId: r.callSessionId,
        fromNumberId: r.fromNumberId,
        fromE164: r.fromE164,
        toE164: r.toE164,
        status: r.status,
        disposition: r.disposition,
        startedAt: req(r.startedAt),
        answeredAt: date(r.answeredAt),
        endedAt: date(r.endedAt),
        durationSec: r.durationSec ?? 0,
        voicemailDropped: bool(r.voicemailDropped),
        notes: r.notes,
      },
      update: {},
    });
  });

  await track('Message', all('Message'), async (r) => {
    await db.message.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        contactId: r.contactId,
        direction: r.direction,
        body: r.body,
        fromE164: r.fromE164,
        toE164: r.toE164,
        telnyxId: r.telnyxId,
        status: r.status,
        error: r.error,
        createdAt: req(r.createdAt),
      },
      update: {},
    });
  });

  await track('EmailMessage', all('EmailMessage'), async (r) => {
    await db.emailMessage.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        contactId: r.contactId,
        direction: r.direction,
        subject: r.subject,
        body: r.body,
        fromAddr: r.fromAddr,
        toAddr: r.toAddr,
        messageId: r.messageId,
        status: r.status,
        error: r.error,
        provider: r.provider,
        createdAt: req(r.createdAt),
      },
      update: {},
    });
  });

  await track('Activity', all('Activity'), async (r) => {
    await db.activity.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        contactId: r.contactId,
        type: r.type,
        direction: r.direction,
        summary: r.summary,
        body: r.body,
        meta: parseJson(r.meta, {}) as never,
        callId: r.callId,
        messageId: r.messageId,
        emailId: r.emailId,
        createdAt: req(r.createdAt),
      },
      update: {},
    });
  });

  await track('CallbackTask', all('CallbackTask'), async (r) => {
    await db.callbackTask.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        contactId: r.contactId,
        dueAt: req(r.dueAt),
        note: r.note,
        completed: bool(r.completed),
        completedAt: date(r.completedAt),
        createdAt: req(r.createdAt),
      },
      update: {},
    });
  });

  await track('VoicemailRecording', all('VoicemailRecording'), async (r) => {
    await db.voicemailRecording.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        name: r.name,
        filePath: r.filePath,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        isDefault: bool(r.isDefault),
        createdAt: req(r.createdAt),
      },
      update: {},
    });
  });

  await track('MessageTemplate', all('MessageTemplate'), async (r) => {
    await db.messageTemplate.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        name: r.name,
        channel: r.channel,
        subject: r.subject,
        body: r.body,
        createdAt: req(r.createdAt),
        updatedAt: req(r.updatedAt),
      },
      update: {},
    });
  });

  await track('Automation', all('Automation'), async (r) => {
    await db.automation.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        name: r.name,
        enabled: bool(r.enabled),
        triggerType: r.triggerType,
        triggerConfig: parseJson(r.triggerConfig, {}) as never,
        steps: parseJson(r.steps, []) as never,
        createdAt: req(r.createdAt),
        updatedAt: req(r.updatedAt),
      },
      update: {},
    });
  });

  await track('Setting', all('Setting'), async (r) => {
    await db.setting.upsert({
      where: { key: r.key },
      create: { key: r.key, value: r.value },
      update: { value: r.value },
    });
  });

  await track('Acknowledgement', all('Acknowledgement'), async (r) => {
    await db.acknowledgement.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        kind: r.kind,
        text: r.text,
        acceptedAt: req(r.acceptedAt),
      },
      update: {},
    });
  });

  sqlite.close();

  // --- verification --------------------------------------------------------
  console.log('\nRow count verification:');
  let mismatch = false;
  for (const [table, c] of Object.entries(counts)) {
    const ok = c.source === c.imported;
    if (!ok) mismatch = true;
    console.log(
      `  ${ok ? 'OK  ' : 'DIFF'} ${table.padEnd(20)} sqlite=${c.source} postgres=${c.imported}`,
    );
  }

  console.log(
    mismatch
      ? '\nSome rows did not import. The SQLite file is untouched — fix the errors above and re-run.'
      : '\nAll rows imported. Keep data/actualizecrm.db as a backup.',
  );

  await db.$disconnect();
  process.exit(mismatch ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
