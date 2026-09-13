/// <reference types="vite/client" />
import { describe, it } from 'vitest';
import { stepInputs } from './world';
import { createWorldFor } from './arena';
import { ARENA_DEFS, arenaById } from './config/arenas';
import { createPlayerAiState, decidePlayerInput, mulberry32 } from './ai/player-profile';
import { configFor } from './config';
import { COUNTDOWN_TICKS, TICK_HZ } from './constants';
import type { World } from './world';
import type { TankKind } from './types';

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped by default: the per-kind active-ordnance baseline
// issue #358 needs before any cap in its provisional role matrix can be judged.
//
// #358 asks for "shell density, lifetime, capacity-stall time, capped fire
// attempts, and encounter duration" per campaign kind, so that a candidate cap
// can be compared against the shipped one. This measures the shipped baseline.
//
// Usage: set VITE_RUN_MEASURE=1, run
//   VITE_RUN_MEASURE=1 npx vitest run src/sim/ordnance-budget.measure.test.ts
//
// Read via `import.meta.env`, NOT `process.env`: purity.test.ts's
// FORBIDDEN_GLOBALS bans that bare token anywhere in src/sim/, test files
// included.
//
// ---------------------------------------------------------------------------
// HOW A VARIANT IS EXPRESSED -- checked before this harness was written, because
// a measurement that cannot be moved is not an experiment.
//
// There is NO injection seam for the cap. `configFor` reads a catalog resolved
// once at module load (config/roster.ts) from validated JSON, and `spawnBullet`
// calls `configFor(owner.kind).weapon.maxActiveProjectiles` directly
// (bullets.ts:93). So a variant is a DATA EDIT to
// config/data/tank-defs.json plus a second run of this harness -- not a
// parameter, and not something a unit test can express in-process.
//
// That knob is wired, and the check that says so: setting teal's
// maxActiveProjectiles from 5 to 2 moved its capacity stall from 5.54% of live
// ticks to 28.28% and its shots from 59 to 37, while OLIVE's row stayed
// bit-identical (0.0326 mean, 3.26%, 20 shots, 17080 tick samples) across both
// runs. The unchanged row is the control: it says the deltas are the edit and
// not run-to-run noise.
//
// Note the cross-talk that same check exposed: capping teal also moved grey and
// the player, because a shorter-ranged opponent changes how long encounters run.
// A variant therefore has to be read per-kind against a matched baseline, and a
// moved number on a kind whose cap did NOT change is a real effect rather than
// an error.
//
// ---------------------------------------------------------------------------
// KNOWN HOLE: "capped fire attempts" is NOT measured here.
//
// The count wanted is how often a tank TRIED to fire and was refused, which is
// not derivable from world state -- the refusal happens inside spawnBullet and
// leaves no trace. PR #445 adds the `fire-blocked` SimEvent that carries it.
// Until that merges, `%ticksAtCap` below is the closest available proxy: it is
// capacity-stall TIME, which is not the same quantity. A tank can sit at its cap
// without ever wanting to shoot.
//
// That gap is not hypothetical, and one variant measures its size. Dropping
// BROWN from 5 to 2 raises its capacity stall from 0.00% to 0.44% and changes
// NOTHING else: brown's shots, kills, deaths and shell lifetime are unchanged,
// and every other kind's row is bit-identical across all nine encounters. The
// cap was occupied and never refused a shot. Dropping brown to 1 does bind --
// stall 3.62%, shots 33 -> 26 -- so the threshold sits between 2 and 1. Read a
// nonzero stall as "worth investigating", never as "shots were lost".
// ---------------------------------------------------------------------------

const SECONDS = 60;
const SEEDS = [1, 2, 3];
/**
 * Campaign boards, by index into ARENA_DEFS. Kept small: the point is per-kind rates.
 *
 * ARENA-04 WAS ADDED FOR ISSUE #358's CONTRAST, and finding out why is the useful part: the
 * previous set was `[0, 1, 2]`, and **green never spawns on any of them**. arena-01 and
 * arena-02 hold brown/grey/teal, arena-03 adds olive, and only arena-04 and arena-05 carry
 * all six campaign kinds. So the baseline table below has been silently missing a row for a
 * kind the roster has, and the contrast threw on it rather than reporting five of six as if
 * it were the roster.
 *
 * Every measurement quoted in this file's header was taken under the OLD three-arena set and
 * should be read against that narrower sample; none of them concerned green.
 */
const ARENAS_UNDER_TEST = [0, 1, 2, 3];

interface KindStat {
  cap: number;
  /** The EFFECTIVE mine capacity this arm gave the kind -- `tank.mineCap ?? configFor(...)`. */
  mineCap: number;
  liveTicks: number;
  shellTicks: number;
  /** Live mines owned, summed per tick, so mine density reads like shell density. */
  mineTicks: number;
  atCapTicks: number;
  shots: number;
  deaths: number;
  kills: number;
  shellLifetimeTicks: number;
  shellsEnded: number;
}

const blank = (cap: number): KindStat => ({
  cap,
  mineCap: -1,
  liveTicks: 0,
  shellTicks: 0,
  mineTicks: 0,
  atCapTicks: 0,
  shots: 0,
  deaths: 0,
  kills: 0,
  shellLifetimeTicks: 0,
  shellsEnded: 0,
});

const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

/**
 * Run every (seed, arena) encounter under ONE arm and aggregate it (issue #358).
 *
 * `pp1Roles` reaches the world through `createWorldFor`'s own init -- the same seam
 * `levels.ts` uses for `?dev=1&pp1Roles=1`, so the arm measured here is the arm a player
 * gets. That seam did not exist when this file was written; its header still describes a
 * variant as "a DATA EDIT to config/data/tank-defs.json plus a second run", which was true
 * then and is no longer the only way.
 *
 * SEEDS AND ARENAS ARE MATCHED ACROSS ARMS by construction: both calls walk the same
 * `SEEDS` x `ARENAS_UNDER_TEST` product in the same order, and the scripted player is seeded
 * from `seed * 7 + 1` either way. Issue #358's required output asks for exactly that.
 */
function runArm(pp1Roles: boolean): {
  agg: Map<TankKind, KindStat>;
  encounters: { arena: string; seed: number; ticks: number; ended: string }[];
} {
    const agg = new Map<TankKind, KindStat>();
    const encounters: { arena: string; seed: number; ticks: number; ended: string }[] = [];

    for (const seed of SEEDS) {
      for (const ai of ARENAS_UNDER_TEST) {
        let w = createWorldFor(arenaById(ARENA_DEFS[ai].id), seed, { pp1Roles }) as World;
        const playerId = w.tanks.find((t) => t.kind === 'player')?.id;
        if (playerId === undefined) continue;
        const rnd = mulberry32(seed * 7 + 1);
        const state = createPlayerAiState(rnd);
        // Shell birth ticks, so lifetime is MEASURED rather than assumed from
        // range/speed. Tracked off world.bullets, not off the `fire` event, which
        // carries no bullet id -- there is no way to join the two.
        const born = new Map<number, { tick: number; kind: TankKind }>();
        let ticks = 0;
        let ended = 'timeout';

        for (let t = 0; t < TICK_HZ * SECONDS; t++) {
          const res = stepInputs(w, [decidePlayerInput(w, playerId, rnd, state)]);
          w = res.world;
          ticks++;

          for (const e of res.events) {
            if (e.type === 'fire') {
              const owner = w.tanks.find((x) => x.id === e.ownerId);
              if (owner) {
                const st = agg.get(owner.kind) ?? blank(configFor(owner.kind).weapon.maxActiveProjectiles);
                st.shots++;
                agg.set(owner.kind, st);
              }
            }
            if (e.type === 'tank-destroyed') {
              const victim =
                agg.get(e.kind) ?? blank(configFor(e.kind).weapon.maxActiveProjectiles);
              victim.deaths++;
              agg.set(e.kind, victim);
              const killer = w.tanks.find((x) => x.id === e.by.ownerId);
              if (killer) {
                const st = agg.get(killer.kind) ?? blank(configFor(killer.kind).weapon.maxActiveProjectiles);
                st.kills++;
                agg.set(killer.kind, st);
              }
            }
          }

          // The countdown is dead air for ordnance: movement and fire are both
          // blocked, so counting those 180 ticks would dilute every rate below.
          if (w.tick <= COUNTDOWN_TICKS) continue;

          const liveIds = new Set(w.bullets.map((b) => b.id));
          for (const b of w.bullets) {
            if (born.has(b.id)) continue;
            const owner = w.tanks.find((x) => x.id === b.ownerId);
            if (owner) born.set(b.id, { tick: w.tick, kind: owner.kind });
          }
          for (const [id, rec] of born) {
            if (liveIds.has(id)) continue;
            const st = agg.get(rec.kind);
            if (st) {
              st.shellLifetimeTicks += w.tick - rec.tick;
              st.shellsEnded++;
            }
            born.delete(id);
          }

          for (const tank of w.tanks) {
            if (!tank.alive) continue;
            // THE EFFECTIVE cap, off the TANK. `configFor` is the ROSTER's value and is the
            // same in both arms by design -- issue #358's whole point is that shipped
            // balance does not move -- so reading it here would report the baseline's cap
            // beside the arm's behaviour, and `atCapTicks` would be computed against a
            // threshold no tank in the run was actually held to.
            const cap = tank.shellCap ?? configFor(tank.kind).weapon.maxActiveProjectiles;
            const stat = agg.get(tank.kind) ?? blank(cap);
            stat.cap = cap;
            stat.mineCap = tank.mineCap ?? configFor(tank.kind).mineCapacity;
            const live = w.bullets.filter((b) => b.ownerId === tank.id).length;
            stat.liveTicks++;
            stat.shellTicks += live;
            stat.mineTicks += w.mines.filter((m) => m.ownerId === tank.id).length;
            if (live >= cap) stat.atCapTicks++;
            agg.set(tank.kind, stat);
          }

          if (w.status !== 'playing') {
            ended = w.status;
            break;
          }
        }
        encounters.push({ arena: ARENA_DEFS[ai].id, seed, ticks, ended });
      }
    }
  return { agg, encounters };
}

measure('per-kind active-ordnance baseline (set VITE_RUN_MEASURE=1 to run)', () => {
  it('reports shell density, capacity stall, shell lifetime and encounter length', () => {
    const { agg, encounters } = runArm(false);

    console.log(
      `\nbaseline: ${SEEDS.length} seeds x ${ARENAS_UNDER_TEST.length} arenas, ` +
        `${SECONDS}s cap each, countdown (${COUNTDOWN_TICKS} ticks) excluded from every rate`,
    );
    console.log(
      '\nkind     cap  meanLiveShells  capacityStall  meanShellLife  shots  kills  deaths  tickSamples',
    );
    for (const [kind, s] of [...agg.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(
        `${kind.padEnd(8)} ${String(s.cap).padStart(2)}   ${(s.shellTicks / s.liveTicks).toFixed(4).padStart(8)}` +
          `      ${((100 * s.atCapTicks) / s.liveTicks).toFixed(2).padStart(6)}%   ` +
          `${(s.shellsEnded ? s.shellLifetimeTicks / s.shellsEnded : Number.NaN).toFixed(1).padStart(11)}t  ` +
          `${String(s.shots).padStart(4)}   ${String(s.kills).padStart(4)}    ${String(s.deaths).padStart(4)}   ${s.liveTicks}`,
      );
    }

    console.log('\nencounters');
    for (const e of encounters) {
      console.log(
        `  ${e.arena} seed=${e.seed}  ${(e.ticks / TICK_HZ).toFixed(1)}s  ended=${e.ended}`,
      );
    }
  });

  /**
   * THE MATCHED CONTRAST issue #358's required output asks for: the shipped baseline against
   * the `pp1Roles` arm, same seeds, same arenas, same scripted inputs.
   *
   * IT PROVES THE KNOB BEFORE IT REPORTS ANYTHING. A harness whose independent variable is
   * not connected produces two runs of the same thing and a table of zero deltas that reads
   * like a finding -- so the first thing this does is assert that the arm actually moved the
   * caps it is supposed to move, per kind, and throw if it did not. Without that, every
   * number below would be evidence for nothing and would look like evidence for "the arm
   * changes little".
   *
   * WHAT HAS NO CONTROL ROW, stated because it is a real limit rather than an oversight: the
   * arm touches ALL SIX campaign kinds' shell caps, so there is no untouched kind whose
   * bit-identical row would separate signal from noise the way OLIVE did for the single-kind
   * edits in this file's header. What stands in for it is determinism -- the same arm run
   * twice is bit-identical, asserted below -- plus grey's MINE cap, which the arm
   * deliberately leaves alone.
   */
  it('contrasts the shipped baseline against the pp1Roles arm, on matched seeds', () => {
    const base = runArm(false);
    const arm = runArm(true);

    // 1. THE KNOB. Shell caps must differ for every kind the table names a different value
    // for, and mine caps for Brown, Teal and Green. Grey's mine cap must NOT move: the arm
    // leaves its placement behaviour alone by owner decision, and a moved value there would
    // mean the experiment had quietly grown an AI change.
    const moved: string[] = [];
    for (const [kind, a] of arm.agg) {
      const b = base.agg.get(kind);
      if (b === undefined) continue;
      if (a.cap !== b.cap) moved.push(`${kind}.shellCap ${b.cap}->${a.cap}`);
      if (a.mineCap !== b.mineCap) moved.push(`${kind}.mineCap ${b.mineCap}->${a.mineCap}`);
    }
    if (moved.length === 0) {
      throw new Error('pp1Roles arm changed no cap at all -- the independent variable is not wired');
    }
    for (const kind of ['brown', 'teal', 'green'] as const) {
      const a = arm.agg.get(kind);
      const b = base.agg.get(kind);
      if (a === undefined || b === undefined) throw new Error(`${kind} never spawned in either arm`);
      if (a.mineCap !== 0 || b.mineCap === 0) {
        throw new Error(`${kind} mine cap did not move to 0 under the arm (${b.mineCap} -> ${a.mineCap})`);
      }
    }
    const greyBase = base.agg.get('grey');
    const greyArm = arm.agg.get('grey');
    if (greyBase && greyArm && greyBase.mineCap !== greyArm.mineCap) {
      throw new Error(`grey's mine cap moved under the arm (${greyBase.mineCap} -> ${greyArm.mineCap})`);
    }
    console.log(`\nknob wired: ${moved.sort().join(', ')}`);

    // 2. DETERMINISM, which is what a missing control row is replaced by here. Two runs of
    // the same arm must agree exactly, or a delta below could be run-to-run noise.
    const repeat = runArm(true);
    for (const [kind, a] of arm.agg) {
      const r = repeat.agg.get(kind);
      if (!r || JSON.stringify(a) !== JSON.stringify(r)) {
        throw new Error(`the arm is not deterministic: ${kind} differs between two identical runs`);
      }
    }
    console.log('determinism: two runs of the pp1Roles arm are bit-identical per kind');

    const rate = (s: KindStat): { shells: number; mines: number; stall: number } => ({
      shells: s.shellTicks / s.liveTicks,
      mines: s.mineTicks / s.liveTicks,
      stall: (100 * s.atCapTicks) / s.liveTicks,
    });
    console.log(
      `\nmatched contrast: ${SEEDS.length} seeds x ${ARENAS_UNDER_TEST.length} arenas, ` +
        `${SECONDS}s cap each, countdown excluded`,
    );
    console.log(
      '\nkind     shellCap    mineCap   meanLiveShells      meanLiveMines       capacityStall        shots',
    );
    for (const kind of [...arm.agg.keys()].sort()) {
      const a = arm.agg.get(kind) as KindStat;
      const b = base.agg.get(kind);
      if (b === undefined) continue;
      const ra = rate(a);
      const rb = rate(b);
      console.log(
        `${kind.padEnd(8)} ${String(rb.shells !== undefined ? b.cap : 0).padStart(2)}->${String(a.cap).padEnd(2)}    ` +
          `${String(b.mineCap).padStart(2)}->${String(a.mineCap).padEnd(2)}   ` +
          `${rb.shells.toFixed(4)}->${ra.shells.toFixed(4)}   ` +
          `${rb.mines.toFixed(4)}->${ra.mines.toFixed(4)}   ` +
          `${rb.stall.toFixed(2)}%->${ra.stall.toFixed(2)}%   ` +
          `${String(b.shots).padStart(4)}->${String(a.shots).padEnd(4)}`,
      );
    }

    // 3. DIFFICULTY, the comparison issue #358 requires explicitly. Player deaths and the
    // fraction of encounters that ended rather than timing out are the two coarse signals
    // this harness can honestly produce; neither is a substitute for normal-speed human play,
    // which the issue names separately and which no harness here provides.
    const ended = (r: typeof base): number => r.encounters.filter((e) => e.ended !== 'timeout').length;
    console.log(
      `\ndifficulty (coarse): player deaths ${base.agg.get('player')?.deaths} -> ${arm.agg.get('player')?.deaths}, ` +
        `encounters resolved ${ended(base)}/${base.encounters.length} -> ${ended(arm)}/${arm.encounters.length}`,
    );
  });
});
