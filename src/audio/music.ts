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

import { VOICES, type MusicTrackDef, type VoiceName } from './music-data';
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
  changeSuite(next: MusicTrackDef): void;
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
  /**
   * A tempo ramp in progress, across the incoming piece's pickup bar. This is
   * ALL that remains of the transition machinery: after four iterations of
   * composing interstitial material (a held pad, then arpeggios, then rolled
   * swells), Austin named the actual flaw -- "you're still using something that
   * exists in neither section to bridge between the two". So nothing is
   * invented any more. The through-line construction ends every progression on
   * its own dominant, which means the incoming piece's FINAL BAR is already the
   * entry music: it is played first, as a pickup, and the only thing synthesised
   * across it is the tempo interpolation.
   */
  let ramp: { played: number; steps: number; fromStep: number; toStep: number } | null = null;
  /**
   * The OUTGOING section's melody, carried over the incoming pickup bar and
   * fading as it goes -- Austin: "maybe we can have an overlap of the two sound
   * types for melody". The overlap material is the outgoing track's own last-bar
   * lead line, so the no-invented-material law holds. Harmonically it is safe by
   * construction: the outgoing final bar is its V, the incoming pickup is ITS V,
   * and V-of-old into V-of-new into new-tonic is a falling-fifths chain.
   */
  let overlay: { notes: Array<number | null>; voice: VoiceName; played: number; steps: number } | null = null;
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
  let pendingSuite: { next: MusicTrackDef } | null = null;
  /**
   * Steps until another switch may fire. Review proved the pickup created a
   * PREMATURE boundary: it set stepsIntoCycle to the final bar, so the wrap one
   * bar later read as "cycle complete" and a queued track hijacked the suite
   * change -- the incoming suite played exactly its pickup bar and vanished. In
   * the single-bar-cycle case the clobber happened in the SAME step, so the
   * incoming suite never sounded at all while the ramp described a transition
   * to a track that had already been discarded. A switch now waits out the
   * pickup plus one full cycle of the track it delivered.
   */
  let switchLock = 0;

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
    // A suite change happens at the boundary, like any track switch -- but the
    // incoming track starts at its FINAL bar, its own dominant, as a pickup.
    // Real material from the incoming section; nothing composed in between.
    if (track && pendingSuite && stepsIntoCycle === 0 && switchLock <= 0) {
      const next = pendingSuite.next;
      const pickupSteps = next.barSteps;
      const startAtStep = Math.max(0, cycleSteps(next) - pickupSteps);
      ramp = {
        played: 0,
        steps: pickupSteps,
        fromStep: track.stepSeconds,
        toStep: next.stepSeconds,
      };
      // Capture the outgoing melody's final bar BEFORE the track is replaced:
      // an audible lead layer, its last outgoingBarSteps entries.
      overlay = null;
      const outgoingBar = track.barSteps > 0 ? track.barSteps : pickupSteps;
      for (let i = 0; i < track.tracks.length; i++) {
        const layer = track.tracks[i];
        if (layer.voice !== 'lead' || layer.intensity > intensity) continue;
        const notes = notesOf(i);
        if (notes.length < outgoingBar) continue;
        overlay = {
          notes: notes.slice(notes.length - outgoingBar),
          voice: layer.voice,
          played: 0,
          steps: pickupSteps,
        };
        break;
      }
      track = next;
      cursors = track.tracks.map(() => startAtStep);
      generated = track.tracks.map(() => null);
      chords = track.chords.map((c) => parseChord(c)).filter((c): c is Chord => !!c);
      stepsIntoCycle = startAtStep;
      switchLock = pickupSteps + cycleSteps(next);
      pendingSuite = null;
    }
    if (track && queued && stepsIntoCycle === 0 && switchLock <= 0) adoptQueued();
    if (track) {
      scheduleComposed(at);
      // The overlap: the outgoing melody's last bar rides over the pickup,
      // fading linearly, and is gone by the time the cycle proper starts.
      if (overlay) {
        const o = overlay;
        const hz = o.notes[o.played % o.notes.length];
        if (hz !== null) {
          const v = VOICES[o.voice];
          const fade = 1 - o.played / o.steps;
          note(hz, at, stepLength() * v.hold, v.peak * fade, v.type);
        }
        o.played += 1;
        if (o.played >= o.steps) overlay = null;
      }
      stepsIntoCycle = (stepsIntoCycle + 1) % cycleSteps(track);
      if (switchLock > 0) switchLock -= 1;
      if (ramp) {
        ramp.played += 1;
        if (ramp.played >= ramp.steps) ramp = null;
      }
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
    if (ramp) {
      const p = ramp.steps <= 1 ? 1 : ramp.played / (ramp.steps - 1);
      return ramp.fromStep + (ramp.toStep - ramp.fromStep) * Math.min(1, p);
    }
    return track ? track.stepSeconds : STEP_SECONDS;
  }

  /**
   * One step of the transition passage.
   *
   * Third design, each correcting a heard fault. The first collapsed the mix to
   * a bare pulse (heard as the music breaking). The second kept the outgoing
   * skeleton and dropped a HELD TRIAD PAD over it -- Austin: "sloppy and
   * sudden" -- and it was: the pad was a texture nothing in these pieces uses,
   * and the outgoing pads went on playing the OLD harmony underneath it, two
   * keys at once.
   *
   * Now the passage speaks the music's own vocabulary and one harmony only:
   * the outgoing bass RHYTHM continues, repitched onto the dominant root with
   * its octave contour preserved, and the dominant is ARPEGGIATED in the pluck
   * voice -- motion, not a slab. Nothing else sounds: pulse continuity without
   * harmonic mush.
   */
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
      // A transition must not survive a stop: the ramp is anchored to a clock
      // that stops meaning anything, the overlay's moment has passed, and a
      // queued switch belongs to the session that queued it. Review found
      // inTransition() reporting true indefinitely after a mid-ramp stop.
      ramp = null;
      overlay = null;
      pendingSuite = null;
      queued = null;
      switchLock = 0;
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
    changeSuite(next: MusicTrackDef): void {
      pendingSuite = { next };
    },
    inTransition(): boolean {
      // pendingSuite too: between changeSuite() and the boundary the change is
      // committed but not yet audible, and callers asking "is a change in
      // flight" mean that window as well.
      return ramp !== null || pendingSuite !== null;
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
