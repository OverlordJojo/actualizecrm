'use client';

/**
 * US precise ringback tone, synthesized locally.
 *
 * 440 Hz + 480 Hz, 2 seconds on / 4 seconds off — the North American standard
 * cadence.
 *
 * Why synthesize rather than let the carrier's early media through: carriers
 * send wildly inconsistent audio before answer. Some send a real ringback,
 * some silence, some a recorded network message, and the timing varies. An
 * operator doing 7 hours of this needs the same sound on every call, and it
 * has to stop the instant the prospect speaks. Generating it locally gives
 * both, and costs nothing.
 */

const FREQ_A = 440;
const FREQ_B = 480;
const ON_SECONDS = 2;
const OFF_SECONDS = 4;
const CYCLE_SECONDS = ON_SECONDS + OFF_SECONDS;
/// Short fade on each burst; a hard gate on a sine wave clicks audibly.
const RAMP = 0.02;

export class RingbackTone {
  private ctx: AudioContext | null = null;
  private oscA: OscillatorNode | null = null;
  private oscB: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private playing = false;
  private volume: number;

  constructor(volume = 0.5) {
    this.volume = clamp(volume);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  async start(): Promise<void> {
    if (this.playing) return;

    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new Ctor();
    }

    // Browsers suspend audio contexts created without a user gesture.
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }

    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);

    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    oscA.frequency.value = FREQ_A;
    oscB.frequency.value = FREQ_B;
    oscA.type = 'sine';
    oscB.type = 'sine';
    oscA.connect(gain);
    oscB.connect(gain);

    const start = ctx.currentTime;
    oscA.start(start);
    oscB.start(start);

    this.oscA = oscA;
    this.oscB = oscB;
    this.gain = gain;
    this.playing = true;

    // Schedule enough cadence cycles that a long ring never runs out. Timing
    // lives on the audio clock rather than setInterval, so it does not drift
    // when the main thread is busy rendering the board.
    this.scheduleCadence(start, 40);
  }

  private scheduleCadence(startTime: number, cycles: number) {
    const gain = this.gain;
    const ctx = this.ctx;
    if (!gain || !ctx) return;

    for (let i = 0; i < cycles; i++) {
      const on = startTime + i * CYCLE_SECONDS;
      const off = on + ON_SECONDS;

      gain.gain.setValueAtTime(0, on);
      gain.gain.linearRampToValueAtTime(this.volume, on + RAMP);
      gain.gain.setValueAtTime(this.volume, off - RAMP);
      gain.gain.linearRampToValueAtTime(0, off);
    }
  }

  /// Stops immediately. Called the moment the prospect answers, so it fades
  /// over milliseconds rather than waiting out the current burst.
  stop(): void {
    if (!this.playing) return;
    this.playing = false;

    const ctx = this.ctx;
    const gain = this.gain;

    if (ctx && gain) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + RAMP);
    }

    const oscA = this.oscA;
    const oscB = this.oscB;
    const stopAt = ctx ? ctx.currentTime + RAMP * 2 : 0;

    try {
      oscA?.stop(stopAt);
      oscB?.stop(stopAt);
    } catch {
      // Already stopped.
    }

    this.oscA = null;
    this.oscB = null;
    this.gain = null;
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume);
    // Take effect on the next burst rather than jumping mid-tone.
    if (this.playing && this.ctx && this.gain) {
      this.stop();
      this.playing = false;
      void this.start();
    }
  }

  /// Plays two seconds of tone so the operator can hear the volume they are
  /// setting, without having to place a call.
  async preview(): Promise<void> {
    await this.start();
    setTimeout(() => this.stop(), ON_SECONDS * 1000);
  }

  dispose(): void {
    this.stop();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}
