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

`src/game/loop.ts` has no test file, and mutations to it pass the full CI gate — including
`while (false && acc >= DT)`, the shipped game never simulating a tick. Closing it needs
the loop's dependencies (`now`, `raf`, renderer, audio, input) injected.

Modules with no sibling test file, as of `c9a783d`: `game/loop.ts`, `main.ts`,
`render/canvas.ts`, `render/particles.ts`, `render/renderer.ts`, `render/scene.ts`,
`sim/ai/decision.ts`, `sim/ai/index.ts`. (`render/entities.ts` and `render/interpolate.ts`
*are* tested — do not assume the whole render layer is bare.) Merged PR descriptions carry
the detailed residual backlog.
