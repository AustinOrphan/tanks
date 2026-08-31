/// <reference types="vite/client" />
import { describe, it } from 'vitest';
import { step, stepInputs } from './world';
import { createWorldFor } from './arena';
import { ARENA_DEFS, arenaById } from './config/arenas';
import { createPlayerAiState, decidePlayerInput, mulberry32 } from './ai/player-profile';
import { configFor } from './config';
import { COUNTDOWN_TICKS, TICK_HZ } from './constants';
import type { World } from './world';

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped by default: how often the active-shell cap actually
// refuses a shot, and in what BURSTS (issue #356).
//
// #356 has to pick a cue for a refusal, and its own criteria include "whether repeated
// attempts become annoying or noisy" and "held/spammed fire cannot create unbounded sound,
// vibration, toast, or animation output". Both are questions about a RATE, and neither can
// be answered by looking at the code: a refusal that happens twice a match can carry a loud
// cue, and one that happens sixty times a second cannot carry any cue without a limiter.
//
// This measures the rate. It does not choose a treatment -- that needs the normal-speed
// comparison the issue requires and is not something a deterministic harness can supply.
//
// Usage: VITE_RUN_MEASURE=1 npx vitest run src/sim/shell-cap-refusal.measure.test.ts
//
// Read via `import.meta.env`, NOT `process.env`: purity.test.ts's FORBIDDEN_GLOBALS bans
// that bare token anywhere in src/sim/, test files included.
//
// TWO DRIVERS, and the distinction is the point:
//
//   HELD    -- fire pressed on every single tick. Not a realistic player, deliberately:
//              it is the WORST CASE the rate-limit criterion has to survive, and its
//              numbers are an upper bound rather than an estimate.
//   BOT     -- decidePlayerInput, the same scripted player the playtest harnesses use.
//              A proxy for a human and stated as one; it fires on its own judgement, so
//              its refusal rate is the closer of the two to ordinary play.
//
// The countdown is excluded from every rate: fire is blocked outright for its 180 ticks
// (world.ts's `canAct`), so counting them would dilute every number here.
// ---------------------------------------------------------------------------

const SECONDS = 60;
const SEEDS = [1, 2, 3];
const ARENAS_UNDER_TEST = [0, 1, 2];

interface Row {
  label: string;
  refusals: number;
  shots: number;
  liveTicks: number;
  longestBurst: number;
  bursts: number;
}

function summarise(r: Row): string {
  const perMin = (r.refusals / (r.liveTicks / TICK_HZ)) * 60;
  return (
    `${r.label.padEnd(6)} refusals=${String(r.refusals).padStart(5)}  shots=${String(r.shots).padStart(4)}` +
    `  perMinute=${perMin.toFixed(1).padStart(7)}  bursts=${String(r.bursts).padStart(4)}` +
    `  longestBurst=${String(r.longestBurst).padStart(4)}t (${(r.longestBurst / TICK_HZ).toFixed(2)}s)` +
    `  liveTicks=${r.liveTicks}`
  );
}

const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('shell-cap refusal rate (set VITE_RUN_MEASURE=1 to run)', () => {
  it('reports refusals per minute and the longest unbroken burst', () => {
    const rows: Row[] = [];

    for (const held of [true, false]) {
      const row: Row = {
        label: held ? 'HELD' : 'BOT',
        refusals: 0, shots: 0, liveTicks: 0, longestBurst: 0, bursts: 0,
      };
      for (const seed of SEEDS) {
        for (const ai of ARENAS_UNDER_TEST) {
          let w = createWorldFor(arenaById(ARENA_DEFS[ai].id), seed) as World;
          const player = w.tanks.find((t) => t.kind === 'player');
          if (!player) continue;
          const pid = player.id;
          const rnd = mulberry32(seed * 7 + 1);
          const state = createPlayerAiState(rnd);
          let burst = 0;

          for (let t = 0; t < TICK_HZ * SECONDS; t++) {
            const p = w.tanks.find((x) => x.id === pid);
            if (!p) break;
            const res = held
              ? step(w, { move: { x: 1, y: 0 }, aim: { x: p.pos.x + 50, y: p.pos.y }, fire: true, mine: false })
              : stepInputs(w, [decidePlayerInput(w, pid, rnd, state)]);
            w = res.world;
            if (w.tick > COUNTDOWN_TICKS) {
              row.liveTicks++;
              const refused = res.events.some(
                (e) => e.type === 'fire-blocked' && e.ownerId === pid && e.reason === 'shell-cap',
              );
              row.shots += res.events.filter((e) => e.type === 'fire' && e.ownerId === pid).length;
              if (refused) {
                row.refusals++;
                burst++;
                row.longestBurst = Math.max(row.longestBurst, burst);
              } else {
                if (burst > 0) row.bursts++;
                burst = 0;
              }
            }
            if (w.status !== 'playing') break;
          }
          if (burst > 0) row.bursts++;
        }
      }
      rows.push(row);
    }

    console.log(
      `\nplayer shell cap ${configFor('player').weapon.maxActiveProjectiles}; ` +
        `${SEEDS.length} seeds x ${ARENAS_UNDER_TEST.length} arenas, ${SECONDS}s each, countdown excluded\n`,
    );
    for (const r of rows) console.log(summarise(r));
    const held = rows[0];
    console.log(
      `\nHELD is the bound the rate-limit criterion has to survive: one refusal every tick of a ` +
        `burst is ${TICK_HZ} cues per second unlimited, and its longest burst here is ` +
        `${held.longestBurst} ticks (${(held.longestBurst / TICK_HZ).toFixed(2)}s).`,
    );
  });
});
