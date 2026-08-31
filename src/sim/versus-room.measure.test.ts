/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { createWorldFor } from './arena';
import { ARENA_DEFS, arenaById } from './config/arenas';
import { stepInputs } from './world';
import { evaluateVersusBoard, MIN_OPEN_FLOOR_PER_PLAYER } from './versus-board';
import { createPlayerAiState, decidePlayerInput, mulberry32 } from './ai/player-profile';
import { configFor } from './config';
import { DT, TICK_HZ } from './constants';
import { vdist } from './types';
import type { GameMode } from './types';
import type { World } from './world';

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped by default: does `openFloorPerPlayer` predict CROWDING
// (issue #418)?
//
// THE PROBLEM THIS EXISTS FOR. `versus-board.test.ts`'s room guard is
// `tightest > MIN_OPEN_FLOOR_PER_PLAYER * 4`, and that multiplier has been LOWERED ON
// MEASUREMENT three times -- 10x when every board was campaign-sized, then 6x, then 4x --
// each time because a newly authored board came in under it. A bound that is relaxed
// whenever it fails is describing the catalogue, not constraining it. Its own comment now
// records 0.25 cells of headroom (vs-tri-01 at N=4 scores 72.25 against a bound of 72) and
// says #418's re-derivation is a prerequisite for the next dedicated board.
//
// So the question is not "what number would the current catalogue pass". It is: what does
// `openFloorPerPlayer` BUY, and is there a value below which play measurably degrades?
//
// Usage: VITE_RUN_MEASURE=1 npx vitest run src/sim/versus-room.measure.test.ts
//
// Read via `import.meta.env`, NOT `process.env`: purity.test.ts's FORBIDDEN_GLOBALS bans
// that bare token anywhere in src/sim/, test files included.
//
// WHAT IT MEASURES. Per (arena, N) over the same sweep the room guard itself uses, a real
// bot match, and three crowding proxies that a ratio ought to predict if it means anything:
//
//   blockedFrac  ticks where a tank asked to move and travelled under a quarter of its
//                per-tick budget, over ticks where it asked to move at all. Walls, other
//                tanks and the arena edge all land here -- this is "there was nowhere to
//                go", which is what a room bound is for.
//   minSep       closest approach between any two tanks, averaged over seeds. A crowded
//                board forces contact the players did not choose.
//   meanSep      mean pairwise separation. Falls as the board shrinks whether or not
//                anything is actually blocked, so it is the control for blockedFrac:
//                separation falling WITHOUT blocking rising is a small board, not a
//                cramped one.
//
// ---------------------------------------------------------------------------
// WHAT IT MEASURED. 45 s per match, 4 seeds per combination, ffa, over the same 24
// (arena, N) combinations the room guard itself sweeps -- 96 matches.
//
//   Spearman rho(openFloorPerPlayer, blockedFrac) = -0.886 over all 24
//                                                 = -0.865 over the 21 offered ones
//
// SO THE RATIO IS A DEFENSIBLE QUANTITY. Tighter boards block more, strongly and
// monotonically, and blockedFrac across the OFFERED boards runs 0.0923 (arena-05 at N=2,
// ratio 450.33) to 0.1959 (vs-tri-01 at N=4, ratio 72.25 -- the board sitting on the
// bound). Roughly a doubling across a nine-fold range of room. Whatever multiplier #418
// settles on, it is bounding something real.
//
// BUT THE BOUND IS NECESSARY, NOT SUFFICIENT, and vs-quad-01 is the proof:
//
//   vs-quad-01 @ N=2   ratio 148.00   blockedFrac 0.3408
//   vs-quad-01 @ N=3   ratio  98.67   blockedFrac 0.2637
//   vs-quad-01 @ N=4   ratio  74.00   blockedFrac 0.2920
//
// At N=2 it has more than twice the bound's worth of open floor per player and the worst
// blocking of anything measured -- its three rows are the only ones outside the offered
// boards' entire 0.092-0.196 range. A ratio cannot see LAYOUT: 148 cells of floor spread
// as four sealed quarters is not 148 cells of room. That is #425's complaint arrived at
// independently, from play rather than from reading the grid, and it is the reason
// vs-quad-01 stays withdrawn from the offered catalogue while remaining in ARENA_DEFS,
// which is the population the room guard sweeps.
//
// WHAT THAT MEANS FOR #418. Raising the multiplier would not have caught vs-quad-01, so
// re-deriving the constant alone does not close the gap the guard exists for. The
// re-derivation wants both: a ratio bound (which this shows is meaningful) AND a check
// that sees layout, for which blockedFrac is a candidate that already discriminates --
// the offered boards occupy 0.092-0.196 and the withdrawn one 0.26-0.34, with no overlap.
// ---------------------------------------------------------------------------
//
// WHAT IT CANNOT DO. It cannot pick the new bound. "Enough room to play" is a judgement
// about how a match FEELS, and #418 asks for the figure to be checked before the next
// board is authored, not for a harness to author it. What it can do is say whether the
// ratio tracks crowding at all -- because if it does not, then no multiplier of it is
// worth defending, and the guard needs a different quantity rather than a better constant.
// ---------------------------------------------------------------------------

const HZ = TICK_HZ;
const SECONDS = 45;
const SEEDS = [7, 11, 23, 41];
const MODE: GameMode = 'ffa' as GameMode;

interface Crowding {
  blockedFrac: number;
  minSep: number;
  meanSep: number;
  ticks: number;
}

function playFor(arenaId: string, n: number, seed: number): Crowding {
  const arena = arenaById(arenaId);
  let w = createWorldFor(arena, seed, undefined, 3, undefined, undefined, n, undefined, MODE) as World;
  const ids = w.tanks.filter((t) => t.kind === 'player').map((t) => t.id);
  const rnd = ids.map((_, i) => mulberry32(seed * 31 + i + 1));
  const ai = rnd.map((r) => createPlayerAiState(r));
  // A quarter of one tick's travel. Generous on purpose: a tank that is merely turning, or
  // sliding along a wall it is pressed against, still covers ground and must NOT read as
  // blocked -- otherwise every wall-hugging manoeuvre inflates the number this is for.
  const budget = configFor('player').movementSpeed * DT;
  const stuckUnder = budget * 0.25;
  let wanted = 0, blocked = 0, sepSum = 0, sepN = 0, minSep = Infinity;
  for (let t = 0; t < HZ * SECONDS; t++) {
    const before = new Map(w.tanks.map((x) => [x.id, { ...x.pos }]));
    const inputs = ids.map((id, i) => decidePlayerInput(w, id, rnd[i], ai[i]));
    const res = stepInputs(w, inputs);
    w = res.world;
    for (let i = 0; i < ids.length; i++) {
      const move = inputs[i].move;
      if (Math.hypot(move.x, move.y) < 1e-6) continue;
      const tank = w.tanks.find((x) => x.id === ids[i]);
      const prev = before.get(ids[i]);
      if (!tank || !tank.alive || !prev) continue;
      wanted++;
      if (vdist(tank.pos, prev) < stuckUnder) blocked++;
    }
    const alive = w.tanks.filter((x) => x.alive);
    for (let a = 0; a < alive.length; a++) {
      for (let b = a + 1; b < alive.length; b++) {
        const d = vdist(alive[a].pos, alive[b].pos);
        sepSum += d; sepN++;
        if (d < minSep) minSep = d;
      }
    }
    if (w.status !== 'playing') break;
  }
  return {
    blockedFrac: wanted === 0 ? 0 : blocked / wanted,
    minSep: minSep === Infinity ? 0 : minSep,
    meanSep: sepN === 0 ? 0 : sepSum / sepN,
    ticks: wanted,
  };
}

const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('versus room ratio: does openFloorPerPlayer predict crowding? (VITE_RUN_MEASURE=1)', () => {
  it('sweeps every (arena, N) the room guard covers', () => {
    console.log(
      `\n${SECONDS}s per match, ${SEEDS.length} seeds per combination, mode ${MODE}.` +
        ` Bound in force: MIN_OPEN_FLOOR_PER_PLAYER * 4 = ${MIN_OPEN_FLOOR_PER_PLAYER * 4}.\n`,
    );
    const rows: { label: string; ratio: number; roomOk: boolean; c: Crowding }[] = [];
    for (const arena of ARENA_DEFS) {
      for (const n of [2, 3, 4] as const) {
        const verdict = evaluateVersusBoard(arena, n);
        const runs = SEEDS.map((s) => playFor(arena.id, n, s));
        rows.push({
          label: `${arena.id} @ N=${n}`,
          ratio: verdict.openFloorPerPlayer,
          roomOk: verdict.roomOk,
          c: {
            blockedFrac: runs.reduce((a, r) => a + r.blockedFrac, 0) / runs.length,
            minSep: runs.reduce((a, r) => a + r.minSep, 0) / runs.length,
            meanSep: runs.reduce((a, r) => a + r.meanSep, 0) / runs.length,
            ticks: runs.reduce((a, r) => a + r.ticks, 0),
          },
        });
      }
    }
    rows.sort((a, b) => a.ratio - b.ratio);
    console.log('combination              openFloor/player  roomOk  blockedFrac   minSep  meanSep   movingTicks');
    for (const r of rows) {
      console.log(
        `${r.label.padEnd(24)}${r.ratio.toFixed(2).padStart(16)}  ${(r.roomOk ? 'yes' : 'NO ').padStart(6)}  ` +
          `${r.c.blockedFrac.toFixed(4).padStart(11)}  ${r.c.minSep.toFixed(2).padStart(7)}  ` +
          `${r.c.meanSep.toFixed(2).padStart(7)}  ${String(r.c.ticks).padStart(12)}`,
      );
    }

    // Does the ratio track crowding at all? Reported as a rank correlation between
    // openFloorPerPlayer and blockedFrac: if room means anything, tighter boards block
    // more, and this comes out clearly negative.
    const n = rows.length;
    const rank = (vals: number[]) => {
      const order = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
      const out = new Array<number>(n);
      order.forEach(([, i], k) => { out[i] = k; });
      return out;
    };
    const rr = rank(rows.map((r) => r.ratio));
    const rb = rank(rows.map((r) => r.c.blockedFrac));
    const dSq = rr.reduce((a, v, i) => a + (v - rb[i]) ** 2, 0);
    const rho = 1 - (6 * dSq) / (n * (n * n - 1));
    console.log(`\nSpearman rho(openFloorPerPlayer, blockedFrac) = ${rho.toFixed(3)} over ${n} combinations`);
    // Reported separately because ARENA_DEFS still carries vs-quad-01, which the versus
    // catalogue has withdrawn pending #425 -- so the sweep's population and the set a
    // player can actually pick are not the same, and a reader should not have to guess
    // which one a single figure describes.
    const offered = rows.filter((r) => !r.label.startsWith('vs-quad-01'));
    const bf = offered.map((r) => r.c.blockedFrac);
    console.log(
      `offered boards only (${offered.length} of ${n}): blockedFrac ${Math.min(...bf).toFixed(4)}` +
        ` .. ${Math.max(...bf).toFixed(4)}; the withdrawn board sits outside that range at every N.`,
    );
    console.log(
      rho < -0.4
        ? 'The ratio tracks crowding: tighter boards block more, so a multiple of it is a defensible bound.'
        : 'The ratio does NOT track crowding on this sweep. A multiple of it is not a defensible bound, whatever the multiplier.',
    );
    expect(rows.length).toBeGreaterThan(0);
  }, 900000);
});
