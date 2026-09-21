// Sticky opponent selection for a bot filling a versus PLAYER slot (issue #891).
//
// WHAT WOULD MAKE THIS FILE FAIL, stated once because every test below depends on it: delete
// `Tank.botDifficulty` from `loadArena`'s stamping, or make `stepAi` skip player-kind tanks
// again, or let `decidePlayerInput` re-pick the nearest opponent instead of reading the
// commitment. Before this change all three were the shipped behaviour, so every assertion
// here fails against `main` as it stood. That is deliberate: the whole feature is invisible
// to the pre-existing suite -- no fixture in the tree stamps `botDifficulty`, so a dead
// implementation would leave 1,326 sim tests exactly as green as a live one.
import { describe, it, expect } from 'vitest';
import { resolveWorldRules, type WorldRulesInit } from '../rules';
import { commitBotTarget, committedOpponent, isBotDriven } from './bot-commitment';
import { BOT_TARGET_COMMITMENT_SECONDS, BOT_DIFFICULTIES } from './bot-difficulty';
import { isOpponent } from './targeting';
import { stepAi } from './index';
import { createPlayerAiState, decidePlayerInput, mulberry32 } from './player-profile';
import { TICK_HZ } from '../constants';
import type { InputState, Tank, Vec2 } from '../types';
import { stepInputs, type World } from '../world';
import { createWorldFor, ARENAS } from '../arena';

function tank(id: number, pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind: 'player', pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function world(tanks: Tank[], rules: WorldRulesInit = { mode: 'ffa' }, over: Partial<World> = {}): World {
  return {
    tick: 0, nextId: 100, seed: 5, tanks, bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: -100000,
    rules: resolveWorldRules(rules), ...over,
  } as World;
}

const SPAN = Math.round(BOT_TARGET_COMMITMENT_SECONDS.normal * TICK_HZ);

describe('a bot slot is what the simulation can see (issue #891)', () => {
  it('treats a player tank as bot-driven only when it carries a difficulty', () => {
    // The NEGATIVE CONTROL for every other test in this file: if `isBotDriven` answered true
    // for a human, the contact overlay would ring the tank you are steering and `stepAi`
    // would overwrite a human's tank fields. Both halves asserted, so neither direction can
    // rot into a constant.
    expect(isBotDriven(tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' }))).toBe(true);
    expect(isBotDriven(tank(2, { x: 0, y: 0 }))).toBe(false);
    expect(isBotDriven(tank(3, { x: 0, y: 0 }, { kind: 'brown' }))).toBe(false);
  });

  it('commits nothing at all for an unstamped player tank', () => {
    // This is what every pre-#891 world is, and why the whole sim suite stayed green: a world
    // built without `WorldForInit.bots` reaches exactly the old code path.
    const w = world([tank(1, { x: 0, y: 0 }), tank(2, { x: 3, y: 0 })]);
    stepAi(w, []);
    expect(w.tanks[0].aiTargetId).toBeUndefined();
    expect(w.tanks[0].aiRetargetReason).toBeUndefined();
    expect(committedOpponent(w, w.tanks[0])).toBeNull();
  });
});

describe('the commitment window (issue #891)', () => {
  it('holds its first opponent for the full span even as a nearer one closes in', () => {
    // THE TEST THE FEATURE EXISTS FOR. A per-tick nearest scan -- the shipped behaviour
    // before this change -- switches the moment tank 3 becomes closer than tank 2, which
    // happens on the first tick below. Stickiness is the only thing that keeps id 2.
    const bot = tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' });
    const near = tank(2, { x: 4, y: 0 });
    const far = tank(3, { x: 20, y: 0 });
    const w = world([bot, near, far]);

    stepAi(w, []);
    expect(w.tanks[0].aiTargetId).toBe(2);
    expect(w.tanks[0].aiRetargetReason).toBe('acquired');

    // Tank 3 walks in and becomes much the closest. A stateless picker takes it immediately.
    far.pos = { x: 1, y: 0 };
    for (let i = 0; i < SPAN - 1; i++) stepAi(w, []);
    expect(w.tanks[0].aiTargetId).toBe(2);

    // Past the span, and materially better, so rule 6 lets the switch happen -- and records
    // it as an expiry switch rather than a loss.
    stepAi(w, []);
    stepAi(w, []);
    expect(w.tanks[0].aiTargetId).toBe(3);
    expect(w.tanks[0].aiRetargetReason).toBe('switched-on-expiry');
  });

  it('counts the span down one tick per step, from the configured seconds', () => {
    // Ties the observable countdown to BOT_TARGET_COMMITMENT_SECONDS rather than to a
    // literal: change the table and this test moves with it, which is what makes the table
    // the real source. A hard-coded 90 would pass with the constant deleted.
    const w = world([tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' }), tank(2, { x: 4, y: 0 })]);
    stepAi(w, []);
    expect(w.tanks[0].aiTargetTicks).toBe(SPAN);
    stepAi(w, []);
    expect(w.tanks[0].aiTargetTicks).toBe(SPAN - 1);
    stepAi(w, []);
    expect(w.tanks[0].aiTargetTicks).toBe(SPAN - 2);
  });

  it('reads its span from the bot table for every difficulty, not from the inert player profile', () => {
    // Population: all 3 shipped difficulties, asserted against the table by name. The point
    // of #891's criterion is WHERE the number comes from, so each arm is checked separately
    // even while the three values are equal.
    let checked = 0;
    for (const difficulty of BOT_DIFFICULTIES) {
      const w = world([tank(1, { x: 0, y: 0 }, { botDifficulty: difficulty }), tank(2, { x: 4, y: 0 })]);
      stepAi(w, []);
      expect(w.tanks[0].aiTargetTicks).toBe(Math.round(BOT_TARGET_COMMITMENT_SECONDS[difficulty] * TICK_HZ));
      checked++;
    }
    expect(checked).toBe(BOT_DIFFICULTIES.length);
    expect(BOT_DIFFICULTIES.length).toBe(3);
  });

  it('drops a dead opponent at once rather than waiting out the window', () => {
    // Rule 5, and the criterion "cannot leave AI stuck on a stale opponent". The span is
    // still running when tank 2 dies, so a window-only implementation would hold it.
    const w = world([
      tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' }),
      tank(2, { x: 4, y: 0 }),
      tank(3, { x: 9, y: 0 }),
    ]);
    stepAi(w, []);
    expect(w.tanks[0].aiTargetId).toBe(2);
    expect(w.tanks[0].aiTargetTicks).toBe(SPAN);

    w.tanks[1].alive = false;
    stepAi(w, []);
    expect(w.tanks[0].aiTargetId).toBe(3);
    expect(w.tanks[0].aiRetargetReason).toBe('target-lost');
  });
});

describe('who a bot may fight (issue #891)', () => {
  it('never targets itself in ffa', () => {
    // `isTargetable`, the campaign predicate, returns true for any live player-kind tank --
    // which in a versus world includes the subject. Selecting through `isOpponent` instead
    // is what excludes it, and a lone bot must therefore commit to nothing at all.
    const w = world([tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' })]);
    stepAi(w, []);
    expect(w.tanks[0].aiTargetId).toBeUndefined();
    expect(committedOpponent(w, w.tanks[0])).toBeNull();
  });

  it('never targets a team-mate in teams, and takes the further enemy over the nearer friend', () => {
    // The nearer tank is the team-mate, so a distance-only picker takes it. Both the
    // commitment and the read have to agree, so both are asserted.
    const w = world([
      tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal', team: 0 }),
      tank(2, { x: 2, y: 0 }, { team: 0 }),
      tank(3, { x: 9, y: 0 }, { team: 1 }),
    ], { mode: 'teams' });
    stepAi(w, []);
    expect(w.tanks[0].aiTargetId).toBe(3);
    expect(committedOpponent(w, w.tanks[0])?.id).toBe(3);
  });

  it('holds an opponent across both versus modes', () => {
    // #891's first criterion names ffa AND teams. Two worlds, same geometry, both asserted --
    // a mode-specific implementation passes one of these and fails the other.
    let checked = 0;
    for (const mode of ['ffa', 'teams'] as const) {
      const w = world([
        tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal', team: 0 }),
        tank(2, { x: 5, y: 0 }, { team: 1 }),
      ], { mode });
      stepAi(w, []);
      expect(w.tanks[0].aiTargetId, mode).toBe(2);
      expect(w.tanks[0].aiTargetTicks, mode).toBe(SPAN);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe('one opponent notion, across the write and the read (issue #891)', () => {
  it('re-validates a commitment that died during the step between write and read', () => {
    // The one-tick lag is real: `decidePlayerInput` runs BEFORE `step`, so it reads what
    // `stepAi` wrote last tick. Killing the committed tank without running `stepAi` again is
    // exactly the gap, and an unchecked read returns the corpse.
    const w = world([
      tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' }),
      tank(2, { x: 4, y: 0 }),
      tank(3, { x: 9, y: 0 }),
    ]);
    stepAi(w, []);
    expect(w.tanks[0].aiTargetId).toBe(2);

    w.tanks[1].alive = false;
    // No stepAi here, deliberately: this is the read side on its own.
    expect(committedOpponent(w, w.tanks[0])?.id).toBe(3);
    expect(w.tanks[0].aiTargetId, 'the read must not write').toBe(2);
  });

  it('falls back to a live candidate on the very first tick, before any commitment exists', () => {
    // Without the fallback a bot idles for one tick at every round start, which is visible.
    const w = world([tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' }), tank(2, { x: 4, y: 0 })]);
    expect(w.tanks[0].aiTargetId).toBeUndefined();
    expect(committedOpponent(w, w.tanks[0])?.id).toBe(2);
  });

  it('drives the bot decision at the committed opponent, not at the nearest one', () => {
    // THE CRITERION "exactly one opponent notion governs movement and firing", exercised
    // through the real decision rather than through the commitment alone. The bot is
    // committed to tank 2; tank 3 is then placed much nearer. A decision that re-picked the
    // nearest would aim the other way, so the aim vector is the observable.
    const w = world([
      tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' }),
      tank(2, { x: 10, y: 0 }),
      tank(3, { x: 0, y: 10 }),
    ]);
    stepAi(w, []);
    expect(w.tanks[0].aiTargetId).toBe(2);

    // Tank 3 closes to half the distance. Still inside the window.
    w.tanks[2].pos = { x: 0, y: 4 };
    const state = createPlayerAiState(mulberry32(7));
    const input = decidePlayerInput(w, 1, mulberry32(7), state);
    // Aim is a world point. Committed tank 2 lies along +x; the nearer tank 3 along +y.
    expect(Math.abs(input.aim.x), 'aims along the committed opponent, not the nearer one')
      .toBeGreaterThan(Math.abs(input.aim.y));
  });

  it('uses the same opponent predicate the commitment does', () => {
    // `isOpponent` is exported from targeting.ts precisely so the two paths cannot diverge.
    // Asserting the predicate's own answers here means a change to it that broke versus
    // targeting fails at the predicate rather than three layers downstream.
    const w = world([
      tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal', team: 0 }),
      tank(2, { x: 4, y: 0 }, { team: 0 }),
      tank(3, { x: 9, y: 0 }, { team: 1 }),
    ], { mode: 'teams' });
    expect(isOpponent(w, w.tanks[0], w.tanks[0]), 'self').toBe(false);
    expect(isOpponent(w, w.tanks[0], w.tanks[1]), 'team-mate').toBe(false);
    expect(isOpponent(w, w.tanks[0], w.tanks[2]), 'enemy').toBe(true);
  });
});

describe('determinism (issue #891)', () => {
  it('reproduces the same targets, spans and reasons from the same seed', () => {
    // The criterion is "seeded replay reproduces bot target choices, spans and retarget
    // reasons exactly". Two independent worlds from one seed, compared tick by tick on all
    // three fields rather than on the id alone.
    const build = () => world([
      tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' }),
      tank(2, { x: 4, y: 0 }, { botDifficulty: 'hard' }),
      tank(3, { x: 9, y: 3 }, { botDifficulty: 'easy' }),
    ]);
    const trace = (w: World) => w.tanks.map((t) => `${t.id}:${t.aiTargetId}:${t.aiTargetTicks}:${t.aiRetargetReason}`).join('|');

    const a = build();
    const b = build();
    const seen: string[] = [];
    for (let i = 0; i < 200; i++) {
      stepAi(a, []);
      stepAi(b, []);
      expect(trace(a), `tick ${i}`).toBe(trace(b));
      seen.push(trace(a));
    }
    // Not a constant trace: a run in which nothing ever changed would satisfy the equality
    // above while proving nothing, so the sweep is asserted to contain more than one state.
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it('commits every bot on the board, not just the first', () => {
    // A loop that broke early, or that only reached slot 0, would pass most of this file.
    const w = world([
      tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' }),
      tank(2, { x: 4, y: 0 }, { botDifficulty: 'normal' }),
      tank(3, { x: 9, y: 0 }, { botDifficulty: 'normal' }),
    ]);
    stepAi(w, []);
    const committed = w.tanks.filter((t) => t.aiTargetId !== undefined);
    expect(committed.length).toBe(3);
    for (const t of w.tanks) expect(t.aiTargetId, `tank ${t.id}`).not.toBe(t.id);
  });
});

describe('through the public boundary, not the seam (issue #891)', () => {
  // Every other test in this file calls `stepAi` or `commitBotTarget` on a world it mutates
  // in place. That cannot see the one thing a real tick does differently: `step` does not
  // mutate its input, so each tick runs on a CLONE. `cloneTank` spreads, so a scalar field
  // rides along -- but "I read the spread" is not "I ran it", and if the clone dropped
  // `botDifficulty` or `aiTargetId` the commitment would reset every tick while all 17
  // assertions above stayed green. .claude/rules/testing.md names this exact gap: a unit
  // test that calls a stage directly cannot prove composition.
  const idle: InputState = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };

  it('carries the commitment across real steps, clone and all', () => {
    const start = createWorldFor(ARENAS[3], 20260921, {
      playerCount: 4,
      rules: { mode: 'ffa' },
      bots: ['normal', 'normal', 'normal', 'normal'],
    });
    const bots = start.tanks.filter((t) => t.botDifficulty !== undefined);
    expect(bots.length, 'loadArena stamped every slot').toBe(4);

    let w = start;
    const spans: (number | undefined)[] = [];
    const ids: (number | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      w = stepInputs(w, [idle, idle, idle, idle]).world;
      const p1 = w.tanks.find((t) => t.controlledBy === 0)!;
      spans.push(p1.aiTargetTicks);
      ids.push(p1.aiTargetId);
      expect(p1.botDifficulty, `tick ${i}: the clone kept the marker`).toBe('normal');
    }

    // The span counts DOWN across ticks. If the clone dropped `aiTargetId`, every tick would
    // re-acquire and this would be a flat run of the full span instead.
    expect(ids.every((id) => id !== undefined && id === ids[0]), 'one opponent, held').toBe(true);
    expect(spans[0]).toBe(SPAN);
    expect(spans[5]).toBe(SPAN - 5);
    expect(new Set(spans).size, 'six distinct countdown values').toBe(6);
  });

  it('leaves a world built without `bots` exactly as it was before #891', () => {
    // The same arena and seed with the stamp omitted: no tank carries a difficulty, so
    // nothing commits and `stepAi` behaves as it did. This is what every pre-existing
    // fixture in the tree is, and why none of them moved.
    let w = createWorldFor(ARENAS[3], 20260921, { playerCount: 4, rules: { mode: 'ffa' } });
    for (let i = 0; i < 6; i++) w = stepInputs(w, [idle, idle, idle, idle]).world;
    const players = w.tanks.filter((t) => t.kind === 'player');
    expect(players.length).toBe(4);
    for (const t of players) {
      expect(t.botDifficulty, `tank ${t.id}`).toBeUndefined();
      expect(t.aiTargetId, `tank ${t.id}`).toBeUndefined();
    }
  });
});

describe('commitBotTarget directly (issue #891)', () => {
  it('returns null and writes nothing for a tank with no difficulty', () => {
    const w = world([tank(1, { x: 0, y: 0 }), tank(2, { x: 4, y: 0 })]);
    expect(commitBotTarget(w, w.tanks[0])).toBeNull();
    expect(w.tanks[0].aiTargetId).toBeUndefined();
  });

  it('reports the reason for the change it made', () => {
    const w = world([tank(1, { x: 0, y: 0 }, { botDifficulty: 'normal' }), tank(2, { x: 4, y: 0 })]);
    expect(commitBotTarget(w, w.tanks[0])).toBe('acquired');
    expect(commitBotTarget(w, w.tanks[0]), 'no change inside the window').toBeNull();
    expect(w.tanks[0].aiRetargetAgeTicks, 'ages once a reason exists').toBe(1);
  });
});
