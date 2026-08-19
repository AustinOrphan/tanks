# Development reference

On-demand rules for development flags, feel constants, and Git workflow.

## Dev flags

Unshipped work lives behind a flag in `src/game/devflags.ts`, on `main` — **not on a
long-lived experimental branch**. Both approaches were measured before choosing:

- Flags cost **4.15 kB raw / 1.45 kB gzipped**, 0.8% of the bundle.
- An unmerged branch (`round-ux`) had NOT rotted after 11 commits — it merged clean and
  passed. Branch rot is not the argument.
- What the split *did* cost was real: `devflags.ts` ended up on two branches at 40 and 53
  lines and had **already diverged**, in the one file whose job is to be the single place
  flags are defined.

The deciding reason is CI. Code on `main` is exercised on every run; a branch is exercised
only when someone updates it. `round-ux` passes today, and nobody would learn the day it
stopped.

**The flag list lives in `docs/dev-flags.md`** — generated from `devflags.ts`'s
`FLAG_REGISTRY` by `npm run devflags:doc`, guarded against drift by
`tools/devflags/doc.test.ts` (editing a flag without regenerating goes red; the fix is
the generator, never the test), and structurally complete: `FLAG_REGISTRY` is a
`Record<keyof DevFlags, …>`, so a new flag without a registry entry is a compile
error. This paragraph deliberately enumerates nothing — a hand-kept list here went
stale three flags deep before the registry replaced it. `playtest=1` is a parse-time
BUNDLE, not a field: its expansion is the registry's `PLAYTEST_BUNDLE.expandsTo`, the
single source both the parser and the doc read. `parseDevFlags` derives the boolean
list from `DEV_FLAGS_OFF` in its tests, so adding one cannot quietly shrink what they
cover.

**`roundPhaseHud` is the first flag to complete the cycle: it SHIPPED, so the flag is
gone and the behaviour is on.** The round opens with `COUNTDOWN_TICKS` (3.0s) in which
movement is blocked; with no HUD, the player pressed a direction and the game read as
broken for three seconds of every round and every respawn. `devflags.test.ts` pins that
the retired key is not merely ignored but absent, so a stale `?dev=1&roundPhaseHud=1`
link cannot read as still meaning something.

Two rules follow:

**Nothing is on unless `dev` is present.** `?aimRay=1` alone does nothing; it needs
`?dev=1&aimRay=1`, so a shared link cannot enable anything by accident.

**A flag is temporary.** It exists so work can land tested and unshipped, not so `main` can
accumulate features nobody decided on. Each one should end up either shipped — flag deleted,
behaviour on — or deleted outright. A flag with no owner and no decision is the thing this
arrangement is meant to avoid, and it is worse than the branch would have been.

Flags are **build-time-free but not free**: they are parsed at runtime, so they must never
reach `src/sim/`. That core is pure and deterministic, and a replay has to stay an exact
function of its inputs — a runtime-varying flag there would break it. `MINE_BLAST_THROUGH_DESTRUCTIBLE`
is a *constant* for exactly this reason.

## Numbers that are feel, not measurement

Some constants were chosen by eye and are cheap to change; the tests are written against
the constant rather than a hardcoded result, so retuning does not mean rewriting tests.

- `TANK_TURN_RATE` (5.0 rad/s) -- how fast the hull swings. Modelled on Wii Play: Tanks!
  from recollection, **not measured against it**. Must stay below
  `PLAYER_TURRET_TURN_RATE` (8.0): a hull that outturns its own gun makes aiming while
  moving feel like fighting the tank.
- `MINE_BLAST_EXPAND_TICKS` / `MINE_BLAST_HOLD_TICKS` (5/5) -- the blast ramp. **Measured**
  to be a feel change, not a balance one: at `TANK_SPEED` 3.0 a tank covers 0.25 units
  while the blast expands, 10% of the 2.5 kill reach. 60 seeded games, 25 detonations,
  7 tanks in reach, 0 escapes either with the ramp or with it flattened to instant.
- `BLAST_FLATTEN` (0.7), `BLAST_LINGER_TICKS` (2), `MINE_DOME_H` -- pure look. Compare
  candidates with `npm run gallery --sweep` rather than guessing.

**`GRACE_TICKS` is 0 -- the grace phase is switched off**, but its machinery is intact.
`roundPhase` and `roundPhaseTicksLeft` delegate to pure `phaseAt(elapsed, countdown,
grace)` and `ticksLeftAt(...)`, which are tested at a POSITIVE grace span precisely so
turning the constant back on does not land on untested code.


## Git workflow

Branches describe the change, never the actor or tool:

- use short lowercase kebab-case
- optionally group under `feat/`, `fix/`, `refactor/`, `test/`, `docs/`, `ci/`, or
  `chore/` when that category adds information
- descriptive unprefixed names such as `level-select` remain valid
- never use agent names, usernames, session ids, or tool prefixes such as `agent/`,
  `claude/`, or `codex/`

Examples: `ci/harden-ubuntu-apt`, `fix/persist-campaign-lives`,
`docs/privacy-policy`, `refactor/scoped-project-instructions`.

Do not add `Co-Authored-By` or tool-attribution trailers. The pull-request title is the
entire squash commit message; do not append branch commits, a body, issue metadata, or
attribution.
