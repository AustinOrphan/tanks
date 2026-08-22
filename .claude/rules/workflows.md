---
paths:
  - ".github/workflows/**"
  - "package.json"
  - "package-lock.json"
  - "vite.config.ts"
  - "index.html"
  - "public/**"
  - "tools/workflows.test.ts"
  - "tools/playwright-args.test.ts"
  - "tools/portability/**"
  - "tools/webmanifest.test.ts"
---

# Workflow, build, and deployment rules

- Supported Node lines are `^22.13.0 || ^24.0.0` and CI verifies the floor and current
  line under stable semantic job names.
- GitHub Pages serves this project below `/tanks/` on the custom apex domain. Preserve
  `base: './'` and run the built-output portability check.
- Automatic Pages deployment must wait for successful CI and check out the triggering
  run's exact `head_sha`.
- Keep the source-repository and push-event guard on `workflow_run`; a fork's `main` can
  otherwise match the branch filter.
- Manual deployment is intentionally ungated and re-runs only part of CI. Do not describe
  it as equivalent to the complete visual and mutation gate.
- Main protection is a repository ruleset, not classic branch protection. Required status
  contexts are `verify (floor)`, `verify (current)`, and `visual`.
- Keep workflow-token permissions least-privilege and update action runtimes deliberately.
- Keep CI's diagnostic and conditional boundaries as named atomic package-script steps;
  agents use the composite `verify:*` entry points instead of duplicating tool commands.
- Recount named checking steps whenever workflow structure changes; historical bare counts
  have repeatedly gone stale.

Read `docs/agent/commands-and-operations.md` before modifying CI, Pages, engine-matrix, or
ruleset-sensitive behavior.
