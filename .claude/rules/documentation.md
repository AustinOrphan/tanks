---
paths:
  - "docs/**"
  - "README.md"
  - "CLAUDE.md"
  - "AGENTS.md"
  - ".claude/**"
  - "tools/instructions.test.ts"
  - "tools/backlog.test.ts"
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
- If a PR can close deferred work, use an issue. Keep only prerequisite decisions or
  measurements in `docs/superpowers/backlog.md` and update its counts through the guarded
  one-file workflow.
- Generate `docs/dev-flags.md` and the tank list through their repository generators.
  Never repair a drift test by editing expected generated output or weakening the guard.
- Treat quoted measurements as claims that need a reproducible derivation and current-tree
  provenance.

Do not import the files under `docs/agent/` from `CLAUDE.md` or an unscoped rule; plain
Markdown links keep them on demand.
