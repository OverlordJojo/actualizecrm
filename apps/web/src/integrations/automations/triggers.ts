import { db } from '@/lib/db';

/**
 * Trigger dispatch (build step 8).
 *
 * The app never calls the worker. It writes an `AutomationRun` and a
 * `ScheduledJob`, and the worker drains them — which is what lets an
 * automation queued at 5pm still run at 9am with the laptop shut.
 *
 * Every call site treats this as best-effort. A broken automation must never
 * fail the thing that triggered it: an operator setting a disposition mid-call
 * cannot have that fail because a template was deleted last week.
 */

export type TriggerType =
  | 'disposition_set'
  | 'stage_changed'
  | 'tag_added'
  | 'lead_imported'
  | 'no_answer_n_times'
  | 'call_completed';

export interface TriggerContext {
  contactId: string;
  disposition?: string;
  stageId?: string;
  stageName?: string;
  tagName?: string;
  listId?: string;
  noAnswerStreak?: number;
}

interface TriggerConfig {
  disposition?: string;
  stageId?: string;
  tag?: string;
  listId?: string;
  count?: number;
}

/// Whether a configured automation cares about this particular event. An empty
/// config means "any" — an automation on `stage_changed` with no stage chosen
/// fires on every stage change, which is the least surprising reading.
function matches(
  type: TriggerType,
  config: TriggerConfig,
  ctx: TriggerContext,
): boolean {
  switch (type) {
    case 'disposition_set':
      return !config.disposition || config.disposition === ctx.disposition;
    case 'stage_changed':
      return !config.stageId || config.stageId === ctx.stageId;
    case 'tag_added':
      return (
        !config.tag ||
        config.tag.toLowerCase() === (ctx.tagName ?? '').toLowerCase()
      );
    case 'lead_imported':
      return !config.listId || config.listId === ctx.listId;
    case 'no_answer_n_times':
      // Fires on the exact Nth no-answer rather than every one after it, so a
      // lead that keeps not answering does not collect a follow-up per dial.
      return (ctx.noAnswerStreak ?? 0) === (config.count ?? 3);
    case 'call_completed':
      return true;
    default:
      return false;
  }
}

export async function fireTrigger(
  type: TriggerType,
  ctx: TriggerContext,
): Promise<number> {
  try {
    const automations = await db.automation.findMany({
      where: { enabled: true, triggerType: type },
    });
    if (automations.length === 0) return 0;

    // Minute granularity: a double-click or a retried request must not queue
    // the same chain twice, while a genuine re-trigger an hour later still
    // gets its own run.
    const bucket = new Date().toISOString().slice(0, 16);

    let queued = 0;

    for (const automation of automations) {
      if (!matches(type, (automation.triggerConfig ?? {}) as TriggerConfig, ctx)) {
        continue;
      }

      const jobKey = `auto:${automation.id}:${ctx.contactId}:${bucket}`;

      const run = await db.automationRun
        .create({
          data: {
            automationId: automation.id,
            contactId: ctx.contactId,
            status: 'pending',
            stepIndex: 0,
            runAt: new Date(),
            jobKey,
            log: [
              {
                at: new Date().toISOString(),
                trigger: type,
                context: ctx as unknown as Record<string, unknown>,
              },
            ] as never,
          },
        })
        .catch(() => null);

      // Null means the unique jobKey rejected it — already queued this minute.
      if (!run) continue;

      await db.scheduledJob
        .create({
          data: {
            type: 'automation.execute',
            jobKey: `run:${run.id}:0`,
            payload: { runId: run.id, stepIndex: 0, contactId: ctx.contactId },
            runAt: new Date(),
          },
        })
        .catch(() => null);

      queued++;
    }

    return queued;
  } catch (err) {
    console.error('[automations] trigger dispatch failed', type, err);
    return 0;
  }
}
