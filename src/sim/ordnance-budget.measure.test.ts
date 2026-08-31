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
// ---------------------------------------------------------------------------

const SECONDS = 60;
const SEEDS = [1, 2, 3];
/** Campaign boards, by index into ARENA_DEFS. Kept small: the point is per-kind rates. */
const ARENAS_UNDER_TEST = [0, 1, 2];

interface KindStat {
  cap: number;
  liveTicks: number;
  shellTicks: number;
  atCapTicks: number;
  shots: number;
  deaths: number;
  kills: number;
  shellLifetimeTicks: number;
  shellsEnded: number;
}

const blank = (cap: number): KindStat => ({
  cap,
  liveTicks: 0,
  shellTicks: 0,
  atCapTicks: 0,
  shots: 0,
  deaths: 0,
  kills: 0,
  shellLifetimeTicks: 0,
  shellsEnded: 0,
});

const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('per-kind active-ordnance baseline (set VITE_RUN_MEASURE=1 to run)', () => {
  it('reports shell density, capacity stall, shell lifetime and encounter length', () => {
    const agg = new Map<TankKind, KindStat>();
    const encounters: { arena: string; seed: number; ticks: number; ended: string }[] = [];

    for (const seed of SEEDS) {
      for (const ai of ARENAS_UNDER_TEST) {
        let w = createWorldFor(arenaById(ARENA_DEFS[ai].id), seed) as World;
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
              const victim = agg.get(e.kind);
              if (victim) victim.deaths++;
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
            const cap = configFor(tank.kind).weapon.maxActiveProjectiles;
            const stat = agg.get(tank.kind) ?? blank(cap);
            stat.cap = cap;
            const live = w.bullets.filter((b) => b.ownerId === tank.id).length;
            stat.liveTicks++;
            stat.shellTicks += live;
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
});
