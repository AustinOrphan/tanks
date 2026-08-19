# Project instruction context budget

Measured for issue #211 on 2026-08-19.

## Unconditional startup footprint

| State | Source | Lines | UTF-8 bytes |
| --- | --- | ---: | ---: |
| Before | `CLAUDE.md` at `844986c` | 1002 | 72393 |
| After | root `CLAUDE.md` on this branch | 98 | 5020 |
| Reduction | globally loaded project prose | — | 67373 (93.1%) |

`AGENTS.md` is the same file through a symlink and is retained for non-Claude harnesses.
No rule under `.claude/rules/` is unscoped, and no on-demand reference is imported by
the root file. Therefore the exact repository-owned prose Claude Code loads
unconditionally is the root `CLAUDE.md`: 5020 bytes, before built-in, user, skill,
MCP, or auto-memory context.

This is an exact byte/line measurement, not a tokenizer or billing estimate. Token count
varies by model and surrounding context.

## Conditional instruction footprint

These files load only after Claude Code reads a file matching their `paths` frontmatter:

| Rule | Lines | UTF-8 bytes |
| --- | ---: | ---: |
| `.claude/rules/simulation.md` | 29 | 1627 |
| `.claude/rules/game.md` | 31 | 1477 |
| `.claude/rules/rendering.md` | 32 | 1439 |
| `.claude/rules/audio.md` | 20 | 778 |
| `.claude/rules/testing.md` | 31 | 1475 |
| `.claude/rules/workflows.md` | 34 | 1457 |
| `.claude/rules/documentation.md` | 31 | 1350 |
| **Total conditional rules** | — | **9603** |

The documents in this directory are normal links and remain unloaded until read.

## Reproduce

```sh
wc -lc CLAUDE.md
find .claude/rules -name '*.md' -print0 | sort -z | xargs -0 wc -lc
npx vitest run tools/instructions.test.ts
```

In an interactive Claude Code session, `/context` can confirm the root instruction file
at startup; reading a matching file should then add only its scoped rule. The automated
test enforces the global budgets and rejects unscoped rules or unquoted `@path` imports,
including imports embedded in prose.
