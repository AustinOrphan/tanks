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
 * nothing else -- reproduces the PREVIOUS hash 056afe38... byte for byte over the whole
 * traced population, and trace.test.ts passes green in that state. Note that previous hash is
 * issue #347's, not #224's: this work was rebased onto the merged turret-acceleration change,
 * so the control is against a tree that ALREADY accelerates, and what it isolates is the aim
 * hold alone on top of that. A span of zero re-arms
 * to a zero countdown, so the hold branch can never be taken and every tick re-solves,
 * which is precisely the pre-#344 behaviour. That also makes the "zero disables the hold"
 * contract documented on AIProfileBalance.aimHoldTime a measured fact rather than a claim.
 *
 * Exposure MEASURED on this tree, over exactly the traced population (5 arenas x 6 seeds x
 * 2500 ticks), by a throwaway probe -- a counter at decideAi's hold call site plus a
 * replica of traceText's loop, run via vitest, then deleted. The replica reproduced this
 * fingerprint, which is what makes it the traced population rather than a similar one.
 *
 * Of 201661 enemy decision-ticks -- every alive non-player tank, every tick, the same
 * population stepAi iterates -- 33539 (16.63%) sent the turret somewhere OTHER than the
 * freshly solved angle. That is the figure quoted deliberately, and it is the narrow one:
 * a tick where the tank holds an angle that happens to equal the fresh solution changes
 * nothing and is excluded, which is why this is 15% and not the 98% a naive "was a hold
 * live?" counter reports over the same run -- the naive figure was measured first, and
 * discarded for describing ticks on which nothing changed. 31560 diverging ticks is ample
 * coupling for a hash that moves on a single ULP; this is not a rounding artefact.
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
 * MOVED (2026-08-28, issue #367): the AI reaction clock no longer banks countdown ticks.
 * `stepAi` accumulates `tank.aimTicks` only while `roundPhase(world)` is 'live', so time
 * spent watching the player through the fire-free countdown no longer satisfies a
 * profile's authored reaction delay. The turret still tracks during the countdown -- that
 * happens inside `decideAi` -- so the telegraph is unchanged; only the clock is held. A
 * changed first-shot tick moves every tank's sampled position downstream of it, so this
 * hash moves directly.
 *
 * ATTRIBUTION IS EXACT, by the same method as the aim-hold entry above. Reverting the ONE
 * changed term -- `phase === 'live' &&` in the dispatcher's `tank.aimTicks` assignment
 * (src/sim/ai/index.ts), nothing else -- reproduces the previous hash
 * a1df14427a1b6e87c57ec9a72a46b97018ccd79e3cd8ea48a6f901bf27f7dda7 byte for byte over the
 * whole traced population, and trace.test.ts passes green in that state. Run, not reasoned.
 *
 * The branch's other production edit, the same rule at the scripted player's own clock
 * (src/sim/ai/player-profile.ts), does not reach this trace: traceText drives the player
 * with its own `Math.cos(t / 37)` input pattern and never calls `decidePlayerInput`. Not
 * left as a reading of the code -- reverting THAT term alone, with the dispatcher's kept,
 * reproduces the hash below unchanged and trace.test.ts stays green. So the move is
 * attributable to the enemy dispatcher alone, by control rather than by argument.
 *
 * Exposure MEASURED over exactly this population (5 arenas x 6 seeds x 2500 ticks) by a
 * throwaway probe that replicated traceText's loop and reproduced BOTH fingerprints -- the
 * old one under the reverted term, the new one under the shipped term -- which is what
 * makes it the traced population rather than a similar one:
 *
 *   - Under the OLD rule: 201652 enemy decision-ticks (every alive non-player tank, every
 *     tick, the population stepAi iterates), of which 80757 fall in a countdown and 9540
 *     of those banked a clock tick -- 11.81% of countdown ticks, 4.73% of all.
 *   - The figure that matters is not that one. In 12 of the 30 traced runs an enemy stood
 *     at or past its FULL authored reaction span at the moment the countdown ended, i.e.
 *     was entitled to fire on the first live tick. That is the defect #367 names, at 40%
 *     of runs.
 *   - Under the NEW rule the same population is 212841 enemy decision-ticks: the divergence
 *     changes who is alive and for how long, which is why the two totals differ and why a
 *     single before/after count would have been the wrong shape to quote.
 *
 *
 * MOVED (2026-08-28, issue #332): teal no longer re-picks bank-first vs direct-first on a
 * global tick cycle. The plan is HELD per tank (Tank.aiShotPlan/aiShotPlanTicks) for a
 * profile span (shotCommitmentTime) and may only turn over on a tick where the held plan
 * has no solution. Which of the two solutions teal aims at is the tank's turretAngle, and
 * traceText samples turretAngle to nine decimals for every tank, so a changed preference
 * moves this hash directly.
 *
 * ATTRIBUTION IS EXACT, by the same method as the two entries above. Restoring the ONE
 * changed term -- `preferBank`, back to the pre-#332 `Math.floor(world.tick / 120) % 2 === 0`
 * in src/sim/ai/teal.ts, and NOTHING else, so the profile field, its validation, the two
 * Tank fields, the two AiDecision fields, the stepAi write-back and teal's no-target carry
 * all stay on the tree -- reproduces the previous hash
 * cf92a77bc9c5b85600cda0cf6031cc2279ec33bca66cd8c84ff9195436d73bb5 byte for byte, and
 * trace.test.ts passes green in that state. Run, not reasoned. That control is also what
 * rules out the plumbing: with every added field present and only the selector reverted,
 * the hash is unmoved, so none of the additions move it by themselves.
 *
 * Exposure MEASURED over exactly this population (5 arenas x 6 seeds x 2500 ticks) by a
 * throwaway probe at the `preferBank` site, run via vitest and then deleted. The probe run
 * reproduced the fingerprint below, which is what makes it the traced population rather
 * than a similar one:
 *
 *   - 36421 of 52961 tealDecision calls -- 68.77% -- chose a different preferred shot type
 *     than the old cycle would have chosen on that tick, across 4 distinct teal tank ids.
 *
 * That is a divergence figure, NOT a claim that 68.77% of ticks changed the turret angle:
 * on any tick where only one of the two shot types has a solution, both rules end up firing
 * the same angle by fallback. It is quoted as the coupling that makes a moved hash expected,
 * and it is ample for a fingerprint that moves on a single ULP.
 *
 * History: 056afe386774790c739f7b28a05bb77abb68e5d07b140f6a798bf7731850024e (issue #347 on
 * PR #348, turret angular acceleration) -> a1df14427a1b6e87c57ec9a72a46b97018ccd79e3cd8ea48a6f901bf27f7dda7
 * (issue #344, the AI aim hold) -> cf92a77bc9c5b85600cda0cf6031cc2279ec33bca66cd8c84ff9195436d73bb5
 * (issue #367, the reaction clock) -> 37eff51ef55ad4bb3ccda2981a6c4ad8b522ee502ec9a560d8e2467a60ceb787
 * (issue #237, the muzzle inset) -> the hash below, confirmed by actually running
 * trace.test.ts rather than by computing it a second way.
 *
 * MOVED (issue #237, the muzzle inset): SHELL_SPAWN_FORWARD went 0.85 -> 0.525, so every
 * shell in the trace is born a third of a unit closer to its firer and reaches everything
 * it hits about three ticks later. `step` -> `stepBullets`/`resolveBulletHits` is squarely
 * in the traced path, so this fingerprint had to move; a change that left it alone would
 * have meant the inset was not reaching the sim.
 *
 * The old value was re-confirmed to still be reachable before it was replaced: with
 * SHELL_NOSE_REACH_RADII set to 0 -- the pre-#237 spawn, with every other line of this
 * change still in place -- trace.test.ts reproduces
 * 37eff51ef55ad4bb3ccda2981a6c4ad8b522ee502ec9a560d8e2467a60ceb787 exactly. That is the
 * evidence that muzzlePoint's restructuring (one return value became two) is
 * behaviour-neutral, and that the spawn distance is the only thing in this change that
 * moves what the trace records.
 *
 * IT IS NOT EVIDENCE ABOUT THE `fire` EVENT, in either direction, and the control cannot
 * be read that way: at SHELL_NOSE_REACH_RADII 0 the muzzle plane and the spawn are the
 * same point, so a flash pinned to either one produces identical output. The trace could
 * not see the difference regardless -- traceText records tank pose, liveness and terminal
 * status only, never events or bullets. The flash's position is pinned by tests instead
 * (bullets.test.ts, step-contract.test.ts, and the `muzzle-flash-collapses-onto-the-shell`
 * manifest entry), not here.
 *
 * MOVED ONCE, on 2026-08-29, and only after proving the move was a WIDENING rather than a
 * re-record -- the failure mode this file's own test warns about ("someone narrows the
 * trace, sees red, and RE-RECORDS the hash"). Issue #271 appended `vs-duel-01` to
 * ARENA_DEFS, and `traceText` iterates that array in order, so the new board's runs land
 * at the END. Measured on both trees with the same probe: the new trace text is
 * byte-identical to the old for its first 115687 characters and adds 6642, containing
 * exactly 6 new `|a:seed:status:tick|` markers -- one per seed for the one new board.
 * `newText.startsWith(oldText)` is true. No existing arena's simulation moved, which is
 * the only thing this fingerprint is a pin on. Previous value:
 * 5a7238535cd9192a39a7ae22aaba2f89afe7d15fd93369be40eeb5ee012a221c
 */
export const BASELINE_HASH = '6438933b56c8d0d1b968217896313c903ea5bc7fbbc4cabac14f6e2e65e00a70';

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
