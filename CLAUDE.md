# Tanks!

A browser arena shooter: a deterministic 2D simulation core with a Three.js render layer
projected from it. Spec and plan live in `docs/superpowers/`.

## Commands

```
npm test     # tsc --noEmit && vitest run
npm run build # tsc --noEmit && vite build
npm run dev   # vite
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build and a bundle-portability
assertion on Node 20 and 22. `engines.node` says `>=20`, but the dependency tree actually
needs `>=20.19.0`.

## Architecture invariants

**`src/sim/` is a pure, deterministic core.** It must import nothing from `three`,
`howler`, or the DOM. That purity is what makes it headlessly testable and makes replays
exact functions of their inputs. `src/sim/purity.test.ts` enforces it by scanning every
file under `src/sim/`; it is the only file there that mentions those packages.

**Fixed timestep.** `TICK_HZ = 60`, `DT = 1/60`. The sim never sees wall-clock time.

**Render and audio are one-way projections.** The sim emits a `SimEvent[]` stream
(`src/sim/events.ts`) and never reaches back. Consumers today: `render/renderer.ts`,
`render/particles.ts`, `audio/director.ts`, `game/state.ts` (win/lose drives the game-over
screen) and `game/loop.ts`. If you change an event's shape, check all five.

`step(world, input)` clones its input and returns `{ world, events }` — it never mutates
what it is given.

## Testing conventions, learned the hard way

These are not style preferences. Each one exists because a real defect shipped green.

**Unit files call sim stages directly, so they cannot see composition.** `movement.test.ts`
and friends call `stepMovement` themselves, which means deleting the call from `step()`
leaves them passing. Composition is pinned separately, through `step()` alone, in
`src/sim/step-pipeline.test.ts`. Anything asserting *that a stage runs* or *in what order*
belongs there and must not call the stage directly.

**Presence-only assertions on the event stream are close to worthless.** The stream is
shared: `some(e => e.type === 'fire')` passes on an AI tank's shell even when the player's
event is dropped entirely. Discriminate by `ownerId`, and assert payloads (`pos`, `angle`)
— `particles.ts` draws bursts at exactly `ev.pos`, so a wrong position is a visible defect
that no presence check catches.

**Prove the gap before writing the test.** Apply the mutation, watch the suite pass, then
write the test, then watch the mutation die. A test that never failed proves nothing.

**Sweep classes, state denominators.** Write "32 of 36 (population: all 36 distinct
single-element moves)", never "32 of 36". A count without its population reads as an
exhaustive sweep. Name any class you did *not* sweep. This repo has twice shipped a
survivor hiding in an unstated remainder.

**Every assertion must be able to fail.** Before adding one, name the production change
that would break it. Watch for tautologies against the fixture: asserting `angle: 0` in a
fixture whose angle is 0 passes even when the field is hardcoded. Decorative assertions are
worse than none — they advertise coverage that does not exist.

**A guard is worth what its own tests prove.** The purity guard reported green for four of
five known-bad imports until it was given a meta-test. Guards need negative controls.

## Merge bar

Nothing reaches `main` without comprehensive adversarial review: reviewers fan out per
subsystem and must prove each finding with a command and its real output, then an
independent pass adjudicates every claim. Re-measure headline numbers yourself rather than
relaying an agent's self-report.

Review agents that *mutate* files each need their own worktree, or they overwrite each
other's experiments and every result becomes noise.

## Commits

No `Co-Authored-By` or tool-attribution trailers — the history carries none. `gh pr merge
--squash` concatenates branch commit messages into the merge commit, so pass an explicit
`--body` to control what lands.

## Known holes

`src/main.ts` still has no test file and cannot have one: it runs at module scope against
`document.getElementById('app')`, so importing it starts the game. It is now **wiring only** —
everything it used to do (the WebGL error page, the teardown registration) lives in
`src/boot.ts`, which takes its collaborators as arguments and is tested. Keep `main.ts` free
of logic; anything added there is unpinned again, and that is the whole of its remaining risk.

The game loop used to be the worst of these — `while (false && acc >= DT)`, the shipped
game never simulating a tick, passed the full gate. It is now split across `game/frame.ts`
(pure timestep maths), `game/driver.ts` (the frame loop, clock and rAF injected) and
`game/loop.ts` (construction and wiring, dependencies injected as factories), each with a
sibling test file. **Two seams there are load-bearing and easy to lose in a tidy-up:**
`driver.ts` reads `sm.state` twice per frame and the reads must not be hoisted into one
const, because `onEvents` flips the state between them; and `Driver.world`/`prevWorld` must
stay getters, since a plain property snapshots at construction and `tsc` will not warn.
`loop.test.ts`'s last describe block exists because `driver.test.ts` injects fake hooks and
so cannot see whether `loop.ts` wires the real collaborators into them — the composition
blindness above, one layer up. Do not delete it.

Modules with no sibling test file, re-verified at `97e4242` and updated here: `main.ts`,
`render/particles.ts`, `render/renderer.ts`, `render/scene.ts`,
`sim/ai/decision.ts`, `sim/ai/index.ts`. (`render/entities.ts` and `render/interpolate.ts`
*are* tested — do not assume the whole render layer is bare.) Merged PR descriptions carry
the detailed residual backlog.
