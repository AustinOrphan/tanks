import { describe, it, expect } from 'vitest';
import { ARENAS, arenaById, createWorldFor } from '../sim/arena';
import { cloneWorld, step, stepInputs, type World } from '../sim/world';
import type { InputState } from '../sim/types';
import { COUNTDOWN_TICKS } from '../sim/constants';
import balanceJson from '../sim/config/data/balance.json';
import {
  canonical,
  fingerprint,
  encodeInput,
  decodeInput,
  decodeTick,
  createRecordingInput,
  replayMetaFor,
  replayTrace,
  checkTrace,
  simDataFingerprint,
  REPLAY_FORMAT,
  REPLAY_SCHEMA,
  type ReplayMeta,
  type EncodedInput,
} from './replay';

const META: ReplayMeta = {
  arenaId: 'arena-01',
  seed: 12345,
  lives: 3,
  unarmedTrigger: 'none',
  invincible: false,
  corpseBlocksShells: false,
  muzzleClearsTanks: true,
  coopAttempts: true,
  mode: 'campaign-coop',
  friendlyFire: false,
  aiTargetPerception: 'full',
};

/**
 * A deterministic, seeded input script -- NOT a constant input.
 *
 * A constant input would make "the recorder captured the stream" untestable: any
 * per-tick mix-up (an off-by-one, a dropped tick, a repeated one) replays
 * identically when every tick is the same. This varies every field, and every SLOT:
 * `slotCount` > 1 gives each slot its own draw from the same stream rather than
 * cloning slot 0's value, so a slot mix-up (the driver-layer twin of
 * step-inputs.test.ts's pairing tests) has something to catch.
 */
function scriptedInputs(
  seed: number,
  slotCount = 1,
): { sample(): InputState[]; calls: number; last: InputState[] | null } {
  let s = seed >>> 0;
  const nextInput = (): InputState => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const a = (s % 1000) / 1000;
    return {
      move: { x: a * 2 - 1, y: 1 - a },
      aim: { x: 10 * a, y: -7 * a },
      fire: (s & 8) !== 0,
      mine: (s & 16) !== 0,
    };
  };
  const src = {
    calls: 0,
    /** The exact array last handed out, so a caller can assert IDENTITY. */
    last: null as InputState[] | null,
    sample(): InputState[] {
      src.calls += 1;
      src.last = Array.from({ length: slotCount }, nextInput);
      return src.last;
    },
  };
  return src;
}

function worldFor(meta: ReplayMeta, playerCount = 1): World {
  return createWorldFor(
    arenaById(meta.arenaId),
    meta.seed,
    meta.unarmedTrigger,
    meta.lives,
    meta.corpseBlocksShells,
    meta.muzzleClearsTanks,
    playerCount,
    meta.coopAttempts,
    meta.mode,
    meta.friendlyFire,
    undefined, // stock: versus-only, not a ReplayMeta field
    undefined, // teams: versus-only, not a ReplayMeta field
    meta.aiTargetPerception,
  );
}

describe('canonical / fingerprint', () => {
  it('is insensitive to key ORDER but sensitive to values', () => {
    // Key order is the failure this exists to prevent: a JSON module's property
    // order is a bundler artefact, so an order-sensitive hash would differ between
    // `vite dev` and `vite build` and silently reject every trace across the two.
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it('keeps ARRAY order, which is data', () => {
    // An arena's grid is an array of row strings; two arenas with the same rows in
    // a different order are different levels.
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
  });

  it('does not confuse an array with the object of its indices', () => {
    expect(fingerprint([7, 8])).not.toBe(fingerprint({ 0: 7, 1: 8 }));
  });

  it('sees a change ANYWHERE in a nested structure', () => {
    const base = { a: { b: { c: [1, { d: 'x' }] } } };
    const moved = { a: { b: { c: [1, { d: 'y' }] } } };
    expect(fingerprint(base)).not.toBe(fingerprint(moved));
  });

  it('distinguishes null, undefined-shaped absence, and the string "null"', () => {
    expect(fingerprint({ a: null })).not.toBe(fingerprint({ a: 'null' }));
    expect(fingerprint({ a: null })).not.toBe(fingerprint({}));
  });
});

describe('simDataFingerprint', () => {
  it('is eight hex digits', () => {
    expect(simDataFingerprint()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('moves when a balance scalar moves', () => {
    // Deliberately NOT a pinned literal. A literal here would make retuning
    // balance.json a three-file edit (JSON, constants.test.ts, and this), which is
    // a pin CLAUDE.md's two-file convention does not ask for. What has to be true
    // is the PROPERTY: perturb the data and the fingerprint moves. Measured against
    // a copy, so nothing in the sim is touched.
    const before = fingerprint({ balance: balanceJson });
    const after = fingerprint({
      balance: { ...balanceJson, tank: { ...balanceJson.tank, speed: balanceJson.tank.speed + 1 } },
    });
    expect(after).not.toBe(before);
  });

  it('covers ai-profiles and arenas, not only balance', () => {
    // The stamp claims all four data files. If it hashed balance alone, this would
    // pass for the wrong reason -- so compare the real stamp against a fingerprint
    // of balance alone: they must differ, which is only true if more went in.
    expect(simDataFingerprint()).not.toBe(fingerprint({ balance: balanceJson }));
  });
});

describe('encodeInput / decodeInput', () => {
  it('round-trips fractional and negative components EXACTLY', () => {
    const input: InputState = {
      move: { x: -0.3333333333333333, y: 0.7 },
      aim: { x: 12.5, y: -0.125 },
      fire: false,
      mine: false,
    };
    expect(decodeInput(encodeInput(input))).toEqual(input);
  });

  it('keeps fire and mine independent', () => {
    // Population: all 4 combinations of the two edge-triggered booleans. Packed
    // into one number, so a wrong mask makes one button press the other.
    for (const fire of [false, true]) {
      for (const mine of [false, true]) {
        const input: InputState = { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire, mine };
        expect(decodeInput(encodeInput(input))).toEqual(input);
      }
    }
  });

  it('does not confuse move with aim', () => {
    const decoded = decodeInput(encodeInput({
      move: { x: 1, y: 2 },
      aim: { x: 3, y: 4 },
      fire: false,
      mine: false,
    }));
    expect(decoded.move).toEqual({ x: 1, y: 2 });
    expect(decoded.aim).toEqual({ x: 3, y: 4 });
  });
});

describe('createRecordingInput', () => {
  it('returns the inner sample UNCHANGED, and calls it exactly once per sample', () => {
    const inner = scriptedInputs(1);
    const rec = createRecordingInput(inner, META);
    const seen = rec.sample();
    expect(inner.calls).toBe(1);
    // IDENTITY, not value equality: the driver hands this array straight to
    // stepInputs(), so a recorder that returned its own reconstruction (through
    // encode/decode, say) would pass a `toEqual` while substituting a different
    // array for the real one.
    expect(seen).toBe(inner.last);
    expect(decodeTick(rec.trace().ticks[0])).toEqual(seen);
  });

  it('records exactly one tick per sample, in order', () => {
    const rec = createRecordingInput(scriptedInputs(7), META);
    const taken: InputState[][] = [];
    for (let i = 0; i < 25; i++) taken.push(rec.sample());
    const trace = rec.trace();
    expect(trace.ticks).toHaveLength(25);
    expect(trace.ticks.map(decodeTick)).toEqual(taken);
  });

  it('stamps the format, schema and sim fingerprint', () => {
    const rec = createRecordingInput(scriptedInputs(1), META);
    const trace = rec.trace();
    expect(trace.format).toBe(REPLAY_FORMAT);
    expect(trace.schema).toBe(REPLAY_SCHEMA);
    expect(trace.data).toBe(simDataFingerprint());
    expect(trace.meta).toEqual(META);
  });

  it('stops at the limit, keeps delegating, and says it truncated', () => {
    const inner = scriptedInputs(3);
    const rec = createRecordingInput(inner, META, 4);
    for (let i = 0; i < 10; i++) rec.sample();
    const trace = rec.trace();
    expect(trace.ticks).toHaveLength(4);
    expect(trace.truncated).toBe(true);
    // The game must not change because a trace filled up: every sample still
    // reaches the real input source.
    expect(inner.calls).toBe(10);
  });

  it('is not truncated before the limit is reached', () => {
    const rec = createRecordingInput(scriptedInputs(3), META, 4);
    for (let i = 0; i < 4; i++) rec.sample();
    expect(rec.trace().truncated).toBe(false);
  });

  it('begin() starts a fresh trace under the new meta', () => {
    const rec = createRecordingInput(scriptedInputs(3), META, 2);
    rec.sample();
    rec.sample();
    rec.sample(); // truncates
    const next: ReplayMeta = { ...META, arenaId: 'arena-03', seed: 99 };
    rec.begin(next);
    expect(rec.trace().ticks).toEqual([]);
    expect(rec.trace().truncated).toBe(false);
    expect(rec.trace().meta).toEqual(next);
    rec.sample();
    expect(rec.trace().ticks).toHaveLength(1);
  });

  it('hands back a SNAPSHOT: later ticks do not mutate a trace already taken', () => {
    const rec = createRecordingInput(scriptedInputs(3), META);
    rec.sample();
    const first = rec.trace();
    rec.sample();
    expect(first.ticks).toHaveLength(1);
    // The encoded tuples are copies at every level -- outer tick array, per-slot
    // array, and the tuple itself -- so mutate at the DEEPEST level (slot 0's tuple's
    // first number), not the tick or slot array, or a shallow-copy regression would
    // pass this the same way a bare `[...t]` at the outer level alone would.
    (first.ticks[0][0] as EncodedInput)[0] = 999;
    expect(rec.trace().ticks[0][0][0]).not.toBe(999);
  });
});

describe('replayMetaFor', () => {
  it('reads the world, not the flags that built it', () => {
    const world = createWorldFor(ARENAS[1], 4242, 'both', 2);
    expect(replayMetaFor(world, 'arena-02')).toEqual({
      arenaId: 'arena-02',
      seed: 4242,
      lives: 2,
      unarmedTrigger: 'both',
      invincible: false,
      corpseBlocksShells: false,
      muzzleClearsTanks: true,
      coopAttempts: true,
      mode: 'campaign-coop',
      friendlyFire: false,
      aiTargetPerception: 'full',
    });
  });

  it('reads the two playtest switches off the world too, not just unarmedTrigger', () => {
    // Same claim as the case above, for the two NEW World-level switches: a replay
    // must reproduce whatever corpseBlocksShells/muzzleClearsTanks the recorded world
    // was actually built with, not today's defaults.
    const world = createWorldFor(ARENAS[0], 7, 'none', 3, true, false);
    expect(replayMetaFor(world, 'arena-01')).toEqual({
      arenaId: 'arena-01',
      seed: 7,
      lives: 3,
      unarmedTrigger: 'none',
      invincible: false,
      corpseBlocksShells: true,
      muzzleClearsTanks: false,
      coopAttempts: true,
      mode: 'campaign-coop',
      friendlyFire: false,
      aiTargetPerception: 'full',
    });
  });

  it('reads coopAttempts off the world too, when the shipped pool model was requested', () => {
    // Same claim again, for the shared-attempts switch: a replay must reproduce
    // whatever coopAttempts the recorded world was actually built with (pool mode,
    // false), not the shared-attempts default.
    const world = createWorldFor(ARENAS[0], 8, 'none', 3, undefined, undefined, 2, false);
    expect(replayMetaFor(world, 'arena-01')).toEqual({
      arenaId: 'arena-01',
      seed: 8,
      lives: 3,
      unarmedTrigger: 'none',
      invincible: false,
      corpseBlocksShells: false,
      muzzleClearsTanks: true,
      coopAttempts: false,
      mode: 'campaign-coop',
      friendlyFire: false,
      aiTargetPerception: 'full',
    });
  });

  it('reads mode and friendlyFire off the world too, when a versus mode was requested (n-player arc PR 4)', () => {
    const world = createWorldFor(ARENAS[0], 11, 'none', 3, undefined, undefined, 4, undefined, 'teams', true);
    expect(replayMetaFor(world, 'arena-01')).toEqual({
      arenaId: 'arena-01',
      seed: 11,
      lives: 3,
      unarmedTrigger: 'none',
      invincible: false,
      corpseBlocksShells: false,
      muzzleClearsTanks: true,
      coopAttempts: true,
      mode: 'teams',
      friendlyFire: true,
      aiTargetPerception: 'full',
    });
  });

  it('reads aiTargetPerception off the world too, when the line-of-sight bound was requested (issue #492)', () => {
    // The seventh rule on World.rules, and the one this meta used to omit entirely: a
    // trace recorded under `?dev=1&aiPerception=los` stamped nothing about the bound,
    // so playback rebuilt at the shipped 'full' while the fingerprint still reported a
    // match. Every field is asserted, so a rule the meta stops reading is caught here
    // whichever of the seven it is.
    const world = createWorldFor(
      ARENAS[0], 13, 'none', 3, undefined, undefined, 1, undefined,
      undefined, undefined, undefined, undefined, 'line-of-sight',
    );
    expect(replayMetaFor(world, 'arena-01')).toEqual({
      arenaId: 'arena-01',
      seed: 13,
      lives: 3,
      unarmedTrigger: 'none',
      invincible: false,
      corpseBlocksShells: false,
      muzzleClearsTanks: true,
      coopAttempts: true,
      mode: 'campaign-coop',
      friendlyFire: false,
      aiTargetPerception: 'line-of-sight',
    });
  });

  it('round-trips mode and friendlyFire through createWorldFor -- enemies stay stripped on the rebuilt world too', () => {
    const recorded = createWorldFor(ARENAS[0], 12, 'none', 3, undefined, undefined, 4, undefined, 'ffa', undefined);
    const meta = replayMetaFor(recorded, 'arena-01');
    expect(meta.mode).toBe('ffa');
    const rebuilt = worldFor(meta, 4);
    expect(rebuilt.rules.mode).toBe('ffa');
    expect(rebuilt.rules.friendlyFire).toBe(false);
    expect(rebuilt.tanks.every((t) => t.kind === 'player')).toBe(true);
  });

  it('round-trips through createWorldFor: a rebuilt world still carries the recorded switches', () => {
    // The discriminating case: replayMetaFor alone proves the meta carries the right
    // values, but a replay is only faithful if REBUILDING from that meta reproduces
    // them too. worldFor() in this file is the same rebuild loop.test.ts's replay
    // round-trip performs against a live game.
    const recorded = createWorldFor(ARENAS[0], 9, 'none', 3, true, false);
    const meta = replayMetaFor(recorded, 'arena-01');
    const rebuilt = worldFor(meta);
    expect(rebuilt.rules.corpseBlocksShells).toBe(true);
    expect(rebuilt.rules.muzzleClearsTanks).toBe(false);
  });

  it('carries the dev invincibility that loop.ts applies AFTER the world is built', () => {
    // The one field that is not an argument to createWorldFor: loop.ts sets it on
    // the player tank, and a replay that dropped it would kill a player the
    // recorded run did not.
    const world = createWorldFor(ARENAS[0], 5, 'none', 3);
    world.tanks.find((t) => t.kind === 'player')!.invincible = true;
    expect(replayMetaFor(world, 'arena-01').invincible).toBe(true);
  });
});

describe('replayTrace', () => {
  it('reproduces a run tick for tick, from the trace alone', () => {
    // The claim the whole feature rests on. Record a real run through the real
    // sim, then rebuild the world from meta and re-apply the recorded inputs: the
    // final worlds must be identical, structurally, not merely "still playing".
    const meta = replayMetaFor(worldFor(META), 'arena-01');
    const rec = createRecordingInput(scriptedInputs(2024), meta);

    let live = worldFor(meta);
    const liveEvents: number[] = [];
    // Past COUNTDOWN_TICKS, so the recorded stretch includes live movement and
    // shots rather than only the blocked opening.
    const TICKS = COUNTDOWN_TICKS + 240;
    for (let i = 0; i < TICKS; i++) {
      const result = stepInputs(live, rec.sample());
      live = result.world;
      liveEvents.push(result.events.length);
    }

    const replayed = replayTrace(rec.trace(), worldFor(meta));
    expect(replayed.ticks).toBe(TICKS);
    expect(cloneWorld(replayed.world)).toEqual(cloneWorld(live));
    expect(replayed.events).toHaveLength(liveEvents.reduce((a, b) => a + b, 0));
    // Non-vacuous: the run has to have DONE something, or an all-zeros comparison
    // would pass with the inputs discarded.
    expect(replayed.events.length).toBeGreaterThan(0);
    expect(replayed.world.tick).toBe(TICKS);
  });

  it('diverges when a single tick is dropped -- the equality above is load-bearing', () => {
    // The negative control for the test above: if the comparison could not see a
    // one-tick difference, it would pass for a recorder that dropped ticks.
    const meta = replayMetaFor(worldFor(META), 'arena-01');
    const rec = createRecordingInput(scriptedInputs(2024), meta);
    let live = worldFor(meta);
    for (let i = 0; i < COUNTDOWN_TICKS + 120; i++) live = stepInputs(live, rec.sample()).world;

    const trace = rec.trace();
    const short = { ...trace, ticks: trace.ticks.filter((_, i) => i !== COUNTDOWN_TICKS + 10) };
    const replayed = replayTrace(short, worldFor(meta));
    expect(cloneWorld(replayed.world)).not.toEqual(cloneWorld(live));
  });

  it('replays an empty trace as the world it was handed', () => {
    const world = worldFor(META);
    const result = replayTrace(createRecordingInput(scriptedInputs(1), META).trace(), world);
    expect(result.ticks).toBe(0);
    expect(result.world).toBe(world);
  });

  it('at a 1-length array (single player, no coop), reproduces EXACTLY what the pre-change step()-based path produced', () => {
    // Non-circular by construction: the LEFT side never touches the recorder, the new
    // EncodedTick shape, or stepInputs -- it is `step()`, structurally unchanged by
    // this PR, driving the same scripted sequence one InputState at a time, exactly
    // as every caller in the tree did before this PR. The RIGHT side is the new
    // pipeline: a 1-length-array sample() of the IDENTICAL sequence, recorded and
    // replayed through encodeTick/decodeTick/stepInputs. Byte-identical worlds here
    // is the regression this PR must not move: single-player behaviour under the new
    // schema has to equal single-player behaviour under the old one.
    let s = 555 >>> 0;
    const nextInput = (): InputState => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const a = (s % 1000) / 1000;
      return {
        move: { x: a * 2 - 1, y: 1 - a },
        aim: { x: 10 * a, y: -7 * a },
        fire: (s & 8) !== 0,
        mine: (s & 16) !== 0,
      };
    };
    const TICKS = COUNTDOWN_TICKS + 200;
    const script: InputState[] = Array.from({ length: TICKS }, nextInput);

    let viaStep = worldFor(META);
    const spawnPos = viaStep.tanks.find((t) => t.kind === 'player')!.pos;
    // Tracked across the WHOLE run, not read once at the end: arena-01 has real
    // enemies, and a player who dies mid-run respawns exactly at spawn under a fresh
    // countdown -- so a final-position check can land back on spawnPos by unlucky
    // timing even though the tank plainly moved in between. "Ever moved" is immune
    // to that; a final-position check on this exact seed was not (measured: it did).
    let everMoved = false;
    for (const input of script) {
      viaStep = step(viaStep, input).world;
      const p = viaStep.tanks.find((t) => t.kind === 'player');
      if (p && (p.pos.x !== spawnPos.x || p.pos.y !== spawnPos.y)) everMoved = true;
    }

    let i = 0;
    const rec = createRecordingInput(
      { sample: () => [script[i++]] },
      replayMetaFor(worldFor(META), 'arena-01'),
    );
    for (let t = 0; t < TICKS; t++) rec.sample();
    const replayed = replayTrace(rec.trace(), worldFor(META));

    expect(replayed.ticks).toBe(TICKS);
    expect(cloneWorld(replayed.world)).toEqual(cloneWorld(viaStep));
    // Non-vacuous: prove the script actually drove the tank away from spawn at some
    // point, or an all-idle comparison would pass with the inputs discarded on both
    // sides alike.
    expect(everMoved).toBe(true);
  });

  it('round-trips TWO slots -- each player replays its OWN recorded input; swapping the two slots diverges', () => {
    const meta = replayMetaFor(worldFor(META, 2), 'arena-01');
    const rec = createRecordingInput(scriptedInputs(4242, 2), meta);

    let live = worldFor(meta, 2);
    const TICKS = COUNTDOWN_TICKS + 120;
    for (let i = 0; i < TICKS; i++) live = stepInputs(live, rec.sample()).world;

    const trace = rec.trace();
    const replayed = replayTrace(trace, worldFor(meta, 2));
    expect(replayed.ticks).toBe(TICKS);
    expect(cloneWorld(replayed.world)).toEqual(cloneWorld(live));

    // Non-vacuous, and immune to arena-01's real enemies possibly killing (and
    // respawning) a player mid-run: rather than reason about final positions, swap
    // the two slots in EVERY recorded tick and replay again. If the per-slot pairing
    // were not actually preserved through record/encodeTick/decodeTick -- both slots
    // silently fed the same entry, or slot order lost in the round trip -- this would
    // replay IDENTICALLY to the unswapped trace. It must not: this is
    // step-inputs.test.ts's "pairs by position, not by which one is first" claim,
    // proven again at the encoding layer.
    const swapped = { ...trace, ticks: trace.ticks.map(([a, b]) => [b, a]) };
    const replayedSwapped = replayTrace(swapped, worldFor(meta, 2));
    expect(cloneWorld(replayedSwapped.world)).not.toEqual(cloneWorld(live));
  });

  it('round-trips the AI perception rule, and a rebuild at the shipped default fights DIFFERENT opponents (issue #492)', () => {
    // The rule the meta used to omit, proven end to end rather than field by field:
    // record under the line-of-sight bound, rebuild from the meta alone, and the
    // replay must reproduce the recorded run -- while the rebuild the omission
    // actually produced ('full', the shipped default) must not.
    //
    // arena-02 is the discriminating board. Measured at world seed 12345, input seed
    // 2024 and COUNTDOWN_TICKS + 240 ticks, the four enemies' committed targets come
    // out [null, 5, 5, null] under the bound and [5, 5, 5, 5] without it: two of them
    // are fighting nobody in the recorded run and all four are fighting the player in
    // the rebuild the defect produced. arena-01 would prove nothing here -- its three
    // enemies commit to the player under both rules (measured over the same seeds at
    // COUNTDOWN_TICKS + 120, + 240 and + 480).
    const recorded = createWorldFor(
      arenaById('arena-02'), 12345, 'none', 3, undefined, undefined, 1, undefined,
      undefined, undefined, undefined, undefined, 'line-of-sight',
    );
    const meta = replayMetaFor(recorded, 'arena-02');
    expect(meta.aiTargetPerception).toBe('line-of-sight');
    expect(worldFor(meta).rules.aiTargetPerception).toBe('line-of-sight');

    const rec = createRecordingInput(scriptedInputs(2024), meta);
    let live = worldFor(meta);
    const TICKS = COUNTDOWN_TICKS + 240;
    for (let i = 0; i < TICKS; i++) live = stepInputs(live, rec.sample()).world;

    const trace = rec.trace();
    const replayed = replayTrace(trace, worldFor(meta));
    expect(cloneWorld(replayed.world)).toEqual(cloneWorld(live));

    // The divergence-sensitive outcome, and the negative control for the equality
    // above: the SAME trace replayed into a world rebuilt at 'full'. Compared on the
    // AI's own committed targets rather than on the whole world, because `rules` is
    // itself part of the world and would differ trivially.
    const committed = (w: World) =>
      w.tanks.filter((t) => t.kind !== 'player').map((t) => t.aiTargetId ?? null);
    const unbounded = replayTrace(trace, worldFor({ ...meta, aiTargetPerception: 'full' }));
    expect(committed(replayed.world)).not.toEqual(committed(unbounded.world));
    // and in which direction: the bound leaves someone with no opponent at all, the
    // default leaves nobody without one. The length is asserted first because `some`
    // and `every` are both vacuous on an empty enemy list.
    expect(committed(replayed.world)).toHaveLength(4);
    expect(committed(replayed.world).some((id) => id === null)).toBe(true);
    expect(committed(unbounded.world).every((id) => id !== null)).toBe(true);
  });
});

describe('checkTrace', () => {
  it('accepts a trace this build just produced', () => {
    expect(checkTrace(createRecordingInput(scriptedInputs(1), META).trace())).toEqual({
      ok: true,
      reason: null,
    });
  });

  it('rejects a foreign format, a foreign schema and a stale fingerprint', () => {
    // Population: the three stamp fields checkTrace inspects, one at a time.
    const good = createRecordingInput(scriptedInputs(1), META).trace();
    expect(checkTrace({ ...good, format: 'something.else' }).ok).toBe(false);
    expect(checkTrace({ ...good, schema: REPLAY_SCHEMA + 1 }).ok).toBe(false);
    expect(checkTrace({ ...good, data: 'deadbeef' }).ok).toBe(false);
    // and the reason names which one, so a bug report says why it was refused
    expect(checkTrace({ ...good, data: 'deadbeef' }).reason).toContain('deadbeef');
    expect(checkTrace({ ...good, schema: 9 }).reason).toContain('schema');
  });

  it('rejects a schema-3 trace, which predates the recorded perception rule (issue #492)', () => {
    // The no-migration policy, at the one version where reading an old trace anyway
    // would be actively wrong: a schema-3 trace carries no aiTargetPerception, so
    // anything that accepted it would have to default the rule to 'full' -- which is
    // exactly the silent divergence the bump exists to stop. Fails if REPLAY_SCHEMA is
    // left at 3 while the field is added, which is the whole hazard of a meta change
    // without a version change.
    const good = createRecordingInput(scriptedInputs(1), META).trace();
    expect(checkTrace({ ...good, schema: 3 }).ok).toBe(false);
    expect(checkTrace({ ...good, schema: 3 }).reason).toContain('schema 3');
    // Non-vacuous: the trace this build just produced is still accepted, so the
    // rejection above is about the version and not about the trace.
    expect(checkTrace(good).ok).toBe(true);
  });
});
