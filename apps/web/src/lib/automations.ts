/**
 * Automation vocabulary shared by the routes and the builder.
 *
 * Lives here rather than in the route file because a Next.js route module may
 * only export handlers and a few reserved config keys — anything else fails
 * the build with a type error that does not name the real problem.
 */

export const TRIGGER_TYPES = [
  'disposition_set',
  'stage_changed',
  'tag_added',
  'lead_imported',
  'no_answer_n_times',
  'call_completed',
] as const;

export type TriggerTypeName = (typeof TRIGGER_TYPES)[number];

export const STEP_TYPES = [
  'delay',
  'send_email',
  'send_sms',
  'voicemail_drop',
  'add_tag',
  'remove_tag',
  'move_stage',
  'create_task',
] as const;
