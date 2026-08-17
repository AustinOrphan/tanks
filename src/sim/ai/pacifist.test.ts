import { describe, it, expect } from 'vitest';
import { createArenaWorld } from '../arena';
import { step } from '../world';

/**
 * The AI's headline metric: against a player who NEVER fires, the enemies must still win.
 * A 'win' here means the player cleared the arena without pulling the trigger once, so
 * every enemy died to its own side.
 *
 * This is a whole-game behavioural test rather than a unit test on purpose. Every defect
 * it has caught was invisible to unit tests: the units each behaved as specified and the
 * self-destruction only emerged from three tanks, two mines each and a boxed arena full of
 * ricochets interacting over thousands of ticks. It has also regressed twice under changes
 * that looked like improvements and passed every other test, which is why the threshold is
 * asserted in CI instead of being measured by hand when someone remembers to.
 *
 * The player wanders instead of standing still: Brown is a spec'd stationary gunner, so a
 * player parked out of its line of sight can deadlock a round forever with no bug involved.
 */
const TICK_CAP = 60 * 60 * 5; // 5 simulated minutes at 60Hz
const SEEDS = 60;
// Measured 0/60 once mine-laying became tactical, against 19/60 (31.7%) before any of the
// fixes. The bar allows a couple of rounds' worth of slack so ordinary AI tuning does not
// fail the build, while staying far below the old number. Every seed is fixed, so this
// number moves only when behaviour actually changes -- and it did, once: directive B's
// estimation error (2026-08-16 owner ruling) makes dodging occasionally wrong on purpose,
// re-measured at 1/60 (shotsPerRound 36.6, minesPerRound 2.67, medianKillTicks 1693 across
// the same 60 seeds), still comfortably inside the bar.
const MAX_FREE_WIN_RATE = 0.05;

// A wander independent of the sim's own PRNG, so driving the player cannot perturb the
// sequence the AI draws from and change what is being measured.
function mulberry(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playPacifist(seed: number) {
  let w = createArenaWorld(seed);
  const rnd = mulberry(seed * 7919 + 13);
  let heading = rnd() * Math.PI * 2;
  let ticks = 0;
  let fires = 0;
  let mines = 0;

  while (w.status === 'playing' && ticks < TICK_CAP) {
    if (ticks % 45 === 0) heading += (rnd() - 0.5) * 2.4;
    const dir = { x: Math.cos(heading), y: Math.sin(heading) };
    const r = step(w, { move: dir, aim: dir, fire: false, mine: false });
    fires += r.events.filter((e) => e.type === 'fire').length;
    mines += r.events.filter((e) => e.type === 'mine-dropped').length;
    ticks++;
    w = r.world;
  }
  return { outcome: w.status === 'playing' ? 'timeout' : w.status, ticks, fires, mines };
}

describe('AI vs a player who never fires', () => {
  const rows = Array.from({ length: SEEDS }, (_, i) => playPacifist(i + 1));

  it('does not hand the player a free win by destroying itself', () => {
    const freeWins = rows.filter((r) => r.outcome === 'win');
    const rate = freeWins.length / SEEDS;
    expect(
      rate,
      `${freeWins.length}/${SEEDS} rounds were won by a player who never fired`,
    ).toBeLessThanOrEqual(MAX_FREE_WIN_RATE);
  });

  it('still shoots: the fix must not buy safety by making the AI passive', () => {
    // The friendly-fire veto refuses shots, so the cheap way to pass the test above is an
    // AI that never pulls the trigger. Measured at ~30 shots per round.
    const shotsPerRound = rows.reduce((n, r) => n + r.fires, 0) / SEEDS;
    expect(shotsPerRound).toBeGreaterThan(15);
  });

  it('lays mines tactically rather than whenever the cooldown allows', () => {
    // The old rule dropped a mine on cooldown regardless of where anyone was: 9.7 per
    // round, of which the overwhelming majority only ever endangered the tank that laid
    // them. Gating on the player being in range gives 4.3 per round. The upper bound is
    // the real assertion; the lower bound guards the opposite regression, an AI that has
    // quietly stopped using mines at all.
    const perRound = rows.reduce((n, r) => n + r.mines, 0) / SEEDS;
    expect(perRound).toBeGreaterThan(1);
    expect(perRound).toBeLessThan(7);
  });

  it('still kills the player promptly in the rounds it wins', () => {
    // Guards the other degenerate pass: enemies that survive by hiding. Measured median
    // ~1700 ticks (28s); the bar is generous so arena tweaks do not fail the build.
    const kills = rows.filter((r) => r.outcome === 'lose').map((r) => r.ticks).sort((a, b) => a - b);
    expect(kills.length).toBeGreaterThan(SEEDS / 2);
    expect(kills[kills.length >> 1]).toBeLessThan(TICK_CAP / 2);
  });
});
