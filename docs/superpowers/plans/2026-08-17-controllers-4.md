# Plan — Controllers 1-4: `pad[i] -> slot[i]`, including slot 0

Status: adopted 2026-08-17, implemented on branch `controllers-4`.

Provenance: PR 3 of the 4-PR N-player arc (owner directives baked in: bots as simulated
players, ceiling to 4, FFA + teams, 1-4 controllers), from the arc design's own "PR 3 —
Controllers 1-4: `pad[i] -> slot[i]`, hotplug, keyboard's home" section. Read against
`docs/superpowers/plans/2026-08-16-players-n.md` (PR 1, merged as #177) and
`docs/superpowers/plans/2026-08-16-bots.md` (PR 2a, merged as #179), both already on
`main`. Reproduced below as adopted, with the source design's own claims resolved
against what this PR actually measured — each is called out where the design's claim
and the measurement differ, confirm, or (in one case) where implementation went further
than the design named.

---

## PR 3 — Controllers 1-4: `pad[i] -> slot[i]`, hotplug, keyboard's home

**The decision, unchanged from the source design.** `pad[i] -> slot[i]` for every slot,
including 0. The naive extension of couch co-op's shipped shape (slot 0 always
`gamepad: false` once a second player exists, slot 1 owns `gamepad[0]`) was rejected in
the design and stays rejected here: it forces P1 off a controller entirely, directly
contradicting the owner directive ("should be able to use controllers from 1-4
players," which includes P1). Slot 0 keeps keyboard/mouse/touch as its baseline and can
additionally merge `gamepad[0]` through the pre-existing `?dev=1&gamepad=1` flag,
unchanged semantics. Slots 1..N-1 are gamepad-only, each on its own dedicated index —
`createGamepadReader`/`createGamepadInputSource` (`src/input/gamepad.ts`) gained a
trailing `padIndex: number = 0` parameter, defaulted so `input.ts`'s single-player merge
call site needed no edit.

**THE NAMED TRADEOFF, reproduced from the design and pinned rather than merely stated.**
Shipped coop mapped a lone connected pad to slot 1 unconditionally — no flag needed —
because slot 0 held keyboard exclusively and slot 1 was the only place for the pad to
go. Under `pad[i] -> slot[i]`, that same lone pad (almost always browser index 0) now
feeds slot 0 if the player opts in via `?dev=1&gamepad=1`, and slot 1 (bound to
padIndex 1) sees nothing from it. "P1 keyboard, hand the one pad to P2" has no
zero-flag path anymore. Accepted, not fixed: a fixed-offset mapping cannot serve both
"P1 optionally on a controller" and "every later slot has its own dedicated pad," and
the owner directive explicitly wants P1 included. The full fix is a manual
assign-pad-to-slot affordance — real UI work, named as deferred, not built
speculatively. Pinned at two levels: `gamepad.test.ts`'s "THE NAMED TRADEOFF" test (pure
function — a reader at padIndex 0 sees a lone pad, a reader at padIndex 1 does not) and
`loop.test.ts`'s "players=2 + gamepad=1 together" test (wiring — `createInput` receives
`{gamepad: true}` under `players >= 2` now, where it used to be forced `false`).

**Hotplug falls out free, confirmed rather than merely traced.** `GamepadReader.poll()`
re-reads `getGamepads()[padIndex]` every tick with no cached "was it connected last
frame" state beyond the fire/mine edge — a pad connecting or disconnecting at a given
index just starts or stops producing non-neutral polls at that slot on the very next
tick. Confirmed at three layers: `gamepad.test.ts` drives a real `createGamepadReader`
and `createGamepadInputSource` through a connect/disconnect/reconnect cycle at index 2
directly; `loop.test.ts`'s "HOTPLUG at a non-zero slot" test drives the same cycle
through the full `startGameWith` wiring, watching the connect TOAST fire on each rising
edge; both pass.

**The toast generalizes per-slot, exactly as designed.** The single `wasGamepadConnected`
boolean (which only ever read slot 0, and under shipped coop's old mapping was
permanently false during co-op — a load-bearing gap the input-routing plan named and
deferred) becomes `gamepadConnectedPrev: boolean[]`, one entry per slot. Slot 0's copy
stays `'Gamepad connected'` (pinned unchanged by its own describe block, which this PR
left untouched); every other slot's copy is named to the player, `"Player {i+1}'s
controller connected"`. A bot-claimed slot has no `PlayerInputSource` in `realSources`
and so never toasts — there is nothing there to report a connection.

**Composition with PR2a's `bots=K`, stated once and verified.** Precedence: `botSlots` is
computed first (bots claim their declared slots, last-K of N, by dev-flag declaration),
and `realSources`' construction loop only calls `deps.createGamepadSource(i)` for a slot
NOT in that set — controllers fill whatever remains, in `pad[i] -> slot[i]` order. A
bot-claimed slot never constructs a gamepad reader at all. Verified with the exact
scenario the source design named: `bots=1 & players=2` — slot 1 is the bot, slot 0 is
keyboard(+optional pad) — spied via `deps.createGamepadSource`'s own construction count
(the established pattern this file already used for "was a collaborator built" claims),
which reads 0 with an empty index list.

**One decision beyond what the source design named: `createIdleInputSource` is
retired, not kept as a second function.** PR1 built `createIdleInputSource()` to fill
slots 2..N-1 with no real controller routing yet — it echoes the tank's own position
back as `aim` so `driveTank`'s turret-hold guard fires instead of the tank slewing
toward world-origin. `createGamepadInputSource`'s own "no pad ever connected" branch
(`src/input/gamepad.ts`) already does the byte-identical thing: `!reader.connected() &&
playerPos !== null` echoes `playerPos` raw. Once every co-player slot 1..N-1 gets its
own `createGamepadInputSource(padIndex)` unconditionally — which hotplug support
requires anyway, since a slot needs to be POLLING its index to notice a pad arriving —
a slot with nothing plugged in gets the same idle hold for free, from the one source
every slot builds regardless. Keeping `createIdleInputSource` around with no production
call site would be exactly the "generator nothing calls rots" pattern CLAUDE.md already
names for a different subsystem (the `cumulus` clouds generator), so it and its 8-test
`describe` block are deleted rather than parked. Its coverage is not lost: the shared
mechanism (`createGamepadInputSource` with no pad ever connected, including through a
real sim tick via `applyPlayerInput`) is already pinned in `gamepad.test.ts`'s
"no-pad-ever-connected" block, untouched by this PR.

**File-level changes, matching the source design's own list plus the doc-staleness
this PR's own reversal exposed.** `src/input/gamepad.ts` (`padIndex` param, trailing and
defaulted, plus its module doc comment's mutual-exclusion claim rewritten — there is no
longer a shared index to arbitrate). `src/game/loop.ts` (`realSources` construction
loop, `input`'s `gamepad` option no longer forced off, per-slot toast array,
`createIdleInputSource` deleted). `src/game/devflags.ts`: the `DevFlags.gamepad` and
`DevFlags.players` doc comments, AND `FLAG_REGISTRY`'s `gamepad`/`players`/`bots`
entries, all carried the OLD "mutually exclusive by construction" claim as fact — these
feed `docs/dev-flags.md` via `npm run devflags:doc`, so left unedited they would have
shipped a generated doc actively describing the wrong behavior. Caught by grepping for
the old claim's exact phrasing across the tree after the code change, not by any test —
`tools/devflags/doc.test.ts` only checks that the generated file matches what the
registry currently says, not that the registry says something true. `docs/dev-flags.md`
regenerated (`npm run devflags:doc`) and diffed by hand.

**No new devflag.** Controller presence is runtime-detected — nothing here is declared
up front the way `players` or `bots` are.

**Trace argument, categorical.** `src/input/` and `src/game/` are outside
`tools/baseline/trace.ts`'s import graph (`../../src/sim/arena` and `../../src/sim/world`
only) — the trace cannot see this PR's changes by construction, the same categorical
form PR2a's own plan used. Confirmed empirically per that PR's own practice:
`npx vitest run tools/baseline/trace.test.ts` — 7/7 passed, `BASELINE_HASH` printed as
`a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9`, unmoved from the
value `tools/baseline/trace.ts` already carried at this branch's base commit (`baf389e`,
"AI hazard estimation is a guess now... #181" — the PR that most recently moved the
hash, per that PR's own title). The heavier three-engine `npm run trace:browser -- --all`
check was judged unnecessary here, on the same categorical argument PR2a's plan already
made for itself: nothing this PR touched is in `trace.ts`'s import graph at all, so
there is nothing for a second engine to disagree with the first about.

**Red-first, with counts and denominators.**

- `gamepad.test.ts`: 9 new tests (padIndex threading for both `createGamepadReader` and
  `createGamepadInputSource`, THE NAMED TRADEOFF, hotplug at a non-zero index).
  7 of the 9 failed against the pre-PR3 `gamepad.ts` (verified live, before the source
  change landed); the other 2 ("defaults to index 0, unchanged from every existing call
  site") pass either way by construction — they assert the DEFAULT-param behavior,
  which was already true, and exist as the regression signal for it, not as red-first
  proof. 34 -> 43 tests in the file.
- `loop.test.ts`: 8 tests deleted (the retired `createIdleInputSource` describe block),
  7 added (6 in a new "per-slot gamepad connect toast" describe, 1 for the bots/
  controller precedence scenario) — 246 -> 245 net. 5 pre-existing tests were inverted
  to the new decided behavior (the `gamepad:false`-forced assertions, the N=3/N=4
  build-count assertions). Verified red-first by temporarily checking out this file's
  pre-PR3 `loop.ts` (`git show baf389e:src/game/loop.ts`, restored via
  `git checkout HEAD --` immediately after, diff-confirmed clean) against the CURRENT
  (post-PR3) `loop.test.ts`: **11 of 245** tests failed — the 4 new per-slot-toast
  tests that exercise a slot other than 0 (including the HOTPLUG one), and 7 of the
  updated/added wiring tests (`players=2`, `players=2+gamepad=1`, `players=3`,
  `players=4`, bots-unset-at-`players=4`, `bots=2`-at-`players=4`,
  `bots=4+gamepad=1`). The bots/controller precedence scenario
  (`bots=1 & players=2`) passed against the pre-PR3 code too — the LAST-K bot rule and
  the single co-op slot's own behavior were already correct there under the old
  mapping, so that test is a confirmation pin, not a red-first one, and is reported as
  such rather than folded into the 11.

**Full gate, all exit code 0:**
- `npx tsc --noEmit` — clean.
- `npm test` (`tsc --noEmit && vitest run`) — 112 files passed, 1 skipped; 2568 tests
  passed, 2 skipped; 0 failed.
- `npm run mutate` — 13/13 mutation(s) ran: 11 killed, 2 survives (both pre-existing
  declared `equivalent mutant`/expected survivors, unrelated to this PR), 0 mismatches
  vs. declared outcome. Notably `replay-recorder-wraps-the-raw-controller`'s declared
  `expectFailures: 4` still reads "4 of 245 test(s) failed" — the SAME 4 named tests,
  even though `loop.test.ts`'s total moved from 205 (when that entry was written) to
  245 across this and intervening PRs, which is exactly the population-vs-count
  distinction CLAUDE.md's own testing conventions section asks for.
- `npm run build` (`tsc --noEmit && vite build`) — clean.
- `npm run portability` — clean, against the built `dist/`.
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.
- `tools/baseline/trace.test.ts` — see the Trace argument above.

**Deviations from the source design:** none in shape. The one addition beyond what the
design's own PR3 section named is `createIdleInputSource`'s retirement, covered above —
the design's text only says slots 1..N-1 are "gamepad-only... no fallback," which is
compatible with either keeping or deleting the old idle-fill function; deleting it was
this implementation's own call, made on the "a generator nothing calls rots" precedent
and verified safe by confirming the shared echo-fallback mechanism's existing test
coverage in `gamepad.test.ts` was unaffected.

**Stays deferred, named (unchanged from the source design):** the manual
assign-pad-to-slot affordance that would fully close THE NAMED TRADEOFF gap; everything
PR 4 (FFA/teams modes) still owns.
