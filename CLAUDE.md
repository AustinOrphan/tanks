# Tanks!

A browser arena shooter with a pure deterministic 2D simulation and a Three.js projection
layer. `docs/README.md` is the generated index of every specification, plan, backlog topic,
and research note.

## Start here

- Work from the current tree; inspect the branch and existing changes before editing.
- Claude Code loads a scoped rule from `.claude/rules/` when it reads a file matching that
  rule's `paths` patterns. Other agents should open the rule files matching every path they
  touch.
- Use `docs/README.md` to find current direction, plans, backlog topics, and research, and
  `docs/agent/README.md` for detailed rationale and historical landmines. Read only the
  relevant section; neither index's documents are imported globally.
- Preserve unrelated user changes and keep a task in its own branch or worktree.

## Essential commands

```sh
npm run verify:quick  # typecheck + unit tests; `npm test` is an alias
npm run verify:build  # production build + subpath-portability check
npm run verify:full   # clean candidate tree: quick + mutation + build + audit; no browser
npm run dev           # Vite development server
```

Specialized tools:

- `npm run verify:visual` with Playwright and Chromium already installed
- `npm run gallery -- --elements mine,tank,shell --view low`
- `npm run mutate -- --only <id>`
- `npm run test:gl`
- `npm run trace:browser -- --all`
- `npm run portability` after building
- `npm run visual` after building

Command behavior and CI/deployment details are in
`docs/agent/commands-and-operations.md`.

## Universal architecture invariants

- `src/sim/` is pure and deterministic: no DOM, Three.js, Howler, wall clock, or runtime
  feature flags. The fixed timestep is 60 Hz.
- Simulation is authoritative. Render, audio, haptics, and UI consume `SimEvent[]` and
  state as one-way projections; they never feed presentation state back into the sim.
- `step(world, input)` does not mutate its input. Multiplayer enters through
  `stepInputs(world, inputs)`; keep the single-player adapter one line.
- Entity, arena, campaign, and balance configuration is validated data. Extend the
  existing catalog/validation path instead of creating parallel configuration plumbing.
- Browser persistence enters through `src/game/storage.ts`. Keep stores on the same
  injected `Storage` and preserve the raw-key save/export boundary.
- `src/main.ts` is wiring only. Put testable behavior behind injected seams elsewhere.

## Change discipline

- Prove a testing gap with a failing production mutation before claiming a new test closes
  it. Every assertion needs a named negative control.
- State populations and derivations beside measured counts; recompute headline numbers
  after the final tree changes.
- Inspect every consumer when changing a shared type or event.
- Generated documents are updated through their generators, never by hand.
- Deferred implementation work belongs in `docs/superpowers/backlog.md` only when it
  requires a decision or measurement before a PR can close it. Otherwise file an issue.
- When closing backlog work, remove or narrow its entry in the same PR.

## Verification and review

- Classify the complete diff as low, standard, or high risk before choosing checks. Mixed
  changes use the highest tier present; uncertainty escalates rather than downgrades.
- Low risk covers prose-only docs, comments, and non-runtime metadata: inspect the diff, run
  directly relevant documentation/format/generator checks, and perform a concise self-review.
- Standard risk covers ordinary application code, agent instructions, and focused tests or
  tooling: run `npm run verify:quick`, add `npm run verify:build` if production output can
  change, and review the affected subsystem.
- High risk covers simulation, persistence/campaign compatibility, renderer/WebGL
  infrastructure, CI/release behavior, and cross-cutting contracts: from a clean candidate
  worktree, run `npm run verify:full` plus applicable subsystem checks, and adversarially
  review invariants and failure modes.
- User-visible visual changes require visual evidence. Build/deploy, entry-point, PWA, and
  asset-path changes require a built-output portability check.
- Delegate only a concrete, bounded, independent investigation whose isolation or parallelism
  is worth its startup and handoff cost. Mutating workers use separate worktrees.
- Before merge, apply the full matrix in `docs/agent/testing-and-review.md#merge-bar` and
  independently reproduce material claims rather than relaying tool output unexamined.

## Git and pull requests

- Name branches for the change, not the person or agent creating them.
- Use short lowercase kebab-case, optionally under `feat/`, `fix/`, `refactor/`, `test/`,
  `docs/`, `ci/`, or `chore/`. Descriptive unprefixed names remain valid.
- Examples: `ci/harden-ubuntu-apt`, `fix/persist-campaign-lives`,
  `docs/privacy-policy`, `refactor/scoped-project-instructions`.
- Never add agent names, usernames, session identifiers, or tool-derived prefixes such as
  `agent/`, `claude/`, or `codex/`.
- Do not add `Co-Authored-By` or tool-attribution trailers.
- The pull-request title is the complete squash commit message. Do not append commit bodies,
  branch names, issue metadata, or attribution to the squash commit.
- `main` is protected by the `Protect main` ruleset. Required checks are
  `verify (floor)`, `verify (current)`, and `visual`; unresolved review threads also block
  merge.

## Instruction routing

| Paths touched | Scoped rule | Detailed reference |
| --- | --- | --- |
| `src/sim/**`, `tools/baseline/**` | `.claude/rules/simulation.md` | `docs/agent/architecture.md` |
| `src/game/**`, `src/input/**`, boot/main | `.claude/rules/game.md` | architecture and known holes |
| `src/render/**`, GL/gallery/visual tools | `.claude/rules/rendering.md` | architecture |
| `src/audio/**`, `tools/audio/**` | `.claude/rules/audio.md` | architecture |
| tests and mutation tooling | `.claude/rules/testing.md` | `docs/agent/testing-and-review.md` |
| workflows, build, Pages, portability | `.claude/rules/workflows.md` | commands and operations |
| docs and instruction files | `.claude/rules/documentation.md` | `docs/agent/README.md` |
