---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Split the monolithic backlog into per-topic files under a compact index, with metadata and a reworked count guard
implementation-issues: [265]
implementation-prs: []
supersedes: []
superseded-by: []
---
# Backlog split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Active backlog topics are discoverable from a compact index and loadable one
topic at a time, with historical material preserved, exactly one authoritative copy of
each item, and every quoted measurement still guarded (issue #265; the central doc index
routing agents through everything is #266).

**Architecture:** Each of the 15 `##` topic sections plus the Ledger moves VERBATIM to
`docs/superpowers/backlog/<slug>.md` with the standard metadata header;
`docs/superpowers/backlog.md` becomes the compact index (one line per topic: title,
status, hook, link) so every existing inbound reference to the path stays live.
`tools/docs/check.mjs` extends its metadata validation to `docs/superpowers/backlog/`;
`tools/backlog.test.ts` re-points its recomputed measurements at the topic files that
carry them and gains an index-completeness check (every topic file indexed exactly once,
no orphans).

**Tech Stack:** Markdown moves, `tools/docs/check.mjs`, vitest.

**Spec:** GitHub issue #265 under #215. Constraints from
`.claude/rules/documentation.md` (do not delete historical rationale; keep the guarded
count workflow) and `docs/agent/document-metadata.md` (header format; this plan extends
its scope statement to the new directory in the same PR).

## Global Constraints

- MOVE, never copy: one authoritative location per item (AC), verbatim bodies —
  reclassifying or rewording a topic is out of scope beyond the added headers.
- Every topic file gets the standard metadata header; statuses assigned conservatively
  (`active` for open questions/spikes, `historical` only where the section itself says it
  is settled) — each status named in the PR body for review.
- `docs/superpowers/backlog.md` STAYS (as the index): CLAUDE.md, rules, docs/agent/*,
  and merged-PR prose all point at that path.
- `tools/backlog.test.ts`'s 8 recomputed measurements survive against their new homes;
  the "quote a measurement, owe a recomputing test" rule gains the index-completeness
  check (a split that silently drops a topic must fail).
- `docs/agent/known-holes.md` and `.claude/rules/documentation.md` references to the
  one-file layout updated in the same PR.
- Low/standard risk (docs + docs tooling + one test file): verify:quick + docs:check;
  no sim surface.

## Tasks (compact — the mechanics are moves)

1. **Slug map + index skeleton**: derive slugs from the 16 section titles (recorded in
   the PR body as the population: 16 of 16 sections moved); write the index format
   (title — status — one-line hook — link).
2. **Move the 15 topic sections** to `docs/superpowers/backlog/<slug>.md` with headers;
   Ledger (with its 5 `###` subsections) moves whole to `backlog/ledger.md`.
3. **Extend `tools/docs/check.mjs`** to validate `backlog/` headers (same validator, new
   glob) and update `docs/agent/document-metadata.md`'s scope line; `npm run docs:check`
   green with the new population stated (50 + 16 = 66 expected).
4. **Rework `tools/backlog.test.ts`**: point file reads at the topic files carrying each
   quoted measurement; add index-completeness (16 entries ↔ 16 files, no orphans, no
   duplicates); negative control: a temporarily-orphaned file fails it (run once, shown
   in the PR body, then reverted).
5. **Reference sweep**: update known-holes.md / documentation.md rule / any `§"Spike:`
   references that assume in-file sections; `git grep 'backlog.md'` sweep with the
   denominator stated.
6. **Gates + PR**: verify:quick, docs:check, self-review diff for verbatim-ness
   (`git diff --stat` + spot `diff <(old section) <(new file body)`), PR `Closes #265`.
