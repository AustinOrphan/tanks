# Plan and specification metadata

This is the source of truth for machine-readable metadata on Markdown documents under
`docs/superpowers/plans/`, `docs/superpowers/specs/`, and `docs/superpowers/backlog/`
(the per-topic backlog files, split from the monolithic backlog by issue #265; the
remaining `docs/superpowers/backlog.md` is their compact index and carries no header).

## Header format

Place metadata at byte zero. The closing delimiter must appear within the first 4 KiB so an
index can read the header without loading the document body.

```yaml
---
status: completed
date: 2026-08-21
last-reviewed: 2026-08-22
scope: VS setup UI and session boot flow
implementation-issues: [228]
implementation-prs: [262]
supersedes: []
superseded-by: []
---
```

The repository accepts a strict YAML subset: one top-level key per line and
JSON-compatible inline arrays. Quote an array's path values, for example
`["docs/superpowers/specs/older-design.md"]`.

## Statuses

| Status | Meaning |
| --- | --- |
| `proposed` | Draft direction that has not been adopted or completed. |
| `active` | Current authoritative direction or work that remains active. |
| `completed` | Implemented work retained as an implementation record. |
| `superseded` | Replaced direction that is no longer authoritative. |
| `historical` | Context retained for provenance, not current direction. |

`superseded` requires at least one `superseded-by` target. A document with a
`superseded-by` target must use that status. `historical` is for retained context that was
not necessarily replaced by one specific document.

## Fields

| Field | Requirement |
| --- | --- |
| `status` | Required; one value from the table above. |
| `date` | Original document date in `YYYY-MM-DD`; at least this or `last-reviewed` is required. |
| `last-reviewed` | Latest substantive review date in `YYYY-MM-DD`; it cannot precede `date`. |
| `scope` | Required one-line summary, no more than 200 characters. |
| `implementation-issues` | Optional unique positive issue numbers from this repository. |
| `implementation-prs` | Optional unique positive pull-request numbers from this repository. |
| `supersedes` | Optional unique repository-relative plan/spec paths this document replaces. |
| `superseded-by` | Optional unique repository-relative plan/spec paths replacing this document. |

Relationship targets must exist, cannot reference the document itself, and cannot appear in
both relationship fields.

Supersession links are also validated as one graph: both ends of every link must be
classified, reciprocal, and the `supersedes` relation must stay acyclic.

## Incremental migration

`tools/docs/legacy-document-baseline.json` is the immutable SHA-256 snapshot of the 46 plan
and specification files that predate this contract. An unchanged file in that snapshot is
temporarily accepted without metadata. A new file or any changed legacy file must add a
valid header; never update a baseline hash to exempt new work.

Issue #264 classified the remaining corpus, so every plan, specification, and backlog topic
now carries a header; `npm run docs:check` reports the split. This contract still does not
move or delete documents. Current-direction judgments belong to each document's own `status`
field, which `docs/README.md` reads.

## Research inventory

Documents under `docs/research/` do not carry frontmatter. Instead,
`docs/research/inventory.json` records one entry per research document: `path`, `date`,
optional `last-reviewed`, a `scope` line, lowercase kebab-case `tags`, a `classification`
(`public-prototype`, `commercial-direction`, or `mixed` against the Public Prototype 1.0
boundary), a one-line `relevance` statement, and evidence-backed `related-issues`,
`related-prs`, and `related-docs`. The same `npm run docs:check` guard fails when a
research document is added, moved, or removed without updating the inventory.

## The generated index

`docs/README.md` is generated from these headers and from the research inventory by
`tools/docs/index.mjs`. It groups documents by `status`, so a document reaches the right
section of the index by declaring the right status, never by being listed somewhere. Run
`npm run docs:index` after any change that moves a row: adding or deleting a document,
changing its `status`, `scope`, title, or its implementation and supersession links.

## Author workflow

Run `npm run docs:check` after adding or editing a plan or specification. It fails when the
committed index disagrees with the generator, and `npm run docs:index` is the fix. The
complete unit suite runs the same repository guard, so `npm run verify:quick` and both
required CI verify jobs reject missing, invalid, or contradictory metadata.
