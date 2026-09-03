/**
 * The game's sounds, synthesised.
 *
 * There are no audio assets and, per CREDITS.md, there will not be AI-generated
 * ones and no samples of unverified licence. So the sounds are AUTHORED HERE as
 * Web Audio graphs: nothing to licence, nothing to download, a few hundred bytes
 * of code instead of a megabyte of wav, and every sound is a pure function of its
 * key. If real samples are ever sourced, `engine.ts` prefers a loaded Howl and
 * this stays as the fallback -- the two paths are interchangeable by design.
 *
 * Each voice is built from three primitives, which is enough for everything a
 * tank game needs:
 *
 *   - a NOISE burst through a filter, for anything that is air or debris
 *     (explosions, the crack of a muzzle),
 *   - a PITCHED body with a falling envelope, for weight (the thump under a
 *     blast, the ring of a ricochet),
 *   - a short CLICK transient, which is most of what makes a hit read as
 *     percussive rather than as a tone.
 *
 * Every node is disconnected when the voice ends: this is the only path that
 * makes sound today, so a leak here is a leak on every shot fired.
 */

/** One synthesised sound, already wired to `dest`. */
export interface Voice {
  /** Audio-clock time the voice is finished and safe to tear down. */
  readonly endsAt: number;
  /** Idempotent: disconnects every node this voice created. */
  release(): void;
}

/** The keys `synthVoice` knows. Anything else falls back to a plain blip. */
export type SfxKey =
  | 'cannon'
  | 'cannon-enemy'
  | 'ping'
  | 'explosion'
  | 'mine-drop'
  | 'mine-arm'
  | 'mine-fuse-warn'
  | 'mine-trip'
  | 'mine-boom'
  | 'fire-blocked'
  | 'fire-blocked-click'
  | 'victory'
  | 'defeat';

/**
 * A second of mono white noise, built once per context and shared by every
 * noise voice. Regenerating it per shot is the single most expensive thing this
 * module could do; an explosion needs ~0.6s of it and a cannon ~0.08s, so one
 * buffer read from a random offset covers both without correlation artefacts.
 */
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer | null {
  const cached = noiseCache.get(ctx);
  if (cached) return cached;
  if (typeof ctx.createBuffer !== 'function') return null;
  const rate = ctx.sampleRate || 44100;
  const buf = ctx.createBuffer(1, Math.floor(rate), rate);
  const data = buf.getChannelData(0);
  // Deterministic xorshift rather than Math.random: two runs of the game make
  // the same noise, which is what lets a test compare renders at all.
  let x = 0x9e3779b9;
  for (let i = 0; i < data.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = ((x >>> 0) / 0xffffffff) * 2 - 1;
  }
  noiseCache.set(ctx, buf);
  return buf;
}

interface Built {
  nodes: AudioNode[];
  stops: Array<{ stop(when: number): void }>;
  endsAt: number;
}

/** Envelope helper: attack to `peak`, then an exponential fall to silence. */
function envelope(
  gain: GainNode,
  when: number,
  peak: number,
  attack: number,
  decay: number,
): void {
  const g = gain.gain;
  // exponentialRamp cannot reach or start from 0, hence the small floor.
  g.setValueAtTime(0.0001, when);
  g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
  g.exponentialRampToValueAtTime(0.0001, when + attack + decay);
}

function noiseVoice(
  ctx: BaseAudioContext,
  when: number,
  opts: {
    duration: number;
    peak: number;
    type: BiquadFilterType;
    from: number;
    to: number;
    q?: number;
  },
  rate = 1,
): Built | null {
  const buf = noiseBuffer(ctx);
  if (!buf || typeof ctx.createBufferSource !== 'function') return null;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // A random-ish but deterministic offset per call site would need state; the
  // start offset is derived from `when` instead, so successive shots do not
  // replay the identical slice and comb-filter against each other.
  // Playback rate, as it means for a sample: brighter AND shorter.
  const dur = opts.duration / rate;
  const offset = (when * 7.3) % Math.max(0.001, buf.duration - dur - 0.01);
  const filter = ctx.createBiquadFilter();
  filter.type = opts.type;
  filter.frequency.setValueAtTime(opts.from * rate, when);
  filter.frequency.exponentialRampToValueAtTime(Math.max(opts.to * rate, 1), when + dur);
  if (opts.q !== undefined) filter.Q.value = opts.q;
  const gain = ctx.createGain();
  envelope(gain, when, opts.peak, 0.004, dur);
  src.connect(filter).connect(gain);
  src.start(when, Math.max(0, offset), dur + 0.02);
  return { nodes: [src, filter, gain], stops: [src], endsAt: when + dur + 0.03 };
}

function toneVoice(
  ctx: BaseAudioContext,
  when: number,
  opts: {
    from: number;
    to?: number;
    duration: number;
    peak: number;
    type?: OscillatorType;
    attack?: number;
  },
  rate = 1,
): Built {
  const dur = opts.duration / rate;
  const osc = ctx.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.from * rate, when);
  if (opts.to !== undefined && typeof osc.frequency.exponentialRampToValueAtTime === 'function') {
    osc.frequency.exponentialRampToValueAtTime(Math.max(opts.to * rate, 1), when + dur);
  }
  const gain = ctx.createGain();
  envelope(gain, when, opts.peak, (opts.attack ?? 0.005) / rate, dur);
  osc.connect(gain);
  osc.start(when);
  osc.stop(when + dur + 0.02);
  return { nodes: [osc, gain], stops: [osc], endsAt: when + dur + 0.03 };
}

/** The recipes. Each returns the layers that make up one sound. */
const RECIPES: Record<
  SfxKey,
  (ctx: BaseAudioContext, when: number, rate: number) => Array<Built | null>
> = {
  // A crack of air, then the weight of the charge. The pitch drop is what makes
  // it read as a cannon rather than a rifle.
  cannon: (c, t, r) => [
    noiseVoice(c, t, { duration: 0.09, peak: 0.5, type: 'bandpass', from: 1800, to: 300, q: 0.9 }, r),
    toneVoice(c, t, { from: 190, to: 55, duration: 0.16, peak: 0.42, type: 'triangle' }, r),
  ],
  // Same shape, duller and quieter: the player must be able to tell their own
  // cannon from an enemy's without looking.
  'cannon-enemy': (c, t, r) => [
    noiseVoice(c, t, { duration: 0.08, peak: 0.3, type: 'lowpass', from: 1100, to: 240, q: 0.7 }, r),
    toneVoice(c, t, { from: 150, to: 48, duration: 0.14, peak: 0.3, type: 'triangle' }, r),
  ],
  // Ricochet: two detuned partials so it rings metallic rather than pure, plus a
  // tick of noise for the impact itself.
  ping: (c, t, r) => [
    noiseVoice(c, t, { duration: 0.03, peak: 0.22, type: 'highpass', from: 3000, to: 2000 }, r),
    toneVoice(c, t, { from: 1850, to: 1500, duration: 0.16, peak: 0.16 }, r),
    toneVoice(c, t, { from: 2470, to: 2100, duration: 0.11, peak: 0.09 }, r),
  ],
  // Body of noise falling away, with a low thump underneath it.
  explosion: (c, t, r) => [
    noiseVoice(c, t, { duration: 0.55, peak: 0.62, type: 'lowpass', from: 2200, to: 130, q: 0.6 }, r),
    toneVoice(c, t, { from: 120, to: 40, duration: 0.42, peak: 0.5, type: 'sine' }, r),
  ],
  // Small, close, mechanical -- it must not compete with a shot.
  'mine-drop': (c, t, r) => [
    noiseVoice(c, t, { duration: 0.04, peak: 0.18, type: 'bandpass', from: 900, to: 500, q: 2 }, r),
    toneVoice(c, t, { from: 320, to: 190, duration: 0.09, peak: 0.2, type: 'square' }, r),
  ],
  /**
   * Issue #356's audio candidate: the cannon refusing to fire.
   *
   * A DRY MECHANICAL CLICK, in the issue's own words. Deliberately built as the negative
   * of `cannon`: no low body, no tail, and a tenth of the peak, so it reads as the
   * mechanism catching rather than as a weak shot. A blocked shot that sounded like a
   * quiet shot would be worse than silence -- the player would think they had fired.
   *
   * Two very short elements: a high filtered tick (the sear) and a low square blip (the
   * mechanism seating). Both well under the 0.09 s a cannon runs for.
   *
   * TIMBRE IS PROVISIONAL and wants an ear on it, the same caveat `mine-fuse-warn`
   * carries. That this fires exactly when the cap refuses a shot, and never otherwise, is
   * pinned by tests; that this is the RIGHT click is not a claim a test can make -- which
   * is why it ships behind `?dev=1&blockedFire=audio` alongside the other candidates
   * rather than as the adopted cue.
   */
  'fire-blocked': (c, t, r) => [
    noiseVoice(c, t, { duration: 0.018, peak: 0.09, type: 'highpass', from: 4200, to: 3000 }, r),
    toneVoice(c, t, { from: 210, to: 150, duration: 0.03, peak: 0.07, type: 'square' }, r),
  ],
  /**
   * Issue #516's `click` arm: the refusal with its BODY REMOVED.
   *
   * The one arm in that matrix that cannot be produced by varying an existing cue, and
   * the reason is structural rather than a matter of taste: #516 asks for "a short dry
   * mechanical click, NO TONE", and no playback rate or gain removes a layer. So this is
   * the `fire-blocked` recipe minus its square blip -- a single 12 ms band of filtered
   * noise, nothing oscillating anywhere in the graph. The other three audio arms are
   * `rate`/`volume` variations of a cue that already exists (director.ts).
   *
   * Deliberately the ONLY single-layer recipe here. Every other sound in this file is
   * two or three layers because a single oscillator is the old beep; this one is one
   * layer because the absent layer IS the design, and synth.test.ts pins that it builds
   * no oscillator at all rather than merely a quiet one.
   *
   * TIMBRE IS PROVISIONAL, like every cue here, and nobody has heard it: it ships behind
   * `?dev=1&blockedFire=click` as one candidate among five, not as the adopted sound.
   */
  'fire-blocked-click': (c, t, r) => [
    noiseVoice(c, t, { duration: 0.012, peak: 0.11, type: 'highpass', from: 5200, to: 3800 }, r),
  ],
  // A rising pair: "armed" should sound like a state change, not an impact.
  'mine-arm': (c, t, r) => [
    toneVoice(c, t, { from: 620, duration: 0.07, peak: 0.16, type: 'square' }, r),
    toneVoice(c, t + 0.08 / r, { from: 930, duration: 0.09, peak: 0.16, type: 'square' }, r),
  ],
  /**
   * "Time is running out" (issue #276, `mine-fuse-warning`). A thin, high double tick --
   * a clock, not an impact -- so it sits above the mix without competing with a shot.
   *
   * ONE-SHOT on purpose. The sim latches this event once, when the fuse crosses into its
   * final window, and the ONGOING urgency is carried by the ring's accelerating blink. A
   * repeating beep would have to be driven by the presentation layer's own clock, which is
   * both a spam risk with several mines down and the sort of feedback loop the render layer
   * is not allowed to have.
   *
   * TIMBRE IS PROVISIONAL and wants an ear on it. The alignment and the one-shot behaviour
   * are pinned by tests; that this is the RIGHT sound is not a claim measurement can make.
   */
  'mine-fuse-warn': (c, t, r) => [
    toneVoice(c, t, { from: 1560, duration: 0.045, peak: 0.13, type: 'square' }, r),
    toneVoice(c, t + 0.075 / r, { from: 1560, duration: 0.045, peak: 0.13, type: 'square' }, r),
  ],
  /**
   * "You tripped this" (issue #276, `mine-triggered`). Deliberately the INVERSE of
   * 'mine-arm': that one rises 620 -> 930 to say a mine became dangerous, this one falls to
   * say a dangerous mine is now committed to going off. Two cues about the same object that
   * must never be confused, so they move in opposite directions rather than differing only
   * in pitch. Also provisional in timbre.
   */
  'mine-trip': (c, t, r) => [
    toneVoice(c, t, { from: 880, to: 300, duration: 0.14, peak: 0.24, type: 'square' }, r),
    noiseVoice(c, t, { duration: 0.05, peak: 0.16, type: 'bandpass', from: 1400, to: 700, q: 2 }, r),
  ],
  // The biggest sound in the game: lower, longer and wider than a shell hit.
  'mine-boom': (c, t, r) => [
    noiseVoice(c, t, { duration: 0.8, peak: 0.72, type: 'lowpass', from: 1800, to: 80, q: 0.5 }, r),
    toneVoice(c, t, { from: 95, to: 32, duration: 0.6, peak: 0.6, type: 'sine' }, r),
    toneVoice(c, t + 0.02 / r, { from: 60, to: 28, duration: 0.5, peak: 0.35, type: 'triangle' }, r),
  ],
  // A rising third; short, because it plays under a panel appearing.
  victory: (c, t, r) => [
    toneVoice(c, t, { from: 523.25, duration: 0.16, peak: 0.28, type: 'triangle' }, r),
    toneVoice(c, t + 0.13 / r, { from: 659.25, duration: 0.16, peak: 0.28, type: 'triangle' }, r),
    toneVoice(c, t + 0.26 / r, { from: 783.99, duration: 0.3, peak: 0.3, type: 'triangle' }, r),
  ],
  // The mirror of victory: falling, and it lands on a flattened note.
  defeat: (c, t, r) => [
    toneVoice(c, t, { from: 392, duration: 0.2, peak: 0.28, type: 'triangle' }, r),
    toneVoice(c, t + 0.17 / r, { from: 311.13, duration: 0.42, peak: 0.3, type: 'triangle' }, r),
  ],
};

export function isSfxKey(key: string): key is SfxKey {
  return key in RECIPES;
}

/**
 * Whether this context can run the recipes at all.
 *
 * Every recipe schedules on AudioParams and most need filtered noise, so a
 * context missing any of that cannot produce these sounds. Checked UP FRONT and
 * as a whole rather than per-node: a partial build would leave half a voice
 * connected and then throw from inside the engine's play path, turning a missing
 * capability into a broken game. Returning false here lets `engine.ts` fall back
 * to its plain beep, which needs only an oscillator and a gain.
 */
function canSynthesise(ctx: BaseAudioContext): boolean {
  if (
    typeof ctx.createGain !== 'function' ||
    typeof ctx.createOscillator !== 'function' ||
    typeof ctx.createBuffer !== 'function' ||
    typeof ctx.createBufferSource !== 'function' ||
    typeof ctx.createBiquadFilter !== 'function'
  ) {
    return false;
  }
  // AudioParam scheduling is the other half: a fake with the factory methods but
  // plain-value params (as the engine's own fallback test uses) would throw on
  // the first envelope.
  const probe = ctx.createGain();
  const ok =
    typeof probe.gain?.setValueAtTime === 'function' &&
    typeof probe.gain?.exponentialRampToValueAtTime === 'function';
  try {
    probe.disconnect();
  } catch {
    // Never connected; nothing to undo.
  }
  return ok;
}

/**
 * Build one sound, connected to `dest`. Returns null when the context cannot
 * support it (a bare test fake, or an environment without Web Audio), so the
 * caller can fall back rather than throw.
 *
 * `volume` scales the whole voice; `rate` shifts it in time (a faster rate is a
 * shorter, brighter sound) by scaling every layer's duration.
 */
export function synthVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  key: string,
  when: number,
  opts?: { rate?: number; volume?: number },
): Voice | null {
  if (!isSfxKey(key)) return null;
  if (!canSynthesise(ctx)) return null;
  // Rate is applied INSIDE the recipes (frequencies up, durations down), which
  // is what the audio director's ricochet ladder depends on: each bounce plays
  // the same ping a step higher. Scaling only the reported end time, as an
  // earlier version did, made every bounce sound identical.
  const rate = opts?.rate ?? 1;
  const bus = ctx.createGain();
  bus.gain.value = opts?.volume ?? 1;
  bus.connect(dest);

  const layers = RECIPES[key](ctx, when, rate).filter((l): l is Built => l !== null);
  if (layers.length === 0) {
    bus.disconnect();
    return null;
  }
  const nodes: AudioNode[] = [bus];
  let endsAt = when;
  for (const layer of layers) {
    // Each layer's last node is its gain; route them all into the voice bus.
    layer.nodes[layer.nodes.length - 1].connect(bus);
    nodes.push(...layer.nodes);
    endsAt = Math.max(endsAt, layer.endsAt);
  }

  let released = false;
  return {
    endsAt,
    release(): void {
      if (released) return;
      released = true;
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          // Already disconnected, or the context closed under us.
        }
      }
    },
  };
}
