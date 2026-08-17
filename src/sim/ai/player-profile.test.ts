import { describe, it, expect } from 'vitest';
import { ARENAS, createWorldFor } from '../arena';
import { step, createWorld } from '../world';
import type { Tank, Vec2 } from '../types';
import { fromAngle, vnorm, vsub, vdist } from '../types';
import { decidePlayerInput, createPlayerAiState, mulberry32 } from './player-profile';

function makeTank(kind: Tank['kind'], id: number, x: number, y: number, team?: number): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
    ...(team !== undefined ? { team } : {}),
  };
}

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
// PINNED assertions, run on every `npm test`. Population: ALL shipped arenas
// (ARENAS.length, 5 as of arena-05) x 25 seeds each = 125 games -- a smaller sample
// than the measurement block above (60 seeds/arena) purely to keep this file's runtime
// down (a 5-simulated-minute cap x 125 games still takes real wall-clock seconds);
// re-measured directly AT this population rather than assumed from the 60-seed
// numbers, since a smaller sample is not guaranteed to land on the same rate. Computed
// once, in the describe body (mirrors pacifist.test.ts's `rows`), so every `it` below
// reads the same 125 games instead of re-simulating per assertion.
//
// Re-measured at this population after directive A part 2 (centroid-aware retreat)
// landed AND directive A part 1 (destructible-wall shots) was implemented, then
// stripped on adjudicated review -- see decidePlayerInput's doc comment and the PR 2b
// plan doc. This is the population's FOURTH measurement in this branch's history: an
// earlier comment here quoted a 4-arena, 100-game population from before arena-05
// shipped; a later one quoted 5 arenas with wall-shooting active; a later one still 5
// arenas with wall-shooting removed again; this one is post directive B (estimation
// error, 2026-08-16 owner ruling) -- decidePlayerInput now draws one extra rnd() call
// per tick for its own hazard-offset (see the module comment), which renumbers every
// later draw in this file's stream, so EVERY game in this population is a genuinely
// different run from the prior measurement, not merely a behaviour delta on top of it:
//   arena1: 16/25 wins  arena2: 15/25  arena3: 12/25  arena4: 6/25  arena5: 1/25
//   total: 50/125 wins (40.0%), 74/125 losses, 0/125 timeouts
//   self-mine deaths: 5/74 losses (6.8%, down from 10/74 -- consistent with, not proof
//     of, estimation error occasionally trading a self-mine death for a different one:
//     the sim is chaotic, so attributing the exact delta to one gate is not warranted)
//   fires/game: arena1 15.3 arena2 13.5 arena3 44.2 arena4 32.7 arena5 29.5
//   mines/game: arena1 1.60 arena2 9.28 arena3 4.12 arena4 3.40 arena5 4.40
// The overall win/loss split (50/125, 40.0%) stays close to the prior measurement
// (51/125, 40.8%); the per-arena breakdown, self-mine share and fires/mines per game all
// moved (this sim is deterministic but chaotic -- a behavior change anywhere changes the
// game from that tick on, not just its own footprint -- see PLAYER_MINE_CHANCE's comment
// in player-profile.ts for the same caveat applied to a different gate). The "arena-01
// easier than arena-03/arena-04" ordinal claim below still holds with real margin (64%
// vs 48% vs 24%), not merely by the assertion's own generous slack.
// ---------------------------------------------------------------------------
describe('a competent scripted player against the shipped arenas', () => {
  const SEEDS = 25;
  const perArena = ARENAS.map((_, a) => Array.from({ length: SEEDS }, (_, i) => playCompetent(a, i + 1)));
  const all = perArena.flat();
  const winRate = (a: number) => perArena[a].filter((r) => r.outcome === 'win').length / SEEDS;

  it('wins a meaningful share of games against the shipped roster', () => {
    // Population: 125 games (5 shipped arenas x 25 seeds). Measured 50/125 (40.0%) post
    // directive B (estimation error); 51/125 (40.8%) pre. Bounded well below that so
    // ordinary AI/arena tuning does not fail the build; a
    // regression that makes the scripted player hapless (rate collapses toward 0) trips
    // it -- confirmed: `fire = false` drops this to 5/100 and dies here (that specific
    // check predates arena-05 and directive A/B and was not rerun at the current
    // population/behavior; the mechanism it guards -- fire wired to false -- is
    // unaffected by either change).
    //
    // NO upper bound: an "aimbot ceiling" was tried and dropped. Three escalating
    // buffs -- perfect aim + instant fire (zero jitter, reactionTicks 0), the same plus
    // ignoring lineOfSight for targeting, and the same plus permanent full-speed
    // kiting -- were each applied in isolation and measured on the THEN-current 100-game,
    // 4-arena population: 48/100, 15/100 and 15/100 respectively, none exceeding the
    // unmodified 50/100 and two WORSE (a wall-blind target wastes fire on an enemy it
    // cannot hit; permanent kiting forfeits position). That experiment has not been
    // rerun at the current 125-game, 5-arena population or against directive A/B's
    // added behavior -- named here as a historical argument for why no upper bound is
    // asserted, not as a current measurement. So win rate here is bounded by
    // survival/positioning, not by offense; an upper bound would have been unfalsifiable
    // by any mutation actually tried at the time, which is exactly the decorative-
    // assertion trap CLAUDE.md warns against. If a real "shoots through everything,
    // never misses, never dies" bug ever needs catching, it will need a mutation this
    // file's movement model cannot express (e.g. bypassing dangerAvoidMove's own
    // geometry), which is out of this issue's scope.
    const wins = all.filter((r) => r.outcome === 'win').length;
    const rate = wins / all.length;
    expect(rate, `${wins}/${all.length} games won`).toBeGreaterThan(0.2);
  });

  it('reads arena-01 as easier than arena-03 and arena-04', () => {
    // Measured win rates post directive B (estimation error): arena-01 16/25 (64%),
    // arena-03 12/25 (48%), arena-04 6/25 (24%) -- a 16-40 point gap, narrower than the
    // pre-directive-B measurement below but still a real, non-boundary margin. Pre
    // directive B: arena-01 21/25 (84%), arena-03 7/25 (28%), arena-04 7/25 (28%) -- a
    // >55-point gap either way. Both measurements keep this a stable ordinal claim under
    // ordinary tuning rather than sitting on a fragile boundary. This is the
    // "level 4 is harder than level 1" kind of claim the issue asks this harness to make
    // measurable; it does not by itself distinguish arena-03 from arena-04 (they swapped
    // which is closer to arena-01 between the two measurements -- 28%/28% pre, 48%/24%
    // post -- within the noise a small tuning or behaviour change can move either).
    // Arena-05 is not part of this specific ordinal claim (it predates arena-05's
    // addition and nothing in directive A/B/estimation-error required extending it); for
    // reference it is currently the hardest of the five at 1/25 (4%, was 3/25/12%).
    //
    // Mutation note (from before arena-05/directive A/B; not rerun at the current tree):
    // every production mutation tried against this assertion (disabling dodging,
    // forcing point-blank ramming, both together) collapsed EVERY arena's win rate
    // toward 0 rather than closing the gap non-degenerately, so the cleanest kill found
    // was arena-01 and arena-03 both landing at 0/25 (`0 > 0` correctly fails). The
    // real, unmutated gaps above are the actual evidence this assertion is not a
    // tautology; no mutation was found that flips the order while both sides stay above
    // zero.
    expect(winRate(0), 'arena-01 vs arena-03').toBeGreaterThan(winRate(2));
    expect(winRate(0), 'arena-01 vs arena-04').toBeGreaterThan(winRate(3));
  });

  it('still shoots: reaction-gated fire is not the same as passive', () => {
    // Population: same 125 games. Measured per-arena averages 13.5-44.2 fires/game post
    // directive B (13.4-55.8 pre); the bar sits far below the lowest observed either way,
    // so it only catches an accidental "never/rarely fires" regression, not ordinary
    // aim/reaction retuning.
    const fires = all.reduce((n, r) => n + r.fires, 0);
    expect(fires / all.length).toBeGreaterThan(5);
  });

  it('lays mines occasionally rather than never or constantly', () => {
    // Population: same 125 games. Measured per-arena averages 1.60-9.28 mines/game post
    // directive B (1.44-7.80 pre).
    const mines = all.reduce((n, r) => n + r.mines, 0);
    const perGame = mines / all.length;
    expect(perGame, `${mines} mines over ${all.length} games`).toBeGreaterThan(0.3);
    expect(perGame, `${mines} mines over ${all.length} games`).toBeLessThan(15);
  });

  it('does not routinely kill itself with its own mine', () => {
    // Population: all LOSSES across the 125 games (a self-mine death can only happen in
    // a loss), measured at 74 both pre- and post-directive-B. Self-mine share measured
    // 5/74 (6.8%) post directive B (estimation error); 10/74 (13.5%, 9 in arena-02 and 1
    // in arena-03 -- per-arena split not re-measured post-directive-B) pre. The residual
    // is real and documented (PLAYER_MINE_CHANCE's comment in player-profile.ts) -- this
    // is a regression guard against it becoming the DOMINANT cause of death, not a claim
    // that it is eliminated.
    const losses = all.filter((r) => r.outcome === 'lose');
    const selfMine = losses.filter((r) => r.selfMineDeath).length;
    expect(losses.length, 'population: losses only, out of 100 games').toBeGreaterThan(0);
    expect(selfMine / losses.length, `${selfMine}/${losses.length} losses were self-mine`).toBeLessThan(0.5);
  });
});

/**
 * Directive A part 1 (destructible-wall shots) was implemented here and then STRIPPED
 * on adjudicated review: a throwaway probe found a shell never destroys a destructible
 * wall in this sim (only a mine blast does, mines.ts's applyBlast), so aiming at and
 * firing on one spent a `weapon.maxActiveProjectiles` slot for a shot that could never
 * pay off -- worse than holding fire, not merely inert. See decidePlayerInput's own doc
 * comment and the PR 2b plan doc (docs/superpowers/plans/2026-08-16-bot-competence.md)
 * for the full finding; mine-breaching (using the mechanic that actually opens a
 * destructible wall) is queued there as the follow-up. The two fixtures this section
 * used to carry (a destructible-wall positive case and a solid-wall negative control)
 * are gone with the feature they tested.
 */

/**
 * Directive A, part 2: whole-map awareness. A bounded per-tick pass builds a threat
 * summary (nearest, centroid) that the movement band's retreat branch reads instead of
 * nearest-only distance -- retreating away from the opponent MASS, not just whichever
 * one happens to be closest, once several are in play.
 *
 * Fixture: player at the origin, one opponent close enough to trigger retreat (within
 * PLAYER_MINIMUM_DISTANCE) directly south, a second opponent further north. Retreating
 * from the NEAREST alone points north (away from the close one); retreating from the
 * CENTROID of both points south (the centroid sits north of the player, since the far
 * opponent pulls it past the midpoint) -- the two disagree by construction, which is
 * what makes this fixture able to actually distinguish the two rules.
 *
 * Seed 4 was found by scanning seeds 1..2000 against the CURRENT code and keeping one
 * where the retreat draw actually fires -- see the self-check assertion below, which
 * fails loudly (not vacuously) if a future change stops reaching the retreat branch on
 * this seed. Re-scanned (was seed 3) when directive B's estimation-error draw landed:
 * decidePlayerInput now consumes one more `rnd()` call before the wander/retreat draws
 * (the per-tick hazard offset), which shifts every later draw in the stream -- a linear
 * PRNG has no bucket to insulate later draws from an earlier one added upstream, unlike
 * the enemy AI's world.seed-keyed hash. Any fixture pinned against a specific seed's
 * draw sequence is fragile to this in the same way; this is the one place in the tree
 * that fixture actually lived.
 */
describe('directive A part 2: whole-map threat summary informs retreat', () => {
  const PLAYER_ID = 1;

  it('retreats from the opponent centroid, not just the nearest, when a second opponent is in play (RED before assessThreats exists)', () => {
    const player = makeTank('player', PLAYER_ID, 0, 0);
    const near = makeTank('brown', 2, 0, -2); // within PLAYER_MINIMUM_DISTANCE (4)
    const far = makeTank('grey', 3, 0, 6);    // pulls the centroid to (0, 2)
    const world = createWorld({ walls: [], tanks: [player, near, far], spawns: [], lives: 3 });
    const rnd = mulberry32(4); // found by scanning seeds 1..2000 for one where the retreat draw fires
    const state = createPlayerAiState(rnd);
    const input = decidePlayerInput(world, PLAYER_ID, rnd, state);

    // Reconstruct both candidate directions using the SAME wander heading this exact
    // call drew (read back from state, mutated in place) -- blend/normalize are shared
    // infrastructure pinned elsewhere; only WHICH point feeds them is in question here.
    const wander = fromAngle(state.wanderHeading);
    const blend = (toward: Vec2): Vec2 => vnorm({
      x: toward.x * 0.5 + wander.x * 0.5,
      y: toward.y * 0.5 + wander.y * 0.5,
    });
    const oldNearestAway = blend(vnorm(vsub(player.pos, near.pos)));
    const centroid = { x: (near.pos.x + far.pos.x) / 2, y: (near.pos.y + far.pos.y) / 2 };
    const newCentroidAway = blend(vnorm(vsub(player.pos, centroid)));

    // Self-check: the fixture must actually discriminate the two rules (retreat fired,
    // and the two candidate directions are genuinely far apart) or the assertion below
    // would pass vacuously.
    expect(vdist(input.move, wander), 'the retreat draw never fired on this seed -- fixture is vacuous')
      .toBeGreaterThan(0.05);
    expect(vdist(oldNearestAway, newCentroidAway), 'fixture does not actually discriminate the two rules')
      .toBeGreaterThan(0.5);

    expect(input.move.x, `move.x: old nearest-away=${oldNearestAway.x.toFixed(4)} new centroid-away=${newCentroidAway.x.toFixed(4)}`)
      .toBeCloseTo(newCentroidAway.x, 5);
    expect(input.move.y, `move.y: old nearest-away=${oldNearestAway.y.toFixed(4)} new centroid-away=${newCentroidAway.y.toFixed(4)}`)
      .toBeCloseTo(newCentroidAway.y, 5);
  });

  it('a CORPSE is not an opponent: a dead tank pulls neither the nearest slot nor the centroid', () => {
    // Review measured this gap: dropping isOpponent's alive check survived every test
    // in this file (0 of 9 red). Same fixture as above plus a dead third enemy placed
    // where, if counted, it would visibly drag the centroid east -- the retreat
    // direction below discriminates. Breaks if isOpponent stops requiring alive.
    const player = makeTank('player', PLAYER_ID, 0, 0);
    const near = makeTank('brown', 2, 0, -2);
    const far = makeTank('grey', 3, 0, 6);
    const corpse = { ...makeTank('teal', 4, 40, 0), alive: false };
    const world = createWorld({ walls: [], tanks: [player, near, far, corpse], spawns: [], lives: 3 });
    const rnd = mulberry32(4); // same seed as above: the retreat draw fires identically
    const state = createPlayerAiState(rnd);
    const input = decidePlayerInput(world, PLAYER_ID, rnd, state);

    const wander = fromAngle(state.wanderHeading);
    const blend = (toward: Vec2): Vec2 => vnorm({
      x: toward.x * 0.5 + wander.x * 0.5,
      y: toward.y * 0.5 + wander.y * 0.5,
    });
    const livingCentroid = { x: (near.pos.x + far.pos.x) / 2, y: (near.pos.y + far.pos.y) / 2 };
    const livingAway = blend(vnorm(vsub(player.pos, livingCentroid)));
    const corpseCentroid = {
      x: (near.pos.x + far.pos.x + corpse.pos.x) / 3,
      y: (near.pos.y + far.pos.y + corpse.pos.y) / 3,
    };
    const corpseAway = blend(vnorm(vsub(player.pos, corpseCentroid)));
    expect(vdist(livingAway, corpseAway), 'fixture does not discriminate corpse inclusion')
      .toBeGreaterThan(0.3);

    expect(input.move.x).toBeCloseTo(livingAway.x, 5);
    expect(input.move.y).toBeCloseTo(livingAway.y, 5);
  });
});

describe('n-player arc PR 4: isOpponent is mode-aware', () => {
  const PLAYER_ID = 1;

  it('campaign-coop (the default): a nearby player-kind tank is never an opponent, even at close range -- pure wander, no retreat', () => {
    // No enemy-kind tank anywhere in this world: if isOpponent regressed to count
    // player-kind tanks, `nearby` (well inside PLAYER_MINIMUM_DISTANCE) would trigger
    // the seeded retreat draw below and move.x/y would diverge from pure wander.
    const player = makeTank('player', PLAYER_ID, 0, 0);
    const nearby = makeTank('player', 2, 0, -2);
    const world = createWorld({ walls: [], tanks: [player, nearby], spawns: [], lives: 3 });
    expect(world.mode).toBe('campaign-coop'); // the fixture's own precondition
    const rnd = mulberry32(4); // same seed the retreat-draw fixtures above use
    const state = createPlayerAiState(rnd);
    const input = decidePlayerInput(world, PLAYER_ID, rnd, state);
    const wander = fromAngle(state.wanderHeading);
    expect(input.move.x).toBeCloseTo(wander.x, 5);
    expect(input.move.y).toBeCloseTo(wander.y, 5);
    expect(input.fire).toBe(false); // nothing to aim at
  });

  it('ffa: any other player-kind tank IS an opponent -- reproduces the directive-A-part-2 centroid-retreat fixture with player-kind stand-ins', () => {
    const player = makeTank('player', PLAYER_ID, 0, 0);
    const near = makeTank('player', 2, 0, -2); // within PLAYER_MINIMUM_DISTANCE (4)
    const far = makeTank('player', 3, 0, 6);   // pulls the centroid to (0, 2)
    const world = createWorld({ walls: [], tanks: [player, near, far], spawns: [], lives: 3, mode: 'ffa' });
    const rnd = mulberry32(4); // the seed the retreat draw is known to fire on
    const state = createPlayerAiState(rnd);
    const input = decidePlayerInput(world, PLAYER_ID, rnd, state);

    const wander = fromAngle(state.wanderHeading);
    const blend = (toward: Vec2): Vec2 => vnorm({
      x: toward.x * 0.5 + wander.x * 0.5,
      y: toward.y * 0.5 + wander.y * 0.5,
    });
    const centroid = { x: (near.pos.x + far.pos.x) / 2, y: (near.pos.y + far.pos.y) / 2 };
    const centroidAway = blend(vnorm(vsub(player.pos, centroid)));

    expect(vdist(input.move, wander), 'the retreat draw never fired on this seed -- fixture is vacuous')
      .toBeGreaterThan(0.05);
    expect(input.move.x).toBeCloseTo(centroidAway.x, 5);
    expect(input.move.y).toBeCloseTo(centroidAway.y, 5);
  });

  it('teams: a same-team player tank is excluded, a different-team one is the sole opponent', () => {
    const player = makeTank('player', PLAYER_ID, 0, 0, 0); // team 0
    const teammate = makeTank('player', 2, 0, -2, 0);       // team 0, close -- must be ignored
    const opponent = makeTank('player', 3, 0, 20, 1);       // team 1, the only real opponent
    const world = createWorld({ walls: [], tanks: [player, teammate, opponent], spawns: [], lives: 3, mode: 'teams' });
    const rnd = mulberry32(1);
    const state = createPlayerAiState(rnd);
    const input = decidePlayerInput(world, PLAYER_ID, rnd, state);

    // Beyond PLAYER_PREFERRED_DISTANCE (7.5): approach. If the close SAME-team tank were
    // still counted as the nearest opponent, the approach/retreat band decision (and the
    // direction blended toward it) would come out differently -- the teammate is at
    // distance 2 (inside PLAYER_MINIMUM_DISTANCE), the real opponent at distance 20.
    // Same SEEK_APPROACH_BIAS (0.5) blend the existing directive-A-part-2 fixtures use.
    const wander = fromAngle(state.wanderHeading);
    const towardOpponent = vnorm(vsub(opponent.pos, player.pos));
    const approach = vnorm({ x: towardOpponent.x * 0.5 + wander.x * 0.5, y: towardOpponent.y * 0.5 + wander.y * 0.5 });
    expect(input.move.x).toBeCloseTo(approach.x, 5);
    expect(input.move.y).toBeCloseTo(approach.y, 5);
  });
});

/**
 * Directive B (2026-08-16 owner ruling): the player's own hazard estimation error, drawn
 * from its INJECTED `rnd` stream (never `world.seed` -- see decidePlayerInput's own
 * comment). One draw per tick: `createPlayerAiState(rnd)` consumes the stream's FIRST
 * value (the initial wander heading), so the hazard-offset draw inside decidePlayerInput
 * is the stream's SECOND value -- both fixtures below account for that by consuming one
 * throwaway draw before reading the one that matters, exactly as `createPlayerAiState`
 * does for real.
 *
 * Seeds found by scanning seeds 1..5000 against `mulberry32(seed)`'s SECOND draw (the
 * first is spent on `wanderHeading`): seed 4771 -> 0.000002468237653374672 (near-minimal,
 * for the UNDER case), seed 3434 -> 0.9998051796574146 (near-maximal, for the OVER case).
 * The shipped player profile is STATIC_BASIC, estimationAccuracy 0.5, so spread =
 * AI_HAZARD_SPREAD / 0.5 = 0.8, and the offsets are (draw*2-1)*0.8 -- essentially -0.8 and
 * +0.8 -- perturbing the true AI_MINE_FLEE_RADIUS (3.25) to roughly 2.45 and 4.05.
 */
describe('directive B: estimation error (the player half, injected rnd, never world.seed)', () => {
  const PLAYER_ID = 1;

  it('UNDER-estimation: the player does not dodge a mine sitting inside its own actual kill radius -- the DECISION half of "sometimes fatal" (death itself is not simulated here)', () => {
    const player = makeTank('player', PLAYER_ID, 0, 0);
    // 2.48: inside the TRUE kill radius (MINE_BLAST_RADIUS + TANK_RADIUS = 2.5) and the
    // true flee radius (3.25), but past the perceived one (~2.45) with real margin either
    // side (~0.02-0.03), not a boundary-exact fixture.
    const mineFixture = { id: 70, ownerId: 99, pos: { x: 2.48, y: 0 }, timer: 3, armed: true, detonated: false };
    const world = { ...createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 }), mines: [mineFixture] };
    const rnd = mulberry32(4771);
    const state = createPlayerAiState(rnd); // draw #1: wanderHeading
    const input = decidePlayerInput(world, PLAYER_ID, rnd, state); // draw #2: hazard offset

    // Ground the "fatal" claim: the mine is inside the player's TRUE lethal blast radius.
    expect(vdist(player.pos, mineFixture.pos)).toBeLessThanOrEqual(2.5);
    // move is NOT the escape vector (-1, 0) that fleeing this mine would produce.
    expect(input.move.x).not.toBeCloseTo(-1, 2);
  });

  it('OVER-estimation: the player dodges a mine the TRUE flee radius says is safe (wasted caution, not merely cosmetic scatter)', () => {
    const player = makeTank('player', PLAYER_ID, 0, 0);
    // 3.8: past the TRUE flee radius (3.25, with a 0.55 margin) but inside the perceived
    // one (~4.05, with a 0.25 margin) -- real margins both sides, not boundary-exact.
    const mineFixture = { id: 71, ownerId: 99, pos: { x: 3.8, y: 0 }, timer: 3, armed: true, detonated: false };
    const world = { ...createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 }), mines: [mineFixture] };
    const rnd = mulberry32(3434);
    const state = createPlayerAiState(rnd);
    const input = decidePlayerInput(world, PLAYER_ID, rnd, state);

    // move IS the escape vector away from (3.8, 0): straight along -x.
    expect(input.move.x).toBeCloseTo(-1, 2);
    expect(input.move.y).toBeCloseTo(0, 2);
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
