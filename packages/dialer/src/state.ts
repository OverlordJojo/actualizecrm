import { db } from '@actualizecrm/db';
import { decodeClientState } from '@actualizecrm/telephony';

/**
 * The conference-anchored dialing engine (§2.2), shared by both services.
 *
 * It lives in a package rather than in either app because both drive it and
 * neither owns it. Operator commands — start, advance, hang up, end — come from
 * the browser through the app's routes, and must be fast, so they call these
 * functions directly rather than crossing a network hop. Everything
 * webhook-driven — the AMD verdict that decides who reaches the operator's ears
 * — arrives at the worker and calls the same functions.
 *
 * Two copies of this logic would be two subtly different state machines racing
 * over one conference. That is the failure mode §2.1 describes at a smaller
 * scale, and it is the reason this is a package.
 *
 * All shared state is in Postgres, and every transition that can race is a
 * conditional update rather than a read-then-write.
 */

/// What the legs of a session carry in `client_state`, echoed back by Telnyx on
/// every event so a webhook knows what it is looking at without a lookup.
export interface SessionLegState {
  k: 'session';
  sessionId: string;
  role: 'operator' | 'prospect';
  /// The `Call` row, for prospect legs.
  callId?: string;
  burstId?: string;
  position?: number;
}

export function sessionLegState(raw: unknown): SessionLegState | null {
  const s = raw as SessionLegState | null;
  return s && s.k === 'session' ? s : null;
}

export function decodeSessionLegState(
  clientState: string | null | undefined,
): SessionLegState | null {
  return sessionLegState(decodeClientState(clientState));
}

export type SessionStatus = 'starting' | 'live' | 'paused' | 'ending' | 'ended';

export interface HeldCaller {
  callId: string;
  contactId: string;
  callControlId: string | null;
  toE164: string;
  heldSeconds: number;
}

export interface SessionView {
  id: string;
  status: SessionStatus;
  conferenceId: string | null;
  operatorLegId: string | null;
  linesPerBurst: number;
  /// Why the session never started, in operator language. Null when fine.
  failureReason: string | null;

  /// The prospect the operator is talking to, if any. Everything the UI needs
  /// to decide whether Hang up is live comes from here — never from the
  /// browser's own line state, which knows nothing about server-held legs.
  active: {
    callId: string;
    contactId: string;
    callControlId: string | null;
    toE164: string;
    bridgedAt: string;
  } | null;

  /// Legs currently ringing in the open burst, for the side-by-side cards
  /// in §3.7.
  ringing: {
    callId: string;
    contactId: string;
    toE164: string;
    amdResult: string | null;
  }[];

  held: HeldCaller[];

  /// Legs that resolved without reaching the operator, most recent first, so
  /// the UI can fade them out showing why (§3.7).
  resolved: {
    callId: string;
    contactId: string;
    disposition: string | null;
    status: string;
  }[];
}

/**
 * Everything the dialer UI needs, in one read.
 *
 * One query set rather than several endpoints because the UI's correctness
 * depends on these agreeing with each other: a hang-up button enabled against
 * one snapshot and a lead card drawn from another is how you get a control that
 * acts on a call the operator is no longer on.
 */
export async function sessionView(sessionId: string): Promise<SessionView | null> {
  const session = await db.dialSession.findUnique({ where: { id: sessionId } });
  if (!session) return null;

  const calls = await db.call.findMany({
    where: { sessionId },
    orderBy: { startedAt: 'desc' },
    take: 40,
  });

  const now = Date.now();
  const active = calls.find(
    (c) => c.id === session.activeCallId && c.endedAt === null && c.bridgedAt !== null,
  );

  return {
    id: session.id,
    status: session.status as SessionStatus,
    conferenceId: session.conferenceId,
    operatorLegId: session.operatorLegId,
    linesPerBurst: session.linesPerBurst,
    failureReason: session.failureReason,

    active: active
      ? {
          callId: active.id,
          contactId: active.contactId,
          callControlId: active.callControlId,
          toE164: active.toE164,
          bridgedAt: active.bridgedAt!.toISOString(),
        }
      : null,

    ringing: calls
      .filter((c) => c.status === 'ringing' && c.endedAt === null)
      .map((c) => ({
        callId: c.id,
        contactId: c.contactId,
        toE164: c.toE164,
        amdResult: c.amdResult,
      })),

    held: calls
      .filter((c) => c.status === 'held' && c.endedAt === null)
      .sort((a, b) => (a.heldAt?.getTime() ?? 0) - (b.heldAt?.getTime() ?? 0))
      .map((c) => ({
        callId: c.id,
        contactId: c.contactId,
        callControlId: c.callControlId,
        toE164: c.toE164,
        heldSeconds: c.heldAt ? Math.round((now - c.heldAt.getTime()) / 1000) : 0,
      })),

    resolved: calls
      .filter((c) => c.endedAt !== null && c.bridgedAt === null)
      .slice(0, 6)
      .map((c) => ({
        callId: c.id,
        contactId: c.contactId,
        disposition: c.disposition,
        status: c.status,
      })),
  };
}

/// The live session, if there is one. Single-operator, so there is at most one.
export async function currentSession(): Promise<{ id: string; status: SessionStatus } | null> {
  const row = await db.dialSession.findFirst({
    where: { endedAt: null, status: { in: ['starting', 'live', 'paused'] } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, status: true },
  });
  return row ? { id: row.id, status: row.status as SessionStatus } : null;
}
