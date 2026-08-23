---
paths:
  - "docs/**"
  - "README.md"
  - "CLAUDE.md"
  - "AGENTS.md"
  - ".claude/**"
  - "tools/instructions.test.ts"
  - "tools/backlog.test.ts"
  - "tools/docs/**"
  - "tools/devflags/**"
  - "tools/tanks/**"
---

# Documentation and instruction rules

- Keep `CLAUDE.md` universal, below its tested line/byte budget, and free of `@path`
  imports. Put conditional guidance in path-scoped rules and long rationale in normal docs.
- `AGENTS.md` remains a Git mode `120000` symlink whose target is `CLAUDE.md`.
- `docs/agent/README.md` is the routing index for agent-oriented reference material.
- Plans, specifications, and the backlog live under `docs/superpowers/`. Do not delete
  historical rationale merely to reduce context; make it discoverable on demand.
- New or changed plans and specifications must follow `docs/agent/document-metadata.md`;
  run `npm run docs:check` and never refresh a legacy baseline hash to exempt new work.
- If a PR can close deferred work, use an issue. Keep only prerequisite decisions or
  measurements in the backlog (`docs/superpowers/backlog.md` is the index; topics live
  under `docs/superpowers/backlog/`) and update quoted counts through
  `tools/backlog.test.ts`, which also gates the index's completeness.
- Generate `docs/dev-flags.md` and the tank list through their repository generators.
  Never repair a drift test by editing expected generated output or weakening the guard.
- Treat quoted measurements as claims that need a reproducible derivation and current-tree
  provenance.

Do not import the files under `docs/agent/` from `CLAUDE.md` or an unscoped rule; plain
Markdown links keep them on demand.
