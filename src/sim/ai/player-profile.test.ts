import { describe, it, expect } from 'vitest';
import { ARENAS, createWorldFor } from '../arena';
import { step } from '../world';
import { decidePlayerInput, createPlayerAiState, mulberry32 } from './player-profile';

/**
 * The competent-player headline metric: the same shape as pacifist.test.ts (a
 * player-controlled tank driven headlessly and seeded, one game per seed), except this
 * player actually FIGHTS. Where pacifist.test.ts's number is "how bad can the player be
 * and still lose" (a ceiling on AI self-destruction), this one is "how good can a
 * modest scripted player be" -- a second, independent read on AI/arena difficulty that
 * no unit test on a single decision function can produce, because the result only
 * exists after thousands of ticks of dodging, positioning and reaction-gated fire
 * interacting with the enemies' own behaviour.
 *
 * `rnd` is `mulberry32` from player-profile.ts, seeded independently of `w.seed`: driving
 * the player must not perturb the sequence the enemy AI draws from, or this changes the
 * very thing it measures (see player-profile.ts's module comment, and pacifist.test.ts's
 * local `mulberry`, which this mirrors).
 */
const TICK_CAP = 60 * 60 * 5; // 5 simulated minutes at 60Hz, same cap as pacifist.test.ts

function playCompetent(arenaIdx: number, seed: number) {
  let w = createWorldFor(ARENAS[arenaIdx], seed);
  const player = w.tanks.find((t) => t.kind === 'player');
  if (!player) throw new Error('no player spawn');
  const playerId = player.id;
  // A different multiplier/offset than pacifist.test.ts's `seed * 7919 + 13` and
  // engagement.measure.test.ts's identical constant, so this harness's stream is not
  // merely independent of the sim's but also independent of the OTHER headless
  // harnesses' player streams -- three harnesses coincidentally sharing a seed
  // formula would still each be internally consistent, but a bug that only shows up
  // when two RNG streams alias would be invisible to all three at once.
  const rnd = mulberry32(seed * 104729 + 31);
  const state = createPlayerAiState(rnd);
  let ticks = 0;
  let fires = 0;
  let mines = 0;
  let selfMineDeath = false;

  while (w.status === 'playing' && ticks < TICK_CAP) {
    const input = decidePlayerInput(w, playerId, rnd, state);
    const r = step(w, input);
    fires += r.events.filter((e) => e.type === 'fire' && e.ownerId === playerId).length;
    mines += r.events.filter((e) => e.type === 'mine-dropped' && e.ownerId === playerId).length;
    for (const e of r.events) {
      if (e.type === 'tank-destroyed' && e.tankId === playerId) {
        selfMineDeath = e.by.source === 'blast' && e.by.ownerId === playerId;
      }
    }
    ticks++;
    w = r.world;
  }
  return { outcome: w.status === 'playing' ? 'timeout' : w.status, ticks, fires, mines, selfMineDeath };
}

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped in CI on purpose -- same convention as
// engagement.measure.test.ts. Flip describe.skip to describe and run
//   npx vitest run src/sim/ai/player-profile.test.ts
// to re-measure after any change to decidePlayerInput or to an AI profile/arena.
// The pinned assertions below use a smaller population (25 seeds, not this block's 60)
// to keep the normal test run's cost down; they were re-measured directly at that
// smaller N, not extrapolated from this block's numbers. Both populations are reported
// here so a future change can compare either.
// ---------------------------------------------------------------------------
describe.skip('competent-player measurement (flip skip off to run locally)', () => {
  it('reports win/loss/timeout rates per arena', () => {
    const SEEDS = 60;
    for (let a = 0; a < ARENAS.length; a++) {
      let wins = 0, losses = 0, timeouts = 0, selfMineDeaths = 0;
      let fires = 0, mines = 0;
      const winTicks: number[] = [];
      const lossTicks: number[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = playCompetent(a, seed);
        if (r.outcome === 'win') { wins++; winTicks.push(r.ticks); }
        else if (r.outcome === 'lose') { losses++; lossTicks.push(r.ticks); if (r.selfMineDeath) selfMineDeaths++; }
        else timeouts++;
        fires += r.fires;
        mines += r.mines;
      }
      winTicks.sort((x, y) => x - y);
      lossTicks.sort((x, y) => x - y);
      const median = winTicks.length ? winTicks[winTicks.length >> 1] : NaN;
      const medianLoss = lossTicks.length ? lossTicks[lossTicks.length >> 1] : NaN;
      console.log(
        `arena${a + 1}: wins=${wins}/${SEEDS} losses=${losses}/${SEEDS} ` +
        `timeouts=${timeouts}/${SEEDS} medianWinTicks=${median} medianLossTicks=${medianLoss} ` +
        `selfMineDeaths=${selfMineDeaths}/${losses} ` +
        `firesPerGame=${(fires / SEEDS).toFixed(1)} minesPerGame=${(mines / SEEDS).toFixed(2)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// PINNED assertions, run on every `npm test`. Population: the 4 shipped arenas x 25
// seeds each = 100 games -- a smaller sample than the measurement block above (60 seeds)
// purely to keep this file's runtime down (a 5-simulated-minute cap x 100 games still
// takes real wall-clock seconds); re-measured directly AT this population rather than
// assumed from the 60-seed numbers, since a smaller sample is not guaranteed to land on
// the same rate. Computed once, in the describe body (mirrors pacifist.test.ts's `rows`),
// so every `it` below reads the same 100 games instead of re-simulating per assertion.
//
// Measured at this population (headless run of this exact file, current
// decidePlayerInput):
//   arena1: 21/25 wins  arena2: 16/25  arena3: 7/25  arena4: 6/25
//   total: 50/100 wins, 50/100 losses, 0/100 timeouts
//   self-mine deaths: 5/50 losses (all 5 in arena2)
//   fires/game: arena1 21.7 arena2 14.4 arena3 49.6 arena4 34.7
//   mines/game: arena1 1.48 arena2 6.52 arena3 4.40 arena4 3.12
// ---------------------------------------------------------------------------
describe('a competent scripted player against the shipped arenas', () => {
  const SEEDS = 25;
  const perArena = ARENAS.map((_, a) => Array.from({ length: SEEDS }, (_, i) => playCompetent(a, i + 1)));
  const all = perArena.flat();
  const winRate = (a: number) => perArena[a].filter((r) => r.outcome === 'win').length / SEEDS;

  it('wins a meaningful share of games against the shipped roster', () => {
    // Population: 100 games (4 shipped arenas x 25 seeds). Measured 50/100 (50%).
    // Bounded well below that so ordinary AI/arena tuning does not fail the build; a
    // regression that makes the scripted player hapless (rate collapses toward 0) trips
    // it -- confirmed: `fire = false` drops this to 5/100 and dies here.
    //
    // NO upper bound: an "aimbot ceiling" was tried and dropped. Three escalating
    // buffs -- perfect aim + instant fire (zero jitter, reactionTicks 0), the same plus
    // ignoring lineOfSight for targeting, and the same plus permanent full-speed
    // kiting -- were each applied in isolation and measured on this exact 100-game
    // population: 48/100, 15/100 and 15/100 respectively. None exceeded the unmodified
    // 50/100, and two were WORSE (a wall-blind target wastes fire on an enemy it cannot
    // hit; permanent kiting forfeits position). So win rate here is bounded by
    // survival/positioning, not by offense, and no buff to THIS file's own levers was
    // found that pushes it toward 1 -- an upper bound would have been unfalsifiable by
    // any mutation actually tried, which is exactly the decorative-assertion trap
    // CLAUDE.md warns against. If a real "shoots through everything, never misses,
    // never dies" bug ever needs catching, it will need a mutation this file's movement
    // model cannot express (e.g. bypassing dangerAvoidMove's own geometry), which is
    // out of this issue's scope.
    const wins = all.filter((r) => r.outcome === 'win').length;
    const rate = wins / all.length;
    expect(rate, `${wins}/${all.length} games won`).toBeGreaterThan(0.2);
  });

  it('reads arena-01 as easier than arena-03 and arena-04', () => {
    // Measured win rates: arena-01 21/25 (84%), arena-03 7/25 (28%), arena-04 6/25 (24%)
    // -- a >50-point gap either way, wide enough to stay a stable ordinal claim under
    // ordinary tuning rather than sitting on a fragile boundary. This is the
    // "level 4 is harder than level 1" kind of claim the issue asks this harness to make
    // measurable; it does not by itself distinguish arena-03 from arena-04 (28% vs 24%
    // is within the noise a small tuning change could flip).
    //
    // Mutation note: every production mutation tried against this assertion (disabling
    // dodging, forcing point-blank ramming, both together) collapsed EVERY arena's win
    // rate toward 0 rather than closing the gap non-degenerately, so the cleanest kill
    // found was arena-01 and arena-03 both landing at 0/25 (`0 > 0` correctly fails).
    // The real, unmutated 56-84-point gaps above are the actual evidence this assertion
    // is not a tautology; no mutation was found that flips the order while both sides
    // stay above zero.
    expect(winRate(0), 'arena-01 vs arena-03').toBeGreaterThan(winRate(2));
    expect(winRate(0), 'arena-01 vs arena-04').toBeGreaterThan(winRate(3));
  });

  it('still shoots: reaction-gated fire is not the same as passive', () => {
    // Population: same 100 games. Measured per-arena averages 14.4-49.6 fires/game; the
    // bar sits far below the lowest observed so it only catches an accidental
    // "never/rarely fires" regression, not ordinary aim/reaction retuning.
    const fires = all.reduce((n, r) => n + r.fires, 0);
    expect(fires / all.length).toBeGreaterThan(5);
  });

  it('lays mines occasionally rather than never or constantly', () => {
    // Population: same 100 games. Measured per-arena averages 1.48-6.52 mines/game.
    const mines = all.reduce((n, r) => n + r.mines, 0);
    const perGame = mines / all.length;
    expect(perGame, `${mines} mines over ${all.length} games`).toBeGreaterThan(0.3);
    expect(perGame, `${mines} mines over ${all.length} games`).toBeLessThan(15);
  });

  it('does not routinely kill itself with its own mine', () => {
    // Population: all LOSSES across the 100 games (a self-mine death can only happen in
    // a loss), measured at 50. Self-mine share measured 5/50 (10%), all in arena-02. The
    // residual is real and documented (PLAYER_MINE_CHANCE's comment in
    // player-profile.ts) -- this is a regression guard against it becoming the DOMINANT
    // cause of death, not a claim that it is eliminated.
    const losses = all.filter((r) => r.outcome === 'lose');
    const selfMine = losses.filter((r) => r.selfMineDeath).length;
    expect(losses.length, 'population: losses only, out of 100 games').toBeGreaterThan(0);
    expect(selfMine / losses.length, `${selfMine}/${losses.length} losses were self-mine`).toBeLessThan(0.5);
  });
});

/**
 * Freeze an object graph, so any write to it throws instead of passing silently.
 * ES modules are strict mode, so a frozen-property assignment is a TypeError.
 */
function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner, seen);
  return Object.freeze(value);
}

describe('the scripted player cannot perturb what it measures', () => {
  it('never writes to the world it is handed', () => {
    // THIS is the guard for the RNG-isolation property, and it exists because the
    // evidence originally cited for that property was worthless.
    //
    // The PR claimed `tools/baseline/trace.test.ts`'s golden fingerprint proved it: "if
    // the player AI had touched an enemy draw, that trace would have moved." It would
    // not. That file imports only `arena`, `world` and `node:crypto` -- it never calls
    // `decidePlayerInput` at all, and drives every game with a fixed sinusoidal input.
    // Review proved it by adding `world.seed += 999999` inside `decidePlayerInput`: the
    // trace still passed, byte-identical.
    //
    // The property is real -- every `nextRng` call site is a pure hash of
    // `world.seed + tank.id * K + bucket`, with no shared counter, so cross-tank
    // interference is structurally impossible -- but a true property defended by an
    // invalid witness is exactly what this repo's bar exists to catch. A future edit
    // that made this function mutate `world` would have passed every test in the suite.
    const world = createWorldFor(ARENAS[0], 7);
    const playerId = world.tanks.find((t) => t.kind === 'player')?.id;
    expect(playerId, 'no player to drive').toBeDefined();
    const rnd = mulberry32(1234);
    const state = createPlayerAiState(rnd);

    const before = JSON.stringify(world);
    deepFreeze(world);
    // Throws on the first write attempt, naming the property -- a far better failure
    // than a diff at the end.
    expect(() => decidePlayerInput(world, playerId as number, rnd, state)).not.toThrow();
    expect(JSON.stringify(world), 'the scripted player mutated the world').toBe(before);
  });

  it('never writes to the world on ANY branch it can reach', () => {
    // The single call above is a tick-0 snapshot, and review named the gap: a write
    // gated on a branch that fixture never reaches -- only on the tick a mine is laid,
    // only once a firing solution has been HELD for the reaction window -- would walk
    // straight past it. That is this repo's "survivor hiding in an unstated remainder"
    // exactly.
    //
    // So drive it frozen, for real, until the interesting branches actually execute.
    // `step` clones its input and never mutates what it is given, so a frozen world can
    // be stepped safely.
    //
    // Population: all 4 shipped arenas x 400 ticks = 1600 decisions, every one made
    // against a fully frozen world. The counters below assert the sweep genuinely
    // reached the fire and mine branches rather than idling -- without them this could
    // pass by never doing anything interesting.
    let fires = 0;
    let mines = 0;
    let decisions = 0;
    for (let a = 0; a < ARENAS.length; a++) {
      let w = createWorldFor(ARENAS[a], 40 + a);
      const rnd = mulberry32(9000 + a);
      const state = createPlayerAiState(rnd);
      for (let tick = 0; tick < 400; tick++) {
        const playerId = w.tanks.find((t) => t.kind === 'player' && t.alive)?.id;
        if (playerId === undefined) break;
        deepFreeze(w);
        const input = decidePlayerInput(w, playerId, rnd, state);
        decisions += 1;
        if (input.fire) fires += 1;
        if (input.mine) mines += 1;
        w = step(w, input).world;
      }
    }
    expect(decisions, 'the sweep never ran').toBeGreaterThan(1000);
    expect(fires, 'never reached the fire branch, so this proves little about it')
      .toBeGreaterThan(0);
    expect(mines, 'never reached the mine branch, so this proves little about it')
      .toBeGreaterThan(0);
  });

  it('is a pure function of its inputs: same seed, same decision', () => {
    // The other half of determinism. `state` is caller-owned and deliberately mutable,
    // so two runs need their own.
    const world = createWorldFor(ARENAS[0], 11);
    const playerId = world.tanks.find((t) => t.kind === 'player')?.id as number;
    const a = decidePlayerInput(world, playerId, mulberry32(99), createPlayerAiState(mulberry32(99)));
    const b = decidePlayerInput(world, playerId, mulberry32(99), createPlayerAiState(mulberry32(99)));
    expect(a).toEqual(b);
  });
});
