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

import { VOICES, type MusicTrackDef } from './music-data';
import { noteToHz } from './notes';
import { parseChord, type Chord } from './chords';
import { generateMelody } from './melody';

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
  /**
   * Change SUITE: at the next cycle boundary, play `steps` of `chord` -- the
   * incoming suite's dominant -- while the tempo ramps toward the incoming
   * track's, then start it. This is the handled join between two sets.
   */
  changeSuite(next: MusicTrackDef, chord: Chord, steps: number): void;
  /** True while the transition passage is sounding. */
  inTransition(): boolean;
  /**
   * Queue a track to take over at the next cycle boundary. Switching mid-phrase
   * is audible; switching at the boundary is not, provided the two share key,
   * tempo and bar length.
   */
  queueTrack(next: MusicTrackDef): void;
  /** The track currently sounding, for tests and tooling. */
  currentTrackId(): string | null;
  /** 0..1, applied to the whole bed. Safe to call while playing. */
  setVolume(v: number): void;
  /**
   * 0..1 arrangement density. Layers whose own `intensity` exceeds this stay
   * silent, so the game can drive the mix from state (enemies remaining).
   */
  setIntensity(v: number): void;
  isPlaying(): boolean;
  dispose(): void;
}

export interface MusicDeps {
  /**
   * A composed track to play. Without one the bed generates, exactly as before:
   * the game is never silent while authoring is half-finished.
   */
  track?: MusicTrackDef | null;
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
  let track = deps.track ?? null;
  /**
   * A track queued to take over at the next CYCLE BOUNDARY.
   *
   * Switching anywhere else is what makes a change audible: mid-phrase the
   * harmony jumps, and mid-bar the pulse breaks. At a boundary the outgoing
   * piece has just completed its progression and the incoming one starts its
   * own, so if both share key, tempo and bar length the join is inaudible --
   * which is exactly what the arena family is built to share.
   */
  let queued: MusicTrackDef | null = null;
  /**
   * An in-progress suite change: a short passage of the incoming suite's
   * DOMINANT, during which the tempo ramps from the outgoing pulse to the
   * incoming one. See the suites design doc.
   */
  let transition: {
    chord: Chord;
    steps: number;
    played: number;
    fromStep: number;
    toStep: number;
    next: MusicTrackDef;
  } | null = null;
  // Per-layer cursors: layers advance INDEPENDENTLY, so a 8-step bass under an
  // 11-step drone gives an 88-step combined cycle without authoring one.
  let cursors = track ? track.tracks.map(() => 0) : [];
  // Generated layers are rebuilt each time they wrap, so the "loop" is only a
  // loop harmonically: the melody over it is new every cycle. That is the whole
  // answer to loop fatigue -- the skeleton repeats, the surface does not.
  let chords = track ? track.chords.map((c) => parseChord(c)).filter((c): c is Chord => !!c) : [];
  let generated: Array<Array<number | null> | null> = track ? track.tracks.map(() => null) : [];
  let cycle = 0;
  let intensity = 1;
  let stepsIntoCycle = 0;
  let pendingSuite: { next: MusicTrackDef; chord: Chord; steps: number } | null = null;

  function regenerate(layerIndex: number): void {
    if (!track) return;
    const spec = track.tracks[layerIndex].generate;
    if (!spec || chords.length === 0) return;
    const names = generateMelody(
      chords,
      track.barSteps,
      spec,
      (deps.seed ?? 0x5eed) + cycle * 131 + layerIndex,
    );
    generated[layerIndex] = names.map((n) => noteToHz(n));
  }

  /** The notes a layer is currently playing: authored, or this cycle's melody. */
  function notesOf(layerIndex: number): Array<number | null> {
    const layer = track!.tracks[layerIndex];
    if (layer.notes) return layer.notes;
    if (!generated[layerIndex]) regenerate(layerIndex);
    return generated[layerIndex] ?? [];
  }

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

  function scheduleComposed(at: number): void {
    if (!track) return;
    // Bound locally: `track` is now reassignable (a queued switch), so TypeScript
    // cannot keep it narrowed across the callback below.
    const t = track;
    t.tracks.forEach((layer, i) => {
      let notes = notesOf(i);
      if (notes.length === 0) return;
      // A generated layer gets a NEW melody each time it comes round.
      if (cursors[i] > 0 && cursors[i] % notes.length === 0 && layer.generate) {
        cycle += 1;
        regenerate(i);
        notes = notesOf(i);
      }
      const hz = notes[cursors[i] % notes.length];
      cursors[i] += 1;
      if (hz === null) return; // a rest: advance the cursor, sound nothing
      // Intensity gates the ARRANGEMENT. The cursor still advances while a layer
      // is silent, so one coming back in lands where the phrase is rather than
      // restarting mid-figure.
      if (layer.intensity > intensity) return;
      const v = VOICES[layer.voice];
      note(hz, at, t.stepSeconds * v.hold, v.peak, v.type);
    });
  }

  function scheduleGenerated(at: number): void {
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

  function scheduleStep(at: number): void {
    if (transition) {
      scheduleTransition(at);
      return;
    }
    // Check for a pending switch BEFORE scheduling: the boundary is the step at
    // which the outgoing cycle has completed, and the incoming track should own
    // that step rather than the one after it.
    if (track && pendingSuite && stepsIntoCycle === 0) {
      transition = {
        chord: pendingSuite.chord,
        steps: pendingSuite.steps,
        played: 0,
        fromStep: track.stepSeconds,
        toStep: pendingSuite.next.stepSeconds,
        next: pendingSuite.next,
      };
      pendingSuite = null;
      scheduleTransition(at);
      return;
    }
    if (track && queued && stepsIntoCycle === 0) adoptQueued();
    if (track) {
      scheduleComposed(at);
      stepsIntoCycle = (stepsIntoCycle + 1) % cycleSteps(track);
    } else {
      scheduleGenerated(at);
    }
  }

  /**
   * Steps until every layer wraps together. A switch at any earlier point would
   * leave some layer mid-phrase; this is the one instant at which the whole
   * arrangement is between cycles.
   */
  function cycleSteps(t: MusicTrackDef): number {
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;
    const lens = t.tracks.map((l) => l.notes?.length ?? t.barSteps * t.chords.length);
    return lens.reduce(lcm, 1) || 1;
  }

  /** Swap in the queued track. Only ever called at a cycle boundary. */
  function adoptQueued(): void {
    if (!queued) return;
    track = queued;
    queued = null;
    cursors = track.tracks.map(() => 0);
    generated = track.tracks.map(() => null);
    chords = track.chords.map((c) => parseChord(c)).filter((c): c is Chord => !!c);
  }

  /**
   * The composed track's tempo when there is one; the bed's otherwise.
   *
   * During a transition the length is interpolated per STEP, not per frame, so
   * it stays a pure function of the step index and the grid cannot drift.
   */
  function stepLength(): number {
    if (transition) {
      const p = transition.steps <= 1 ? 1 : transition.played / (transition.steps - 1);
      return transition.fromStep + (transition.toStep - transition.fromStep) * Math.min(1, p);
    }
    return track ? track.stepSeconds : STEP_SECONDS;
  }

  /** One step of the transition passage: the dominant, sustained and pulsed. */
  function scheduleTransition(at: number): void {
    const t = transition;
    if (!t) return;
    const len = stepLength();
    // Root on every other step keeps the pulse alive across the ramp; the triad
    // enters once and sustains, so the chord reads as a single held gesture.
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    if (t.played % 2 === 0) {
      const rootHz = noteToHz(`${NAMES[t.chord.root]}1`);
      if (rootHz !== null) note(rootHz, at, len * VOICES.bass.hold, VOICES.bass.peak, VOICES.bass.type);
    }
    if (t.played === 0) {
      for (const pc of t.chord.pitchClasses) {
        const hz = noteToHz(`${NAMES[pc]}3`);
        if (hz !== null) note(hz, at, len * t.steps, VOICES.pad.peak, VOICES.pad.type);
      }
    }
    t.played += 1;
    if (t.played >= t.steps) {
      // The passage is done: the incoming track starts its own cycle here.
      track = t.next;
      cursors = track.tracks.map(() => 0);
      generated = track.tracks.map(() => null);
      chords = track.chords.map((c) => parseChord(c)).filter((c): c is Chord => !!c);
      stepsIntoCycle = 0;
      transition = null;
    }
  }

  function pump(): void {
    if (!bus || disposed) return;
    const horizon = ctx.currentTime + LOOKAHEAD_SECONDS;
    // Guard against a long stall (tab backgrounded): jump the cursor forward
    // rather than scheduling a burst of notes that all fire at once on return.
    if (nextStepAt < ctx.currentTime) nextStepAt = ctx.currentTime;
    while (nextStepAt < horizon) {
      scheduleStep(nextStepAt);
      nextStepAt += stepLength();
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
    queueTrack(next: MusicTrackDef): void {
      queued = next;
    },
    changeSuite(next: MusicTrackDef, chord: Chord, steps: number): void {
      pendingSuite = { next, chord, steps: Math.max(1, Math.floor(steps)) };
    },
    inTransition(): boolean {
      return transition !== null;
    },
    currentTrackId(): string | null {
      return track?.id ?? null;
    },
    setIntensity(v: number): void {
      intensity = Math.max(0, Math.min(1, v));
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
