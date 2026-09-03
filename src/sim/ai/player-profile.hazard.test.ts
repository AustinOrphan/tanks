// The VERSUS BOT's half of issue #223's perceived hazard picture.
//
// A separate file from `player-profile.test.ts` on purpose, and not for tidiness: that file
// steps 200 whole games in its describe body, so anything scoped to it costs minutes in the
// mutation harness. These two claims are unit-sized -- one decision call per tick of one
// refresh span -- and they are the ones the manifest pins, so they belong somewhere a
// mutation entry can re-run in a second. Same reasoning as the split of `hud.test.ts`.
//
// WHY THE PLAYER SIDE NEEDS ITS OWN PIN AT ALL. `withBotDifficulty` is applied in
// `player-profile.ts` and nowhere else, because a versus bot fills a PLAYER slot -- campaign
// enemies resolve `configFor(tank.kind)` with no preset. So an axis that reaches no decision
// HERE is a menu label with nothing behind it, however correctly the preset resolves.
import { describe, it, expect } from 'vitest';
import { createWorld } from '../world';
import { decidePlayerInput, createPlayerAiState, mulberry32 } from './player-profile';
import { hazardRefreshTicks } from './hazard-perception';
import { configFor } from '../config';
import type { Tank } from '../types';

const PLAYER_ID = 1;

function makeTank(kind: Tank['kind'], id: number, x: number, y: number): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
}

describe('the versus bot holds a difficulty-scaled hazard read', () => {
  it('HOLDS one hazard read for the profile refresh span instead of re-drawing per tick (#223)', () => {
    // The enemy AI re-derives its snapshot from a pure hash of (world.seed, tank.id,
    // bucket); this file's subject cannot, because it draws from a linear `rnd` stream that
    // cannot be asked what it said 20 ticks ago. So the span is HELD in PlayerAiState, and
    // this is what proves the hold exists: the pre-#223 code drew a fresh offset every tick,
    // which is exactly the frame-to-frame noise #223 opens against -- a misjudgement that
    // averages itself away over the frames of one dodge instead of being lived with.
    const player = makeTank('player', PLAYER_ID, 0, 0);
    const enemy = makeTank('brown', 2, 0, -8);
    const w = createWorld({ walls: [], tanks: [player, enemy], spawns: [], lives: 3 });
    const rnd = mulberry32(11);
    const state = createPlayerAiState(rnd);
    const span = hazardRefreshTicks(configFor('player'));
    decidePlayerInput(w, PLAYER_ID, rnd, state);
    const held = state.hazardOffset;
    const heldDelay = state.hazardDelayTicks;
    // The rest of the span reads the SAME belief, and the counter walks down to it.
    for (let i = 1; i < span; i++) {
      decidePlayerInput(w, PLAYER_ID, rnd, state);
      expect(state.hazardOffset).toBe(held);
      expect(state.hazardDelayTicks).toBe(heldDelay);
    }
    expect(state.hazardTicksLeft).toBe(0);
    // ...and it then turns over. Non-vacuous: a build that never re-drew would keep `held`
    // forever, which is the opposite defect and equally wrong.
    decidePlayerInput(w, PLAYER_ID, rnd, state);
    expect(state.hazardTicksLeft).toBe(span - 1);
    expect(state.hazardOffset).not.toBe(held);
  });

  it('scales the held refresh span with the DIFFICULTY, so easy lives with a bad read for longer', () => {
    // `hazardRefreshTime` is one of the three competence axes #223 added. Without this the
    // axis resolves correctly in `withBotDifficulty` and reaches no decision.
    const armSpan = (difficulty: 'easy' | 'normal' | 'hard'): number => {
      const player = makeTank('player', PLAYER_ID, 0, 0);
      const w = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 });
      const rnd = mulberry32(11);
      const state = createPlayerAiState(rnd);
      decidePlayerInput(w, PLAYER_ID, rnd, state, difficulty);
      return state.hazardTicksLeft + 1;
    };
    expect(armSpan('easy')).toBeGreaterThan(armSpan('normal'));
    expect(armSpan('normal')).toBeGreaterThan(armSpan('hard'));
    // `normal` is the exact no-op, so its span is the authored one.
    expect(armSpan('normal')).toBe(hazardRefreshTicks(configFor('player')));
  });
});
