/**
 * Seeded generated scenarios with structural invariants (issue #760).
 *
 * WHAT THIS IS. Hand-authored tests pin the combinations a maintainer thought of. This
 * builds legal worlds from an explicit seed -- a shipped arena, a mode and player count the
 * catalogs allow, rule values a world can be created with -- drives them for a bounded
 * number of ticks through `stepInputs`, the entry point the game itself uses, and checks
 * structural invariants after every tick. A failure names the seed, the resolved scenario,
 * the tick and the invariant, and prints the command that reruns exactly that case.
 *
 * WHAT IT IS NOT. It never builds a world by hand, never steps a second simulation path, and
 * asserts nothing about balance or feel. It is testing infrastructure: nothing in the game
 * imports it. Pure like the rest of `src/sim/`: seeded randomness only, no wall clock.
 *
 * The required-CI corpus is `generated-scenarios.test.ts`; the deeper on-demand sweep is
 * `generated-scenarios.measure.test.ts`. Commands and runtime budgets are in
 * docs/agent/commands-and-operations.md.
 */
import { arenaById } from './config/arenas';
import { CAMPAIGN_ARENA_DEFS } from './config/campaign';
import { VERSUS_CATALOG } from './config/versus-catalog';
import { configFor } from './config/roster';
import { bulletConfig } from './constants';
import { createWorldFor } from './arena';
import { stepInputs, type World } from './world';
import { createPlayerAiState, decidePlayerInput, mulberry32, type PlayerAiState } from './ai/player-profile';
import { worldFingerprint } from './fingerprint';
import type { SimEvent } from './events';
import type { AiTargetPerception, GameMode, InputState, UnarmedTrigger } from './types';

/**
 * How one player tank is driven. `ai` is the shipped player-profile bot; `scripted` is a
 * seeded walk through the whole input space, including fire and mine presses the rules must
 * refuse; `idle` sends the zero input every tick.
 */
export type ScenarioDriver = 'ai' | 'scripted' | 'idle';

/** Everything that determines a generated run. Printed whole on a failure. */
export interface ScenarioConfig {
  readonly seed: number;
  readonly ticks: number;
  readonly arenaId: string;
  readonly mode: GameMode;
  readonly playerCount: number;
  /** Versus stock; undefined in campaign-coop. */
  readonly stock?: number;
  readonly drivers: readonly ScenarioDriver[];
  readonly rules: {
    readonly unarmedTrigger: UnarmedTrigger;
    readonly friendlyFire: boolean;
    readonly corpseBlocksShells: boolean;
    readonly muzzleClearsTanks: boolean;
    readonly coopAttempts: boolean;
    readonly aiTargetPerception: AiTargetPerception;
  };
}

const UNARMED_TRIGGERS: readonly UnarmedTrigger[] = ['none', 'proximity', 'bullet', 'both'];
const PERCEPTIONS: readonly AiTargetPerception[] = ['full', 'line-of-sight'];
/** `ai` twice: the bot is the driver that produces fights, so it gets half the draws. */
const DRIVERS: readonly ScenarioDriver[] = ['ai', 'ai', 'scripted', 'idle'];

/** Ticks a run continues past the tick its status leaves 'playing', to watch the latch. */
export const TERMINAL_WATCH_TICKS = 30;

function pick<T>(rnd: () => number, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(rnd() * items.length))];
}

/**
 * The scenario a seed resolves to. A pure function of (seed, ticks): the same arguments give
 * the same scenario on every run, which is what makes a reported seed a reproduction.
 *
 * Legal by construction. Campaign-coop draws from the campaign's own arenas at 1 to 4
 * players. Versus draws an entry from the validated versus catalog, and only the player
 * counts and modes that entry lists.
 */
export function generateScenario(seed: number, ticks: number): ScenarioConfig {
  const rnd = mulberry32(seed);
  const versus = rnd() < 0.5;
  let arenaId: string;
  let mode: GameMode;
  let playerCount: number;
  let stock: number | undefined;
  if (versus) {
    const entry = pick(rnd, VERSUS_CATALOG);
    arenaId = entry.arenaId;
    mode = pick(rnd, entry.modes);
    playerCount = pick(rnd, entry.players);
    stock = 1 + Math.floor(rnd() * 5);
  } else {
    arenaId = pick(rnd, CAMPAIGN_ARENA_DEFS).id;
    mode = 'campaign-coop';
    playerCount = 1 + Math.floor(rnd() * 4);
  }
  const drivers = Array.from({ length: playerCount }, () => pick(rnd, DRIVERS));
  return {
    seed, ticks, arenaId, mode, playerCount, stock, drivers,
    rules: {
      unarmedTrigger: pick(rnd, UNARMED_TRIGGERS),
      friendlyFire: rnd() < 0.5,
      corpseBlocksShells: rnd() < 0.5,
      muzzleClearsTanks: rnd() < 0.5,
      coopAttempts: rnd() < 0.5,
      aiTargetPerception: pick(rnd, PERCEPTIONS),
    },
  };
}

/** The tick-0 world, built the way the game builds one. */
export function buildScenarioWorld(cfg: ScenarioConfig): World {
  return createWorldFor(arenaById(cfg.arenaId), cfg.seed, {
    playerCount: cfg.playerCount,
    stock: cfg.stock,
    rules: { ...cfg.rules, mode: cfg.mode },
  });
}

/** One broken invariant, located. */
export interface Violation {
  readonly tick: number;
  readonly invariant: InvariantName;
  readonly detail: string;
}

export type InvariantName =
  | 'finite-numbers'
  | 'unique-ids'
  | 'owners-exist'
  | 'no-resurrection'
  | 'tick-advances'
  | 'status-latched'
  | 'shell-cap'
  | 'mine-cap'
  | 'bounce-budget'
  | 'fire-legal';

/** What a run observed. */
export interface ScenarioRun {
  readonly config: ScenarioConfig;
  /** Violations of the first violating tick; empty when every tick held. */
  readonly violations: readonly Violation[];
  /**
   * One digest per simulated tick, over the world fingerprint AND that tick's events, so a
   * change in the order of either -- not only in a value -- moves it.
   */
  readonly digests: readonly number[];
  /** The tick the status left 'playing', or undefined if it never did. */
  readonly terminalTick?: number;
  readonly eventCounts: Readonly<Record<string, number>>;
}

/** Every number anywhere in `value` that is not finite, with its path. */
function nonFinite(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path} = ${value}`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) nonFinite(value[i], `${path}[${i}]`, out);
    return;
  }
  for (const [k, v] of Object.entries(value)) nonFinite(v, `${path}.${k}`, out);
}

/** What the checks remember across ticks. */
export interface InvariantMemory {
  /** Shell and mine ids that have left the world or died; neither may come back. */
  readonly retiredShells: Set<number>;
  readonly retiredMines: Set<number>;
}

export function createInvariantMemory(): InvariantMemory {
  return { retiredShells: new Set(), retiredMines: new Set() };
}

/**
 * The structural invariants, checked across one step: `prev` is the world handed to
 * `stepInputs`, `curr` the world it returned, `events` what it emitted. Records what later
 * ticks need in `memory`.
 */
export function checkTick(
  prev: World,
  curr: World,
  events: readonly SimEvent[],
  memory: InvariantMemory,
): Violation[] {
  const out: Violation[] = [];
  const tick = curr.tick;
  const fail = (invariant: InvariantName, detail: string): void => {
    out.push({ tick, invariant, detail });
  };

  // Every number in the world is finite -- the whole world, not a chosen list of fields, so
  // a field added later is covered without anyone remembering to add it here.
  const bad: string[] = [];
  nonFinite(curr, 'world', bad);
  if (bad.length > 0) fail('finite-numbers', bad.slice(0, 5).join('; '));

  // Ids are unique within each collection and were issued (below nextId); every shell and
  // mine names an owner that is a tank.
  const tankIds = new Set<number>();
  for (const t of curr.tanks) {
    if (tankIds.has(t.id)) fail('unique-ids', `tank id ${t.id} appears twice`);
    tankIds.add(t.id);
  }
  const collections = [['shell', curr.bullets], ['mine', curr.mines], ['blast', curr.blasts]] as const;
  for (const [name, list] of collections) {
    const seen = new Set<number>();
    for (const e of list) {
      if (seen.has(e.id)) fail('unique-ids', `${name} id ${e.id} appears twice`);
      seen.add(e.id);
      if (e.id >= curr.nextId) fail('unique-ids', `${name} id ${e.id} was never issued (nextId ${curr.nextId})`);
    }
  }
  for (const b of curr.bullets) {
    if (!tankIds.has(b.ownerId)) fail('owners-exist', `shell ${b.id} names owner ${b.ownerId}, which is not a tank`);
  }
  for (const m of curr.mines) {
    if (!tankIds.has(m.ownerId)) fail('owners-exist', `mine ${m.id} names owner ${m.ownerId}, which is not a tank`);
  }

  // Nothing comes back from the dead except by a rule that says so. A tank revives only with
  // a `respawn` event naming it, or with a round restart (resetArena moves roundStartTick).
  // A shell or mine that has left the world, or died, never returns.
  const respawned = new Set<number>();
  for (const e of events) if (e.type === 'respawn') respawned.add(e.tankId);
  const roundRestarted = curr.roundStartTick !== prev.roundStartTick;
  for (const t of curr.tanks) {
    const before = prev.tanks.find((p) => p.id === t.id);
    if (t.alive && before && !before.alive && !respawned.has(t.id) && !roundRestarted) {
      fail('no-resurrection', `tank ${t.id} is alive again with no respawn event and no round restart`);
    }
  }
  for (const b of curr.bullets) {
    if (b.alive && memory.retiredShells.has(b.id)) fail('no-resurrection', `shell ${b.id} is live again`);
  }
  for (const m of curr.mines) {
    if (memory.retiredMines.has(m.id)) fail('no-resurrection', `mine ${m.id} is back in the world`);
  }
  const liveShells = new Set<number>();
  for (const b of curr.bullets) {
    if (b.alive) liveShells.add(b.id);
    else memory.retiredShells.add(b.id);
  }
  for (const b of prev.bullets) if (!liveShells.has(b.id)) memory.retiredShells.add(b.id);
  const minesNow = new Set(curr.mines.map((m) => m.id));
  for (const m of prev.mines) if (!minesNow.has(m.id)) memory.retiredMines.add(m.id);

  // Phase transitions: every step advances the clock by exactly one tick, and a finished
  // game stays finished.
  if (curr.tick !== prev.tick + 1) fail('tick-advances', `tick went from ${prev.tick} to ${curr.tick}`);
  if (prev.status !== 'playing' && curr.status !== prev.status) {
    fail('status-latched', `status went from ${prev.status} to ${curr.status}`);
  }

  // Populations stay inside their authoritative caps: the same expressions the gates read
  // (bullets.ts shellCapReached, mines.ts), and the shell type's bounce budget.
  for (const t of curr.tanks) {
    const cfg = configFor(t.kind);
    let shells = 0;
    for (const b of curr.bullets) if (b.alive && b.ownerId === t.id) shells++;
    const shellCap = t.shellCap ?? cfg.weapon.maxActiveProjectiles;
    if (shells > shellCap) fail('shell-cap', `tank ${t.id} has ${shells} live shells, cap ${shellCap}`);
    const mineCap = t.mineCap ?? cfg.mineCapacity;
    if (t.activeMineIds.length > mineCap) {
      fail('mine-cap', `tank ${t.id} holds ${t.activeMineIds.length} mines, cap ${mineCap}`);
    }
    for (const id of t.activeMineIds) {
      if (!minesNow.has(id)) fail('mine-cap', `tank ${t.id} counts mine ${id}, which is not in the world`);
    }
  }
  for (const b of curr.bullets) {
    const budget = bulletConfig[b.type].bounces;
    if (b.bouncesLeft < 0 || b.bouncesLeft > budget) {
      fail('bounce-budget', `shell ${b.id} (${b.type}) has ${b.bouncesLeft} bounces left, budget ${budget}`);
    }
  }

  // No shot bypasses the fire rules: the shooter was a live tank, off cooldown, and fired
  // once this tick.
  const shotsBy = new Map<number, number>();
  for (const e of events) {
    if (e.type !== 'fire') continue;
    shotsBy.set(e.ownerId, (shotsBy.get(e.ownerId) ?? 0) + 1);
    const before = prev.tanks.find((t) => t.id === e.ownerId);
    if (!before) {
      fail('fire-legal', `a shot from ${e.ownerId}, which was not a tank before the step`);
      continue;
    }
    // stepRespawns runs before player input in the same step and zeroes the cooldown, so a
    // tank that was dead before the step may legally fire on the tick it respawns.
    if (respawned.has(e.ownerId)) continue;
    if (!before.alive) fail('fire-legal', `tank ${e.ownerId} fired while dead`);
    // The cooldown is decremented before the fire check in the same step (world.ts for
    // players, ai/index.ts for enemies), so a legal shot needs at most 1 before the step.
    if (before.fireCooldown > 1) {
      fail('fire-legal', `tank ${e.ownerId} fired with ${before.fireCooldown} ticks of cooldown left`);
    }
  }
  for (const [owner, n] of shotsBy) if (n > 1) fail('fire-legal', `tank ${owner} fired ${n} shots in one tick`);

  return out;
}

/**
 * A 53-bit string hash (cyrb53). Not cryptographic: it only has to make two runs that
 * diverged disagree, and a real divergence persists across many ticks, each hashed afresh.
 */
export function digest(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const IDLE: InputState = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };

function driverInput(
  world: World,
  id: number,
  driver: ScenarioDriver,
  rnd: () => number,
  ai: PlayerAiState,
): InputState {
  if (driver === 'ai') return decidePlayerInput(world, id, rnd, ai);
  if (driver === 'idle') return IDLE;
  const tank = world.tanks.find((t) => t.id === id);
  const at = tank ? tank.pos : { x: 0, y: 0 };
  return {
    move: { x: Math.round(rnd() * 2) - 1, y: Math.round(rnd() * 2) - 1 },
    aim: { x: at.x + (rnd() - 0.5) * 20, y: at.y + (rnd() - 0.5) * 20 },
    fire: rnd() < 0.3,
    mine: rnd() < 0.05,
  };
}

/** One step of a scenario: the world handed in, the world returned, what the step emitted. */
export interface ScenarioStep {
  readonly prev: World;
  readonly world: World;
  readonly events: readonly SimEvent[];
}

/**
 * The scenario's steps, one per tick up to `ticks`: the generator's drivers feeding
 * `stepInputs`. The only place a scenario is stepped, so `runScenario` and a test that needs
 * a mid-run world cannot drive the same seed differently.
 */
export function* scenarioSteps(cfg: ScenarioConfig): Generator<ScenarioStep> {
  let world = buildScenarioWorld(cfg);
  const players = world.tanks.filter((t) => t.kind === 'player').map((t) => t.id);
  // One stream per player slot, derived from the scenario seed, so a driver's draws never
  // depend on how many draws another slot's driver made.
  const rnds = players.map((_, slot) => mulberry32((cfg.seed * 31 + slot + 1) >>> 0));
  const ai = rnds.map((r) => createPlayerAiState(r));
  for (let i = 0; i < cfg.ticks; i++) {
    const inputs = players.map((id, slot) => driverInput(world, id, cfg.drivers[slot] ?? 'idle', rnds[slot], ai[slot]));
    const { world: next, events } = stepInputs(world, inputs);
    yield { prev: world, world: next, events };
    world = next;
  }
}

/**
 * Drive a scenario, checking every tick. Stops at the first violating tick, or
 * TERMINAL_WATCH_TICKS after the status leaves 'playing', or at `ticks`.
 */
export function runScenario(cfg: ScenarioConfig): ScenarioRun {
  const memory = createInvariantMemory();
  const digests: number[] = [];
  const eventCounts: Record<string, number> = {};
  let violations: Violation[] = [];
  let terminalTick: number | undefined;
  for (const { prev, world, events } of scenarioSteps(cfg)) {
    for (const e of events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
    violations = checkTick(prev, world, events, memory);
    digests.push(digest(`${worldFingerprint(world)}|${JSON.stringify(events)}`));
    if (violations.length > 0) break;
    if (terminalTick === undefined && world.status !== 'playing') terminalTick = world.tick;
    if (terminalTick !== undefined && world.tick >= terminalTick + TERMINAL_WATCH_TICKS) break;
  }
  return { config: cfg, violations, digests, terminalTick, eventCounts };
}

/**
 * A seed list as the sweep's environment spells it: comma-separated seeds and inclusive
 * ranges, `"1-200"` or `"3,7,40-42"`. Refuses anything else rather than sweeping a guess.
 */
export function parseSeedList(text: string): number[] {
  const seeds: number[] = [];
  for (const part of text.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) throw new Error(`seed list: '${part}' is not a seed or a range like 1-200`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (to < from) throw new Error(`seed list: range '${part}' runs backwards`);
    for (let s = from; s <= to; s++) seeds.push(s);
  }
  return seeds;
}

/** The first index at which two runs' digests differ, or -1 when they agree throughout. */
export function firstDivergence(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** The copy-paste command that reruns exactly one seed at one tick budget. */
export function reproductionCommand(cfg: Pick<ScenarioConfig, 'seed' | 'ticks'>): string {
  return `VITE_RUN_MEASURE=1 VITE_SCENARIO_SEEDS=${cfg.seed} VITE_SCENARIO_TICKS=${cfg.ticks} `
    + 'npx vitest run src/sim/generated-scenarios.measure.test.ts';
}

/** A failure report: everything needed to rerun and read the case, in one string. */
export function describeFailure(run: ScenarioRun): string {
  const lines = run.violations.map((v) => `  tick ${v.tick} '${v.invariant}': ${v.detail}`);
  return [
    `generated scenario seed ${run.config.seed} broke ${run.violations.length} invariant check(s):`,
    ...lines,
    `scenario: ${JSON.stringify(run.config)}`,
    `rerun: ${reproductionCommand(run.config)}`,
  ].join('\n');
}

/** A repeat-run report: where two runs of one scenario first disagreed. */
export function describeDivergence(cfg: ScenarioConfig, a: ScenarioRun, b: ScenarioRun): string {
  const at = firstDivergence(a.digests, b.digests);
  return [
    `generated scenario seed ${cfg.seed} is not repeatable: the runs first differ after simulated tick ${at + 1}`,
    `  (digests ${a.digests[at]} vs ${b.digests[at]}; run lengths ${a.digests.length} and ${b.digests.length})`,
    `scenario: ${JSON.stringify(cfg)}`,
    `rerun: ${reproductionCommand(cfg)}`,
  ].join('\n');
}
