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

**4. A persisted store can miss the save export, and nothing fails.** `tanks.versus.v1` (the
retained VS setup, made persistent deliberately by #260) is written and read by
`versus-setup-store.ts` but appears in **neither** `SAVE_KEYS` nor `SAVE_IMPORT_KEYS`, and
`save.ts` says nothing about the omission -- unlike `tanks.touch.v1`, whose exclusion from the
export list is argued at length. So a save export/import round-trip silently drops it.

Whether it SHOULD travel is a product decision -- a retained match setup is arguably session
furniture rather than save data -- but the decision was never forced, because no guard exists
to force it. `storage.test.ts`'s inventory makes a new store join `GameStores`, `createStores`
and `STORE_WRITES`, which is what stops it bypassing the developer namespace; nothing
comparable ties a persisted key to the save allow-list, and `save.test.ts` pins `SAVE_KEYS`
against a literal list a new store simply does not appear in. What would answer it: the
ruling, plus an inventory assertion in the same shape as `STORE_WRITES`, so the next store
cannot be added without one.

---
