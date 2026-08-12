import { step, type World } from '../sim/world';
import type { InputState, UnarmedTrigger } from '../sim/types';
import type { SimEvent } from '../sim/events';
import balanceJson from '../sim/config/data/balance.json';
import tankDefsJson from '../sim/config/data/tank-defs.json';
import aiProfilesJson from '../sim/config/data/ai-profiles.json';
import arenasJson from '../sim/config/data/arenas.json';
import { TICK_HZ } from '../sim/constants';

/**
 * Record the per-tick input stream, and replay it back through the sim.
 *
 * The sim needs NO change for this: `step(world, input)` clones its argument and
 * returns a new world, every draw comes from a seeded mulberry32 keyed off
 * `world.seed`, and nothing under `src/sim/` reads a clock or `Math.random`. So a
 * run is already an exact function of (starting world, input per tick) -- what was
 * missing was anything in the shipped game that could CAPTURE that pair.
 *
 * The recorder is a DECORATOR over the input collaborator loop.ts hands the
 * driver. driver.ts calls `input.sample()` exactly once per simulated tick, so
 * wrapping it captures the stream `step` actually saw -- including the autoplay
 * substitution, which is the same seam -- with no change to the driver at all.
 *
 * Game layer only. Nothing here may reach `src/sim/`: a recorder inside the sim
 * would be state the sim's own purity guard exists to keep out.
 */

/** The wire discriminator, so a pasted blob of some other JSON is rejected loudly. */
export const REPLAY_FORMAT = 'tanks.replay';

/**
 * The TRACE SCHEMA's version: the shape below, and nothing about the sim.
 * Bump it when the encoding changes; it says nothing about whether the sim would
 * produce the same run, which is what the fingerprint is for.
 */
export const REPLAY_SCHEMA = 1;

/**
 * Ten minutes at 60 Hz. A trace that grows forever is a memory leak in a flag
 * someone leaves on; recording stops here and says so (`truncated`) rather than
 * dropping the oldest ticks, because a replay must start at tick 0 to mean
 * anything.
 *
 * Its MAGNITUDE is pinned by no test, deliberately: halving it to five minutes
 * leaves replay.test.ts green, because the limit tests pass an explicit `limit`
 * rather than exercising this number. What IS pinned is that the default gets
 * APPLIED at all -- setting it to 0 fails several of those tests. Retune it
 * freely; that is the same treatment CLAUDE.md gives its other feel constants.
 */
export const DEFAULT_TICK_LIMIT = TICK_HZ * 60 * 10;

/**
 * What a run needs to be REBUILT before its inputs can be re-applied.
 *
 * Read off the world rather than off the flags that produced it: `invincible` is
 * a dev flag applied to the player tank after `levels.world(...)` returns, and a
 * trace recorded with it on replays differently, so the trace has to carry the
 * world's own answer.
 */
export interface ReplayMeta {
  /**
   * The ARENA this trace's world was built from, not a campaign level id. A
   * level can be re-pointed to a different arena later (issue #154's
   * campaign.json), and a trace must keep reproducing the exact geometry it
   * was recorded against -- so it names the arena directly rather than a
   * level id re-resolved through (possibly since-edited) campaign data.
   */
  arenaId: string;
  seed: number;
  lives: number;
  unarmedTrigger: UnarmedTrigger;
  invincible: boolean;
}

/** `[moveX, moveY, aimX, aimY, bits]`, bits = fire | mine<<1. */
export type EncodedInput = [number, number, number, number, number];

export interface ReplayTrace {
  format: string;
  schema: number;
  /**
   * A fingerprint of the sim's DATA -- balance, tank defs, AI profiles, arenas.
   * See simDataFingerprint() for exactly what it does and does not cover.
   */
  data: string;
  meta: ReplayMeta;
  ticks: EncodedInput[];
  /** True once the tick limit was reached and inputs stopped being appended. */
  truncated: boolean;
}

/**
 * FNV-1a over a CANONICAL rendering of a value: object keys sorted, arrays kept
 * in order, numbers via their JSON form.
 *
 * Sorted keys are the point. JSON module imports are transformed by the bundler,
 * and relying on property order would let the same data fingerprint differently
 * under `vite dev` and `vite build` -- traces recorded in one and silently
 * rejected in the other.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`).join(',')}}`;
}

/** FNV-1a, 32-bit, as 8 lowercase hex digits. Not a security hash -- a change detector. */
export function fingerprint(value: unknown): string {
  const text = canonical(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * THE VERSION-STAMP DECISION, since a trace recorded against different constants
 * diverges silently and there is no way to tell from the divergence alone.
 *
 * The stamp is TWO things, because they answer different questions:
 *
 *  - `schema` (REPLAY_SCHEMA) -- can this build PARSE the trace?
 *  - `data` (this fingerprint) -- would this build produce the same run from it?
 *
 * The fingerprint covers all four JSON files the sim is built from, not just
 * balance.json: `arenas.json` decides the world a level index rebuilds to,
 * `ai-profiles.json` and `tank-defs.json` decide what every enemy does with it.
 * Any of them moving invalidates a trace, so all four are in.
 *
 * WHAT IT DOES NOT COVER, stated because a matching stamp is easy to over-read:
 * CODE. A change to `targeting.ts` or `collision.ts` diverges a replay with this
 * fingerprint unchanged. Closing that would mean stamping a build identity (a
 * commit sha injected at build time), which is a build-pipeline change this does
 * not make -- see the backlog entry. A mismatch is therefore proof a trace is
 * stale; a match is not proof it is fresh.
 *
 * `campaign.json` (issue #154) is DELIBERATELY not a 5th hashed file, for the
 * same reason ReplayMeta carries an arena id rather than a level id: campaign
 * order changes which arena a level POSITION resolves to, not any single
 * arena's own trajectory, and this fingerprint's job is "would this build's
 * data reproduce the same run from an already-resolved arena," not "did the
 * position-to-arena mapping stay the same."
 *
 * LAZY and memoised, not a module-level const. The canonical rendering of the four
 * files is 20,445 characters; hashing it cost 3.5 ms cold and 0.27 ms warm
 * (median of 50) in a standalone node 24 script running this same canonical/FNV
 * code over the same four files -- NOT an in-browser measurement, and not this
 * module under vite. Small either way, but it was being paid at import time by
 * every boot, including the ones with no dev flag on at all, since loop.ts
 * imports this module unconditionally. Nothing calls it unless
 * `?dev=1&replay=1` is set.
 */
let simDataFingerprintMemo: string | null = null;
export function simDataFingerprint(): string {
  simDataFingerprintMemo ??= fingerprint({
    balance: balanceJson,
    tankDefs: tankDefsJson,
    aiProfiles: aiProfilesJson,
    arenas: arenasJson,
  });
  return simDataFingerprintMemo;
}

export function encodeInput(input: InputState): EncodedInput {
  return [
    input.move.x,
    input.move.y,
    input.aim.x,
    input.aim.y,
    (input.fire ? 1 : 0) | (input.mine ? 2 : 0),
  ];
}

export function decodeInput(t: EncodedInput): InputState {
  return {
    move: { x: t[0], y: t[1] },
    aim: { x: t[2], y: t[3] },
    fire: (t[4] & 1) !== 0,
    mine: (t[4] & 2) !== 0,
  };
}

/** The slice of the input controller the driver -- and therefore this -- uses. */
export interface InputSource {
  sample(): InputState;
}

export interface RecordingInput extends InputSource {
  /**
   * Start a NEW trace for a freshly built world. Called at boot and on every
   * level switch: a trace spans one world, because its inputs only mean anything
   * applied to the world they were sampled against.
   */
  begin(meta: ReplayMeta): void;
  /** The trace so far. A snapshot -- later ticks do not mutate what was returned. */
  trace(): ReplayTrace;
}

/**
 * Wrap an input source so every sample is remembered.
 *
 * `sample()` returns the inner value UNCHANGED and calls the inner source exactly
 * once, which is what makes recording invisible to the game: the driver steps the
 * sim with the same object it would have had.
 */
export function createRecordingInput(
  inner: InputSource,
  meta: ReplayMeta,
  limit: number = DEFAULT_TICK_LIMIT,
): RecordingInput {
  let current = meta;
  let ticks: EncodedInput[] = [];
  let truncated = false;

  return {
    sample(): InputState {
      const input = inner.sample();
      if (ticks.length < limit) ticks.push(encodeInput(input));
      else truncated = true;
      return input;
    },
    begin(next: ReplayMeta): void {
      current = next;
      ticks = [];
      truncated = false;
    },
    trace(): ReplayTrace {
      return {
        format: REPLAY_FORMAT,
        schema: REPLAY_SCHEMA,
        data: simDataFingerprint(),
        meta: { ...current },
        ticks: ticks.map((t) => [...t] as EncodedInput),
        truncated,
      };
    },
  };
}

/** What a world says about itself, for the trace's meta. */
export function replayMetaFor(world: World, arenaId: string): ReplayMeta {
  return {
    arenaId,
    seed: world.seed,
    lives: world.lives,
    unarmedTrigger: world.unarmedTrigger,
    invincible: world.tanks.find((t) => t.kind === 'player')?.invincible ?? false,
  };
}

export interface TraceCheck {
  ok: boolean;
  /** null when ok. */
  reason: string | null;
}

/**
 * Is this trace one THIS build can replay faithfully?
 *
 * Separate from replaying it: a stale trace still replays, it just produces a
 * different run, so the caller gets to decide whether to look anyway.
 */
export function checkTrace(trace: ReplayTrace): TraceCheck {
  if (trace.format !== REPLAY_FORMAT) return { ok: false, reason: `not a ${REPLAY_FORMAT} trace` };
  if (trace.schema !== REPLAY_SCHEMA) {
    return { ok: false, reason: `schema ${trace.schema} != ${REPLAY_SCHEMA}` };
  }
  const want = simDataFingerprint();
  if (trace.data !== want) {
    return { ok: false, reason: `sim data ${trace.data} != ${want}` };
  }
  return { ok: true, reason: null };
}

export interface ReplayResult {
  world: World;
  events: SimEvent[];
  ticks: number;
}

/**
 * Re-apply a trace's inputs to a world, tick for tick.
 *
 * The caller supplies the STARTING world, rebuilt from `trace.meta`: this module
 * cannot build one without knowing the session's level system, and taking one as
 * an argument keeps it a pure function of (world, trace).
 *
 * Does NOT check the stamp -- `checkTrace` is separate on purpose, so a
 * deliberately-stale replay (what did this trace do under the NEW balance?) is
 * possible.
 */
export function replayTrace(trace: ReplayTrace, world: World): ReplayResult {
  let w = world;
  const events: SimEvent[] = [];
  for (const t of trace.ticks) {
    const result = step(w, decodeInput(t));
    w = result.world;
    for (const ev of result.events) events.push(ev);
  }
  return { world: w, events, ticks: trace.ticks.length };
}
