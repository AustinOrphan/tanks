// Difficulty actually reaches HAZARD judgment (issue #223, criteria 4 and 5).
//
// #267 shipped the presets and pinned their SHAPE -- monotone, `normal` a referential
// no-op, personality untouched. What it did not pin is that any of it survives the trip to
// a decision: `withBotDifficulty` scales `estimationAccuracy`, `profileHazardSpread` divides
// the anchor by it, and `estimationError` turns that into the offset an AI adds to the mine
// flee radius before deciding whether it is safe. Break any link and bot-difficulty.test.ts
// stays entirely green while every difficulty judges mines identically.
//
// The measured quantity is deliberately the CONSEQUENCE rather than the spread: how often a
// tank believes it is safe while standing inside the radius a blast actually kills at. That
// is issue #223's "sometimes react late or choose insufficient escape" in the only form the
// simulation can be asked about.
import { describe, it, expect } from 'vitest';
import { estimationError, profileHazardSpread } from './targeting';
import { withBotDifficulty, BOT_DIFFICULTIES } from './bot-difficulty';
import { configFor } from '../config';
import { AI_MINE_FLEE_RADIUS, MINE_BLAST_RADIUS, TANK_RADIUS } from '../constants';
import type { World } from '../world';
import type { Tank } from '../types';

/** What a blast actually kills at -- NOT the flee radius, which already carries a margin. */
const KILL_RADIUS = MINE_BLAST_RADIUS + TANK_RADIUS;

/**
 * The perceived flee radius over a wide sweep of tanks and draw buckets.
 *
 * `estimationError` buckets by tick, so sampling every tick would count each draw many
 * times over; stepping by a whole bucket samples each draw once. Population: 40 tank ids x
 * 200 buckets = 8000 draws per difficulty.
 */
function perceivedRadii(difficulty: (typeof BOT_DIFFICULTIES)[number]): number[] {
  const cfg = withBotDifficulty(configFor('player'), difficulty);
  const spread = profileHazardSpread(cfg);
  const out: number[] = [];
  for (let id = 1; id <= 40; id++) {
    for (let tick = 0; tick < 4000; tick += 20) {
      const world = { seed: 5, tick } as unknown as World;
      const tank = { id } as unknown as Tank;
      out.push(AI_MINE_FLEE_RADIUS + estimationError(world, tank, spread));
    }
  }
  return out;
}
const fatalRate = (rs: number[]) => rs.filter((r) => r < KILL_RADIUS).length / rs.length;

describe('difficulty reaches hazard judgment', () => {
  it('makes an EASY bot misjudge a mine fatally more often than a HARD one', () => {
    // Measured at the time of writing: easy 18.79%, normal 2.94%, hard 0.00%. Asserted as
    // an ORDERING plus a floor on easy, not as those numbers -- the multipliers are
    // provisional until #223's sweep runs, so pinning them literally would pin the one
    // thing the issue exists to move.
    const easy = fatalRate(perceivedRadii('easy'));
    const normal = fatalRate(perceivedRadii('normal'));
    const hard = fatalRate(perceivedRadii('hard'));
    expect(easy).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(hard);
    // ...and easy's misjudgment is COMMON enough to be a behaviour rather than a rounding
    // artefact. Without this the ordering above is satisfied by 0.3% > 0.2% > 0.1%.
    expect(easy).toBeGreaterThan(0.05);
  });

  it('never makes a HARD bot exact: it still misjudges, just not fatally', () => {
    // Issue #223's binding limit -- "no preset may create oracle-perfect awareness" -- at
    // the decision rather than at the profile. A hard bot that always perceived the true
    // radius would read every mine correctly and stop being beatable by baiting.
    const hard = perceivedRadii('hard');
    const min = Math.min(...hard);
    const max = Math.max(...hard);
    expect(max - min).toBeGreaterThan(0.5); // a real band, not a point
    expect(min).toBeLessThan(AI_MINE_FLEE_RADIUS); // it does under-estimate...
    expect(max).toBeGreaterThan(AI_MINE_FLEE_RADIUS); // ...and over-estimate
  });

  it('narrows the band monotonically as difficulty rises', () => {
    // The spread is what every hazard decision reads, so this is the link bot-difficulty's
    // own monotonicity test cannot see: a build that resolved the preset and then ignored
    // `estimationAccuracy` here passes there and fails here.
    const bands = BOT_DIFFICULTIES.map((d) => {
      const rs = perceivedRadii(d);
      return Math.max(...rs) - Math.min(...rs);
    });
    expect(bands[0]).toBeGreaterThan(bands[1]); // easy wider than normal
    expect(bands[1]).toBeGreaterThan(bands[2]); // normal wider than hard
    expect(bands[2]).toBeGreaterThan(0); // ...and hard is still not a point
  });
});
