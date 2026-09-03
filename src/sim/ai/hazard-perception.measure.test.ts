/// <reference types="vite/client" />
import { describe, it } from 'vitest';
import { ARENAS, createWorldFor } from '../arena';
import { step } from '../world';
import { configFor } from '../config';
import { incomingThreats } from './targeting';
import { hazardPerceptionSample, perceiveHazards } from './hazard-perception';
import { withBotDifficulty, BOT_DIFFICULTIES, type BotDifficulty } from './bot-difficulty';
import { AI_MINE_FLEE_RADIUS, MINE_BLAST_RADIUS, TANK_RADIUS } from '../constants';
import type { World } from '../world';

// ---------------------------------------------------------------------------
// THE DEVELOPER TRACE issue #223 asks for, kept as a harness rather than a runtime flag:
// "keep a developer trace comparing actual and perceived hazard state".
//
// WHY A HARNESS AND NOT A DEV FLAG. `src/sim/` is forbidden runtime feature flags, so a
// trace that lived inside the simulation would either be a purity violation or a permanent
// allocation on the hot path. `hazardPerceptionSample` (ai/hazard-perception.ts) is instead
// a pure function nothing in `step` calls, and this file is its consumer -- the same shape
// every other measurement in this directory takes.
//
// Usage: VITE_RUN_MEASURE=1 npx vitest run src/sim/ai/hazard-perception.measure.test.ts
//
// Read via `import.meta.env`, NOT `process.env`: purity.test.ts's FORBIDDEN_GLOBALS bans
// that bare token anywhere in src/sim/, test files included.
//
// WHAT IT REPORTS, per difficulty, over real stepped matches:
//   delay        mean staleness of the hazard picture, in ticks
//   shellErr     mean and P95 metres between where a shell IS and where it is believed to be
//   missed       tick-samples where a shell inside the TRUE danger corridor is not perceived
//                -- a dodge that will not happen
//   phantom      tick-samples where a shell is perceived that is not really a threat
//                -- a dodge that did not need to happen
//   fatalRead    tick-samples whose PERCEIVED flee radius sits inside the radius a blast
//                actually kills at, i.e. the tank believes it is safe where it is not
//
// The last column is the one that answers issue #223's acceptance criteria directly, and it
// is deliberately the same quantity `hazard-competence.test.ts` asserts an ordering on --
// this file reports it over stepped play rather than over a synthetic draw sweep, so the two
// are independent reads on the same claim.
//
// ---------------------------------------------------------------------------
// WHAT IT MEASURED (2026-09-02, this tree). 8 arenas x 6 seeds x 1800 ticks, sampled every
// 30 ticks: 7866 tank-samples per arm, the same population for all three because the sample
// is taken over the SAME stepped games at each difficulty.
//
//   arm      samples   delay(mean ticks)   shellErr mean/P95   missed  phantom  fatalRead%
//   easy        7866                5.21         0.289/0.900       48       35       24.94
//   normal      7866                3.04         0.168/0.500       31       19        0.78
//   hard        7866                2.10         0.117/0.400       12       34        0.00
//
// FOUR OF THE FIVE COLUMNS ARE MONOTONE and in the direction the issue asks for. `hard`'s
// picture is 2.10 ticks stale on average and its shells are believed 0.117 units from where
// they are -- smaller than `normal`, never zero, which is "faster and more consistent, but
// never perfect" as a measurement rather than as a claim. `easy` believes it is safe inside
// the radius a blast actually kills at on a QUARTER of samples, against `normal`'s 0.78%.
//
// PHANTOM IS NOT MONOTONE, and that is a result rather than a defect: 35 / 19 / 34. `easy`
// invents threats because its radius error is wide in BOTH directions; `hard` invents them
// because its safety margin (+0.2 world units) genuinely widens the corridor it treats as
// dangerous. Those are different mistakes with the same name -- one is a bad read, the other
// is caution -- and the column cannot tell them apart. Read `missed` for competence and this
// one only alongside it.
//
// NOT A TUNING RECOMMENDATION. Issue #223 asks for modifiers "selected from deterministic
// sweeps AND representative normal-speed play evidence"; this is the first half only.
// ---------------------------------------------------------------------------

/** What a blast actually kills at -- NOT the flee radius, which already carries a margin. */
const KILL_RADIUS = MINE_BLAST_RADIUS + TANK_RADIUS;
const SEEDS = [1, 2, 3, 4, 5, 6];
const TICKS = 1800; // 30 simulated seconds per run
/** Sampled every SAMPLE_EVERY ticks so one refresh window contributes ~1 sample, not 30. */
const SAMPLE_EVERY = 30;

interface Row {
  delays: number[];
  shellErrors: number[];
  missed: number;
  phantom: number;
  fatalReads: number;
  samples: number;
}

function emptyRow(): Row {
  return { delays: [], shellErrors: [], missed: 0, phantom: 0, fatalReads: 0, samples: 0 };
}

function sweep(difficulty: BotDifficulty): Row {
  const row = emptyRow();
  for (const arena of ARENAS) {
    for (const seed of SEEDS) {
      let w: World = createWorldFor(arena, seed);
      for (let t = 0; t < TICKS && w.status === 'playing'; t++) {
        const d = { x: Math.cos(t / 37), y: Math.sin(t / 41) };
        w = step(w, { move: d, aim: d, fire: t % 23 === 0, mine: t % 311 === 0 }).world;
        if (t % SAMPLE_EVERY !== 0) continue;
        for (const tank of w.tanks) {
          if (!tank.alive || tank.kind === 'player') continue;
          // The difficulty is applied here rather than in `stepAi`, which resolves the
          // authored profile: campaign enemies carry no preset, so this reads what the SAME
          // tank would believe at each difficulty rather than pretending it plays at one.
          const cfg = withBotDifficulty(configFor(tank.kind), difficulty);
          const s = hazardPerceptionSample(w, tank, cfg,
            (world, corridor) => incomingThreats(world, tank, corridor).map((b) => b.id));
          row.delays.push(s.delayTicks);
          row.shellErrors.push(s.maxShellPositionError);
          row.missed += s.missedThreats;
          row.phantom += s.phantomThreats;
          if (perceiveHazards(w, tank, cfg).fleeRadius < KILL_RADIUS) row.fatalReads++;
          row.samples++;
        }
      }
    }
  }
  return row;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const p95 = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};

const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('hazard perception: actual against perceived (VITE_RUN_MEASURE=1)', () => {
  it('reports the divergence each difficulty lives with', () => {
    console.log(
      `\n${ARENAS.length} arenas x ${SEEDS.length} seeds x ${TICKS} ticks,` +
      ` sampled every ${SAMPLE_EVERY} ticks. True flee radius ${AI_MINE_FLEE_RADIUS},` +
      ` true kill radius ${KILL_RADIUS}.\n`,
    );
    console.log('arm      samples   delay(mean ticks)   shellErr mean/P95   missed  phantom  fatalRead%');
    for (const d of BOT_DIFFICULTIES) {
      const r = sweep(d);
      console.log(
        `${d.padEnd(8)} ${String(r.samples).padStart(7)}   ` +
        `${mean(r.delays).toFixed(2).padStart(17)}   ` +
        `${mean(r.shellErrors).toFixed(3)}/${p95(r.shellErrors).toFixed(3)}`.padStart(19) + '   ' +
        `${String(r.missed).padStart(6)}  ${String(r.phantom).padStart(7)}  ` +
        `${((r.fatalReads / Math.max(1, r.samples)) * 100).toFixed(2).padStart(9)}`,
      );
    }
  }, 600_000);
});
