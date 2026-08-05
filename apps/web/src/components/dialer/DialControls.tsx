'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { formatPhone, toE164 } from '@/lib/phone';
import { DISPOSITIONS, type DispositionValue } from '@/lib/dispositions';
import type { LineState } from '@/integrations/telnyx/useSoftphone';

export interface SessionStats {
  dials: number;
  connects: number;
  booked: number;
  talkTimeSec: number;
  startedAt: number | null;
}

const LINE_LABEL: Record<LineState, string> = {
  offline: 'Offline',
  connecting: 'Starting…',
  ready: 'Ready',
  dialing: 'Dialing',
  ringing: 'Ringing',
  connected: 'Connected',
  ending: 'Ending…',
};

const LINE_TONE: Record<LineState, string> = {
  offline: 'bg-red-500',
  connecting: 'bg-amber-500',
  ready: 'bg-green-500',
  dialing: 'bg-brand-500',
  ringing: 'bg-brand-500 animate-pulse',
  connected: 'bg-green-400',
  ending: 'bg-ink-500',
};

/**
 * Region B. Session controls, a manual dial pad, live stats, and the five
 * disposition buttons.
 */
export function DialControls({
  lineState,
  muted,
  callerId,
  sessionActive,
  queueLength,
  stats,
  gapSeconds,
  countdown,
  callSeconds,
  onStartSession,
  onPauseSession,
  onEndSession,
  onManualDial,
  onHangup,
  onToggleMute,
  onDisposition,
  onVoicemailDrop,
  dropping,
  incoming,
  onAnswerInbound,
  onDeclineInbound,
  incomingIsOperatorLeg,
  held,
  governor,
  linesPerBurst,
  canHangup,
  listeningToVoicemail,
}: {
  lineState: LineState;
  muted: boolean;
  callerId: string | null;
  sessionActive: boolean;
  queueLength: number;
  stats: SessionStats;
  gapSeconds: number;
  /// Name of the recording playing into the call, or null.
  dropping: string | null;
  /// Set while an inbound call is ringing the browser (add-on A).
  incoming: { callerNumber: string; callerName?: string } | null;
  onAnswerInbound: () => void;
  onDeclineInbound: () => void;
  /// The ringing call is this session's own operator leg, not a prospect.
  incomingIsOperatorLeg?: boolean;
  /// Queued owners waiting on hold (§4.3).
  held: { callId: string; toE164: string; heldSeconds: number }[];
  /// Live abandonment governor state (§4.4).
  governor: { rate: number; blocked: boolean; allowedLines: number; warning: string | null } | null;
  linesPerBurst: number;
  /// True the instant a prospect leg is bridged into the conference, false
  /// otherwise — driven by webhooks, never optimistic (§2.4).
  canHangup: boolean;
  /// The operator is hearing an answering machine, not a person.
  listeningToVoicemail?: boolean;
  /// Seconds remaining before the dialer auto-advances, or null when idle.
  countdown: number | null;
  /// Seconds since the prospect answered, or null when not connected.
  callSeconds: number | null;
  onStartSession: () => void;
  onPauseSession: () => void;
  onEndSession: () => void;
  onManualDial: (phone: string) => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onDisposition: (value: DispositionValue) => void;
  onVoicemailDrop: () => void;
}) {
  const [manual, setManual] = useState('');
  const manualValid = toE164(manual) !== null;

  /**
   * Whether a prospect is actually on the line.
   *
   * From the server's leg state, never from `lineState` (§2.4). Deriving it
   * from the browser's SDK is the bug that was reported: during a burst the
   * legs belong to the server and the browser sits idle in the conference, so
   * every in-call control rendered permanently disabled and the operator had
   * nothing but Pause and End.
   */
  const onCall = canHangup;

  const elapsedMin = stats.startedAt
    ? Math.max((Date.now() - stats.startedAt) / 60000, 1 / 60)
    : 0;
  const dialsPerHour = elapsedMin > 0 ? Math.round((stats.dials / elapsedMin) * 60) : 0;
  const connectRate = stats.dials > 0 ? Math.round((stats.connects / stats.dials) * 100) : 0;

  return (
    <div className="flex w-[380px] shrink-0 flex-col gap-2.5">
      {/* line status + caller id */}
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', LINE_TONE[lineState])} />
        <span className="text-xs font-medium text-ink-200">
          {LINE_LABEL[lineState]}
        </span>
        {/* Live timer, started at answer rather than at dial (§3.2). */}
        {callSeconds !== null && (
          <span className="font-mono text-sm font-semibold tabular-nums text-green-400">
            {formatDuration(callSeconds)}
          </span>
        )}
        {callerId && (
          <span className="ml-auto font-mono text-[11px] text-ink-400">
            from {formatPhone(callerId)}
          </span>
        )}
      </div>

      {/* Inbound. Sits above everything because it is the only thing on this
          panel with a few seconds to act on. */}
      {incoming && (
        <div
          className={cn(
            'rounded-lg border px-3 py-2',
            incomingIsOperatorLeg
              ? 'border-brand-600 bg-brand-950/50'
              : 'border-green-700 bg-green-950/50',
          )}
        >
          {incomingIsOperatorLeg ? (
            <>
              {/* The operator's own number ringing them is confusing on its
                  face — it is the dialer connecting their headset, not a
                  prospect. Say which, or it reads as a bug. */}
              <p className="text-xs font-medium text-brand-200">
                Connecting your headset…
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-brand-100/70">
                This is the dialer calling you, not a prospect. It answers
                itself — press Connect if it does not.
              </p>
              <div className="mt-1.5">
                <button className="btn-primary py-1 text-xs" onClick={onAnswerInbound}>
                  Connect
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-green-200">
                Incoming call from{' '}
                <span className="font-mono">{formatPhone(incoming.callerNumber)}</span>
                {incoming.callerName ? ` — ${incoming.callerName}` : ''}
              </p>
              <div className="mt-1.5 flex gap-1.5">
                <button className="btn-primary py-1 text-xs" onClick={onAnswerInbound}>
                  Answer
                </button>
                <button className="btn-ghost py-1 text-xs" onClick={onDeclineInbound}>
                  Decline
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* A recording playing into the operator's ear with no explanation reads
          as a bug. Say what it is, and that hanging up moves on. */}
      {listeningToVoicemail && (
        <div className="rounded-lg border border-violet-800 bg-violet-950/40 px-3 py-2">
          <p className="text-xs font-medium text-violet-200">
            Answering machine — listening to the greeting
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-violet-100/70">
            Owner&rsquo;s voice or a front desk? Hang up when you have heard
            enough; it is already logged as a voicemail.
          </p>
        </div>
      )}

      {/* manual dial pad */}
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (manualValid && !onCall) {
            onManualDial(manual);
            setManual('');
          }
        }}
      >
        <input
          className="input py-1.5 font-mono"
          placeholder="Type a number to call"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          disabled={onCall}
        />
        <button
          type="submit"
          className="btn-primary shrink-0 py-1.5"
          disabled={!manualValid || onCall || lineState === 'offline'}
        >
          Call
        </button>
      </form>

      {/* session + in-call controls */}
      <div className="flex flex-wrap gap-1.5">
        {!sessionActive ? (
          <button
            className="btn-primary py-1.5 text-xs"
            onClick={onStartSession}
            disabled={queueLength === 0 || lineState === 'offline'}
            title={queueLength === 0 ? 'Load a list first' : undefined}
          >
            Start session ({queueLength})
          </button>
        ) : (
          <>
            <button className="btn-ghost py-1.5 text-xs" onClick={onPauseSession}>
              Pause <Key>P</Key>
            </button>
            <button className="btn-ghost py-1.5 text-xs" onClick={onEndSession}>
              End <Key>Esc</Key>
            </button>
          </>
        )}

        <button
          className="btn-ghost py-1.5 text-xs"
          onClick={onToggleMute}
          disabled={!onCall}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>

        <button
          className="btn-ghost py-1.5 text-xs"
          onClick={onVoicemailDrop}
          disabled={!onCall || dropping !== null}
        >
          Voicemail <Key>V</Key>
        </button>

        <button
          className="btn-danger py-1.5 text-xs"
          onClick={onHangup}
          disabled={!onCall}
        >
          Hang up <Key>Space</Key>
        </button>
      </div>

      {/* Queued owners. Shown because the operator needs to know somebody is
          waiting — that is the whole reason the next advance bridges instead
          of dialing. */}
      {held.length > 0 && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/40 px-2.5 py-1.5">
          <p className="text-xs font-medium text-amber-200">
            {held.length} caller{held.length === 1 ? '' : 's'} on hold
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {held.map((h) => (
              <li key={h.callId} className="flex justify-between text-[10px] text-amber-100/80">
                <span className="font-mono">{formatPhone(h.toE164)}</span>
                <span className="tabular-nums">{h.heldSeconds}s</span>
              </li>
            ))}
          </ul>
          <p className="mt-0.5 text-[10px] text-amber-100/60">
            The next advance bridges the longest wait instead of dialing.
          </p>
        </div>
      )}

      {governor?.warning && (
        <div
          className={cn(
            'rounded-lg px-2.5 py-1.5 text-[11px]',
            governor.blocked
              ? 'border border-red-800 bg-red-950/50 text-red-200'
              : 'border border-amber-800 bg-amber-950/40 text-amber-100',
          )}
        >
          {governor.warning}
        </div>
      )}

      {dropping && (
        <div className="rounded-lg bg-violet-500/10 px-2.5 py-1.5 text-xs text-violet-200">
          Playing &ldquo;{dropping}&rdquo; — hangs up on its own when the
          recording finishes.
        </div>
      )}

      {countdown !== null && (
        <div className="rounded-lg bg-brand-500/10 px-2.5 py-1.5 text-xs text-brand-300">
          Next lead in {countdown}s
          <span className="ml-1 text-ink-500">(gap {gapSeconds}s)</span>
        </div>
      )}

      {/* dispositions */}
      <div>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-500">
          Outcome
        </div>
        <div className="grid grid-cols-5 gap-1">
          {DISPOSITIONS.map((d) => (
            <button
              key={d.value}
              onClick={() => onDisposition(d.value)}
              className="flex flex-col items-center gap-0.5 rounded-lg border border-ink-700 bg-ink-850 px-1 py-1.5 text-[10px] font-medium leading-tight text-ink-200 transition-colors hover:bg-ink-800"
              style={{ borderBottomColor: d.color, borderBottomWidth: 2 }}
              title={`${d.label} (${d.hotkey})`}
            >
              <span className="text-center">{d.label}</span>
              <Key>{d.hotkey}</Key>
            </button>
          ))}
        </div>
      </div>

      {/* stats — one compact row so Region B never overflows into the board */}
      <div className="mt-auto grid grid-cols-7 gap-1 border-t border-ink-800 pt-2">
        <Stat label="Dials" value={stats.dials} />
        <Stat label="Conn" value={stats.connects} />
        <Stat label="Rate" value={`${connectRate}%`} />
        <Stat label="Talk" value={formatDuration(stats.talkTimeSec)} />
        <Stat label="/hr" value={dialsPerHour} />
        <Stat label="Booked" value={stats.booked} tone="good" />
        {/* §4.4 requires the rolling abandonment rate to be visible live. */}
        <Stat
          label={linesPerBurst > 1 ? `Aband (${governor?.allowedLines ?? 1}L)` : 'Aband'}
          value={governor ? `${(governor.rate * 100).toFixed(1)}%` : '—'}
          tone={governor?.blocked ? 'bad' : undefined}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'good' | 'bad';
}) {
  return (
    <div>
      <div
        className={cn(
          'truncate text-sm font-semibold tabular-nums',
          tone === 'good'
            ? 'text-green-400'
            : tone === 'bad'
              ? 'text-red-400'
              : 'text-ink-100',
        )}
      >
        {value}
      </div>
      <div className="text-[9px] text-ink-500">{label}</div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-ink-600 bg-ink-900 px-1 text-[9px] text-ink-400">
      {children}
    </kbd>
  );
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
