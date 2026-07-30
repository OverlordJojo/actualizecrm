import { db } from '@actualizecrm/db';

/**
 * Idempotency guard (§0.3).
 *
 * Railway restarts mid-job re-deliver the message. Without this, a restart
 * during an automation that sends SMS would send it twice — which the prospect
 * notices and which costs money. Every job carries a deterministic key; we
 * record it before doing the work and refuse to repeat a key that already
 * succeeded.
 */

export interface Claim {
  runId: string;
  /// True when this key already completed and the job should exit immediately.
  alreadyDone: boolean;
}

export async function claim(jobKey: string, contactId?: string): Promise<Claim> {
  const existing = await db.automationRun.findUnique({ where: { jobKey } });

  if (existing) {
    if (existing.status === 'completed') {
      return { runId: existing.id, alreadyDone: true };
    }
    // A previous attempt crashed part-way. Re-running is the intended
    // behaviour; BullMQ's retry brought us here.
    await db.automationRun.update({
      where: { id: existing.id },
      data: { status: 'running' },
    });
    return { runId: existing.id, alreadyDone: false };
  }

  const run = await db.automationRun.create({
    data: {
      jobKey,
      contactId: contactId ?? null,
      status: 'running',
      // Standalone jobs (sweeps, rollups) are not tied to an Automation row.
      automationId: await systemAutomationId(),
    },
  });

  return { runId: run.id, alreadyDone: false };
}

export async function markDone(runId: string, log: unknown[] = []) {
  await db.automationRun.update({
    where: { id: runId },
    data: { status: 'completed', completedAt: new Date(), log: log as never },
  });
}

export async function markFailed(runId: string, error: unknown) {
  await db.automationRun.update({
    where: { id: runId },
    data: {
      status: 'failed',
      completedAt: new Date(),
      log: [
        { at: new Date().toISOString(), error: String(error) },
      ] as never,
    },
  });
}

/**
 * AutomationRun requires an automationId, but housekeeping jobs are not user
 * automations. Rather than making the column nullable and losing the foreign
 * key, keep one hidden system Automation that owns them.
 */
let cachedSystemId: string | null = null;

async function systemAutomationId(): Promise<string> {
  if (cachedSystemId) return cachedSystemId;

  const existing = await db.automation.findFirst({
    where: { name: '__system__' },
  });
  if (existing) {
    cachedSystemId = existing.id;
    return existing.id;
  }

  const created = await db.automation.create({
    data: {
      name: '__system__',
      enabled: false,
      triggerType: 'system',
    },
  });
  cachedSystemId = created.id;
  return created.id;
}
