/**
 * The music bed, generated.
 *
 * There is no music track and no licensed source for one, so the game had
 * silence: `engine.ts` nulls the music Howl on load error and `startMusic()` is
 * guarded on it, meaning music was the one thing with no fallback at all.
 *
 * This is that fallback. It is deliberately NOT a tune -- a melody you cannot
 * turn off becomes irritating in a game you replay for hours. It is a slow
 * two-note bass pulse under a sparse held drone, in a minor scale, at a tempo
 * near a resting heart rate. The pattern advances through a seeded sequence so
 * it does not loop audibly, but it is deterministic: the same seed makes the
 * same session, which is what lets a test assert anything about it.
 *
 * Scheduling uses the standard lookahead pattern: a timer wakes periodically and
 * schedules every note falling inside the next window against the AUDIO clock,
 * never `setTimeout` timing. Timer jitter of tens of milliseconds is inaudible
 * when the notes themselves were placed on a sample-accurate clock.
 */

/** Bass root notes, A minor, one octave apart from the drone. */
const BASS_HZ = [55, 55, 61.74, 55, 65.41, 55, 49, 55];
/** Drone partials, a fifth and an octave above the root. */
const DRONE_HZ = [220, 246.94, 261.63, 293.66];

/** Seconds per step. 1.5s is 40 steps/minute -- slow enough to sit under play. */
const STEP_SECONDS = 1.5;
/** How far ahead to schedule, and how often to wake. Standard lookahead. */
const LOOKAHEAD_SECONDS = 0.6;
const TIMER_MS = 250;

export interface MusicBed {
  /** Idempotent: a second start does not layer a second bed. */
  start(): void;
  /** Stops scheduling and silences anything already scheduled. */
  stop(): void;
  /** 0..1, applied to the whole bed. Safe to call while playing. */
  setVolume(v: number): void;
  isPlaying(): boolean;
  dispose(): void;
}

export interface MusicDeps {
  /** Injected so tests can drive the clock without real timers. */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (h: ReturnType<typeof setInterval>) => void;
  /** Seeds the step sequence. Same seed, same session. */
  seed?: number;
}

/**
 * Whether this context can run the bed. Same reasoning as synth.ts: check up
 * front and as a whole, so a context that cannot do it stays silent rather than
 * throwing from inside a timer where nothing can catch it.
 */
function canPlay(ctx: BaseAudioContext): boolean {
  if (typeof ctx.createGain !== 'function' || typeof ctx.createOscillator !== 'function') {
    return false;
  }
  const probe = ctx.createGain();
  const ok =
    typeof probe.gain?.setValueAtTime === 'function' &&
    typeof probe.gain?.exponentialRampToValueAtTime === 'function';
  try {
    probe.disconnect();
  } catch {
    // Never connected.
  }
  return ok;
}

export function createMusicBed(
  ctx: BaseAudioContext,
  dest: AudioNode,
  deps: MusicDeps = {},
): MusicBed {
  const setIv = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIv = deps.clearInterval ?? ((h) => clearInterval(h));

  let bus: GainNode | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let nextStepAt = 0;
  let step = 0;
  let volume = 1;
  let disposed = false;
  // Live voices, so stop() can silence notes already scheduled into the future.
  let voices: Array<{ osc: OscillatorNode; gain: GainNode }> = [];
  // `|| 0x5eed`, not `?? 0x5eed`: xorshift on 0 stays 0 forever, so a seed of 0
  // would fire the drone on every step and always pick the same partial.
  let rng = deps.seed || 0x5eed;

  function nextRandom(): number {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return ((rng >>> 0) % 1000) / 1000;
  }

  function note(freq: number, at: number, dur: number, peak: number, type: OscillatorType): void {
    if (!bus) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    // Long, soft attack: a bed should swell, not click. A click at this
    // repetition rate is the fastest way to make music annoying.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + dur * 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(bus);
    osc.start(at);
    osc.stop(at + dur + 0.05);
    const voice = { osc, gain };
    voices.push(voice);
    if (typeof osc.addEventListener === 'function') {
      osc.addEventListener('ended', () => {
        voices = voices.filter((v) => v !== voice);
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          // Context closed under us.
        }
      });
    }
  }

  function scheduleStep(at: number): void {
    const bass = BASS_HZ[step % BASS_HZ.length];
    note(bass, at, STEP_SECONDS * 0.9, 0.22, 'triangle');
    // The drone enters sparsely -- roughly one step in three -- so the bed has
    // some shape without ever becoming a melody the player can get sick of.
    if (nextRandom() < 0.34) {
      const partial = DRONE_HZ[Math.floor(nextRandom() * DRONE_HZ.length) % DRONE_HZ.length];
      note(partial, at, STEP_SECONDS * 1.8, 0.05, 'sine');
    }
    step += 1;
  }

  function pump(): void {
    if (!bus || disposed) return;
    const horizon = ctx.currentTime + LOOKAHEAD_SECONDS;
    // Guard against a long stall (tab backgrounded): jump the cursor forward
    // rather than scheduling a burst of notes that all fire at once on return.
    if (nextStepAt < ctx.currentTime) nextStepAt = ctx.currentTime;
    while (nextStepAt < horizon) {
      scheduleStep(nextStepAt);
      nextStepAt += STEP_SECONDS;
    }
  }

  return {
    start(): void {
      if (disposed || timer !== null) return;
      if (!canPlay(ctx)) return;
      bus = ctx.createGain();
      bus.gain.value = volume;
      bus.connect(dest);
      nextStepAt = ctx.currentTime + 0.08;
      pump();
      timer = setIv(pump, TIMER_MS);
    },
    stop(): void {
      if (timer !== null) {
        clearIv(timer);
        timer = null;
      }
      // Notes are scheduled AHEAD of now, so stopping the timer is not enough --
      // without this, up to LOOKAHEAD_SECONDS of music plays after "stop".
      for (const v of voices) {
        try {
          v.osc.stop();
          v.osc.disconnect();
          v.gain.disconnect();
        } catch {
          // Already stopped or the context closed.
        }
      }
      voices = [];
      if (bus) {
        try {
          bus.disconnect();
        } catch {
          // Already disconnected.
        }
        bus = null;
      }
    },
    setVolume(v: number): void {
      volume = Math.max(0, Math.min(1, v));
      if (bus) bus.gain.value = volume;
    },
    isPlaying(): boolean {
      return timer !== null;
    },
    dispose(): void {
      this.stop();
      disposed = true;
    },
  };
}
