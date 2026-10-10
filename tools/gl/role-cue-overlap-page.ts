/**
 * The full role-cue overlap table (issue #1018), run in a real browser by
 * `node tools/gl/role-cue-overlap.mjs`. A measurement, not a gate: it asserts nothing about the
 * cue and publishes what it measured, with the two controls and the staging guard beside it.
 * See `role-cue-cells.ts` for what each effect is and how it is removed.
 *
 * Axes, fixed before the first run: kind and lever (the four `LEVER_PAIRS`, plus the
 * `ZERO_BY_CONSTRUCTION` pairs as checks), event (`fire`, `fire-blocked`), preset (`high`,
 * `medium`; `low` builds no smoke), motion (full, reduced), and the five `SAMPLE_TICKS`. Effects:
 * smoke on both events; the particle burst and smoke-plus-burst on `fire` only, since a refusal
 * spawns no burst. One axis was added after that run: `pose` (see `CuePose`). The pairs moved
 * after the published #1018 run: issue #1059 gated the riser on MINE_LAYER, so brown's riser
 * became a zero-by-construction check and grey, which holds it, took brown's place as a carrier.
 */
import {
  CUE_KINDS,
  LEVER_PAIRS,
  SAMPLE_TICKS,
  ZERO_BY_CONSTRUCTION,
  cell,
  colours,
  createCueRig,
  differing,
  isZeroByConstruction,
  patched,
  type CellResult,
  type CueEffect,
  type CueEvent,
  type CueKind,
  type CueLever,
  type CueMotion,
  type CuePose,
  type CueRig,
} from './role-cue-cells';

const params = new URLSearchParams(location.search);
const PRESETS = (params.get('presets') ?? 'high,medium').split(',') as ('high' | 'medium')[];
const MOTIONS = (params.get('motions') ?? 'full,reduced').split(',') as CueMotion[];
const POSES = (params.get('poses') ?? 'east,toward-camera').split(',') as CuePose[];
const TICKS = params.has('ticks') ? params.get('ticks')!.split(',').map(Number) : [...SAMPLE_TICKS];
const WIDTH = Number(params.get('w') ?? 320);
const HEIGHT = Number(params.get('h') ?? 240);
const KINDS: readonly CueKind[] = CUE_KINDS;
const EVENTS: CueEvent[] = ['fire', 'fire-blocked'];

/**
 * `dump=<kind>,<event>,<tick>`: keep that sequence's frames as PNGs, so a person can see what a
 * cell measured -- the armed and unarmed frames with no effect and with smoke plus burst (or
 * smoke alone on a refusal), for both levers, at every preset, motion and pose the run covers.
 */
const DUMP = params.get('dump')?.split(',') ?? null;
const dumps: Record<string, string> = {};
function png(frame: Uint8ClampedArray): string {
  const c = document.createElement('canvas');
  c.width = WIDTH;
  c.height = HEIGHT;
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame), WIDTH, HEIGHT), 0, 0);
  return c.toDataURL('image/png');
}

export interface Row extends CellResult {
  kind: CueKind;
  lever: CueLever;
  event: CueEvent;
  preset: 'high' | 'medium';
  motion: CueMotion;
  pose: CuePose;
  effect: CueEffect;
  tick: number;
}
export interface Control {
  name: string;
  preset: string;
  motion: string;
  pose: string;
  detail: string;
  pass: boolean;
}

type Frames = Uint8ClampedArray[];
const rows: Row[] = [];
const controls: Control[] = [];
const page = window as unknown as { __roleCue?: unknown; __roleCueError?: string };

async function measure(): Promise<void> {
  for (const preset of PRESETS) {
    for (const motion of MOTIONS) {
      const rig = (lever: CueLever | null, smoke: boolean): CueRig =>
        createCueRig({ lever, preset, smoke, motion, width: WIDTH, height: HEIGHT });
      // Two unarmed renderers per smoke setting: the second is the first control's other half.
      const rigs = {
        noneOff: rig(null, false), noneOff2: rig(null, false),
        noneOn: rig(null, true), noneOn2: rig(null, true),
        flareOff: rig('flare', false), flareOn: rig('flare', true),
        riserOff: rig('riser', false), riserOn: rig('riser', true),
      };
      // A discarded warm-up per renderer, the existing enemyRole check's lesson: the first capture
      // on a fresh context can race presentation and read back a cleared buffer.
      for (const r of Object.values(rigs)) await r.sequence('brown', 'fire-blocked', false, [0]);

      for (const pose of POSES) {
        for (const kind of KINDS) {
          for (const event of EVENTS) {
            console.log(`[role-cue] ${preset} ${motion} ${pose} ${kind} ${event}`);
            await measureSequence(rigs, preset, motion, pose, kind, event);
          }
        }
      }
      for (const r of Object.values(rigs)) r.dispose();
    }
  }

  // The staging guard: every pair's no-effect footprint is nonzero in every sampled cell, and
  // every zero-by-construction pair's is 0 in every one. Each also needs cells to exist: a pair
  // whose kind the run never built has none, and a check over no cells passes by default.
  for (const { kind, lever } of LEVER_PAIRS) {
    const cells = rows.filter((r) => r.kind === kind && r.lever === lever);
    const empty = cells.filter((r) => r.footprint === 0);
    controls.push({
      name: `staging guard: ${kind} ${lever} footprint nonzero`, preset: 'all', motion: 'all', pose: 'all',
      pass: cells.length > 0 && empty.length === 0, detail: `${empty.length} of ${cells.length} cells with an empty footprint`,
    });
  }
  for (const { kind, lever } of ZERO_BY_CONSTRUCTION) {
    const cells = rows.filter((r) => r.kind === kind && r.lever === lever);
    const nonzero = cells.filter((r) => r.footprint !== 0);
    controls.push({
      name: `check: ${kind} ${lever} footprint is 0 by construction`, preset: 'all', motion: 'all', pose: 'all',
      pass: cells.length > 0 && nonzero.length === 0, detail: `${nonzero.length} of ${cells.length} cells with a nonzero footprint`,
    });
  }
}

async function measureSequence(
  rigs: Record<string, CueRig>,
  preset: 'high' | 'medium',
  motion: CueMotion,
  pose: CuePose,
  kind: CueKind,
  event: CueEvent,
): Promise<void> {
  const where = { preset, motion, pose };
  const bursts = event === 'fire' ? [false, true] : [false];
  const got: Record<string, Record<string, Frames>> = {};
  // Every renderer runs the same sequences in the same order, so each pair compared below has the
  // same history behind it.
  for (const [key, r] of Object.entries(rigs)) {
    got[key] = {};
    for (const burst of bursts) got[key][String(burst)] = await r.sequence(kind, event, burst, TICKS, pose);
  }
  for (const frames of Object.values(got).flatMap((g) => Object.values(g))) {
    for (const f of frames) {
      if (colours(f) < 8) throw new Error(`a cleared buffer (${colours(f)} colours) in ${preset}/${motion}/${pose}/${kind}/${event}`);
    }
  }
  if (DUMP && DUMP[0] === kind && DUMP[1] === event && TICKS.includes(Number(DUMP[2]))) {
    const t = TICKS.indexOf(Number(DUMP[2]));
    const fx = event === 'fire' ? 'true' : 'false';
    const tag = `${preset}-${motion}-${pose}`;
    for (const key of ['noneOff', 'flareOff', 'riserOff']) dumps[`${tag}-${key}-none`] = png(got[key].false[t]);
    for (const key of ['noneOn', 'flareOn', 'riserOn']) dumps[`${tag}-${key}-effect`] = png(got[key][fx][t]);
  }
  // Control (i): two unarmed renderers under the same effect agree to the pixel, at every tick.
  for (const [a, b, label] of [['noneOff', 'noneOff2', 'no effect'], ['noneOn', 'noneOn2', 'smoke']] as const) {
    for (const burst of bursts) {
      const worst = Math.max(...TICKS.map((_, t) => differing(got[a][String(burst)][t], got[b][String(burst)][t]).length));
      controls.push({
        ...where, name: `unarmed vs unarmed, ${kind} ${event}, ${label}${burst ? ' + burst' : ''}`,
        pass: worst === 0, detail: `${worst} differing pixels at the worst tick`,
      });
    }
  }
  // The smoke is drawn at the muzzle with the event's pos off the board, so it does not follow
  // `pos`: the frame with smoke differs from the frame without it inside the cloud's life.
  {
    const t = TICKS.indexOf(6) >= 0 ? TICKS.indexOf(6) : 0;
    const smokeAtMuzzle = differing(got.noneOn.false[t], got.noneOff.false[t]).length;
    controls.push({
      ...where, name: `smoke drawn with pos off the board, ${kind} ${event}`,
      pass: smokeAtMuzzle > 0, detail: `${smokeAtMuzzle} pixels differ with the smoke on`,
    });
  }
  const pairs = [...LEVER_PAIRS, ...ZERO_BY_CONSTRUCTION].filter((p) => p.kind === kind);
  for (const { lever } of pairs) {
    const off = lever === 'flare' ? got.flareOff : got.riserOff;
    const on = lever === 'flare' ? got.flareOn : got.riserOn;
    const effects: { effect: CueEffect; armed: Frames; unarmed: Frames }[] = [
      { effect: 'smoke', armed: on.false, unarmed: got.noneOn.false },
    ];
    if (event === 'fire') {
      effects.push({ effect: 'burst', armed: off.true, unarmed: got.noneOff.true });
      effects.push({ effect: 'both', armed: on.true, unarmed: got.noneOn.true });
    }
    for (const { effect, armed, unarmed } of effects) {
      TICKS.forEach((tick, t) => {
        rows.push({ kind, lever, event, ...where, effect, tick, ...cell(off.false[t], got.noneOff.false[t], armed[t], unarmed[t]) });
      });
    }
    // Control (ii): an opaque patch over the footprint, in both frames, reads ~0 retained.
    if (!isZeroByConstruction(kind, lever)) {
      const footprint = differing(off.false[0], got.noneOff.false[0]);
      const res = cell(off.false[0], got.noneOff.false[0], patched(on.false[0], footprint), patched(got.noneOn.false[0], footprint));
      controls.push({
        ...where, name: `opaque patch over the footprint, ${kind} ${lever} ${event}`,
        pass: res.retainedFraction !== null && res.retainedFraction < 0.01,
        detail: `retained ${res.retained} of ${res.footprint}`,
      });
    }
  }
}

// Published either way, so the runner never waits out its ceiling on a page that threw.
measure().then(
  () => { page.__roleCue = { rows, controls, ticks: TICKS, width: WIDTH, height: HEIGHT, dumps }; },
  (e: unknown) => { page.__roleCueError = e instanceof Error ? `${e.message}\n${e.stack}` : String(e); },
);
