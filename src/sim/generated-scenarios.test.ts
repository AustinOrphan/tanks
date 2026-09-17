// Generated-scenario invariants: the small fixed corpus required CI runs (issue #760).
//
// Each corpus seed resolves to a legal scenario (`generateScenario`), is driven through
// `stepInputs`, and must hold every structural invariant in `scenarios.ts` on every tick. A
// failure prints the seed, the resolved scenario, the tick, the invariant and the command
// that reruns exactly that case. The deeper sweep over many more seeds is
// tools/scenarios/generated-scenarios.measure.test.ts; both commands and their runtime
// budgets are in docs/agent/commands-and-operations.md.
//
// The second half is the harness's own negative control: every invariant is shown to fire
// on a known-bad world, so a check that silently stopped checking fails here rather than
// passing the corpus forever.
import { describe, it, expect, vi } from 'vitest';
import { cloneWorld, type World } from './world';
import { bulletConfig } from './constants';
import { configFor } from './config/roster';
import type { SimEvent } from './events';
import {
  checkTick,
  createInvariantMemory,
  describeDivergence,
  describeFailure,
  digest,
  firstDivergence,
  generateScenario,
  parseSeedList,
  reproductionCommand,
  runScenario,
  scenarioSteps,
  type InvariantName,
  type ScenarioConfig,
  type ScenarioRun,
} from './scenarios';

/**
 * The corpus: seeds 1-10 at 1200 ticks (20 s of play) each, taken in order rather than
 * chosen, so the corpus is whatever the generator makes of them. What that covers is
 * asserted below rather than assumed, so a generator change that narrowed it fails here.
 */
const CORPUS_SEEDS = parseSeedList('1-10');
const CORPUS_TICKS = 1200;
/** Seeds run a second time for the repeat check: one per mode among the corpus's scenarios. */
const REPEAT_SEEDS = [1, 7, 8];
/** Per-test ceiling. A corpus seed measured at most ~0.5 s here; this is headroom, not a target. */
const SEED_TIMEOUT_MS = 20_000;

const runs = new Map<number, ScenarioRun>();
function corpusRun(seed: number): ScenarioRun {
  let run = runs.get(seed);
  if (!run) {
    run = runScenario(generateScenario(seed, CORPUS_TICKS));
    runs.set(seed, run);
  }
  return run;
}

describe('generated scenarios: the required corpus', () => {
  for (const seed of CORPUS_SEEDS) {
    it(`seed ${seed} holds every structural invariant on every tick`, () => {
      const run = corpusRun(seed);
      expect(run.violations.length === 0 ? 'no violations' : describeFailure(run)).toBe('no violations');
    }, SEED_TIMEOUT_MS);
  }

  it('repeats exactly: a second run, and a run on freshly loaded sim modules, match the first on every tick', async () => {
    // Two comparisons, because they catch different module-level state. A second run in the
    // same module graph catches state that keeps changing (a counter). It cannot catch a
    // first-write-wins cache: both runs read what the first run, or an earlier seed, stored.
    // A run on a fresh copy of every module starts from no stored state at all, so it
    // disagrees with a corpus run that inherited some from the seeds before it.
    // Measured: a module-level respawn-cell cache survived the second-run check alone
    // (manifest entry respawn-cell-memoised-across-worlds).
    const expectSame = (cfg: ScenarioConfig, a: ScenarioRun, b: ScenarioRun): void => {
      expect(firstDivergence(a.digests, b.digests) === -1 ? 'repeatable' : describeDivergence(cfg, a, b)).toBe('repeatable');
    };
    for (const seed of REPEAT_SEEDS) {
      const cfg = generateScenario(seed, CORPUS_TICKS);
      const first = corpusRun(seed);
      expectSame(cfg, first, runScenario(cfg));
      vi.resetModules();
      const fresh = await import('./scenarios');
      expectSame(cfg, first, fresh.runScenario(fresh.generateScenario(seed, CORPUS_TICKS)));
    }
  }, SEED_TIMEOUT_MS * REPEAT_SEEDS.length);

  it('is not one game: every corpus seed ends in a different world', () => {
    // The dead-knob control. A generator that ignored its seed would pass every check above
    // ten times over one scenario.
    const finals = CORPUS_SEEDS.map((seed) => corpusRun(seed).digests.at(-1));
    expect(new Set(finals).size).toBe(CORPUS_SEEDS.length);
  }, SEED_TIMEOUT_MS * CORPUS_SEEDS.length);

  it('covers every mode, every driver, and one to four players', () => {
    const configs = CORPUS_SEEDS.map((seed) => generateScenario(seed, CORPUS_TICKS));
    expect(new Set(configs.map((c) => c.mode))).toEqual(new Set(['campaign-coop', 'ffa', 'teams']));
    expect(new Set(configs.flatMap((c) => c.drivers))).toEqual(new Set(['ai', 'scripted', 'idle']));
    expect(new Set(configs.map((c) => c.playerCount))).toEqual(new Set([1, 2, 3, 4]));
    expect(new Set(configs.map((c) => c.arenaId)).size).toBeGreaterThanOrEqual(4);
    // One per mode, as REPEAT_SEEDS' comment says.
    expect(new Set(REPEAT_SEEDS.map((seed) => generateScenario(seed, CORPUS_TICKS).mode)).size).toBe(3);
  });

  it('exercises what the invariants guard: shots, refusals, bounces, mines, kills, respawns and an ending', () => {
    // A corpus in which no tank ever fired would hold the fire rule vacuously. Every event
    // type an invariant reads, or that proves its precondition was reached, must occur.
    const totals: Record<string, number> = {};
    for (const seed of CORPUS_SEEDS) {
      for (const [type, n] of Object.entries(corpusRun(seed).eventCounts)) totals[type] = (totals[type] ?? 0) + n;
    }
    const required = ['fire', 'fire-blocked', 'ricochet', 'mine-dropped', 'mine-detonate', 'tank-destroyed',
      'wall-destroyed', 'respawn'];
    expect(required.filter((type) => !(totals[type] > 0))).toEqual([]);
    expect(CORPUS_SEEDS.filter((seed) => corpusRun(seed).terminalTick !== undefined).length).toBeGreaterThan(0);
  }, SEED_TIMEOUT_MS * CORPUS_SEEDS.length);
});

describe('generated scenarios: the generator', () => {
  it('resolves a seed to the same scenario every time, and different seeds to different ones', () => {
    expect(generateScenario(5, 600)).toEqual(generateScenario(5, 600));
    const distinct = new Set(CORPUS_SEEDS.map((seed) => JSON.stringify({ ...generateScenario(seed, 600), seed: 0 })));
    expect(distinct.size).toBe(CORPUS_SEEDS.length);
  });

  it('parses the sweep seed list and refuses anything else', () => {
    expect(parseSeedList('3')).toEqual([3]);
    expect(parseSeedList('1-3,7, 9-10')).toEqual([1, 2, 3, 7, 9, 10]);
    expect(() => parseSeedList('')).toThrow(/not a seed/);
    expect(() => parseSeedList('5-2')).toThrow(/backwards/);
    expect(() => parseSeedList('1;2')).toThrow(/not a seed/);
  });

  it('prints a failure the reader can rerun: seed, scenario, tick, invariant and command', () => {
    const cfg = generateScenario(4, 900);
    const run: ScenarioRun = {
      config: cfg, digests: [], eventCounts: {},
      violations: [{ tick: 77, invariant: 'shell-cap', detail: 'tank 1 has 6 live shells, cap 5' }],
    };
    const text = describeFailure(run);
    expect(text).toContain('seed 4');
    expect(text).toContain("tick 77 'shell-cap': tank 1 has 6 live shells, cap 5");
    expect(text).toContain(`scenario: ${JSON.stringify(cfg)}`);
    expect(text).toContain(`rerun: ${reproductionCommand(cfg)}`);
    expect(reproductionCommand(cfg)).toBe(
      'VITE_RUN_MEASURE=1 VITE_SCENARIO_SEEDS=4 VITE_SCENARIO_TICKS=900 npx vitest run tools/scenarios/generated-scenarios.measure.test.ts',
    );
  });

  it('locates the first tick two runs disagree on', () => {
    expect(firstDivergence([1, 2, 3], [1, 2, 3])).toBe(-1);
    expect(firstDivergence([1, 2, 3], [1, 9, 3])).toBe(1);
    expect(firstDivergence([1, 2, 3], [1, 2])).toBe(2);
    expect(digest('a')).not.toBe(digest('b'));
  });
});

describe('generated scenarios: every invariant fires on a known-bad world', () => {
  /**
   * A genuine step from the corpus with something in every collection a check reads: two or
   * more tanks, a live shell and a mine: the first such step of the first corpus seed with a
   * scripted driver, found rather than hand-built, so the world is one the sim really produces.
   */
  let found: { prev: World; curr: World; events: readonly SimEvent[] } | undefined;
  function fixture(): { prev: World; curr: World; events: SimEvent[] } {
    found ??= (() => {
      for (const seed of CORPUS_SEEDS) {
        const cfg = generateScenario(seed, CORPUS_TICKS);
        if (!cfg.drivers.includes('scripted')) continue;
        for (const step of scenarioSteps(cfg)) {
          const w = step.world;
          if (w.tanks.length >= 2 && w.bullets.some((b) => b.alive) && w.mines.length > 0) {
            return { prev: step.prev, curr: w, events: step.events };
          }
        }
      }
      throw new Error('no corpus step has a live shell and a mine');
    })();
    // A fresh copy per call: every case below corrupts its own.
    return { prev: cloneWorld(found.prev), curr: cloneWorld(found.curr), events: [...found.events] };
  }

  /** The invariant names `checkTick` reports, in order, without duplicates. */
  function firing(prev: World, curr: World, events: readonly SimEvent[] = [], memory = createInvariantMemory()): InvariantName[] {
    return [...new Set(checkTick(prev, curr, events, memory).map((v) => v.invariant))];
  }

  it('reports nothing on the genuine step (the control every case below departs from)', () => {
    const { prev, curr, events } = fixture();
    expect(checkTick(prev, curr, events, createInvariantMemory())).toEqual([]);
  });

  it('finite-numbers: a NaN anywhere in the world, including a field no other check reads', () => {
    const { prev, curr } = fixture();
    curr.tanks[0].bodyAngle = Number.NaN;
    expect(firing(prev, curr)).toEqual(['finite-numbers']);
    const deep = fixture();
    deep.curr.mines[0].timer = Number.POSITIVE_INFINITY;
    expect(firing(deep.prev, deep.curr)).toEqual(['finite-numbers']);
  });

  it('unique-ids: a duplicated id, and an id that was never issued', () => {
    const dup = fixture();
    dup.curr.mines.push({ ...dup.curr.mines[0] });
    expect(firing(dup.prev, dup.curr)).toEqual(['unique-ids']);
    const unissued = fixture();
    unissued.curr.nextId = Math.max(...unissued.curr.mines.map((m) => m.id));
    expect(firing(unissued.prev, unissued.curr)).toEqual(['unique-ids']);
  });

  it('owners-exist: a shell or mine whose owner is not a tank', () => {
    const shell = fixture();
    shell.curr.bullets.find((b) => b.alive)!.ownerId = 99_999;
    expect(firing(shell.prev, shell.curr)).toEqual(['owners-exist']);
    const mine = fixture();
    mine.curr.mines[0].ownerId = 99_999;
    expect(firing(mine.prev, mine.curr)).toEqual(['owners-exist']);
  });

  it('no-resurrection: a tank revived without a respawn or restart, and a retired shell or mine returning', () => {
    const tank = fixture();
    const revived = tank.curr.tanks.find((t) => t.alive)!;
    tank.prev.tanks.find((t) => t.id === revived.id)!.alive = false;
    expect(firing(tank.prev, tank.curr)).toEqual(['no-resurrection']);
    // The two lifecycle transitions that DO revive a tank are exempt.
    const respawn: SimEvent = { type: 'respawn', tankId: revived.id, controlledBy: 0, pos: { ...revived.pos } };
    expect(firing(tank.prev, tank.curr, [respawn])).toEqual([]);
    const restarted = cloneWorld(tank.curr);
    restarted.roundStartTick = tank.prev.roundStartTick + 1;
    expect(firing(tank.prev, restarted)).toEqual([]);

    const shell = fixture();
    const memory = createInvariantMemory();
    memory.retiredShells.add(shell.curr.bullets.find((b) => b.alive)!.id);
    expect(firing(shell.prev, shell.curr, [], memory)).toEqual(['no-resurrection']);
    const mine = fixture();
    const mineMemory = createInvariantMemory();
    mineMemory.retiredMines.add(mine.curr.mines[0].id);
    expect(firing(mine.prev, mine.curr, [], mineMemory)).toEqual(['no-resurrection']);
  });

  it('no-resurrection: remembers across ticks, so a shell that left and came back is caught later', () => {
    const { prev, curr } = fixture();
    const memory = createInvariantMemory();
    const gone = cloneWorld(curr);
    const shell = curr.bullets.find((b) => b.alive)!;
    gone.bullets = gone.bullets.filter((b) => b.id !== shell.id);
    gone.tick = curr.tick + 1;
    expect(firing(curr, gone, [], memory)).toEqual([]);
    const back = cloneWorld(curr);
    back.tick = gone.tick + 1;
    expect(firing(gone, back, [], memory)).toEqual(['no-resurrection']);
    expect(prev.tick).toBe(curr.tick - 1);
  });

  it('tick-advances and status-latched: a skipped tick, and a finished game resuming', () => {
    const skipped = fixture();
    skipped.curr.tick += 1;
    expect(firing(skipped.prev, skipped.curr)).toEqual(['tick-advances']);
    const resumed = fixture();
    resumed.prev.status = 'win';
    expect(firing(resumed.prev, resumed.curr)).toEqual(['status-latched']);
  });

  it('shell-cap, mine-cap and bounce-budget: a population past its authoritative bound', () => {
    const shells = fixture();
    const owner = shells.curr.tanks[0];
    const template = shells.curr.bullets.find((b) => b.alive)!;
    const cap = owner.shellCap ?? configFor(owner.kind).weapon.maxActiveProjectiles;
    for (let i = 0; i <= cap; i++) shells.curr.bullets.push({ ...template, id: shells.curr.nextId++, ownerId: owner.id });
    expect(firing(shells.prev, shells.curr)).toEqual(['shell-cap']);

    const mines = fixture();
    const layer = mines.curr.tanks[0];
    const mineCap = layer.mineCap ?? configFor(layer.kind).mineCapacity;
    for (let i = 0; i <= mineCap; i++) {
      const id = mines.curr.nextId++;
      mines.curr.mines.push({ ...mines.curr.mines[0], id, ownerId: layer.id });
      layer.activeMineIds.push(id);
    }
    expect(firing(mines.prev, mines.curr)).toEqual(['mine-cap']);
    const dangling = fixture();
    dangling.curr.tanks[0].activeMineIds = [dangling.curr.nextId - 1_000_000];
    expect(firing(dangling.prev, dangling.curr)).toEqual(['mine-cap']);

    const over = fixture();
    const shell = over.curr.bullets.find((b) => b.alive)!;
    shell.bouncesLeft = bulletConfig[shell.type].bounces + 1;
    expect(firing(over.prev, over.curr)).toEqual(['bounce-budget']);
    shell.bouncesLeft = -1;
    expect(firing(over.prev, over.curr)).toEqual(['bounce-budget']);
  });

  it('fire-legal: a shot on cooldown, two shots in a tick, and a shot from a dead tank', () => {
    const base = fixture();
    const shooter = base.curr.tanks[0];
    const shot: SimEvent = { type: 'fire', ownerId: shooter.id, bulletType: 'normal', pos: { ...shooter.pos }, angle: 0 };
    const before = (): World => {
      const w = cloneWorld(base.prev);
      const t = w.tanks.find((x) => x.id === shooter.id)!;
      t.alive = true;
      t.fireCooldown = 0;
      return w;
    };
    expect(firing(before(), base.curr, [shot])).toEqual([]);
    const hot = before();
    hot.tanks.find((t) => t.id === shooter.id)!.fireCooldown = 2;
    expect(firing(hot, base.curr, [shot])).toEqual(['fire-legal']);
    expect(firing(before(), base.curr, [shot, shot])).toEqual(['fire-legal']);
    const dead = before();
    dead.tanks.find((t) => t.id === shooter.id)!.alive = false;
    const stillDead = cloneWorld(base.curr);
    stillDead.tanks.find((t) => t.id === shooter.id)!.alive = false;
    expect(firing(dead, stillDead, [shot])).toEqual(['fire-legal']);
    // The one way a dead tank legally fires: it respawned earlier in the same step.
    const respawn: SimEvent = { type: 'respawn', tankId: shooter.id, controlledBy: 0, pos: { ...shooter.pos } };
    const hotDead = before();
    const t = hotDead.tanks.find((x) => x.id === shooter.id)!;
    t.alive = false;
    t.fireCooldown = 30;
    expect(firing(hotDead, base.curr, [respawn, shot])).toEqual([]);
  });
});
