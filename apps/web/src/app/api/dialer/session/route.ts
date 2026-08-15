import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  startSession,
  endSession,
  pauseSession,
  resumeSession,
  hangupActive,
  switchToCall,
  hangupCall,
  openBurst,
  bridgeOldestHeld,
  sessionView,
  currentSession,
} from '@actualizecrm/dialer';
import { abandonmentState } from '@/integrations/telnyx/governor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Operator commands for the conference-anchored dialer (§2.2, §2.4).
 *
 * These call the engine directly rather than going through the worker. The
 * operator is standing there with a finger on the space bar, and a network hop
 * between the keypress and the hang-up is latency they can hear. Webhook-driven
 * transitions — the AMD verdict that decides who reaches their ears — run on the
 * worker, against the same functions in `@actualizecrm/dialer`.
 */

const startSchema = z.object({
  action: z.literal('start'),
  contactIds: z.array(z.string().min(1)).min(1),
  sourceType: z.string().default('stage'),
  sourceName: z.string().optional(),
});

const commandSchema = z.object({
  action: z.enum(['advance', 'hangup', 'pause', 'resume', 'end', 'switch', 'hangupCall']),
  sessionId: z.string().min(1),
  /// The specific leg, for per-line commands.
  callId: z.string().optional(),
  /// Leads to open the next burst on, in kanban order. Ignored when somebody is
  /// already on hold — draining beats dialling, and the server decides that so
  /// the two cannot disagree.
  contactIds: z.array(z.string().min(1)).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const start = startSchema.safeParse(body);
  if (start.success) {
    try {
      const governor = await abandonmentState();
      const session = await startSession({
        contactIds: start.data.contactIds,
        // The governor, not the setting, decides how many lines are allowed —
        // and it is consulted at session start rather than read from a cache.
        linesPerBurst: governor.allowedLines,
        sourceType: start.data.sourceType,
        sourceName: start.data.sourceName,
      });
      return NextResponse.json({ ...session, governor });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Could not start the session.' },
        { status: 502 },
      );
    }
  }

  const cmd = commandSchema.safeParse(body);
  if (!cmd.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const { action, sessionId } = cmd.data;

  try {
    switch (action) {
      case 'hangup': {
        const ended = await hangupActive(sessionId);
        return NextResponse.json({ ok: ended, view: await sessionView(sessionId) });
      }

      // Per-line commands. The operator can see every live leg and act on any
      // of them, not only the one in their ear.
      case 'switch': {
        if (!cmd.data.callId) break;
        const moved = await switchToCall({ sessionId, callId: cmd.data.callId });
        return NextResponse.json({ ok: moved, view: await sessionView(sessionId) });
      }

      case 'hangupCall': {
        if (!cmd.data.callId) break;
        const ended = await hangupCall({ sessionId, callId: cmd.data.callId });
        return NextResponse.json({ ok: ended, view: await sessionView(sessionId) });
      }

      case 'pause':
        await pauseSession(sessionId);
        return NextResponse.json({ ok: true, view: await sessionView(sessionId) });

      case 'resume':
        await resumeSession(sessionId);
        return NextResponse.json({ ok: true, view: await sessionView(sessionId) });

      case 'end':
        await endSession(sessionId);
        return NextResponse.json({ ok: true, view: await sessionView(sessionId) });

      case 'advance': {
        /**
         * Drain before dialling, always (§2.2 step 9).
         *
         * Somebody on hold answered the phone. A lead in the queue has not.
         * Serving the person who is already there is both the courteous order
         * and the profitable one — and it is what keeps the abandonment rate
         * under the cap, since every held second counts against it.
         *
         * When several owners answered at once this drains them one after
         * another, oldest first, opening no new burst until the last is dealt
         * with.
         */
        const bridged = await bridgeOldestHeld(sessionId);
        if (bridged) {
          return NextResponse.json({
            mode: 'bridged_held',
            callId: bridged,
            view: await sessionView(sessionId),
          });
        }

        const governor = await abandonmentState();
        if (governor.blocked) {
          // Hard block at 3%: single line until the rate recovers, no override.
          governor.allowedLines = 1;
        }

        const burst = await openBurst(
          sessionId,
          cmd.data.contactIds ?? [],
          governor.allowedLines,
        );
        return NextResponse.json({
          mode: 'burst',
          ...burst,
          governor,
          view: await sessionView(sessionId),
        });
      }
    }

    return NextResponse.json({ error: 'That command needs a call id.' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'That did not work.' },
      { status: 502 },
    );
  }
}

/**
 * The dialer's whole live state, in one read.
 *
 * Polled while a session is live. One endpoint rather than several because the
 * UI's correctness depends on these agreeing: a hang-up button enabled from one
 * snapshot beside a lead card drawn from another is how a control ends up acting
 * on a call the operator is no longer on.
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('sessionId');
  const sessionId = id ?? (await currentSession())?.id;
  if (!sessionId) return NextResponse.json({ view: null, governor: await abandonmentState() });

  const [view, governor] = await Promise.all([sessionView(sessionId), abandonmentState()]);
  return NextResponse.json({ view, governor });
}
