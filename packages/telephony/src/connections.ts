/**
 * The two Telnyx connection ids this app needs, and why it is two.
 *
 * They are different objects and neither can do the other's job:
 *
 * - **Credential connection** (`TELNYX_CONNECTION_ID`) carries the SIP
 *   credentials the browser registers with. It is what makes the MacBook a
 *   phone, and it is what inbound numbers route to.
 * - **Call Control Application** (`TELNYX_CALL_CONTROL_APP_ID`) is the only
 *   thing `POST /v2/calls` accepts. Every server-originated leg — burst legs,
 *   bulk voicemail drops, the §2 conference — goes through it.
 *
 * Passing a credential connection to Call Control fails with a 422 reading
 * *"The requested connection_id (Call Control App ID) is either invalid or does
 * not exist"*, and that error is why multi-line dialing never originated a
 * single leg: the burst engine looked correct and was calling an endpoint that
 * refused it every time. The browser path kept working throughout, because
 * WebRTC does not go through Call Control at all — which is exactly what made
 * it look like a UI bug.
 *
 * A telephony credential **cannot** be attached to a Call Control Application
 * (`invalid connection`), so collapsing these back into one id is not an option
 * however tempting it looks.
 */

export function credentialConnectionId(): string | null {
  return process.env.TELNYX_CONNECTION_ID?.trim() || null;
}

export function callControlAppId(): string | null {
  return process.env.TELNYX_CALL_CONTROL_APP_ID?.trim() || null;
}

/**
 * The id to originate from, or a thrown explanation.
 *
 * Deliberately refuses to fall back to `TELNYX_CONNECTION_ID`. A fallback here
 * would restore the exact failure this split exists to fix, and it would do it
 * silently — the 422 arrives per call, at dial time, not at startup.
 */
export function requireCallControlAppId(): string {
  const id = callControlAppId();
  if (!id) {
    throw new Error(
      'TELNYX_CALL_CONTROL_APP_ID is not set. Server-originated calls need a ' +
        'Telnyx Call Control Application; a credential connection is rejected with ' +
        'a 422. Create one under Voice → Call Control, point it at this ' +
        "deployment's webhook, and attach the outbound voice profile.",
    );
  }
  return id;
}
