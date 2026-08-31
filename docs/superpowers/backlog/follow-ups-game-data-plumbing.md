---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Follow-ups from "game data plumbing" (storage resolver, save export/import, replay recorder)
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Follow-ups from "game data plumbing" (storage resolver, save export/import, replay recorder)

**Raised 2026-08-10** by #127, which shipped issues #109, #110 and #118. All three were
consciously deferred, not missed.

**Deliberately NOT ledger lines.** The Ledger below states a measured provenance — how many
of its lines came from the PR-description harvest — and `tools/backlog.test.ts` recomputes
that split by treating every unmarked line as harvested. Appending new work there would
make that sentence say something false about where these came from, so they sit here, in
the same shape as the "walls as geometry" follow-ups above.

**1. The replay stamp cannot see CODE.** `simDataFingerprint()` (`src/game/replay.ts`) is a
canonical FNV-1a over four of the sim's six JSON data files — balance, tank-defs,
ai-profiles, arenas — so any change to those invalidates a trace. The two it omits are
omitted CORRECTLY, and the reason is worth stating so nobody 'fixes' it: `campaign.json` and
`versus-catalog.json` decide WHICH arena a session loads, and `ReplayMeta.arenaId` already
records the resolved arena rather than a level id, precisely so a re-pointed level or a
re-declared catalog cannot change what a trace reproduces (see that field's own comment). A change to `targeting.ts` or
`collision.ts` diverges a replay with the fingerprint unchanged. So a mismatch proves a
trace is stale; a match does not prove it is fresh. Closing it means stamping a build
identity (a commit sha injected through `vite`'s `define`), which is a build-pipeline
change this PR did not make. Until then, treat a matching stamp as necessary and not
sufficient.

**2. An imported save is invisible until reload, and nothing enforces the reload.** Every
store snapshots its key into an in-memory shadow at CONSTRUCTION and writes back from that
shadow, so `__tanks.save.import(...)` mid-session changes nothing on screen — and the next
write from a live store overwrites what was just imported. `save.ts`'s doc comment says so
and the API is dev-flag-gated, which is the whole of the mitigation. A real fix is either a
`location.reload()` inside `import`, or a re-read path on the SEVEN stores
(`createStores`: progress, stats, customization, settings, achievements, run, versusSetup --
it said five when this was written; `run` and `versusSetup` have since joined, which makes
the second option larger, not different); both are product decisions about what an import is
allowed to do to a session in progress.

**3. Nothing REPLAYS a trace back into the running game.** `replayTrace(trace, world)`
re-simulates headlessly and is what the tests use, but the loop has no path that feeds a
recorded trace to the driver in place of live input — so there is no attract-mode demo and
no "watch the bug happen" viewer yet. The pieces are in place (the decorator seam is the
same seam a player would use); what is missing is the world-rebuild-from-meta path in
`loop.ts` and a decision about what the HUD shows while one is playing.

---
