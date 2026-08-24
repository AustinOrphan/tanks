/**
 * The golden trace, as a module both Node and a BROWSER can run.
 *
 * It used to live inline in trace.test.ts and hash through `node:crypto`, which meant the
 * one measurement that can prove the sim did not move could only ever be taken under
 * Node. The open question it exists to answer is cross-engine: if Chrome, Firefox and
 * Safari disagree by one ULP on `Math.hypot` or `Math.cos`, every peer-deterministic
 * netcode design is dead on arrival (docs/research/multiplayer.md, open question 1). So
 * the body moved here, and everything it touches is web-standard:
 *
 *   - `crypto.subtle.digest` instead of `node:crypto` -- present in browsers and in Node
 *     20+ as a global. It has no streaming API, so the trace is accumulated as text and
 *     hashed once; over the same UTF-8 bytes that is the identical digest, which is what
 *     BASELINE_HASH being unchanged by the extraction demonstrates.
 *   - `TextEncoder` for those bytes.
 *
 * `crypto.subtle` is only exposed in a SECURE CONTEXT. http://localhost counts; serving
 * this page over plain http from another host does not, and `crypto.subtle` is then
 * undefined. tools/baseline/run.mjs always serves on localhost.
 *
 * This module imports src/sim only. Adding an import of anything else -- a tool helper, a
 * node builtin -- is what would make it unloadable in a browser, silently, since nothing
 * typechecks tools/.
 */
import { ARENAS, createWorldFor } from '../../src/sim/arena';
import { step } from '../../src/sim/world';

/**
 * A golden trace over every shipped arena x 6 seeds x 2500 ticks. determinism.test.ts
 * asserts self-consistency, which is invariant under behaviour changes -- this is the pin
 * that actually moves when AI or collision behaviour moves. Changing it is a deliberate
 * act: re-record the value and say in the commit WHY it moved.
 *
 * MOVED (2026-08-16, PR "estimation error, both populations"): directive B's hazard
 * estimation error (the owner's 08:17 ruling -- AIs must not have oracle knowledge of
 * exact mine blast radii or perfect dodge positions) perturbs the PERCEIVED radius
 * `dangerAvoidMove`/`incomingThreats`/`mineThreatensPlayer` gate on for grey.ts/teal.ts,
 * which sit in the trace's reachable path (`step` -> `stepAi` -> `decideAi`). Old hash
 * `324aa9b5d369ec6abc61f73e8e454de67b5fbf365f4b0df2eedf2c01add33bb5`, new hash below --
 * confirmed moved by actually running trace.test.ts (not assumed), and confirmed it is
 * NOT a coincidence of some other change: this PR's only `src/sim/` edits are the five
 * `targeting.ts` parameterizations (all defaulted to today's exact constants),
 * grey.ts/teal.ts's perturbed-radius wiring, and the `estimationAccuracy` profile field.
 * The player-side half of the same mechanism (player-profile.ts, drawn from the injected
 * `rnd` stream, never `world.seed`) contributes NOTHING to this move -- the trace drives
 * its one player through `stepInputs` directly, never through `decidePlayerInput` -- which
 * is exactly the split this PR's plan predicted rather than treating "AI changed -> hash
 * moves" as one undifferentiated fact.
 *
 * What it does and does not cover. Every line below was RE-MEASURED on this branch by
 * applying the mutation and running trace.test.ts, not carried forward:
 *
 *   - bankShot returning the first valid candidate instead of the shortest
 *     (`bestAngle === null || length < bestLength || ...` -> `bestAngle === null`) moved
 *     the hash to 0cf1f76a14060992eb8763c9cd20e95b8c17cde2d1dbe3e8de6c87ff47137e9a and
 *     failed, AGAINST THE PRE-ESTIMATION-ERROR TREE -- not re-measured against the current
 *     hash below, so treat it as unmeasured at this tree rather than still-true.
 *   - The inside-wall escape is still NOT covered: disabling resolveWalls' union-mass
 *     branch outright (`if (false && walls.some(...))`, collision.ts) leaves all 7 tests
 *     green -- also measured against the pre-estimation-error tree, also unmeasured here.
 *     The seeded replay never drives a hull inside a wall, which the estimation-error
 *     change does not touch, so this is likely still true but is not re-confirmed.
 *   - Neither are the multi-input pairing rules in world.ts. This drives ONE player, so
 *     all 8 mutations swept in src/sim/step-inputs.test.ts leave the hash untouched --
 *     which is why that file exists.
 *
 * Lesson: a coverage claim recorded at one commit can go stale as later changes alter
 * trajectories -- re-measure rather than carrying it forward.
 */
/*
 * MOVED (2026-08-23, issue #275 as owner-revised on PR #311): mine triggers are
 * now source-specific -- a SHELL hit detonates immediately (unchanged from
 * pre-#275), FUSE expiry detonates exactly when it always did (its warning is
 * the fuse's final window, adding no time), and PROXIMITY entry opens a
 * MINE_PROXIMITY_DELAY_TICKS (30-tick) reaction window before the blast. Only
 * that proximity delay perturbs trajectories relative to the original tree, and
 * everything downstream of a delayed blast (kills, wall breaches, AI reactions)
 * shifts with it. NOT a coincidence of some other change: this PR's only
 * `src/sim/` edits are the phase machine (mines.ts/types.ts/events.ts/
 * constants.ts/balance.json's fuseWarningTicks+proximityDelayTicks) and
 * bullets.ts's immediate-shell call. Exposure MEASURED on this tree: the traced
 * population (5 arenas x 6 seeds x 2500 ticks, a mine laid every 311 ticks)
 * contains 19 proximity trips, 58 fuse warnings and 71 detonations -- ample
 * coupling. History: a5458ede... (pre-#275) -> cc748a89... (the first,
 * universal-30-tick-delay implementation, superseded before merge by the owner
 * direction) -> the hash below, confirmed by actually running trace.test.ts.
 * The Mine struct is never serialized here -- only sampled tank poses -- so the
 * field additions alone could not have moved it; the proximity timing shift is
 * what did.
 */
export const BASELINE_HASH = 'bbce570946e5049e3b7589c3f029ea283e5d1d48a1391980c49691e1107c08d5';

/** Seeds 1..TRACE_SEEDS are traced for every arena. */
export const TRACE_SEEDS = 6;
/** Ticks per (arena, seed) run, or until the world stops being 'playing'. */
export const TRACE_TICKS = 2500;
/** A tank sample is taken every TRACE_SAMPLE_EVERY ticks. */
export const TRACE_SAMPLE_EVERY = 100;

/**
 * Runs the trace and returns the exact text the fingerprint hashes.
 *
 * Split out from the hashing so the expensive, engine-sensitive half is synchronous and
 * inspectable: when two engines disagree, this is the string to diff, and the first
 * differing sample localises the divergence to an arena, a seed and a 100-tick window.
 */
export function traceText(): string {
  const parts: string[] = [];
  for (let a = 0; a < ARENAS.length; a++) {
    for (let seed = 1; seed <= TRACE_SEEDS; seed++) {
      let w = createWorldFor(ARENAS[a], seed);
      for (let t = 0; t < TRACE_TICKS && w.status === 'playing'; t++) {
        const d = { x: Math.cos(t / 37), y: Math.sin(t / 41) };
        w = step(w, { move: d, aim: d, fire: t % 23 === 0, mine: t % 311 === 0 }).world;
        if (t % TRACE_SAMPLE_EVERY === 0) {
          parts.push(w.tanks.map((k) =>
            `${k.pos.x.toFixed(9)},${k.pos.y.toFixed(9)},${k.turretAngle.toFixed(9)},${k.alive}`).join('|'));
        }
      }
      parts.push(`|${a}:${seed}:${w.status}:${w.tick}|`);
    }
  }
  return parts.join('');
}

/** SHA-256 of a string's UTF-8 bytes, lower-case hex. Web Crypto, so browser and Node. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  // padStart is load-bearing: a byte below 0x10 renders as one nibble without it, and the
  // hash comes out short and wrong only for inputs that happen to contain such a byte.
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The fingerprint: run the trace, hash it. Compare against BASELINE_HASH. */
export async function traceFingerprint(): Promise<string> {
  return sha256Hex(traceText());
}
