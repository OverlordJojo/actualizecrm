import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { checkA2pStatus } from '@/integrations/messaging/a2p';
import { connection as calendarConnection } from '@/integrations/calendar/google';

/**
 * Pre-flight validation for automations (§8.2).
 *
 * An automation that cannot possibly work should not be savable. The failure it
 * would otherwise produce arrives hours later, at 3am, as a dead job the
 * operator can do nothing with — and by then the follow-up it was supposed to
 * send has not gone out and nobody knows.
 *
 * Every message names the cause and the one action that fixes it. No error
 * codes, no job ids, no stack traces: those describe the machine's problem, and
 * the operator has a different one.
 */

export interface ValidationProblem {
  /// Which step is broken, or null when it is the automation as a whole.
  stepIndex: number | null;
  /// Plain language, addressed to the operator.
  message: string;
  /// Where to go and fix it.
  fixHref?: string;
  fixLabel?: string;
}

export interface AutomationStep {
  type: string;
  config?: Record<string, unknown>;
}

export async function validateAutomation(params: {
  trigger: string | null;
  steps: AutomationStep[];
}): Promise<ValidationProblem[]> {
  const problems: ValidationProblem[] = [];
  const { trigger, steps } = params;

  // --- shape ---------------------------------------------------------------

  if (!trigger) {
    problems.push({
      stepIndex: null,
      message: 'This automation has no trigger, so nothing would ever start it.',
    });
  }

  const actions = steps.filter((s) => s.type !== 'delay');
  if (actions.length === 0) {
    problems.push({
      stepIndex: null,
      message:
        steps.length === 0
          ? 'This automation has no steps, so it would run and do nothing.'
          : 'This automation only waits — there is no action after the delay, so it would never do anything.',
    });
  }

  // A delay at the end holds a run open forever waiting for a step that does
  // not exist.
  if (steps.length > 0 && steps[steps.length - 1]?.type === 'delay') {
    problems.push({
      stepIndex: steps.length - 1,
      message:
        'The last step is a wait, so this automation would pause and then stop without doing anything. Put the action after the wait.',
    });
  }

  // --- the connections each action needs -----------------------------------

  const needs = {
    sms: steps.some((s) => s.type === 'sms'),
    email: steps.some((s) => s.type === 'email'),
    voicemail: steps.some((s) => s.type === 'voicemail_drop'),
    booking: steps.some((s) => s.type === 'booking' || s.type === 'calendar'),
  };

  const [settings] = await Promise.all([getSettings()]);

  if (needs.sms) {
    const a2p = await checkA2pStatus().catch(() => null);
    if (!a2p?.approved) {
      problems.push({
        stepIndex: steps.findIndex((s) => s.type === 'sms'),
        message:
          'Text messages are locked until your A2P registration is approved. Carriers reject unregistered business texting outright, so this would fail every time.',
        fixHref: '/settings?tab=messaging',
        fixLabel: 'Check status',
      });
    }
  }

  if (needs.email) {
    const configured = Boolean(settings['email.fromAddress']);
    if (!configured) {
      problems.push({
        stepIndex: steps.findIndex((s) => s.type === 'email'),
        message: 'Connect an email account in Settings first — there is nothing to send from.',
        fixHref: '/settings?tab=email',
        fixLabel: 'Connect',
      });
    }
  }

  if (needs.voicemail) {
    const recordings = await db.voicemailRecording.count();
    if (recordings === 0) {
      problems.push({
        stepIndex: steps.findIndex((s) => s.type === 'voicemail_drop'),
        message: 'Upload a voicemail recording first — there is nothing to play.',
        fixHref: '/settings?tab=voicemail',
        fixLabel: 'Upload',
      });
    }
  }

  if (needs.booking) {
    const calendar = await calendarConnection().catch(() => null);
    if (!calendar?.connected) {
      problems.push({
        stepIndex: steps.findIndex(
          (s) => s.type === 'booking' || s.type === 'calendar',
        ),
        message: calendar?.needsReconnect
          ? 'Google Calendar has stopped accepting our access — something revoked or expired it. Reconnect and this will work again.'
          : 'Connect Google Calendar first — there is nowhere to put the meeting.',
        fixHref: '/settings?tab=calendar',
        fixLabel: calendar?.needsReconnect ? 'Reconnect' : 'Connect',
      });
    }
  }

  // --- steps that cannot do their job --------------------------------------

  steps.forEach((step, i) => {
    const config = step.config ?? {};

    if (step.type === 'sms' && !String(config.body ?? '').trim()) {
      problems.push({
        stepIndex: i,
        message: 'This text message has no wording, so there is nothing to send.',
      });
    }
    if (step.type === 'email' && !String(config.subject ?? '').trim()) {
      problems.push({
        stepIndex: i,
        message: 'This email has no subject. An email without one usually lands in spam.',
      });
    }
    if (step.type === 'delay' && Number(config.minutes ?? 0) <= 0) {
      problems.push({
        stepIndex: i,
        message: 'This wait is zero minutes long, which does nothing. Remove it or give it a length.',
      });
    }
  });

  return problems;
}
