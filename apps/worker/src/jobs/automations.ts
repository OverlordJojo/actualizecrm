import { db } from '@actualizecrm/db';
import { sendEmail } from '../lib/mailer';
import { sendSms } from '../lib/sms';

/**
 * The automation step walker (build step 8).
 *
 * An automation is a trigger followed by an ordered list of steps. A `delay`
 * step is not a `setTimeout` — it writes the run back with a future `runAt` and
 * schedules a fresh job, so a chain paused for three days survives every
 * redeploy in between. That is the difference between an automation engine and
 * a timer that quietly forgets.
 *
 * The `AutomationRun` row is its own idempotency ledger: each job carries the
 * step index it expects to execute, and a redelivered job for a step the run
 * has already moved past does nothing. Without that, a Railway restart between
 * "email sent" and "run saved" sends the email twice.
 */

export interface AutomationStep {
  type:
    | 'delay'
    | 'send_email'
    | 'send_sms'
    | 'voicemail_drop'
    | 'add_tag'
    | 'remove_tag'
    | 'move_stage'
    | 'create_task';
  seconds?: number;
  templateId?: string;
  recordingId?: string;
  tag?: string;
  stageId?: string;
  dueInMinutes?: number;
  note?: string;
}

export interface AutomationExecutePayload {
  runId: string;
  /// Which step this job is for. A job for a step the run has passed is stale.
  stepIndex?: number;
}

export interface AutomationExecuteResult {
  ran: string[];
  paused?: string;
  completed?: boolean;
  skipped?: string;
}

function appendLog(existing: unknown, entry: Record<string, unknown>): unknown[] {
  const log = Array.isArray(existing) ? existing : [];
  return [...log, { at: new Date().toISOString(), ...entry }].slice(-200);
}

export async function runAutomation(
  payload: AutomationExecutePayload,
): Promise<AutomationExecuteResult> {
  const run = await db.automationRun.findUnique({
    where: { id: payload.runId },
    include: { automation: true, contact: true },
  });

  if (!run) return { ran: [], skipped: 'run no longer exists' };
  if (run.status === 'completed') return { ran: [], skipped: 'already completed' };

  if (
    payload.stepIndex !== undefined &&
    payload.stepIndex !== run.stepIndex
  ) {
    return {
      ran: [],
      skipped: `stale job for step ${payload.stepIndex}; run is at ${run.stepIndex}`,
    };
  }

  // An automation switched off after the run was queued should not fire. The
  // operator flipping the toggle means "stop", not "stop new ones only".
  if (!run.automation.enabled) {
    await db.automationRun.update({
      where: { id: run.id },
      data: {
        status: 'skipped',
        completedAt: new Date(),
        log: appendLog(run.log, { skipped: 'automation is switched off' }) as never,
      },
    });
    return { ran: [], skipped: 'automation is switched off' };
  }

  const steps = (run.automation.steps ?? []) as unknown as AutomationStep[];
  const ran: string[] = [];
  let log = run.log as unknown;

  await db.automationRun.update({
    where: { id: run.id },
    data: { status: 'running' },
  });

  for (let i = run.stepIndex; i < steps.length; i++) {
    const step = steps[i];

    if (step.type === 'delay') {
      const seconds = Math.max(step.seconds ?? 0, 0);
      const runAt = new Date(Date.now() + seconds * 1000);

      await db.automationRun.update({
        where: { id: run.id },
        data: {
          status: 'pending',
          stepIndex: i + 1,
          runAt,
          log: appendLog(log, {
            step: i,
            type: 'delay',
            resumesAt: runAt.toISOString(),
          }) as never,
        },
      });

      // The continuation is a database row, not an in-process timer, so it
      // survives the redeploy that will certainly happen during a 3-day wait.
      await db.scheduledJob.create({
        data: {
          type: 'automation.execute',
          jobKey: `auto:${run.id}:${i + 1}`,
          payload: { runId: run.id, stepIndex: i + 1, contactId: run.contactId },
          runAt,
        },
      });

      return { ran, paused: `waiting ${seconds}s before step ${i + 1}` };
    }

    let outcome: string;
    try {
      outcome = await executeStep(step, run.contactId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.automationRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          stepIndex: i,
          log: appendLog(log, { step: i, type: step.type, error: message }) as never,
        },
      });
      throw err;
    }

    ran.push(`${step.type}: ${outcome}`);
    log = appendLog(log, { step: i, type: step.type, outcome });

    // Persist after every step so a crash resumes at the right place rather
    // than replaying sends that already went out.
    await db.automationRun.update({
      where: { id: run.id },
      data: { stepIndex: i + 1, log: log as never },
    });
  }

  await db.automationRun.update({
    where: { id: run.id },
    data: {
      status: 'completed',
      completedAt: new Date(),
      stepIndex: steps.length,
      log: appendLog(log, { completed: true }) as never,
    },
  });

  return { ran, completed: true };
}

async function executeStep(
  step: AutomationStep,
  contactId: string | null,
): Promise<string> {
  if (!contactId) return 'no lead attached — nothing to do';

  switch (step.type) {
    case 'send_email': {
      const template = step.templateId
        ? await db.messageTemplate.findUnique({ where: { id: step.templateId } })
        : null;
      if (!template) return 'template was deleted — skipped';

      const result = await sendEmail({
        contactId,
        subject: template.subject ?? '(no subject)',
        body: template.body,
        templateName: template.name,
      });
      if (result.error) throw new Error(result.error);
      return result.sent ? 'sent' : `skipped — ${result.skipped}`;
    }

    case 'send_sms': {
      const template = step.templateId
        ? await db.messageTemplate.findUnique({ where: { id: step.templateId } })
        : null;
      if (!template) return 'template was deleted — skipped';

      const result = await sendSms({ contactId, body: template.body, templateName: template.name });
      if (result.error) throw new Error(result.error);
      return result.sent ? 'sent' : `skipped — ${result.skipped}`;
    }

    case 'voicemail_drop': {
      const recording = step.recordingId
        ? await db.voicemailRecording.findUnique({ where: { id: step.recordingId } })
        : await db.voicemailRecording.findFirst({ where: { isDefault: true } });
      if (!recording) return 'no recording available — skipped';

      const day = new Date().toISOString().slice(0, 10);
      await db.scheduledJob
        .create({
          data: {
            type: 'voicemail.drop',
            jobKey: `vmdrop:${day}:${contactId}`,
            payload: { contactId, recordingId: recording.id },
            runAt: new Date(),
          },
        })
        .catch(() => {
          // Unique jobKey: already queued for this lead today, which is the
          // outcome we want rather than two voicemails on one phone.
        });
      return `queued drop of "${recording.name}"`;
    }

    case 'add_tag': {
      if (!step.tag) return 'no tag named — skipped';
      const tag = await db.tag.upsert({
        where: { name: step.tag },
        create: { name: step.tag, color: '#64748b' },
        update: {},
      });
      const created = await db.contactTag
        .create({ data: { contactId, tagId: tag.id } })
        .then(() => true)
        .catch(() => false);
      if (created) {
        await db.activity.create({
          data: {
            contactId,
            type: 'tag',
            summary: `Tagged ${tag.name} by automation`,
            meta: { tagName: tag.name, source: 'automation' },
          },
        });
      }
      return created ? `tagged ${tag.name}` : `already tagged ${tag.name}`;
    }

    case 'remove_tag': {
      if (!step.tag) return 'no tag named — skipped';
      const tag = await db.tag.findUnique({ where: { name: step.tag } });
      if (!tag) return 'tag does not exist — skipped';
      await db.contactTag
        .delete({ where: { contactId_tagId: { contactId, tagId: tag.id } } })
        .catch(() => {});
      return `removed ${tag.name}`;
    }

    case 'move_stage': {
      if (!step.stageId) return 'no stage chosen — skipped';
      const stage = await db.pipelineStage.findUnique({ where: { id: step.stageId } });
      if (!stage) return 'stage was deleted — skipped';

      await db.contact.update({
        where: { id: contactId },
        data: { stageId: stage.id, pipelineRemovedAt: null, removalReason: null },
      });
      await db.activity.create({
        data: {
          contactId,
          type: 'stage_change',
          summary: `Moved to ${stage.name} by automation`,
          meta: { toStage: stage.name, source: 'automation' },
        },
      });
      return `moved to ${stage.name}`;
    }

    case 'create_task': {
      const dueAt = new Date(Date.now() + (step.dueInMinutes ?? 60) * 60_000);
      await db.callbackTask.create({
        data: { contactId, dueAt, note: step.note ?? null },
      });
      await db.activity.create({
        data: {
          contactId,
          type: 'automation',
          summary: `Callback task created for ${dueAt.toLocaleString('en-CA')}`,
          meta: { dueAt: dueAt.toISOString(), source: 'automation' },
        },
      });
      return `callback due ${dueAt.toISOString()}`;
    }

    default:
      return `unknown step type "${step.type}" — skipped`;
  }
}
