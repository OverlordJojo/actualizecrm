import { db } from '@actualizecrm/db';

/**
 * Conversation-history retention sweep (§1.4).
 *
 * The rule in one sentence: a lead sitting in any pipeline stage keeps its
 * history forever; a lead that is not in a stage keeps only 7 days.
 *
 * The subtlety that matters: the 7-day clock starts at `pipelineRemovedAt`,
 * not at record creation. A lead that was Booked for a year and is then marked
 * not-interested keeps its year of history for another 7 days. Starting the
 * clock at record age would delete all of it the instant it was removed, which
 * would destroy exactly the history someone is most likely to want to review
 * after losing a deal.
 */

const RETENTION_DAYS = 7;

export interface SweepResult {
  contactsExamined: number;
  recordsExamined: number;
  recordsDeleted: number;
  contactsDeleted: number;
  retainedInPipeline: number;
  retainedByBooking: number;
  durationMs: number;
}

export async function runRetentionSweep(): Promise<SweepResult> {
  const startedAt = Date.now();

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const result: SweepResult = {
    contactsExamined: 0,
    recordsExamined: 0,
    recordsDeleted: 0,
    contactsDeleted: 0,
    retainedInPipeline: 0,
    retainedByBooking: 0,
    durationMs: 0,
  };

  // Only contacts with no stage are candidates. Anything in a stage — including
  // user-created stages — is retained forever, so it is never even loaded.
  const candidates = await db.contact.findMany({
    where: { stageId: null },
    select: {
      id: true,
      pipelineRemovedAt: true,
      createdAt: true,
      _count: { select: { bookings: true } },
    },
  });

  result.contactsExamined = candidates.length;

  const inPipeline = await db.contact.count({ where: { NOT: { stageId: null } } });
  result.retainedInPipeline = inPipeline;

  for (const contact of candidates) {
    // A lead with a calendar booking keeps its history regardless — deleting
    // the context behind a meeting that is still on the calendar would be
    // actively harmful.
    if (contact._count.bookings > 0) {
      result.retainedByBooking++;
      continue;
    }

    // Clock starts at removal, falling back to creation for leads that were
    // never placed in a stage at all.
    const clockStart = contact.pipelineRemovedAt ?? contact.createdAt;
    if (clockStart > cutoff) continue;

    await db.$transaction(async (tx) => {
      const [calls, messages, emails, activities] = await Promise.all([
        tx.call.count({ where: { contactId: contact.id } }),
        tx.message.count({ where: { contactId: contact.id } }),
        tx.emailMessage.count({ where: { contactId: contact.id } }),
        tx.activity.count({ where: { contactId: contact.id } }),
      ]);

      const total = calls + messages + emails + activities;
      result.recordsExamined += total;

      await tx.call.deleteMany({ where: { contactId: contact.id } });
      await tx.message.deleteMany({ where: { contactId: contact.id } });
      await tx.emailMessage.deleteMany({ where: { contactId: contact.id } });
      await tx.activity.deleteMany({ where: { contactId: contact.id } });

      result.recordsDeleted += total;

      // With the last record gone and no booking, the contact row itself has
      // nothing left to reference.
      await tx.contact.delete({ where: { id: contact.id } });
      result.contactsDeleted++;
    });
  }

  result.durationMs = Date.now() - startedAt;

  await db.retentionSweepLog.create({
    data: {
      contactsExamined: result.contactsExamined,
      recordsExamined: result.recordsExamined,
      recordsDeleted: result.recordsDeleted,
      contactsDeleted: result.contactsDeleted,
      retainedInPipeline: result.retainedInPipeline,
      retainedByBooking: result.retainedByBooking,
      durationMs: result.durationMs,
    },
  });

  return result;
}
