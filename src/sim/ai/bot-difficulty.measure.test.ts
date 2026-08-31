/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { createWorldFor } from '../arena';
import { arenaById } from '../config/arenas';
import { stepInputs } from '../world';
import { createPlayerAiState, decidePlayerInput, mulberry32 } from './player-profile';
import { BOT_DIFFICULTIES, type BotDifficulty } from './bot-difficulty';
import type { GameMode } from '../types';

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped by default: do the COMPETENCE multipliers actually
// CHANGE ANYTHING a player could notice (issues #223 and #267)?
//
// bot-difficulty.ts says so itself: "THE NUMBERS ARE PROVISIONAL. Both issues ask for
// modifiers 'selected from deterministic sweeps and representative normal-speed play
// evidence', and no such sweep has been run." This is that sweep. It does not pick new
// numbers -- that needs the normal-speed human read both issues also require -- it
// establishes whether the shipped multipliers are LIVE, ORDERED, and BIG ENOUGH to be
// worth a menu entry.
//
// WHAT IS ACTUALLY UNDER TEST. `bot-difficulty.test.ts` already pins that
// `withBotDifficulty` returns a differently-scaled config: easy 0.65/0.65/1.7, hard
// 1.25/1.25/0.7 against normal's identity. That is a statement about a config object.
// Nothing anywhere pins that the scaled config reaches an OUTCOME -- and a modifier that
// moves three numbers and no match result is a dead knob wearing a menu label. Config
// deltas are not outcome deltas, which is the whole reason this file steps real matches
// rather than asserting on `withBotDifficulty`'s return value.
//
// Usage: VITE_RUN_MEASURE=1 npx vitest run src/sim/ai/bot-difficulty.measure.test.ts
//
// Read via `import.meta.env`, NOT `process.env`: purity.test.ts's FORBIDDEN_GLOBALS bans
// that bare token anywhere in src/sim/, test files included.
//
// THE SHAPE. One duel per (difficulty, seed): slot 0 plays at the difficulty under test,
// slot 1 always plays `normal`. So `normal` vs `normal` is the CONTROL ARM, and its win
// rate is the board's own asymmetry -- whatever the spawn geometry and turn order are
// worth before difficulty enters. Reading easy's or hard's win rate against 50% rather
// than against that control would credit difficulty with the board's bias.
//
// ---------------------------------------------------------------------------
// WHAT IT MEASURED. vs-duel-01, ffa, 90 s per match, 16 seeds per arm (48 matches):
//
//   arm      W   D   L   deaths taken  deaths dealt  shots fired  first kill (med)
//   easy     0   4  12        34            12            58          22.9 s
//   normal   7   5   4        20            27           102          22.4 s   <- control
//   hard     8   4   4        21            28           121          22.8 s
//
// `normal` is the control arm -- normal against normal -- so slot 0's 7-5-4 there is the
// board's own asymmetry, and the other two arms are read against THAT, not against 50%.
//
// EASY WORKS, AND STRONGLY. 0 wins in 16, and the kill ledger inverts: 34 deaths taken
// against 12 dealt, where the control is 20 against 27. Whatever else is unresolved, the
// easy multipliers reach the match.
//
// HARD CHANGES BEHAVIOUR BUT NOT OUTCOME. It fires 121 shots against the control's 102
// -- a real and expected consequence of reactionTime x0.7 -- yet its record (8-4-4, 21
// deaths taken, 28 dealt) is the control's record (7-5-4, 20, 27) within noise at this
// population. So at the shipped 1.25/1.25/0.7, `hard` is measurably busier and not
// measurably better.
//
// That is a finding about the NUMBERS, not the structure: `withBotDifficulty` composes
// correctly and `easy` proves the path is live end to end. What it says is that the hard
// multipliers are too small to separate from normal on this board, or that the scripted
// profile is already near its ceiling here and accuracy is not the binding constraint.
// Picking better numbers needs the normal-speed human read both issues also require;
// this harness can only say that the current ones do not separate.
//
// A NOTE ON POPULATION, because the first run of this sweep got it wrong. At 8 seeds
// hard read 3-2-3 against a control of 4-3-1, which looks like hard being WORSE. At 16
// the two converge. Eight matches cannot resolve a difference this size, and the earlier
// number should not be quoted.
// ---------------------------------------------------------------------------
//
// THE RNG STREAM IS KEYED ON SEED AND SLOT ALONE, never on the difficulty, matching
// loop.ts's own comment on `createBotSources`: keying it on difficulty too would re-roll
// every subsequent decision, so an A/B would compare two different matches rather than
// the same match played by a differently-competent bot.
// ---------------------------------------------------------------------------

const HZ = 60;
const SECONDS = 90;
// 24 seeds, not 8: the first run of this sweep put hard at 3W/3L against a normal-vs-normal
// control of 4W/1L, which is a difference no eight-match arm can resolve. Chosen so each arm
// is a fixed, stated population rather than "enough".
const SEEDS = [7, 11, 23, 41, 59, 83, 97, 113, 131, 149, 167, 181, 199, 211, 233, 251];
const MODE: GameMode = 'ffa' as GameMode;

interface Match {
  /** Kills credited to each slot, by the slot whose tank died. */
  deaths: [number, number];
  shots: [number, number];
  firstKillTick: number;
  winner: number | null;
}

function duel(difficulty: BotDifficulty, seed: number): Match {
  const arena = arenaById('vs-duel-01');
  let w = createWorldFor(arena, seed, undefined, 3, undefined, undefined, 2, undefined, MODE);
  const players = w.tanks.filter((t) => t.kind === 'player').map((t) => t.id);
  const rnd = players.map((_, i) => mulberry32(seed * 31 + i + 1));
  const ai = rnd.map((r) => createPlayerAiState(r));
  const per: BotDifficulty[] = [difficulty, 'normal'];
  const m: Match = { deaths: [0, 0], shots: [0, 0], firstKillTick: -1, winner: null };
  for (let t = 0; t < HZ * SECONDS; t++) {
    const inputs = players.map((id, i) => decidePlayerInput(w, id, rnd[i], ai[i], per[i]));
    const res = stepInputs(w, inputs);
    w = res.world;
    for (const e of res.events) {
      if (e.type === 'fire') {
        const i = players.indexOf(e.ownerId);
        if (i >= 0) m.shots[i]++;
      }
      if (e.type === 'tank-destroyed') {
        const i = players.indexOf(e.tankId);
        if (i >= 0) m.deaths[i]++;
        if (m.firstKillTick < 0) m.firstKillTick = w.tick;
      }
    }
    if (w.status !== 'playing') break;
  }
  // Fewer deaths wins. A draw stays null rather than being scored for either side.
  m.winner = m.deaths[0] === m.deaths[1] ? null : m.deaths[0] < m.deaths[1] ? 0 : 1;
  return m;
}

const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('bot difficulty: do the COMPETENCE multipliers reach an outcome? (VITE_RUN_MEASURE=1)', () => {
  it('sweeps easy/normal/hard against a normal opponent', () => {
    console.log(
      `\nvs-duel-01, ${MODE}, ${SECONDS}s per match, ${SEEDS.length} seeds per arm.` +
        ` Slot 0 plays the arm, slot 1 always plays normal.\n`,
    );
    console.log('arm     wins  draws  losses   deathsFor  deathsAgainst   shotsFor  firstKill(med s)');
    const byArm = new Map<BotDifficulty, Match[]>();
    for (const d of BOT_DIFFICULTIES) {
      const runs = SEEDS.map((s) => duel(d, s));
      byArm.set(d, runs);
      const wins = runs.filter((r) => r.winner === 0).length;
      const draws = runs.filter((r) => r.winner === null).length;
      const fk = runs.map((r) => r.firstKillTick).filter((t) => t > 0).sort((a, b) => a - b);
      const med = fk.length ? (fk[Math.floor(fk.length / 2)] / HZ).toFixed(1) : 'none';
      console.log(
        `${d.padEnd(7)} ${String(wins).padStart(4)}  ${String(draws).padStart(5)}  ` +
          `${String(runs.length - wins - draws).padStart(6)}   ` +
          `${String(runs.reduce((a, r) => a + r.deaths[0], 0)).padStart(9)}  ` +
          `${String(runs.reduce((a, r) => a + r.deaths[1], 0)).padStart(13)}   ` +
          `${String(runs.reduce((a, r) => a + r.shots[0], 0)).padStart(8)}  ${med.padStart(16)}`,
      );
    }

    // THE DEAD-KNOB CHECK, and the reason this file exists. If the three arms produce
    // identical match records then the multipliers never reached the sim, and every
    // number printed above is describing one match played three times.
    const fingerprint = (runs: Match[]) => JSON.stringify(runs.map((r) => [r.deaths, r.shots, r.firstKillTick]));
    const prints = BOT_DIFFICULTIES.map((d) => fingerprint(byArm.get(d)!));
    const distinct = new Set(prints).size;
    console.log(`\ndistinct match records across the ${BOT_DIFFICULTIES.length} arms: ${distinct}`);
    if (distinct === 1) {
      console.log('DEAD KNOB: every arm played identically -- the multipliers do not reach the match.');
    }
    expect(distinct, 'the difficulty arms produced identical matches, so the knob is not wired').toBeGreaterThan(1);
  }, 600000);
});
