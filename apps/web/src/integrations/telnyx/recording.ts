/**
 * Telnyx Call Control, re-exported from `packages/telephony`.
 *
 * The primitives moved to the shared package when the webhook moved to the
 * worker (§1) — both services issue Call Control commands now, and two copies
 * of `record_start` would drift the moment one side gained an option. This
 * module stays as the app's import point so every route that already did
 * `from '@/integrations/telnyx/recording'` kept working, the same way
 * `@/lib/settings` survived settings moving into `packages/db`.
 *
 * Add new primitives to the package, not here.
 */
export {
  startRecording,
  stopRecording,
  startTranscription,
  stopTranscription,
  playAudio,
  stopPlayback,
  speak,
  hangup,
  answer,
  originate,
  amdParams,
  encodeClientState,
  decodeClientState,
  TelnyxCallError,
} from '@actualizecrm/telephony';

import { transfer } from '@actualizecrm/telephony';

/**
 * Sends a live leg to the operator's softphone.
 *
 * Named for what it does here rather than for the Telnyx verb, because the
 * distinction matters: this is a *transfer*, not a bridge. The operator's
 * browser is a SIP endpoint, not a Call Control leg we hold an id for, so there
 * is nothing to bridge *to*.
 *
 * §2 replaces this path with a conference the operator joins once per session.
 * A transfer hands the operator's audio to whichever prospect leg happens to be
 * up, which is why hang-up had no leg it could act on.
 */
export async function transferToOperator(
  callControlId: string,
  sipUri: string,
  fromE164: string,
  clientState?: string,
): Promise<void> {
  await transfer(callControlId, sipUri, fromE164, clientState);
}
