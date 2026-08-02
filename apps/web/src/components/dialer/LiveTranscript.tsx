'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

interface Segment {
  speaker: string;
  text: string;
  confidence: number | null;
  at: string;
}

/**
 * The live transcript pane beside the Active Lead Card (§5.6).
 *
 * This is the *rough* copy. Telnyx streams it phrase by phrase during the call
 * so the operator can glance at what was just said — a number, a spelling, the
 * name of the person they were transferred to — without breaking eye contact
 * with the conversation. The accurate, speaker-attributed transcript is
 * produced afterwards by Deepgram over the dual-channel recording and replaces
 * this wholesale.
 *
 * The distinction is stated in the UI rather than hidden, because acting on a
 * mis-heard email address is the exact failure mode the AI surfaces are built
 * to avoid.
 */
export function LiveTranscript({
  callId,
  live,
}: {
  callId: string | null;
  /// True while the call is connected. Polling stops the moment it is not.
  live: boolean;
}) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    setSegments([]);
    setStatus(null);
  }, [callId]);

  useEffect(() => {
    if (!callId || !live) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch(`/api/calls/${callId}/transcript`);
        if (!res.ok || cancelled) return;
        const json = await res.json();
        setSegments(json.segments ?? []);
        setStatus(json.status ?? null);
      } catch {
        // A dropped poll is cosmetic — the transcript is durable server-side.
      }
    };

    tick();
    const t = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [callId, live]);

  // Follow the conversation, but stop fighting the operator if they scroll up
  // to re-read something — which is the only reason they would.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [segments]);

  if (!callId) return null;

  return (
    <div className="flex min-h-0 w-[280px] shrink-0 flex-col rounded-lg border border-ink-800 bg-ink-950">
      <div className="flex shrink-0 items-baseline gap-2 border-b border-ink-800 px-2.5 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-ink-400">
          Live transcript
        </span>
        {live && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
        )}
        <span className="ml-auto text-[9px] text-ink-600">rough</span>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="scroll-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2.5 py-2"
      >
        {segments.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-ink-600">
            {live
              ? 'Listening… phrases appear here a second or two after they are said.'
              : status === 'skipped'
                ? 'Transcription is switched off in Settings.'
                : 'Nothing transcribed for this call.'}
          </p>
        ) : (
          segments.map((s, i) => (
            <p key={i} className="text-[11px] leading-snug">
              <span
                className={cn(
                  'font-medium',
                  s.speaker === 'Prospect' ? 'text-brand-300' : 'text-ink-500',
                )}
              >
                {s.speaker}:{' '}
              </span>
              <span
                className={cn(
                  // Low-confidence phrases are dimmed rather than hidden. The
                  // operator can still read them, but they look like what they
                  // are: a guess.
                  s.confidence !== null && s.confidence < 0.6
                    ? 'text-ink-500'
                    : 'text-ink-200',
                )}
              >
                {s.text}
              </span>
            </p>
          ))
        )}
      </div>

      <p className="shrink-0 border-t border-ink-800 px-2.5 py-1 text-[9px] leading-tight text-ink-600">
        Rough live text. The accurate transcript is written after the call and
        replaces this.
      </p>
    </div>
  );
}
