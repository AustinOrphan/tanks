/// <reference types="vite/client" />
import { describe, it } from 'vitest';
import { ARENA_DEFS, arenaById, createWorldFor } from './arena';
import { step } from './world';
import { configFor } from './config';
import {
  DT,
  COUNTDOWN_TICKS,
  MINE_PROXIMITY_RADIUS,
  MINE_PROXIMITY_DELAY_TICKS,
  MINE_BLAST_RADIUS,
  MINE_BLAST_EXPAND_TICKS,
  MINE_BLAST_HOLD_TICKS,
  TANK_RADIUS,
} from './constants';
import { vdist } from './types';
import type { Tank, InputState } from './types';
import type { World } from './world';

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped by default: can a tank that trips an armed mine
// get clear before the blast, and how much reaction delay can it afford?
//
// Issue #277 asks for mine timing to be tuned and validated. The closed-form
// bound posted on that issue says a player covers 1.50 units in the 0.5s
// proximity interval and needs 1.05 from a trip at the trigger radius, so it
// "should" escape with room to spare. This harness exists because that bound
// answers the wrong question: it assumes an unobstructed run, and most of the
// board is not unobstructed.
//
// Usage: set VITE_RUN_MEASURE=1, run
//   VITE_RUN_MEASURE=1 npx vitest run src/sim/mine-escape.measure.test.ts
// and read the tables off the console.
//
// Read via `import.meta.env`, NOT `process.env`: this file lives under src/sim/,
// and purity.test.ts's FORBIDDEN_GLOBALS bans the bare token "process" anywhere
// in src/sim/, test files included. The same guard bans the bare token for the
// browser global one would naturally use for "the 0.5s reaction span" -- it
// scans PROSE too, so this file says "interval" throughout on purpose.
//
// ---------------------------------------------------------------------------
// THREE LANDMINES, each of which produced a silently dead harness before it was
// found. Anything that drives a tank from a hand-built world hits all three.
//
// 1. COUNTDOWN. `roundPhase` blocks movement ENTIRELY for the first
//    COUNTDOWN_TICKS (180) ticks of a round -- world.ts sets
//    `desiredMove = {x:0,y:0}` outright during 'countdown'. A harness that
//    steps 30 ticks and measures displacement reads 0.000 at every pose and
//    every heading, which looks exactly like a broken input path. Worse,
//    `roundStartTick` is `tick + 1`, so it takes 181 steps, not 180, to reach
//    'live'. `live()` below burns them.
//
// 2. GEOMETRY, not timing, decides the escape. Of the 72 poses this harness can
//    use (8 arenas x their spawns x the +/-x it drives along) only 42 give a
//    tank a fully unobstructed 3.5-unit run; see `scanOpenPoses`, which prints
//    both numbers rather than trusting this comment. At a hemmed pose the tank
//    slides along the wall and simply stops short -- in arena-01 from spawn 1
//    driving +x it plateaus 0.05 units inside the kill radius and dies with
//    zero reaction delay. Measuring at an arbitrary spawn silently samples that
//    class and reports a timing verdict that is really a wall.
//
// 3. THE BLAST IS NOT INSTANT. It expands over MINE_BLAST_EXPAND_TICKS and
//    holds for MINE_BLAST_HOLD_TICKS, and the kill test re-runs every tick
//    against the CURRENT radius (mines.ts: `vdist <= radius + TANK_RADIUS`).
//    A harness that stops at the `mine-detonate` event has not yet seen whether
//    the tank died; the first version of this one reported "escaped" for a run
//    that kills.
//
// The mine is laid through `input.mine` and armed by driving clear, never by
// writing into `world.mines`: arming is a property of stepMines (an unarmed
// mine cannot be triggered at all), so a hand-placed mine measures a state the
// game cannot reach.
//
// Every row is PAIRED. The control runs the identical input script from the
// identical pose with the mine key never pressed, so a treatment that matches
// its control means a dead harness rather than a finding.
// ---------------------------------------------------------------------------

/** The radius detonateMine actually kills at. Not MINE_PROXIMITY_RADIUS, which only trips. */
const KILL_RADIUS = MINE_BLAST_RADIUS + TANK_RADIUS;

const player = (w: World): Tank => w.tanks.find((t) => t.kind === 'player') as Tank;

/** Drive along x, aim straight ahead. `mx` of 0 stands still without changing facing. */
const drive = (w: World, mx: number, mine = false): InputState => {
  const p = player(w);
  return { move: { x: mx, y: 0 }, aim: { x: p.pos.x + (mx || 1) * 50, y: p.pos.y }, fire: false, mine };
};

/**
 * A world at the given spawn with the countdown burned off and no opponents.
 *
 * Enemies are removed rather than guarded around: a mine fuse interval is long
 * enough for an AI shell to kill and respawn the player, which re-anchors
 * `roundStartTick` and teleports the tank mid-measurement. `world.status` stays
 * 'playing' with them gone, so `stepInputs` still applies input.
 */
function live(arena: number, spawn: number): World {
  let w = createWorldFor(arenaById(ARENA_DEFS[arena].id), 1) as World;
  const p = player(w);
  w.tanks.length = 0;
  w.tanks.push(p);
  p.pos = { ...w.spawns[spawn].pos };
  for (let i = 0; i <= COUNTDOWN_TICKS; i++) w = step(w, drive(w, 0)).world;
  return w;
}

/** Poses where a tank can run 3.5 units unobstructed -- enough to clear KILL_RADIUS with margin. */
function scanOpenPoses(): { arena: number; spawn: number; away: number; moved: number }[] {
  const TICKS = 70;
  const want = (configFor('player').movementSpeed * TICKS) / 60;
  const open: { arena: number; spawn: number; away: number; moved: number }[] = [];
  for (let a = 0; a < ARENA_DEFS.length; a++) {
    const spawns = (createWorldFor(arenaById(ARENA_DEFS[a].id), 1) as World).spawns.length;
    for (let s = 0; s < spawns; s++) {
      for (const away of [1, -1]) {
        let w = live(a, s);
        const from = { ...player(w).pos };
        for (let i = 0; i < TICKS; i++) w = step(w, drive(w, away)).world;
        const moved = vdist(player(w).pos, from);
        if (moved >= want * 0.99) open.push({ arena: a, spawn: s, away, moved });
      }
    }
  }
  return open;
}

interface Run {
  died: boolean;
  trip: number;
  clearanceAtDetonation: number;
  /**
   * `clearanceAtDetonation - KILL_RADIUS`, unrounded.
   *
   * Printed raw because a `toFixed(3)` of this read 0.000 at the hemmed pose and got
   * reported as "misses survival by nothing". A tank that dies is at or inside the kill
   * radius, so the sign is what carries the claim -- the rounded magnitude carries none.
   */
  marginRaw: number;
  /**
   * The clearance at which the tank stopped gaining ground, or NaN if it never did.
   *
   * The stopped/free discriminator, and deliberately sampled only while the tank is
   * ALIVE. Anything read on or after the death tick is contaminated: the respawn lands
   * in the same tick as `tank-destroyed`, so that event's `pos` is the RESPAWN point and
   * `roundStartTick` has already jumped (measured: 1 -> 248). An earlier version of this
   * harness derived a "distance gained" figure across that boundary and reported tanks
   * covering 24 units in 10 ticks, which is 48x the speed limit.
   */
  pinnedClearance: number;
  endClearance: number;
  legs: string;
}

/**
 * Lay a mine, drive clear until it arms, drive back until it trips, hesitate
 * `delay` ticks still driving IN, then run. `lay: false` is the paired control:
 * the same script with no mine in the world.
 */
function escapeRun(
  arena: number,
  spawn: number,
  away: number,
  lay: boolean,
  delay = 0,
  preLay = 0,
): Run {
  let w = live(arena, spawn);
  // Shift the lay point off the spawn node. Spawns and wall faces are both grid-aligned,
  // so a mine laid exactly on a spawn is a measure-zero special case; `preLay` is what
  // proves the verdict is not an artifact of that alignment. Positive drives along the
  // flee heading (mine ends up NEARER the wall), negative drives away from it.
  const preDir = preLay >= 0 ? away : -away;
  for (let i = 0; i < Math.abs(preLay); i++) w = step(w, drive(w, preDir)).world;
  let r = step(w, drive(w, 0, lay));
  w = r.world;
  const mine = { ...(lay ? w.mines[0].pos : player(w).pos) };

  let leave = 0;
  for (let i = 0; i < 400; i++) {
    w = step(w, drive(w, away)).world;
    leave++;
    // Arming is what makes the mine dangerous, and it happens only once the
    // owner is clear of MINE_PROXIMITY_RADIUS. The control has no mine to wait
    // on, so it matches on the same distance to keep both scripts the same length.
    if (lay ? w.mines[0]?.armed : vdist(player(w).pos, mine) > MINE_PROXIMITY_RADIUS) break;
  }

  let approach = 0;
  for (let i = 0; i < 400; i++) {
    r = step(w, drive(w, -away));
    w = r.world;
    approach++;
    if (lay ? r.events.some((e) => e.type === 'mine-triggered') : vdist(player(w).pos, mine) <= 1.45) break;
  }
  const trip = vdist(player(w).pos, mine);

  for (let i = 0; i < delay; i++) w = step(w, drive(w, -away)).world;

  let died = false;
  let clearanceAtDetonation = -1;
  let fled = 0;
  let pinnedClearance = Number.NaN;
  let prevClearance = vdist(player(w).pos, mine);
  let stillTicks = 0;
  // Past the detonation and through the blast's whole expand+hold life, because
  // the kill test re-runs every tick of it (landmine 3).
  const budget = MINE_PROXIMITY_DELAY_TICKS + MINE_BLAST_EXPAND_TICKS + MINE_BLAST_HOLD_TICKS + 5;
  for (let i = 0; i < budget; i++) {
    r = step(w, drive(w, away));
    w = r.world;
    fled++;
    const clearance = vdist(player(w).pos, mine);
    if (r.events.some((e) => e.type === 'mine-detonate')) clearanceAtDetonation = clearance;
    if (r.events.some((e) => e.type === 'tank-destroyed')) {
      died = true;
      break;                       // read nothing further: the respawn is in THIS tick
    }
    stillTicks = Math.abs(clearance - prevClearance) < 1e-9 ? stillTicks + 1 : 0;
    if (stillTicks >= 2 && Number.isNaN(pinnedClearance)) pinnedClearance = clearance;
    prevClearance = clearance;
  }
  return {
    died,
    trip,
    clearanceAtDetonation,
    marginRaw: clearanceAtDetonation - KILL_RADIUS,
    pinnedClearance,
    endClearance: vdist(player(w).pos, mine),
    legs: `${leave}/${approach}/${fled}`,
  };
}

/** Every pose the harness can drive, open or not. */
function allPoses(): { arena: number; spawn: number; away: number }[] {
  const out: { arena: number; spawn: number; away: number }[] = [];
  for (let a = 0; a < ARENA_DEFS.length; a++) {
    const spawns = (createWorldFor(arenaById(ARENA_DEFS[a].id), 1) as World).spawns.length;
    for (let s = 0; s < spawns; s++) for (const away of [1, -1]) out.push({ arena: a, spawn: s, away });
  }
  return out;
}

const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('mine escape margin (set VITE_RUN_MEASURE=1 to run)', () => {
  it('reports the escape verdict and reaction budget, open field vs hemmed', () => {
    const speed = configFor('player').movementSpeed;
    const reach = speed * MINE_PROXIMITY_DELAY_TICKS * DT;
    console.log(
      `\nshipped: trigger ${MINE_PROXIMITY_RADIUS}, kill ${KILL_RADIUS}, interval ` +
        `${MINE_PROXIMITY_DELAY_TICKS}t (${MINE_PROXIMITY_DELAY_TICKS * DT}s), blast ` +
        `${MINE_BLAST_EXPAND_TICKS}+${MINE_BLAST_HOLD_TICKS}t, speed ${speed}\n` +
        `closed form: straight-line reach ${reach.toFixed(3)}, needed from the trigger edge ` +
        `${(KILL_RADIUS - MINE_PROXIMITY_RADIUS).toFixed(3)}`,
    );

    const open = scanOpenPoses();
    const cardinalPoses = ARENA_DEFS.reduce(
      (n, d) => n + (createWorldFor(arenaById(d.id), 1) as World).spawns.length * 2,
      0,
    );
    console.log(`\nopen poses: ${open.length} of ${cardinalPoses} (arena x spawn x +/-x)`);

    // One representative of each class. The hemmed pose is named explicitly rather
    // than sampled, so the contrast cannot quietly become two open poses.
    const hemmed = { arena: 0, spawn: 1, away: 1 };
    const cases = [
      { label: 'OPEN   ', ...open[0] },
      { label: 'OPEN   ', ...open[1] },
      { label: 'HEMMED ', ...hemmed },
    ];

    console.log('\nclass   arena     spawn away  trip   clear@det  died   | control died  control end');
    for (const c of cases) {
      const t = escapeRun(c.arena, c.spawn, c.away, true);
      const ctl = escapeRun(c.arena, c.spawn, c.away, false);
      console.log(
        `${c.label} ${ARENA_DEFS[c.arena].id}  ${c.spawn}     ${c.away > 0 ? '+x' : '-x'}   ` +
          `${t.trip.toFixed(3)}  ${t.clearanceAtDetonation.toFixed(3)}      ${t.died ? 'YES' : 'no '}    | ` +
          `${ctl.died ? 'YES' : 'no '}          ${ctl.endClearance.toFixed(3)}`,
      );
    }

    console.log('\nreaction budget: ticks of hesitation (still driving IN) before fleeing');
    console.log('class   arena     spawn  k=0..12            first death');
    for (const c of cases) {
      let first = -1;
      const row: string[] = [];
      for (let k = 0; k <= 12; k++) {
        const t = escapeRun(c.arena, c.spawn, c.away, true, k);
        if (t.died && first < 0) first = k;
        row.push(t.died ? 'X' : '.');
      }
      console.log(
        `${c.label} ${ARENA_DEFS[c.arena].id}  ${c.spawn}      ${row.join('')}       ` +
          `${first < 0 ? 'none in 0..12' : `k=${first} (${(first * DT).toFixed(3)}s)`}`,
      );
    }

    // ---- Every pose, so the two rows above have a denominator ----------------
    //
    // The tables above sample ONE pose per class. That is not enough to say
    // "geometry decides it": a pose can be non-open because the tank is stopped
    // dead or because it is SLIDING along a surface, and those behave differently
    // under a longer interval -- a slider keeps gaining clearance, a stopped tank
    // does not. `gainLast10` separates them. This sweeps all of them instead.
    const openKey = new Set(open.map((o) => `${o.arena}:${o.spawn}:${o.away}`));
    const rows = allPoses().map((pose) => {
      const r = escapeRun(pose.arena, pose.spawn, pose.away, true);
      return { ...pose, ...r, isOpen: openKey.has(`${pose.arena}:${pose.spawn}:${pose.away}`) };
    });
    const summarise = (label: string, set: typeof rows) => {
      if (set.length === 0) return;
      const dead = set.filter((r) => r.died);
      // Pinned = the tank stopped gaining ground before the blast. Free = it never did.
      const pinned = set.filter((r) => Number.isFinite(r.pinnedClearance));
      const free = set.filter((r) => !Number.isFinite(r.pinnedClearance));
      const margins = set.map((r) => r.marginRaw).sort((a, b) => a - b);
      console.log(
        `${label.padEnd(10)} n=${String(set.length).padStart(2)}  died=${String(dead.length).padStart(2)}` +
          `  pinned=${String(pinned.length).padStart(2)} free=${String(free.length).padStart(2)}` +
          `  margin min=${margins[0].toExponential(3)} med=${margins[margins.length >> 1].toFixed(3)}` +
          ` max=${margins[margins.length - 1].toFixed(3)}`,
      );
    };
    console.log('\nall poses at k=0 (margin = clearance at detonation - kill radius, RAW)');
    summarise('ALL', rows);
    summarise('OPEN', rows.filter((r) => r.isOpen));
    summarise('NON-OPEN', rows.filter((r) => !r.isOpen));

    // ---- Where the wall stops mattering ------------------------------------
    //
    // The rows above lay the mine on a spawn node, which is grid-aligned with the
    // wall faces -- so the pinned clearance lands on a suspiciously round number.
    // This walks the lay point off that node in both directions at one pinned pose
    // and reports the crossover, which is what turns "it dies here" into a rule.
    const pinnedPose = rows.find((r) => r.died && Number.isFinite(r.pinnedClearance));
    if (pinnedPose) {
      console.log(
        `\nwall standoff sweep at ${ARENA_DEFS[pinnedPose.arena].id} spawn=${pinnedPose.spawn}` +
          ` ${pinnedPose.away > 0 ? '+x' : '-x'} (+preLay = mine nearer the wall)`,
      );
      console.log('  preLay  pinnedAt  clear@det  margin      died');
      for (const preLay of [7, 3, 1, 0, -1, -3, -7, -10, -14, -20, -30]) {
        const r = escapeRun(pinnedPose.arena, pinnedPose.spawn, pinnedPose.away, true, 0, preLay);
        console.log(
          `  ${String(preLay).padStart(6)}  ${(Number.isFinite(r.pinnedClearance) ? r.pinnedClearance.toFixed(4) : ' never').padStart(8)}` +
            `  ${r.clearanceAtDetonation.toFixed(4).padStart(9)}  ${r.marginRaw.toExponential(2).padStart(10)}  ${r.died ? 'YES' : 'no'}`,
        );
      }
    }

    // The fatal poses in full, with the unrounded margin, so no claim rests on a
    // rounded print.
    console.log('\nfatal poses at k=0');
    for (const r of rows.filter((x) => x.died)) {
      console.log(
        `  ${ARENA_DEFS[r.arena].id} spawn=${r.spawn} ${r.away > 0 ? '+x' : '-x'}` +
          `  clearance=${r.clearanceAtDetonation}  margin=${r.marginRaw.toExponential(4)}` +
          `  pinnedAt=${Number.isFinite(r.pinnedClearance) ? r.pinnedClearance.toFixed(4) : 'never'}` +
          `  ${r.isOpen ? 'OPEN' : 'non-open'}`,
      );
    }
  });
});
