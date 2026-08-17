# Plan — Controller Assignment UI

Status: adopted 2026-08-17, implemented on branch `controller-assignment`.

Provenance: closes controllers-4's deferred-UI note (`docs/superpowers/plans/
2026-08-17-controllers-4.md`: "Stays deferred, named ... the manual assign-pad-to-slot
affordance that would fully close THE NAMED TRADEOFF gap"). Owner rulings baked in
before adjudication: session-only (no persistence, no seventh store); BOTH surfaces
(pre-game screen + settings-reachable row); a disconnected pad's slot stays RESERVED
AND IDLE (tank holds, reclaimable) rather than being inherited. Reproduced below as
adopted, with deviations from the adjudicated design called out where implementation
forced one.

---

## The model — `src/input/assignment.ts` (new, pure)

`SlotSource` is a closed union (`'keyboard' | {gamepad, padIndex} | 'bot' | 'none'`);
`Assignment` is `SlotSource[]`, indexed by slot, session-only. `deriveInitialAssignment`
makes today's rule explicit and data-driven (slot 0 keyboard unless bot-claimed, slot
i>=1 gamepad@padIndex i unless bot-claimed). `reassign` is the pure exclusivity-bounce:
assigning `'keyboard'` bounces whichever OTHER slot held it to `'none'`; assigning a
gamepad padIndex bounces whichever OTHER slot claims that index; `'bot'`/`'none'` never
bounce anything, and a slot never bounces itself.

`createHeldInputSource` is a DELIBERATE UN-RETIREMENT of `loop.ts`'s deleted
`createIdleInputSource` (n-player arc PR3): a `'none'` slot needs a `PlayerInputSource`
that never polls hardware and echoes the tank's own position back as `aim`, so
`driveTank`'s `aimDir` resolves to exactly `{0,0}` and the turret holds rather than
slewing toward world-origin. CLAUDE.md's retirement note ("a generator nothing calls
rots") applies only while nothing calls it; `'none'` is a real, UI-selectable call site
again. Proven red-first: replacing the echo (`aim: {...lastPos}`) with a constant
`{x:0,y:0}` fails 3 of `assignment.test.ts`'s 21 tests, including the turret-slew test
driven through the real sim (`applyPlayerInput`) -- reverted after confirming, bytes
verified identical via `git diff --stat`.

21 of 21 `assignment.test.ts` tests green, red-first against the absent module (1 failed
suite, 0 tests collected, before `assignment.ts` existed).

## `loop.ts`: assignment-driven construction, `reassignSlot`

`realSources`/`botSources` construction is driven entirely by the session-held
`assignment` variable, not a hardcoded slot-0/1..N-1 split. `buildRealSource(source)`
maps a `SlotSource` to a `PlayerInputSource | null` (`null` for `'bot'`, which has none).

`reassignSlot(slot, source)` is the one write path: applies `reassign`'s exclusivity
bounce, then rebuilds -- never re-points -- every slot whose descriptor ACTUALLY
changed, which is the target AND any bounced slot (a bounced slot that kept its old
source would sample it in parallel with the new holder, the exact bug the bounce exists
to prevent). `input` (the keyboard singleton) is never disposed on reassign, whichever
slot loses it -- only `dispose()` at final teardown frees it. A slot gaining a real
source (gamepad/none) is seeded from `driver.world` IMMEDIATELY, before its first
`sample()` -- proven red-first: removing the two-line seed fails the dedicated test
(turret slews to `-1.9999999999999998` instead of holding at the spawn heading `0`),
reverted after confirming, bytes verified identical. A slot gaining/losing `'bot'`
touches exactly one `botSources` Map entry (`createBotSources` with a single-element
Set), never rebuilding an unrelated bot's `rnd` stream or `PlayerAiState` object.

Fixed the slot-0 assumption at the gamepad-connect-toast site: gated on
`assignment[i].kind === 'keyboard'`, not `i === 0`. Added the falling-edge disconnect
toast (`Gamepad disconnected` / `Player N's controller disconnected`), extending the
existing per-slot `gamepadConnectedPrev` array rather than a new mechanism -- two
pre-existing tests that asserted only rising-edge toasts were updated to expect the new
falling-edge companion too (a deliberate behavior change, not a regression).

259 of 259 `loop.test.ts` tests green (254 pre-existing + 5 new), including the two
updated toast tests. New coverage: rebuild-and-dispose on reassignment; the keyboard
bounce rebuilding BOTH the target and the bounced slot (not just the target -- the
narrower, single-slot version would pass a test that only checked the target); the
immediate position seed; and bot-conversion touching exactly one `botSources` entry.

**The bot-conversion test was tried as a full physical-trajectory comparison first, and
rejected on evidence.** Booting two otherwise-identical sessions, converting an
unrelated slot to bot in one, and comparing a third slot's bot trajectory over many
ticks diverges by tick ~30 even with a correct single-entry `reassignSlot` -- not a test
bug. CLAUDE.md's "the bot brain reads the whole board": `isOpponent`
(`player-profile.ts`) only treats non-player-kind tanks as opponents in campaign-coop,
so the newly-bot-claimed slot is never a TARGET, but its shells and mines still land in
`world.bullets`/`world.mines`, which every bot's hazard-avoidance reads regardless of
owner. Asserting "an unrelated bot's trajectory is identical" would be false the instant
the reassigned slot fires -- exactly the overclaim CLAUDE.md's "claims must match
evidence" warns against. What `reassignSlot` actually promises is narrower: the OTHER
bot's `botSources` Map entry (its `rnd` stream and `PlayerAiState` object) is never
rebuilt. Split into two tests that prove that without the board-interaction confound: a
pure `createBotSources` proof (same seed+slot draws the same first value regardless of
what else is in the passed Set) and a wiring-level proof (`realSources`/dispose spies
show an unrelated slot's dedicated source is untouched).

## `hud.ts` + `hud.css`: one panel, two entry points

`.hud-controllers-open` sits at both `title` and `paused` -- the one new variant of the
per-button visibility pattern `.hud-panel-settings` already uses. Its Back button routes
to `shownState`, not a hardcoded `'title'`: every sibling subpanel hardcodes `'title'`
because they are title-only, but this one is opened over EITHER title or paused, and
hardcoding `'title'` would abandon a paused round on Back and desync the HUD's panel
from the state machine -- CLAUDE.md names this exact class of defect as one this repo
has shipped green before. `setState`'s unconditional close block gets
`showControllers(false)` alongside `showCustomize(false)`, so the panel (and loop.ts's
window listeners) cannot leak onto a resumed game. `.hud-controllers` joins
`activePanelContainer`'s sweep, so D-pad/roving-focus navigation falls out free of the
generic `button,[tabindex]` sweep -- confirmed, not merely traced: the title-screen
reachability test now recurses into the panel via the same `OPEN_TO_PANEL`/
`BACK_OF_PANEL` mechanism it already used for the other four.

Rows are driven by two Hud inputs: `setControllers(assignment)` and
`setDetectedPads(pads)`. Both are UNCONDITIONAL rebuilds -- "REPLACE, never append,"
mirroring `setLevelSelect`'s own convention, not the visibility-gated `setAchievements`
one -- so a boot-time push (before the panel has ever opened) still renders correctly
the first time it does. One button per candidate source (Keyboard/Bot/None/one per
currently detected pad index), a selection ring on the slot's current source,
disconnected pads shown dimmed with a `Controller N` fallback for an unreadable id.

`gamepad.ts` gains `readDetectedPads` (+ the `DetectedPad` type; `GamepadLike.id` is now
optional, backward compatible with every existing test fake) for the panel's live pad
list -- routed through `loop.ts`'s new `GameDeps.readDetectedPads` seam and a
`HostWindow` extension for `gamepadconnected`/`gamepaddisconnected`, added/removed only
while the panel is open (in `onControllersOpen`/`onControllersClose`), read once
immediately on open since those events fire only on change.

422 of 422 across `hud.test.ts`/`hud.css.test.ts`/`loop.test.ts` green, plus 46
`gamepad.test.ts` (3 new: `readDetectedPads`'s own unit tests). `hud.css.test.ts`'s
`buttons.length` recomputed to 58 (48 + 2 static [`.hud-controllers-open`,
`.hud-controllers-back`] + 8 row buttons from that file's own 2-slot/1-pad fixture: 2
slots x (Keyboard/Bot/None + 1 detected pad) = 2 x 4 = 8; arithmetic inline per that
file's own convention). Four `hud.test.ts` roving-focus counts/paths updated for the
same reason (43->44 title-screen controls including the panel's own Back button; the
pause panel needs a third ArrowDown to reach Quit now that Controllers-open sits
between the action button and Quit; 5->6 `tabindex="-1"` containers) -- all real
consequences of a real new panel, not defects.

New `hud.test.ts` describe block: row rendering per `SlotSource` kind (keyboard/
connected gamepad/disconnected gamepad/bot/none), candidate-button selection ring, the
two open-context headings ("Choose who's playing" at title, "Controllers" at pause),
Back routing to `shownState` from a PAUSED open (not abandoning the round), and
onControllersOpen/Close's wasOpen-guarded contract (mirroring onCustomizeOpen/Close's
own test). New `loop.test.ts` describe block: the boot-time `setControllers` push, the
post-reassignment push, `onControllersOpen` reading pads once immediately before adding
listeners, a hotplug event while open pushing a fresh read, and `onControllersClose`
removing both listeners.

## Reserved-idle hold, proven end to end, not just relayed

Every gamepad-slot test elsewhere in `loop.test.ts` drives the FAKE
`createGamepadSource` (always `move: {x:1,y:0}`, no real hold mechanism) -- right for
pinning loop.ts's OWN wiring, but incapable of exercising the reserved-idle guarantee
itself, which lives inside gamepad.ts's REAL `createGamepadInputSource`. One dedicated
test substitutes the real production function for one slot (wrapped only to COUNT
builds) and drives an actual connect -> deflect -> disconnect -> reconnect cycle through
`startGameWith`: the tank holds (position unchanged, turret frozen at whatever heading
it had at the moment of disconnect -- not reset, not slewed toward world-origin) across
the disconnect; both the falling-edge and rising-edge toasts fire; and the underlying
`PlayerInputSource` is rebuilt ZERO times across the whole cycle -- proof the descriptor
stayed `{kind: 'gamepad', padIndex: 1}` throughout, since `reassignSlot` was never
called and no other mechanism could be driving that slot. Verified non-tautological by
the same mutation-proof discipline as every other guarantee in this doc: reverting
gamepad.ts's raw-position echo to the literal `{0,0}` bug it exists to prevent fails
this exact test (turretAngle moves from `-1.9999999999999998` to `-2.258941291940779`
instead of holding), reverted after confirming (`git diff --stat` empty).

## Trace argument

Categorical: `src/input/assignment.ts`, `loop.ts`, `hud.ts`, `hud.css`, and
`gamepad.ts`'s new `readDetectedPads` are all outside `tools/baseline/trace.ts`'s import
graph (`../../src/sim/arena` and `../../src/sim/world` only) -- the same argument
controllers-4 already made for `gamepad.ts` generally. Confirmed empirically, not merely
asserted: `npx vitest run tools/baseline/trace.test.ts` after every step, hash unmoved
at `a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9` throughout.

## Full gate

- `npm test` (`tsc --noEmit && vitest run`) -- 114 files, 2673 tests, 2 skipped
  (pre-existing), clean. (2672 before the reserved-idle end-to-end test above landed.)
- `npm run build` -- clean (`tsc --noEmit && vite build`).
- `npm run portability` -- clean, against the built `dist/`.
- `npm audit --omit=dev --audit-level=high` -- 0 vulnerabilities.
- `npm run mutate` -- 13/13 existing manifest entries, 0 mismatches vs. declared
  outcome; none touch this PR's code (expected -- no manifest entry exists for
  `reassign`'s exclusivity-bounce, a natural follow-up not required to ship).
- `npm run test:gl` -- 61/61 GL checks pass. Getting a clean run took a detour worth
  recording: the harness's own `page.waitForFunction` call (line 102) failed at
  `Timeout 30000ms exceeded` on five consecutive attempts on this box, despite the file's
  own comment claiming a 90s timeout tuned for exactly this hardware. Verified this is
  NOT caused by this branch's changes, two ways: (1) `tools/gl/harness.ts`'s own import
  list touches none of `assignment.ts`/`loop.ts`/`hud.ts`/`hud.css`/`gamepad.ts`'s new
  exports -- it imports `render/scene.ts`, `render/renderer.ts`, `render/aimray.ts`,
  `render/preview.ts`, `render/framing.ts`, `audio/synth.ts`, `audio/music.ts`, none of
  which this PR touches; (2) a temporary worktree at the pre-PR base commit (`1bf8d49`)
  reproduces the identical `Timeout 30000ms exceeded` failure, this time at `page.goto`
  rather than `page.waitForFunction` -- same box, same symptom, zero PR code present.
  This box was running dozens of concurrent agent worktrees at the time (`git worktree
  list` -- 60+ entries), consistent with the "review fan-out freezes this box" pattern
  named elsewhere in this repo's memory, just at a larger scale than one review's own
  fan-out. A TEMPORARY, reverted diagnostic edit (`page.setDefaultTimeout(240000)` in
  `tools/gl/run.mjs`, never committed -- `git diff --stat` confirmed empty after
  reverting) let the harness run to completion once: all 61 checks passed, proving this
  is a slowness ceiling on a contended box, not a hang or a real regression. The
  underlying `run.mjs` timeout question (why the file's own `{timeout: 90000}` argument
  did not appear to take effect) is unresolved and out of this PR's scope -- named here
  rather than fixed, since `tools/gl/run.mjs` is untouched by every commit on this
  branch and a fix deserves its own review.

## Deviations from the adjudicated plan

1. **`onReassignSlot`'s `Hud` interface member landed in the loop.ts commit (nominally
   "step 2"), not the hud.ts commit ("step 3") the plan's own ordering names.** Forced
   by `noUnusedLocals`: `loop.ts`'s `reassignSlot` function has no other reachable
   caller until something in `hud.ts` can register it, so leaving it unwired for a
   whole commit would not compile. Only the callback-registration shape landed early
   (mirroring `onPickHullColor`'s own shape exactly, zero UI); the panel markup,
   `showControllers`, `onControllersOpen/Close`, `setControllers`, and
   `setDetectedPads` all landed together in the next commit, as planned.
2. **hud.ts's markup and hud.css's rules landed in ONE commit, not two.** They are
   functionally coupled under jsdom, not just cosmetically: with no
   `.hud-controllers--hidden` rule, `getComputedStyle` never resolves the panel to
   `display: none`, so `activePanelContainer()` finds it "visible" even during
   `'playing'` and the whole roving-focus gate breaks. Confirmed directly: running
   `hud.test.ts` against the markup alone (no CSS) failed 6 of 391 tests, all
   traceable to that one missing rule -- not a coincidental batch of failures.
3. **`setControllers`/`setDetectedPads` are UNCONDITIONAL rebuilds, not gated on the
   panel being open.** The plan's own prose ("only re-renders if the panel is open,
   same as setAchievements") was tried first and reverted: it conflicts with the
   explicit hud.css.test.ts requirement ("mountEveryButton must call setControllers
   with a fixture... so the new buttons land under the sweep"), since that fixture
   never opens the panel. Switched to `setLevelSelect`'s own convention instead
   (unconditional "REPLACE, never append"), which the plan's own prose names as the
   precedent for the row-building convention two sentences earlier -- the fixture
   requirement and the visibility-gate suggestion could not both be honored, and the
   fixture requirement was explicit while the gate was a stated analogy, not a rule.
4. **The bot-conversion "touches exactly one entry" test is NOT a full physical-
   trajectory comparison**, despite that being the natural first reading of "assert an
   unrelated bot's next RNG draw is unchanged." See the dedicated paragraph above.

## Deferred, unchanged from the adjudicated plan

Two identical pads swapping indices on reconnect (no fix possible without a
browser-exposed serial); `players=N` count itself gaining a menu affordance (still
dev-flag-only); FFA/Teams team picker (PR4's own territory, already shipped
separately); assignment persistence across refresh (owner ruling: session-only, not a
gap); `?dev=1&gamepad=1`'s implicit padIndex-0 claim colliding with an explicit
padIndex-0 reassignment elsewhere (rare, dev-only double-read, named not guarded).
