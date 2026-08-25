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
/*
 * MOVED (2026-08-23, issue #222 on PR for feat/ai-decision-commitment): AI movement is now
 * COMMITTED for a profile-driven span (ai/commitment.ts, applied centrally in decideAi)
 * instead of re-decided every tick, and aim jitter DRIFTS across its AI_JITTER_TICKS bucket
 * (smoothstep between adjacent draws) instead of holding one value and stepping at the
 * boundary. Both change enemy trajectories and aim, and everything downstream of a
 * differently-aimed shell or a differently-steered tank shifts with them.
 *
 * NOT a coincidence of some other change: this PR's only `src/sim/` edits are
 * ai/commitment.ts (new), aimJitter in ai/targeting.ts, the avoid/avoidKind/intent fields
 * threaded through ai/decision.ts + brown/grey/teal + index.ts, the commitmentTime profile
 * field (config/types.ts, config/validate.ts, data/ai-profiles.json), three new constants,
 * and the shared hold reaching decidePlayerInput.
 *
 * The two new Tank fields could NOT have moved this by themselves: traceText below samples
 * only pos.x/pos.y/turretAngle/alive per tank plus a per-run status/tick line -- it never
 * serializes the Tank struct -- so the move is attributable entirely to changed behaviour.
 *
 * Exposure MEASURED on this tree, over exactly the traced population (5 arenas x 6 seeds x
 * 2500 ticks): 203238 enemy decision-ticks, of which 123003 (60.5%) ran with a live
 * commitment being HELD rather than re-decided, and 193137 (95.0%) read an aim offset from
 * somewhere other than a jitter-bucket boundary -- i.e. a drifted value where the old code
 * returned that bucket's flat draw. Ample coupling in both mechanisms; this is not a hash
 * moved by a rounding difference.
 *
 * History: bbce5709... (issue #275 as owner-revised) -> the hash below, confirmed by
 * actually running trace.test.ts rather than by computing it a second way.
 */
/*
 * MOVED (2026-08-24, issue #224): wall navigability checks now look AI_PATH_HORIZON_TICKS
 * (8) ticks ahead instead of one, at four call sites: bestEscapeDirection's mine-flee
 * wheel, both perpendicular passes in dangerAvoidMove's bullet branch, seekMove's blocked-
 * heading fallback, and player-profile.ts's seekLikeMove (now sharing targeting.ts's
 * wallBlocksPath instead of a private one-tick copy). A new deterministic fallback,
 * sidestepAroundBlockage, also engages when dangerAvoidMove's both dodge perpendiculars
 * are wall-blocked. wallBlocksStep stays at one tick, unchanged, for commitment.ts's
 * emergency check, which is not in the trace's AI path.
 *
 * NOT a coincidence of some other change: this PR's only `src/sim/` edits are
 * ai/targeting.ts (wallBlocksPath's horizon parameter, sidestepAroundBlockage),
 * constants.ts (the new AI_PATH_HORIZON_TICKS constant), and ai/player-profile.ts
 * (seekLikeMove switched onto the shared wallBlocksPath and its now-redundant private
 * wallBlocksStep copy deleted) -- confirmed via `git diff main...HEAD --stat -- src/sim/`.
 *
 * traceText samples only pos.x/pos.y/turretAngle/alive per tank plus a per-run
 * status/tick line; it never serializes a Tank's or a Wall's struct, so no field addition
 * could have moved this hash by itself -- only a changed trajectory could, and a changed
 * navigability check is exactly that.
 *
 * Exposure MEASURED on this tree, over exactly the traced population (5 arenas x 6 seeds x
 * 2500 ticks): a throwaway probe (written for this measurement, run via `npx tsx`, then
 * deleted) replayed the trace and, at every enemy decision-tick (204272 of them -- every
 * alive non-player tank, every tick, the same population ai/index.ts's stepAi iterates),
 * evaluated the fixed 16-sample ESCAPE_SAMPLES wheel bestEscapeDirection/
 * sidestepAroundBlockage both use against that tank's actual position and the real wall
 * geometry, comparing wallBlocksPath(..., AI_PATH_HORIZON_TICKS) to wallBlocksStep (the old
 * one-tick probe) for each of the 16 fixed directions. 14655 of 204272 decision-ticks
 * (7.17%) had at least one wheel candidate flip from clear-at-one-tick to blocked-at-the-
 * horizon; 63039 of 3268352 individual candidate evaluations (1.93%) flipped. This measures
 * only the wheel mechanism (data-independent, so cheap to re-derive exactly outside the
 * sim) and is a real, specific LOWER BOUND, not a claim of exhaustive coverage: it does not
 * replay dangerAvoidMove's state-dependent bullet-perpendicular candidates or seekMove's
 * single seek-heading candidate, both of which also call wallBlocksPath and can only add to
 * this figure, never subtract from it. Ample coupling either way -- this is not a hash
 * moved by a rounding difference.
 *
 * History: 1ae1d739f4fda997d0796e127e899219d197bfeb2f0f1d39463a5b86659cc2b6 (issue #222 on
 * PR for feat/ai-decision-commitment) -> the hash below, confirmed by actually running
 * trace.test.ts rather than by computing it a second way.
 */
/*
 * MOVED (2026-08-25, issue #347): the AI turret gained angular ACCELERATION. stepAi now
 * routes through accelSlew (ai/turret-accel.ts), which carries the turret's angular velocity
 * on the tank and bounds how fast that velocity may change, instead of slewAngle's bang-bang
 * min(|error|, maxDelta). stepAi is in the traced path and traceText below samples
 * turretAngle to nine decimals per tank, so a changed turret trajectory moves this hash.
 *
 * ATTRIBUTION, STATED HONESTLY -- this one does NOT have the byte-for-byte control that
 * issues #344/#345 had, and the difference is worth being explicit about. There is no setting
 * of AI_TURRET_RAMP_TICKS that recovers the old behaviour: at ramp 1 the acceleration budget
 * equals the whole rate cap, but accelSlew ALSO decelerates onto its target and clamps
 * arrival, and both of those are unconditional. Measured rather than assumed -- ramp 1
 * produces 0be09f94..., which is neither this hash nor the previous 42d764e9... So the
 * constant cannot be used as an off switch, and no claim is made that it can.
 *
 * What the attribution rests on instead:
 *   - Edit surface: this PR's only non-test src/sim behaviour edits are ai/turret-accel.ts
 *     (new), the single slew call site in ai/index.ts, Tank.turretVel in types.ts, the two
 *     revival resets in world.ts, and the new constant. Confirmed with
 *     `git diff main...HEAD --name-only -- src/sim/ | grep -v '.test.ts'`.
 *   - traceText serializes no struct -- only pos/turretAngle/alive -- so the new Tank field
 *     cannot have moved this hash by existing; only a changed trajectory can.
 *   - Direct exposure, measured on this tree over exactly the traced population (5 arenas x 6
 *     seeds x 2500 ticks) by a throwaway probe that reproduced this fingerprint: of 197815
 *     enemy turret updates, 10357 (5.24%) returned an angle DIFFERENT from what slewAngle
 *     would have returned from the same state on the same tick. The two rules agree whenever
 *     the turret is already saturated or sitting on its target, and disagree while it is
 *     ramping, which is exactly the intended surface.
 * MOVED (2026-08-25, issue #344): AI tanks now HOLD a solved aim angle for a profile
 * span (aimHoldTime) instead of re-solving aimLead from scratch every tick and slewing at
 * whatever came out. decideAi layers holdAimFor (ai/aim-hold.ts) over the behaviour
 * function's turretAngle, exactly as it already layers commitMove over desiredMove, and
 * stepAi writes the held angle and its countdown back onto the tank. stepAi is squarely in
 * the traced path (step -> stepAi -> decideAi) and traceText below samples turretAngle to
 * nine decimals for every tank, so a changed aim target moves this hash directly.
 *
 * ATTRIBUTION IS EXACT, not inferred. Setting every profile's aimHoldTime to 0 -- changing
 * nothing else -- reproduces the PREVIOUS hash 42d764e9... byte for byte over the whole
 * traced population, and trace.test.ts passes green in that state. A span of zero re-arms
 * to a zero countdown, so the hold branch can never be taken and every tick re-solves,
 * which is precisely the pre-#344 behaviour. That also makes the "zero disables the hold"
 * contract documented on AIProfileBalance.aimHoldTime a measured fact rather than a claim.
 *
 * Exposure MEASURED on this tree, over exactly the traced population (5 arenas x 6 seeds x
 * 2500 ticks), by a throwaway probe -- a counter at decideAi's hold call site plus a
 * replica of traceText's loop, run via vitest, then deleted. The replica reproduced this
 * fingerprint, which is what makes it the traced population rather than a similar one.
 *
 * Of 205695 enemy decision-ticks -- every alive non-player tank, every tick, the same
 * population stepAi iterates -- 34992 (17.01%) sent the turret somewhere OTHER than the
 * freshly solved angle. That is the figure quoted deliberately, and it is the narrow one:
 * a tick where the tank holds an angle that happens to equal the fresh solution changes
 * nothing and is excluded, which is why this is 17% and not the 98% a naive "was a hold
 * live?" counter reports over the same run. 34992 diverging ticks is ample coupling for a
 * hash that moves on a single ULP; this is not a rounding artefact.
 *
 * NOT a coincidence of some other change: this PR's only non-test src/sim edits are
 * ai/aim-hold.ts (new), the hold call site and write-back in ai/index.ts, the two Tank
 * fields in types.ts, the two AiDecision fields plus their eight literal construction
 * sites, AI_AIM_BREAK in constants.ts, and aimHoldTime in config/types.ts + validate.ts.
 * The Tank and AiDecision field additions could NOT have moved this by themselves --
 * traceText serializes no struct, only pos/turretAngle/alive -- so the move is
 * attributable entirely to the changed aim target, and the aimHoldTime=0 control above
 * demonstrates that directly.
 *
 * History: 42d764e94d4234e1acea2dd16ed45bdea8cb0c9e22ba3635753a4739346b81f0 (issue #224 on
 * PR for feat/ai-wall-aware-evasion) -> the hash below, confirmed by actually running
 * trace.test.ts rather than by computing it a second way.
 */
export const BASELINE_HASH = '056afe386774790c739f7b28a05bb77abb68e5d07b140f6a798bf7731850024e';

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
