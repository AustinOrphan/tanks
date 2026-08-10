import { describe, it, expect } from 'vitest';
import { createWorld, step, stepInputs, applyPlayerInputs } from './world';
import type { World } from './world';
import type { Tank, Spawn, InputState } from './types';
import { COUNTDOWN_TICKS, GRACE_TICKS, PLAYER_TURRET_TURN_RATE, DT } from './constants';

/**
 * Pins the LIST form of the step boundary: `stepInputs(world, inputs)` pairs `inputs[i]`
 * with the i-th `kind === 'player'` tank in tank-array order, and `step(world, input)` is
 * an adapter over it.
 *
 * Nothing in the shipped game passes more than one input -- config/validate.ts still
 * hard-fails any grid without exactly one `P` -- so every rule here is unreachable from
 * gameplay today and would be unpinned by the whole rest of the suite if this file did
 * not exist. That is precisely why the pairing rules are worth writing down: the next
 * change (a recorded input per tick, then a second player) is what makes them load
 * bearing, and by then a wrong one is a silent behaviour change.
 *
 * MUTATION RECORD -- measured, one mutation at a time, each applied to src/sim/world.ts
 * and run against the WHOLE gate (`npx vitest run`). Every figure below was RE-MEASURED
 * against the head of this branch; the numbers an earlier draft carried (87 files / 1718
 * tests) were taken at the branch's first commit and were stale by the time it shipped.
 * The gate with this file present is 88 files (87 passed + 1 skipped) and 1733 tests
 * (1731 passed + 2 skipped). "Killed here only" means the run's sole failing file was
 * this one, which is the same evidence as watching it survive before the file existed.
 *
 * Population: every distinct single-element edit to applyPlayerInputs' FOUR decisions --
 * which tanks are indexed (1), how the input is chosen (2, 3), how many are driven and
 * what an unmatched tank gets (4, 5), and in what ORDER they are driven (8) -- plus
 * step's delegation (6, 7). 8 of 8 run, 7 killed, 1 survivor disclosed below.
 *
 * An earlier draft of this list said "three decisions" and omitted 8. That was not a
 * wording slip: the order was genuinely unpinned, and the omission is what let the
 * mutant survive review. It is stated here because a population claim that quietly
 * excludes the class a survivor lives in is the failure mode CLAUDE.md names.
 *
 *   1. `filter(kind === 'player')` -> `filter(kind === 'player' && t.alive)`
 *      (a dead player stops consuming its slot)   killed here only (1 test)
 *   2. `inputs[i]` -> `inputs[0]`                 killed here only (3 tests)
 *   3. `inputs[i]` -> `inputs[n - 1 - i]`         killed here only (3 tests)
 *   4. `Math.min(...)` -> `players.length` with an idle input synthesised for the
 *      unmatched tanks                            killed here only (2 tests)
 *   5. `Math.min(...)` -> `inputs.length`         killed here (1) AND by
 *      src/game/loop.test.ts (1, "pushes null when the built world has no player tank")
 *      -- a world with no player tank indexes past the end and throws, so this one was
 *      already half-covered.
 *   6. `step` -> `stepInputs(world, [input, input])`  killed here only (2 tests)
 *   8. `for (i = 0; i < n; i++)` -> `for (i = n - 1; i >= 0; i--)`, pairing untouched
 *      -- the tanks are driven in reverse slot order. Before the "drives the players in
 *      SLOT ORDER" test below existed this passed the WHOLE gate (87 files passed / 1
 *      skipped, 1730 passed / 2 skipped, 0 failed) while renumbering every shell and
 *      reversing the event stream. Now: killed here only (1 test).
 *
 * SURVIVOR, disclosed: (7) giving `step` its own copy of the pipeline body -- clone,
 * tick, `applyPlayerInput`, the seven stages -- instead of delegating to `stepInputs`
 * passes the ENTIRE gate. Re-measured at this head with the new test present: 1731
 * passed / 2 skipped, zero failures, and the golden trace hash unchanged. It is
 * behaviour-identical today, which is exactly why nothing can catch it; the risk it
 * carries is that the single-player path stops being the same code as the list path,
 * which is the whole argument for the trace hash proving this refactor. Unfalsifiable
 * by construction, not merely untested: any test that could tell the two apart would
 * have to observe a behavioural difference, and there is none to observe -- what the
 * mutation removes is a structural guarantee, which only review can hold. `step`'s doc
 * comment says so.
 *
 * Also measured, and the reason this file has to exist: the golden trace hash
 * (015a5d17..., tools/baseline/trace.test.ts) was UNCHANGED under all eight mutations --
 * tools/baseline/trace.test.ts is among the passing files in every run above. It drives
 * one player, so it cannot see a pairing rule or a drive order at all.
 */

const A_ID = 1;
const B_ID = 2;

function makeTank(kind: Tank['kind'], id: number, x: number, y: number): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
}

const SPAWNS: Spawn[] = [
  { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
  { kind: 'player', pos: { x: 20, y: 5 }, angle: 0 },
];

/**
 * TWO player-kind tanks and no enemies at all, past countdown+grace so input is live.
 *
 * No enemies on purpose: stepAi skips every `kind === 'player'` tank (ai/index.ts), so
 * with none present nothing but the inputs under test can move a tank, and resolveStatus
 * cannot fire (its win branch needs `enemies.length > 0`). A second player tank is not a
 * loadable arena -- this is built through createWorld directly, which is the only reason
 * it can exist at all.
 */
function twoPlayerWorld(): World {
  const w = createWorld({
    walls: [],
    tanks: [makeTank('player', A_ID, 5, 5), makeTank('player', B_ID, 20, 5)],
    spawns: SPAWNS,
    lives: 3,
  });
  w.roundStartTick = -(COUNTDOWN_TICKS + GRACE_TICKS) - 1;
  return w;
}

const tankById = (w: World, id: number) => w.tanks.find((t) => t.id === id)!;

/** A moves +x and aims NORTH; B moves -x and aims SOUTH. Every field discriminates. */
const inputA: InputState = { move: { x: 1, y: 0 }, aim: { x: 5, y: 15 }, fire: false, mine: false };
const inputB: InputState = { move: { x: -1, y: 0 }, aim: { x: 20, y: -5 }, fire: false, mine: false };

/** One tick of turret slew, the most a turret can turn in either direction. */
const SLEW = PLAYER_TURRET_TURN_RATE * DT;

describe('stepInputs pairs inputs with player tanks by position', () => {
  it('pairs by position: each player flies its own input, not the first one', () => {
    const r = stepInputs(twoPlayerWorld(), [inputA, inputB]);
    const a = tankById(r.world, A_ID);
    const b = tankById(r.world, B_ID);

    expect(a.desiredMove).toEqual({ x: 1, y: 0 });
    expect(b.desiredMove).toEqual({ x: -1, y: 0 });
    // Positions, not just the intent field: a pairing bug that only reached desiredMove
    // would still be a visibly wrong game.
    expect(a.pos.x).toBeGreaterThan(5);
    expect(b.pos.x).toBeLessThan(20);
    // Aim is the second half of an input and travels the same path. North vs south:
    // opposite signs, so swapping the two inputs cannot pass.
    expect(a.turretAngle).toBeCloseTo(SLEW, 12);
    expect(b.turretAngle).toBeCloseTo(-SLEW, 12);
  });

  it('gives each player its own shell, with its own ownerId', () => {
    const r = stepInputs(twoPlayerWorld(), [
      { ...inputA, fire: true },
      { ...inputB, fire: true },
    ]);
    // Discriminated by owner, not counted: a shared stream makes a bare count pass while
    // one player's shot is dropped and the other's is duplicated.
    expect(r.world.bullets.map((b) => b.ownerId).sort()).toEqual([A_ID, B_ID]);
    const fired = r.events.filter((e) => e.type === 'fire').map((e) => e.ownerId).sort();
    expect(fired).toEqual([A_ID, B_ID]);
  });

  it('drives the players in SLOT ORDER, so ids and events are a function of the slot', () => {
    // The `.sort()` in the test above is deliberate there -- it asks "did each player get
    // its own shell" -- but it is also exactly what let a reversed loop
    // (`for (i = n - 1; i >= 0; i--)`, pairing untouched) pass the WHOLE gate: 87 files /
    // 1730 passed / 2 skipped, 0 failed. Order is a fourth decision applyPlayerInputs
    // makes, and nothing pinned it.
    //
    // It is not cosmetic. `world.nextId++` is consumed in drive order (bullets.ts:62), so
    // the reversal renumbers every shell; `events` is appended in drive order, and
    // render/particles.ts draws from that stream. A recorded input list replayed against a
    // build that iterated the other way would diverge on tick one -- which is the whole
    // property `stepInputs` exists to make replayable.
    const r = stepInputs(twoPlayerWorld(), [
      { ...inputA, fire: true },
      { ...inputB, fire: true },
    ]);

    // UNSORTED, on all three: the array order, the id order, and the event order.
    expect(r.world.bullets.map((b) => b.ownerId)).toEqual([A_ID, B_ID]);
    const shellOf = (id: number) => r.world.bullets.find((b) => b.ownerId === id)!;
    expect(shellOf(A_ID).id).toBeLessThan(shellOf(B_ID).id);
    expect(r.events.filter((e) => e.type === 'fire').map((e) => e.ownerId)).toEqual([A_ID, B_ID]);
  });

  it('gives a player past the end of the list NO input, not an idle one', () => {
    const w = twoPlayerWorld();
    const b0 = tankById(w, B_ID);
    b0.fireCooldown = 5;
    b0.mineCooldown = 7;
    b0.turretAngle = 1;

    const r = stepInputs(w, [inputA]);
    const b = tankById(r.world, B_ID);

    // An idle InputState is NOT the same as no input: it still decrements both cooldowns
    // and still slews the turret toward its aim point. Nothing of the sort may happen to
    // a tank the caller did not send an input for.
    expect(b.fireCooldown).toBe(5);
    expect(b.mineCooldown).toBe(7);
    expect(b.turretAngle).toBe(1);
    expect(b.desiredMove).toEqual({ x: 0, y: 0 });
    // A, which DID get an input, is the control: the tick really ran.
    expect(tankById(r.world, A_ID).desiredMove).toEqual({ x: 1, y: 0 });
  });

  it('ignores inputs past the last player tank', () => {
    const surplus: InputState = { move: { x: 0, y: 1 }, aim: { x: 0, y: 0 }, fire: true, mine: true };
    const withSurplus = stepInputs(twoPlayerWorld(), [inputA, inputB, surplus]);
    const without = stepInputs(twoPlayerWorld(), [inputA, inputB]);
    expect(withSurplus.world).toEqual(without.world);
    expect(withSurplus.events).toEqual(without.events);
  });

  it('runs the whole tick on an EMPTY input list, driving no player', () => {
    const w = twoPlayerWorld();
    tankById(w, A_ID).fireCooldown = 4;
    const r = stepInputs(w, []);

    // The tick still happened: an empty list means "no human acted", not "no tick".
    expect(r.world.tick).toBe(w.tick + 1);
    // ... and nothing was applied on anyone's behalf. A synthesised idle input would
    // decrement this.
    expect(tankById(r.world, A_ID).fireCooldown).toBe(4);
    expect(tankById(r.world, A_ID).desiredMove).toEqual({ x: 0, y: 0 });
  });
});

describe('step() is an adapter over stepInputs', () => {
  it('is exactly stepInputs with a one-element list', () => {
    const viaStep = step(twoPlayerWorld(), inputA);
    const viaList = stepInputs(twoPlayerWorld(), [inputA]);
    expect(viaStep.world).toEqual(viaList.world);
    expect(viaStep.events).toEqual(viaList.events);
  });

  it('drives ONLY the first player, whatever else is in the arena', () => {
    const r = step(twoPlayerWorld(), inputA);
    expect(tankById(r.world, A_ID).desiredMove).toEqual({ x: 1, y: 0 });
    // The second player-kind tank is untouched -- this is what a duplicated adapter
    // (`[input, input]`) breaks, and it is the reason the one-argument callers in the
    // tree are unaffected by the list form existing.
    expect(tankById(r.world, B_ID).desiredMove).toEqual({ x: 0, y: 0 });
    expect(tankById(r.world, B_ID).pos).toEqual({ x: 20, y: 5 });
    expect(tankById(r.world, B_ID).turretAngle).toBe(0);
  });
});

describe('applyPlayerInputs is reachable on its own', () => {
  it('drives tanks without cloning, like every other exported stage', () => {
    // The stage exports in this file are called directly by tests and by anything
    // embedding the sim; unlike stepInputs they mutate in place. Pinning that here means
    // a future "helpful" clone inside the stage is caught.
    const w = twoPlayerWorld();
    applyPlayerInputs(w, [inputA, inputB], []);
    expect(tankById(w, A_ID).desiredMove).toEqual({ x: 1, y: 0 });
    expect(tankById(w, B_ID).desiredMove).toEqual({ x: -1, y: 0 });
  });

  it('keeps a dead player in its slot, so the survivor is not handed the wrong input', () => {
    // Asserted at the STAGE, not through stepInputs, and that is a finding rather than a
    // convenience: with a dead player tank, resolveStatus runs at the end of the same
    // tick, spends a life and calls resetArena, which returns every tank to its spawn
    // with desiredMove zeroed -- erasing the evidence. Written through stepInputs first,
    // this test read {x:0,y:0} for BOTH pairings and so could not have failed.
    const w = twoPlayerWorld();
    tankById(w, A_ID).alive = false;
    applyPlayerInputs(w, [inputA, inputB], []);
    const b = tankById(w, B_ID);

    // B is the SECOND player tank and gets the SECOND input even though the first is a
    // corpse. Indexing over the living instead would hand B inputA and drive it +x.
    expect(b.desiredMove).toEqual({ x: -1, y: 0 });
    expect(b.turretAngle).toBeCloseTo(-SLEW, 12);
    // And the dead one is still not driven.
    expect(tankById(w, A_ID).desiredMove).toEqual({ x: 0, y: 0 });
  });
});
