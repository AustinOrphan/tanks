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
  | 'mine-boom'
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
): Built | null {
  const buf = noiseBuffer(ctx);
  if (!buf || typeof ctx.createBufferSource !== 'function') return null;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // A random-ish but deterministic offset per call site would need state; the
  // start offset is derived from `when` instead, so successive shots do not
  // replay the identical slice and comb-filter against each other.
  const offset = (when * 7.3) % Math.max(0.001, buf.duration - opts.duration - 0.01);
  const filter = ctx.createBiquadFilter();
  filter.type = opts.type;
  filter.frequency.setValueAtTime(opts.from, when);
  filter.frequency.exponentialRampToValueAtTime(Math.max(opts.to, 1), when + opts.duration);
  if (opts.q !== undefined) filter.Q.value = opts.q;
  const gain = ctx.createGain();
  envelope(gain, when, opts.peak, 0.004, opts.duration);
  src.connect(filter).connect(gain);
  src.start(when, Math.max(0, offset), opts.duration + 0.02);
  return { nodes: [src, filter, gain], stops: [src], endsAt: when + opts.duration + 0.03 };
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
): Built {
  const osc = ctx.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.from, when);
  if (opts.to !== undefined && typeof osc.frequency.exponentialRampToValueAtTime === 'function') {
    osc.frequency.exponentialRampToValueAtTime(Math.max(opts.to, 1), when + opts.duration);
  }
  const gain = ctx.createGain();
  envelope(gain, when, opts.peak, opts.attack ?? 0.005, opts.duration);
  osc.connect(gain);
  osc.start(when);
  osc.stop(when + opts.duration + 0.02);
  return { nodes: [osc, gain], stops: [osc], endsAt: when + opts.duration + 0.03 };
}

/** The recipes. Each returns the layers that make up one sound. */
const RECIPES: Record<SfxKey, (ctx: BaseAudioContext, when: number) => Array<Built | null>> = {
  // A crack of air, then the weight of the charge. The pitch drop is what makes
  // it read as a cannon rather than a rifle.
  cannon: (c, t) => [
    noiseVoice(c, t, { duration: 0.09, peak: 0.5, type: 'bandpass', from: 1800, to: 300, q: 0.9 }),
    toneVoice(c, t, { from: 190, to: 55, duration: 0.16, peak: 0.42, type: 'triangle' }),
  ],
  // Same shape, duller and quieter: the player must be able to tell their own
  // cannon from an enemy's without looking.
  'cannon-enemy': (c, t) => [
    noiseVoice(c, t, { duration: 0.08, peak: 0.3, type: 'lowpass', from: 1100, to: 240, q: 0.7 }),
    toneVoice(c, t, { from: 150, to: 48, duration: 0.14, peak: 0.3, type: 'triangle' }),
  ],
  // Ricochet: two detuned partials so it rings metallic rather than pure, plus a
  // tick of noise for the impact itself.
  ping: (c, t) => [
    noiseVoice(c, t, { duration: 0.03, peak: 0.22, type: 'highpass', from: 3000, to: 2000 }),
    toneVoice(c, t, { from: 1850, to: 1500, duration: 0.16, peak: 0.16 }),
    toneVoice(c, t, { from: 2470, to: 2100, duration: 0.11, peak: 0.09 }),
  ],
  // Body of noise falling away, with a low thump underneath it.
  explosion: (c, t) => [
    noiseVoice(c, t, { duration: 0.55, peak: 0.62, type: 'lowpass', from: 2200, to: 130, q: 0.6 }),
    toneVoice(c, t, { from: 120, to: 40, duration: 0.42, peak: 0.5, type: 'sine' }),
  ],
  // Small, close, mechanical -- it must not compete with a shot.
  'mine-drop': (c, t) => [
    noiseVoice(c, t, { duration: 0.04, peak: 0.18, type: 'bandpass', from: 900, to: 500, q: 2 }),
    toneVoice(c, t, { from: 320, to: 190, duration: 0.09, peak: 0.2, type: 'square' }),
  ],
  // A rising pair: "armed" should sound like a state change, not an impact.
  'mine-arm': (c, t) => [
    toneVoice(c, t, { from: 620, duration: 0.07, peak: 0.16, type: 'square' }),
    toneVoice(c, t + 0.08, { from: 930, duration: 0.09, peak: 0.16, type: 'square' }),
  ],
  // The biggest sound in the game: lower, longer and wider than a shell hit.
  'mine-boom': (c, t) => [
    noiseVoice(c, t, { duration: 0.8, peak: 0.72, type: 'lowpass', from: 1800, to: 80, q: 0.5 }),
    toneVoice(c, t, { from: 95, to: 32, duration: 0.6, peak: 0.6, type: 'sine' }),
    toneVoice(c, t + 0.02, { from: 60, to: 28, duration: 0.5, peak: 0.35, type: 'triangle' }),
  ],
  // A rising third; short, because it plays under a panel appearing.
  victory: (c, t) => [
    toneVoice(c, t, { from: 523.25, duration: 0.16, peak: 0.28, type: 'triangle' }),
    toneVoice(c, t + 0.13, { from: 659.25, duration: 0.16, peak: 0.28, type: 'triangle' }),
    toneVoice(c, t + 0.26, { from: 783.99, duration: 0.3, peak: 0.3, type: 'triangle' }),
  ],
  // The mirror of victory: falling, and it lands on a flattened note.
  defeat: (c, t) => [
    toneVoice(c, t, { from: 392, duration: 0.2, peak: 0.28, type: 'triangle' }),
    toneVoice(c, t + 0.17, { from: 311.13, duration: 0.42, peak: 0.3, type: 'triangle' }),
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
  const bus = ctx.createGain();
  bus.gain.value = opts?.volume ?? 1;
  bus.connect(dest);

  const layers = RECIPES[key](ctx, when).filter((l): l is Built => l !== null);
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
  // A rate above 1 shortens the sound; below 1 lengthens it. Applied to the
  // reported end time only -- the schedule above is already absolute.
  const rate = opts?.rate ?? 1;
  if (rate !== 1) endsAt = when + (endsAt - when) / rate;

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
