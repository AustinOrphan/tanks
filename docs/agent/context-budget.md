# Project instruction context budget

Initial baseline measured for #211 on 2026-08-19; re-measured for #213 on 2026-08-21,
for #266, #245 and #321 on 2026-08-25, for the targeted local mutation and CI-pending
orchestration policies on 2026-08-28, and for #473 on 2026-09-02. The conditional-rule
table below had drifted between those re-measurements -- before #266 it recorded
`documentation.md` at 31 lines /
1350 bytes against a file that was already 35 / 1663 -- so its figures are recomputed here
on the final tree, not adjusted. Only the `After` row is enforced by a test.

## Unconditional startup footprint

| State | Source | Lines | UTF-8 bytes |
| --- | --- | ---: | ---: |
| Before | `CLAUDE.md` at `844986c` | 1002 | 72393 |
| After | root `CLAUDE.md` on this branch | 137 | 8244 |
| Reduction | globally loaded project prose | — | 64219 (88.7%) |

`AGENTS.md` is the same file through a symlink and is retained for non-Claude harnesses.
No rule under `.claude/rules/` is unscoped, and no on-demand reference is imported by
the root file. Therefore the exact repository-owned prose Claude Code loads
unconditionally is the root `CLAUDE.md`: 8174 bytes, before built-in, user, skill,
MCP, or auto-memory context.

This is an exact byte/line measurement, not a tokenizer or billing estimate. Token count
varies by model and surrounding context.

## Conditional instruction footprint

These files load only after Claude Code reads a file matching their `paths` frontmatter:

| Rule | Lines | UTF-8 bytes |
| --- | ---: | ---: |
| `.claude/rules/simulation.md` | 29 | 1627 |
| `.claude/rules/game.md` | 41 | 2270 |
| `.claude/rules/rendering.md` | 32 | 1437 |
| `.claude/rules/audio.md` | 20 | 778 |
| `.claude/rules/presentation.md` | 19 | 944 |
| `.claude/rules/testing.md` | 41 | 2275 |
| `.claude/rules/workflows.md` | 37 | 1722 |
| `.claude/rules/documentation.md` | 39 | 2029 |
| **Total conditional rules** | — | **13082** |

The documents in this directory are normal links and remain unloaded until read.

## Reproduce

```sh
wc -lc CLAUDE.md
find .claude/rules -name '*.md' -print0 | sort -z | xargs -0 wc -lc
npm run test:unit -- tools/instructions.test.ts
```

In an interactive Claude Code session, `/context` can confirm the root instruction file
at startup; reading a matching file should then add only its scoped rule. The automated
test enforces the global budgets and rejects unscoped rules or unquoted `@path` imports,
including imports embedded in prose.
