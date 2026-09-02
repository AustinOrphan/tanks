# Architecture reference

Detailed invariants, measurements, provenance, and rejected approaches. Use the matching path-scoped rule first, then search this file for the named mechanism.

## Architecture invariants

**`src/sim/` is a pure, deterministic core.** It must import nothing from `three`,
`howler`, or the DOM. That purity is what makes it headlessly testable and makes replays
exact functions of their inputs. `src/sim/purity.test.ts` enforces it by scanning every
file under `src/sim/`; it is the only file there that mentions those packages.

**Fixed timestep.** `TICK_HZ = 60`, `DT = 1/60`. The sim never sees wall-clock time.

**Render and audio are one-way projections.** The sim emits a `SimEvent[]` stream
(`src/sim/events.ts`) and never reaches back. Consumers today: `render/renderer.ts`,
`render/particles.ts`, `audio/director.ts`, `game/haptics.ts` (issue #112's seam --
`navigator.vibrate` on web, injected so a future Capacitor build can swap in the native
plugin), `game/state.ts` (win/lose drives the game-over screen) and `game/loop.ts`. If
you change an event's shape, check all six.

`step(world, input)` clones its input and returns `{ world, events }` — it never mutates
what it is given.

**Presentation contracts sit between the application and its projections (issue #473).**
`src/presentation/` owns the renderer-independent vocabulary that more than one layer
reads: `identity.ts` (player-slot and team colours, team letters, `resolveOwnerColor`,
`identityApplies`), `customization.ts` (the hull/accent/skin/spawn-animation catalog and
`skinScroll`) and `blocked-fire.ts` (the blocked-fire cue set). It carries no DOM, no
Three.js, no package, no persistence and no session orchestration, and it may name
simulation TYPES only. The direction rule: `main.ts`/`boot.ts` wire everything; `game/`
imports `presentation/`, `input/` and `sim/`, and reaches `render/` or `audio/` only from
the wiring modules listed in `GAME_WIRING` (loop, route-ui, devflags, app-shell, settings,
hud), per target module; `render/`, `audio/` and `input/` never import `game/` or each
other; `three` stays in `render/` and `howler` in `audio/`.
`src/dependency-direction.test.ts` enforces it by resolving every module specifier under
`src/` — the purity guard's shape, with hand-written fixtures on both sides of all 36
ordered layer pairs so a widened rule fails its meta-test instead of shrinking it — and a
reverse import fails naming the file. Before it, `render/entities.ts` was the
authoritative source of the identity colours the HUD painted, five render modules
imported `game/customization.ts` to name a skin, and the audio director imported the
developer-flag parser to name a cue; all three compiled, because TypeScript is content
with a cycle of type imports. What stays put on purpose: `QualityPreset` and
`MineWarnStyle` are renderer-owned treatments only a developer flag selects, so
`devflags.ts` validates against `render/` directly (if either becomes a Setting, its
names move here), and `DEFAULT_VOLUME` is the audio engine's default, read by
`settings.ts` and, until #324 moves the slider into Settings, `hud.ts`.

**The step boundary takes a LIST.** `stepInputs(world, inputs: InputState[])` is the
primitive and pairs `inputs[i]` with the i-th `kind === 'player'` tank in tank-array
order; `step(world, input)` is a one-line adapter (`stepInputs(world, [input])`) and is
what every caller in the tree uses. The adapter must stay one line: two copies of the
single-player path is exactly what would break the argument that the golden trace hash
proves single-player behaviour did not move. Nothing else about multiplayer exists —
`config/validate.ts` still hard-fails any grid without exactly one `P`, `resolveStatus`
still defines a win as "every non-player tank dead", and four AI sites still take the
FIRST player. The pairing rules (a dead player keeps its slot; surplus inputs are
ignored; a player past the end of the list gets NO input, which differs from an idle one)
are unreachable from gameplay today and are pinned ONLY by
`src/sim/step-inputs.test.ts` — the trace drives one player and cannot see them, measured:
all 8 mutations swept there leave the hash unchanged.

**Match rules are one frozen object on the world, `World.rules` (issue #472).**
`src/sim/rules.ts` defines `WorldRules` — `mode`, `friendlyFire`, `unarmedTrigger`,
`aiTargetPerception`, `corpseBlocksShells`, `muzzleClearsTanks`, `coopAttempts`,
`arenaGeometry` — every value that is fixed for a world's life and read by the sim as a
POLICY. A rule is resolved ONCE, before the world exists, by `resolveWorldRules` (the only
place a default is chosen: `createWorld` calls it on its flat init, `render/preview.ts`'s
prop calls it directly, hand-built test fixtures call it), frozen, and carried through
`cloneWorld` as a single reference — never re-resolved, never enumerated. That last part is
why it exists: #471 was `aiTargetPerception` living on `World` as an OPTIONAL field, read as
`?? 'full'`, and omitted from the clone's field-by-field copy, so the loss surfaced as the
shipped default from tick 1 — invisible to TypeScript (an optional field is legally absent)
and to every consumer (the fallback hid it). Every rule is now required and `readonly`,
consumers read `world.rules.x` with no fallback, and `arenaGeometry` is `null` rather than
absent. `WORLD_RULE_KEYS` (a `satisfies Record<keyof WorldRules, true>` key manifest) lets
`world.test.ts` sweep every rule through 5 real `stepInputs` ticks programmatically;
measured while landing this: adding a ninth rule to the interface fails typecheck first in
`resolveWorldRules` (where its default must be chosen), then in exactly three more places
(the key manifest, and the non-default sample tables in `world.test.ts` and
`rules.test.ts`) before any test runs. The freeze is shallow: `ArenaGeometry`'s fields are
`readonly` by type (types.ts) so the one shared non-primitive rule is covered too, and a
spread of `world.rules` is a fresh unfrozen copy — derive a variant through
`resolveWorldRules({ ...world.rules, mode: 'ffa' })`, which re-freezes. `seed` and `spawns`
are deliberately NOT rules: both are fixed for a world's life, but neither is a policy
(`seed` is the entropy key, `spawns` is immutable arena data), and both are required and
typechecked already, with none of the optional-field hazard — `seed` is `readonly` on
`World` so the claim is enforced; `spawns` stays a deep-copied array because moving it is
World-shape churn the issue's boundaries exclude. Dev flags that are rules — `aiPerception`
since #472, like `corpseBlock`/`muzzleInside`/`coopPool`/`mode`/`friendlyFire` before it —
reach the world through `levels.ts`'s closures and the trailing positionals of
`createWorldFor` and `createSandboxWorld` (13 and 5 parameters now; #493 collapses the
rule-shaped ones into one `WorldRulesInit`); `loop.ts`'s `buildWorld` applies only
`invincible`, which marks a tank (mutable snapshot state), and a rule write on a built
world throws. The golden trace is unmoved
(`8584bf34…`, 7 of 7 at the landing tree): every shipped world resolves to the same defaults
it carried before.

**Persistence is one seam, `src/game/storage.ts`.** All six stores take an injected
`Storage`; `resolveStorage()` picks the browser's or a complete in-memory shim (the old
inline stand-in was `{getItem, setItem}` cast to `Storage`, so `removeItem`/`clear`/`key`
were TypeErrors waiting), and `createStores(storage)` gives all six the SAME one **by
signature** — resolving per store was harmless only because localStorage returns the same
object every time, and would have given each store a private namespace under the shim.
Pointing the game at Capacitor Preferences or a file-backed desktop shim is a one-file
change with a test that can fail. `src/game/save.ts` serialises those six keys as one
blob at the RAW key/value layer, deliberately not through the typed stores: they validate
on read and drop what they do not recognise, which is exactly the data an export exists to
preserve. Import writes only keys on the `SAVE_IMPORT_KEYS` allow-list — the origin is
shared, so a pasted blob must not be able to set a neighbour's key — and an imported save
is **invisible until reload**, because every store snapshots its key into an in-memory
shadow at construction.

`SAVE_IMPORT_KEYS` is deliberately WIDER than `SAVE_KEYS`, by exactly one key. A new export
carries `tanks.settings.v1` and never `tanks.touch.v1`, because no current build writes the
legacy key; an import still accepts `tanks.touch.v1` so a save taken before #320 does not
lose its touch preferences on restore. Widening the export list instead would have made
every new export emit a key nothing writes; weakening the import list to one shared set
would have widened the security boundary. Adding the settings key did not bump
`SAVE_VERSION`: the blob SCHEMA is unchanged, and an old build already ignores keys outside
its own allow-list.

**Player settings are one versioned, capability-aware model (#320).** `tanks.settings.v1`
holds every durable preference, grouped `audio` / `input` / `presentation`, with an explicit
`version` integer INSIDE the payload — the other stores version by key name, which cannot
distinguish "a key this build does not know" from "this key, written by a newer build".

| Field | Default | Domain | Invalid stored value | Capability gate | Effective rule |
| --- | --- | --- | --- | --- | --- |
| `audio.muted` | `false` | boolean | default | none | the stored value |
| `audio.volume` | `DEFAULT_VOLUME` (0.6) | finite number in [0, 1] | finite out of range is clamped; anything else defaults | none | the stored value |
| `input.touchScheme` | `stick` | `TOUCH_SCHEMES` | default | none, deliberately | the stored value |
| `input.fireMode` | `tap` | `FIRE_MODES` | default | none, deliberately | the stored value |
| `input.deviceHaptics` | `true` | boolean | default | `navigator.vibrate` exists | stored AND capable |
| `input.controllerRumble` | `true` | boolean | default | a connected pad has an actuator | stored AND capable |
| `presentation.motion` | `system` | `system` / `full` / `reduced` | default | live `prefers-reduced-motion` | `system` follows the OS; `full` is false; `reduced` is true |
| `presentation.uiScale` | `100` | `100` / `125` / `150` percent | default | none | the stored value, plus a `uiScaleFactor` multiplier for #290/#321 |

Every field validates independently, so junk in one never resets a sibling. Touch scheme and
fire mode are ungated on purpose: gating them on touch capability would rewrite a hybrid
device's saved choice, and whether to SHOW the control is #227's question. Device vibration
and controller rumble are separate capabilities end to end — rumble is never delivered
through `navigator.vibrate`. Only booleans leave `capabilities.ts`; no gamepad index, device
id or slot assignment is ever persisted.

`src/game/effective-settings.ts` is the only place those rules are applied, and
`src/game/capabilities.ts` is the only place JavaScript reads
`matchMedia('(prefers-reduced-motion: reduce)')` — consumers take the resolved value as an
argument (`createTankPreview`) rather than querying the platform. The HUD takes it through a
setter instead, `hud.setReducedMotion`, pushed from `loop.ts`'s one `effectiveSettings`
subscription beside mute, volume and haptics: a construction argument would freeze whichever
answer was true at boot and leave the Settings toggle apparently inert until a reload. It
drives `src/game/transitions.ts` — the single contract every application screen change,
panel open/close and backdrop change schedules through (issue #364) — to zero duration.
That module owns scheduling and interruption only and never touches the DOM; the duration
and easing live once in `hud.css`, and `hud.ts` reads the token rather than mirroring it, so
a missing stylesheet degrades to instant rather than to a second constant that can drift.

**The HUD owns pane history; the state machine does not (issue #318).** The six panes
(Records, Customize, Achievements, Levels, Controllers, Versus Setup) are layers on a stack
inside `hud.ts`, built from the pure `src/game/navigation.ts`. Each layer records the
surface it was pushed over and the control that opened it, so Back -- the pane's button,
Escape while a layer is open, `Hud.back()`, or the browser's own Back -- pops exactly one
layer, re-renders that origin surface and restores focus to the opener when it still exists
(the container otherwise). They are deliberately NOT `AppRoute` values on the machine,
although `app-state.ts` still declares kinds for them: `toRoute` from gameplay drops the
session, so Controllers over Pause could never be one, and the page's painter closes every
pane on every surface change, so a pane pushed as a route would be closed by the paint that
announced it. The invariant runs the other way: after every `setState` the stack is empty.
The browser mirror keeps ONE state-only history entry while a layer is open and retires it
with one `back()` when the stack empties; every History call is wrapped, and the first
throw (Safari's `pushState` rate limit) latches the mirror off with the in-app stack
unaffected. Pause is a gameplay phase and stays outside the stack -- the flip is two lines,
deferred until standalone Back is measured on a device -- and the loop's hotkey guard
names `input,select,textarea` only, because a restored opener is a button and the old
`button` term was the reason every arrival had to focus a container. Scroll restoration is
not implemented: no shipped flow returns to a pane a deeper layer covered, and two of the
three scrollers rebuild their rows on reopen (issue #488 records the seam to add with the
first covering layer).

**Menu input is one action vocabulary; the gamepad never shares a gameplay reader (issue
#494).** `src/input/ui-actions.ts` names seven `UiAction`s (`up`, `down`, `left`, `right`,
`confirm`, `back`, `pause`) and the one consume rule, `consumesKey`: a focused control keeps
only the keys it consumes (text entry everything; a slider or select Space, Enter, the
arrows and Home/End; a button only Space and Enter, because the arrows are the roving
focus's), and `input.ts`, the session's hotkey guards and the HUD's roving-focus handler
all ask it, so Escape with a volume slider focused is Back or Pause, never lost. `Hud.act(action)` is the dispatcher for the active layer -- directions walk the
panel, `confirm` activates the focused control through its own click handler (or lands on
the first control when only the container is focused, so a Confirm the instant a panel
arrives cannot start a New Game blind), `back` is `Hud.back()`, and `pause` is reported
unconsumed for the page to toggle on the state machine exactly as the Pause button's tap
does. The keyboard reaches the same verbs through the window-capture key handler; a
keyboard `confirm` is the browser's own Enter/Space activation and is never dispatched.
A direction is spatial (issue #495): `src/game/spatial-focus.ts` derives rows from the
controls' rectangles at the moment of the move (vertical overlap makes a row, left edge
orders it), Left/Right wrap within the row, Up/Down land on the nearest column of the
adjacent row and wrap from the last row to the first, and with every rect empty -- jsdom,
a hidden subtree -- Up/Down fall back to document order so the walk still closes. The HUD
reads rectangles through `HudOptions.measure` (default `getBoundingClientRect`), which is
how tests draw a layout; no CSS names a row, so a pane that wraps at a narrow width is a
grid without any change here.
`src/input/gamepad-menu.ts` turns the UNION of connected pads into actions with its own
per-action edge state and a desktop-style repeat for directions only; `route-host.ts` owns
one poller on the page's frame loop from construction to disposal, dispatches only `pause`
while a session simulates (a direction, Confirm or Back pressed mid-play is dropped but
still counted as held), and any action at Launch dismisses the splash. The gameplay readers
in `gamepad.ts` keep their own fire/mine edges and are not polled while nothing simulates,
which is why `loop.ts` calls `resyncGamepad()` on slot 0 and every co-player source on
every entry into play: the A that confirmed Resume, still held on the first tick, is adopted
as already-down rather than fired. The Controllers and Versus Setup rows re-render from
scratch on hotplug and reassignment; `hud.ts`'s `captureFocus` puts focus back on the same
candidate of the same `data-slot` row, or the row's first control when that candidate
unplugged.

**A developer session persists into its own key namespace (issue #245).**
`selectStorageNamespace(location.search)` reads the `dev` GATE — `parseDeveloperMode`, not
any individual flag, so a stray `?aimRay=1` cannot move a session off the player's keys —
and `createNamespacedStorage` applies it once, before `createStores`. The `production`
namespace returns the base `Storage` **object itself**, which is what makes "ordinary URLs
keep current key names and behavior" provable rather than argued: on a production session
there is nothing between the stores and the browser. The `developer` namespace prefixes the
WHOLE key, so `tanks.progress.v1` becomes `tanks.dev.tanks.progress.v1` rather than the
tidier `tanks.dev.progress.v1` — the redundancy buys injectivity with one code path, where
strip-and-re-prefix would map `tanks.progress.v1` and `progress.v1` onto the same underlying
key and leave `key(i)` with no inverse. `length`, `key(i)` and `clear()` are scoped too:
nothing in `src/` enumerates a `Storage` today, but an unscoped `clear()` on a developer
session would wipe the player's real save. The adapter deliberately does **not** catch —
every store already degrades on its own — and because `AppSettings.storage` is the same
adapter instance the stores got, `save.ts` and the `__tanks` dev console inherit the
namespace for KEY SCOPING with no change of their own. Legacy migration follows: a developer
session neither adopts nor deletes the production `tanks.touch.v1` or `tanks.run.v1`.

Key scoping is not the whole problem, which is what issue #250 added to `save.ts`. The
adapter cannot be asked which namespace it is — `production` returns the base object itself,
and both namespaces expose the same store-facing key names — so a save blob taken through it
carried no trace of its origin, and importing a developer blob into a production session
silently overwrote the player's real save with developer data. The namespace therefore
travels as DATA beside the adapter: `SaveBlob.namespace` records it, `GameDeps.storageNamespace`
carries it to `createSaveApi`, and `importSave` refuses a blob whose namespace is not the
active one unless `allowForeignNamespace` is passed. An ABSENT namespace is treated as
foreign rather than assumed production, because the adapter shipped after `save.ts`'s last
change on the same day and unlabelled developer exports have been possible ever since.
`GameDeps.storageNamespace` is required rather than defaulted for the same reason
`releaseAudio` is: a default would label every developer export `production`.

Imports are all-or-nothing. `Storage` has no transaction, so `importSave` captures each
key's previous value and, on any failed write, removes every applied key **before**
restoring — the failure is almost always a full storage, and restoring in place would
attempt the operation that just failed on a storage no emptier than when it failed. The
residual is real and reported rather than argued away: a restore write can itself throw, and
the keys that survive are exactly those absent from `ImportResult.rolledBack`.

**`AppSettings` owns persistence for the PAGE, not the session.** `boot.ts` builds
`createBrowserAppSettings()` once and hands the same instance to every `startGame` call.
It has to be above the session: `boot.ts` disposes the whole game handle and rebuilds
`GameDeps` on every campaign/versus reboot, so anything a session owns restarts at its
default — which is why mute and volume used to reset on the way into a versus match. One
owner also means one settings store per page (no second writable shadow), one resolved
`Storage` (the in-memory shim is not re-created per session), and a persistence notice that
can fire at most once per document load. A session subscribes and unsubscribes on teardown;
only the page's `pagehide` disposes the owner.

Issue #317 took that slice, in that shape. `app-shell.ts` now owns `AppSettings` rather
than `boot.ts` owning it directly, and two more page-scoped things sit beside it: the
**audio engine** and the **Launch gate**. Both were session-owned for the same reason
settings used to be, and cost the same way. A rebuilt engine starts with a suspended
`AudioContext`; it self-heals, because the engine keeps its own document-level gesture
listener and `tryResume` retries rather than latching, so what a reboot actually lost was
ORDERING -- the guarantee that a gesture had happened before the menu was on screen. A
rebuilt state machine can only open at the Launch route, so every Campaign/Versus switch
replayed the splash. Those two are why the engine and the gate had to move together:
skipping the splash is only correct once the engine outlives the session that unlocked it.

A session borrows the engine and must never dispose it -- `dispose()` latches, and
`ensureCtx` returns null forever afterwards, so one session's teardown would silence every
later one with nothing thrown. `GameDeps.releaseAudio` is what a session calls instead
(`stopMusic`, so the abandoned level's bed does not play on under the new menu), and it is
required rather than defaulted precisely so a shared `createAudio` cannot be wired without
it.

**The state machine is page-scoped; a session's subscription to it is not.** Since issue
#468 `route-host.ts` builds one `GameStateMachine` per document and every session
subscribes to it in `startGameWith`. `onChange` returns the unsubscribe and a session's
`dispose` calls it, because a subscriber left behind runs on every later change with the
retired session's closures -- its level, its identity, its disposed input controller.
Measured through loop.test.ts's page harness before the unsubscribe existed: a retired
Practice session on level 3 recorded level 3 as cleared when the LIVE campaign session
cleared level 1 (`rec.cleared` read `[3, 1]`), and a retired campaign session advanced the
shared run with its own stale life count before the live one wrote the real value.
`emit` walks a snapshot of the subscriber list so a mid-emit unsubscribe cannot skip the
next subscriber. The same page/session split decides who paints the Main Menu: the page
paints what it can read from its own stores at construction and re-reads Continue on every
arrival at the Main Menu (`route-host.ts`), because with the host booting empty (#428) a
session's own construction-time paints happened for nobody -- a returning player's first
Main Menu had no Continue and no Levels grid. A session still pushes the same values at
its own construction, and the page resets the session-shaped affordances
(`setRelaunchTarget`, `setSessionKind`) when the slot is released, so an empty host never
offers a "Start Match" that is a New Game in disguise. What the page still does NOT own is
recorded in issue #485: menu music and the settings-driven controls, both of which run
through the session's `applySettings`/`followMusic` and go silent or stale on the empty
host.

`tanks.touch.v1` is now a migration READ only (`readLegacyTouchSettings`). When there is no
usable canonical payload, each legacy field is validated independently, merged over the
current defaults, written canonically, and the legacy key is removed — in that order, so a
storage that refuses writes keeps the player's data rather than losing it. A valid canonical
payload always wins, and a FUTURE-version payload is never migrated over, never
reinterpreted field by field, and never overwritten except by an explicit `reset()`.

**A run is recordable because the sim is pure, and the recorder is a DECORATOR.**
`src/game/replay.ts` wraps the input collaborator `loop.ts` hands the driver — `driver.ts`
already calls `input.sample()` exactly once per simulated tick, so nothing in the driver
changed. It wraps `effectiveInput`, not `input`, so an autoplay demo records the stream
`step` actually saw. A trace spans ONE world and restarts on every level switch.
**The stamp is two things**: `schema` (can this build parse it?) and a canonical, key-sorted
FNV-1a fingerprint of all four sim data files — balance, tank-defs, ai-profiles, arenas
(can this build reproduce it?). Key-sorted because JSON module property order is a bundler
artefact. It does **not** cover CODE: a change to `targeting.ts` diverges a replay with the
fingerprint unchanged, so a mismatch proves a trace is stale while a match does not prove
it is fresh.

**The RENDER ANIMATION CLOCK is a second clock, and it is now named and decided.** The sim
is fixed-step and never sees wall time; the render layer does, as the `dt` `driver.ts`
hands `renderer.render`, which forwards it to **two** consumers — `entities.sync` (an
animated skin's texture scroll, gated on `dt > 0`) and `particles.update`. `frame.ts`'s
`animationDt(dt, state)` decides how much of it a frame gets: **it runs whenever the game
is not `paused`**. Pause is the one non-simulating state a player enters deliberately to
make the board hold still, so the cosmetics stop with it; `splash`/`title` keep a live
board behind the menu, and `win`/`lose` arrive mid-explosion, where freezing would hang
debris in the air. Before it was named, the answer was "always, silently" — an unstated
consequence of the non-playing branch dropping the accumulator but still forwarding
`plan.dt`, asserted nowhere. `frame.test.ts` pins the rule and `driver.test.ts` pins that
the driver applies it, the same split `renderAlpha` has. It must stay out of `src/sim/`:
a wall clock there would break replay.

**A SKIN'S UV MAPPING IS DECIDED PER PART, and the three parts disagree on purpose.**
`entities.ts` is the only place this lives, and each rule exists because a render was
wrong in a way no numeric probe caught.

The HULL must read as one continuous surface — the design ruling's "the hull should be
distinctly one piece". `ExtrudeGeometry` carries THREE parameterisations: the caps come from the
shape's own (x, y), while the bevel ring and side walls come from `generateSideWallUV`,
which returns `(x, 1 - z)` or `(y, 1 - z)` and **chooses between them per quad** on
`Math.abs(a_y - b_y) < Math.abs(a_x - b_x)`. So the perimeter's own u axis flipped with
the direction of that stretch of outline. `projectBodyUV` projects the body from above
and `unrollSkirtUV` folds the skirt outward by its drop; a plain top-down projection is
NOT enough on its own, because the near-vertical walls collapse and the skirt renders as
vertical streaks (checker became columns, camo a picket fence). The unroll averages the
outward direction over every vertex sharing a position, which is load-bearing rather
than tidy: the geometry is non-indexed, so facet normals split the UV at every rounded
corner — per-facet measures 0.102506 over the VISIBLE surface (normal.y > −0.1, 729 of
1248 vertices) and 0.400000 over all 1248, against 0.000000 either way once averaged and
1.472500 for the untouched default. **State which population**: an earlier draft quoted
0.102506 bare and a reviewer reproducing it over all vertices got 0.400000 and could not
match the figure.

**Three separate guards, because one metric cannot see all three failures.**
Co-located vertices agreeing pins continuity (negative control: the unmapped enemy hull).
It is blind to the unroll, since a collapsed skirt is perfectly continuous — so skirt
TEXEL DENSITY pins that the sides are drawn at authored size, and UV footprint exceeding
the plan footprint pins that the unroll goes OUTWARD rather than folding back inward.
Both of those mutations, and collapsing `projectPlanarUV`'s `along` axis, each left the
full suite green before those tests existed.

The TURRET keeps `LatheGeometry`'s own wrap and **must not be touched**: u around the
axis is what makes checker a pinwheel and flow a swirl, and the design feedback asked for
both by name. The generalisation that "fixes" the hull everywhere is exactly the wrong move
here; a test compares the dome's position, normal and uv arrays against a freshly built
reference so that move fails loudly.

The BARREL is a lathe too, and its defect was DENSITY, not topology. Lathe u is one full
texture repeat around the circumference whatever that circumference is, so the same tile
was packed 2.8x tighter on the 0.82-unit gun than on the 2.26-unit turret and flow's
swirl arrived as corduroy; lathe v is INDEX-based, so the 0.05-unit flare step and the
0.4-unit tube got equal shares. `matchLatheToTurret` scales u by the radius ratio and
rebuilds v from real arc length, both against the turret. That makes u a FRACTION of a
repeat, so it no longer meets itself and there is a seam — `BARREL_SEAM_PHI` puts it on
the gun's underside, and `PI/2` is exactly 4 of the barrel's 16 segments, so the surface
is unchanged and only the seam moves. Pick an angle that is not a whole number of
segments and the silhouette rotates with it.

`stripes` is the exception to all of it: a hard-edged band wrapped around a lathe axis
arrives as pie slices, so its turret and barrel are projected flat. `STRIPE_TURRET_MODE`
is `'body'` — one field at world scale, 0.084 wide on every part, which was chosen from
renders ("I like continuous stripes actually"). `'part'` normalises each part to its own
half-width (0.084 / 0.069 / 0.025 on hull / turret / barrel) and was rejected because the
three sets do not line up. Pinned through the behaviour — all three parts must share one
v scale — not through the constant alone.

**CAMO AND CLOUDS ARE DIFFERENT SHAPE LANGUAGES — but only camo got a new generator.**
They shared one `blotches` helper (lobed clusters of circles) and differed only in count,
radius and lobes, so review twice reported them as swapped. The coverage WAS backwards
and swapping it was necessary — camo covers, clouds does not — but it was not sufficient,
because two skins cut from one silhouette generator read as versions of each other at any
density. `camoCells` is now a seeded power diagram: hard-edged interlocking polygons,
straight edges, no arcs, which a circle-based generator cannot produce at any parameter
setting.

**A soft-edged clouds generator (`cumulus`) was built for the other half of that split
and REJECTED ON LOOK** — "before clouds looks better actually" — so clouds is back on
`blotches` at the sparse post-swap setting, byte-identical to the texture it had at
`76ef38a`. `cumulus` is deleted rather than parked behind a switch; a generator nothing
calls rots. Do not rebuild it without new evidence: PR #139 carries the tile render it
lost on.

Two pins moved with it, and both had said something that stopped being true:

- **Coverage is measured by EXACT hull-hex equality.** It briefly used a nearest-tone
  classifier, which was genuinely forced by `cumulus`'s rim pixels (they equal no tone
  exactly, scoring 0.5913 exact against 0.6484 nearest). With both skins hard-edged again
  the two metrics are the same function — measured equal to 4 dp on all 12 (skin, hull)
  pairs — and exact is the one that cannot be fooled, since nearest has to guess the
  three flat tones by taking the three commonest.
- **The shape discriminator is EDGE GEOMETRY, not edge hardness.** Hardness now reads
  0.0000 for both. The test measures the share of boundary pixels lying on a locally
  straight run (7px window, 0.6px RMS): camo 0.2855, clouds 0.0355. Three cheaper
  candidates — base-region connectivity, triple-junction count, accent-meets-accent
  boundary share — were tried first and all three collapsed under a coverage-matched
  control, scoring camo's generator at clouds' coverage the same as clouds. The straight-
  run metric does not (0.2651 there), which is what makes it a shape metric rather than a
  density one wearing a shape's name.

Both skins still tile toroidally and stay deterministic from one seed, and neither tone
derivation moved: `autoAccent` keeps camo muted, `cloudTone` keeps clouds light, and the
white hull's deliberate darkening survives.

**`clouds is LIGHT on every hull that has room to be` was a tautology for two commits**,
which is worth knowing because nothing announced it. It read the tile's commonest colour
as "the dominant tone, the second one painted" — true only at the DENSE setting. The
density swap made the hull itself the majority tone, so that colour became the hull, and
the comparison became `hullL < hullL`. Forcing `cloudTone` to darken unconditionally left
it green. It now excludes the hull before taking the commonest, and the same mutation
fails it on 5 of the 6 hulls (all but white, which is allowed to darken).

**Entity configs are data, resolved through `src/sim/config/`.** A tank is
`TankDefinition` (`data/tank-defs.json`) + `BalanceConstants` (balance.ts, whose
AI profiles come from `data/ai-profiles.json`) → `resolveTankConfig` →
`ResolvedTankConfig`, read via `configFor(kind)`; gameplay code never branches
on a kind literal **to pick stats or behaviour** (identity checks like
`kind === 'player'` and the render's per-kind texture choice remain). The JSON
is validated at module load by `validate.ts` — a bad edit is a boot failure
naming the exact path, and the validator's own tests carry negative controls.
Adding a `TankKind` member is a compile error until `TANK_KINDS` (validate.ts)
lists it, which is what forces the JSON entry. Walls are the second family on
the same catalog machinery (`walls.ts`, `wallConfigFor`); new families
(power-ups, turrets, bosses) should ride `createCatalog` rather than invent
parallel plumbing. The **authoritative balance scalars live in
`config/data/balance.json`**; `constants.ts` derives from it and stays the
sim's one import site, so retuning is a two-file edit — the JSON entry and its
literal pin in `constants.test.ts` (every balance.json value is pinned;
`SHELL_MUZZLE_FORWARD` stays a TS literal, render-coupled). The muzzle **plane** and
the shell's **spawn centre** are two numbers, not one (#237): `SHELL_SPAWN_FORWARD` is
derived from the plane by `shellSpawnForward()`, insetting by the shell's *drawn* nose
reach (`SHELL_NOSE_REACH_RADII`, a render measurement the sim may not import) so the
visible round starts at the barrel opening rather than past it. `entities.test.ts` pins
that constant both ways against the shell mesh's built geometry; the `fire` event
carries the plane, so the muzzle flash does not follow the shell inward.
`decideAi` routes by the resolved profile's `behavior`; grey's dodge patience is
`(1 − aggression) · TICK_HZ`, rounded, pinned equal to `DODGE_PATIENCE_TICKS` in
`config/roster.test.ts`. Profile fields consumed today: `behavior`, `aggression`,
the signs of `directShotWeight`/`bankShotWeight`/`minePlacementChance`, and the
movement band — `preferredDistance`/`minimumDistance`/`retreatChance` (magnitude
included) drive `seekMove`, the mobile decisions' baseline move (approach beyond
preferred, seeded retreat draw inside minimum, wander in the band; tuned by
sweep, see `SEEK_APPROACH_BIAS`) — and `aimAccuracy`: per-profile jitter is
`AI_AIM_SPREAD / aimAccuracy` (`profileAimSpread`), the anchor being a
perfect-accuracy profile's spread; curve chosen by sweep, see the anchor's
comment in constants.ts — and `estimationAccuracy` (directive B): per-profile hazard
misjudgement is `AI_HAZARD_SPREAD / estimationAccuracy` (`profileHazardSpread`), the same
anchor/derate shape, feeding a per-tank-per-window `estimationError` draw that perturbs
the perceived mine-flee radius, danger corridor and mine-tactical radius `dangerAvoidMove`/
`incomingThreats`/`mineThreatensPlayer`/`friendlyInMineBlast` gate on — and
`minePlacementChance` in full: its magnitude is
the per-bucket mine-proposal probability (`mineInclination`) — and
`reactionTime`: the dispatcher holds every AI shot until the solution has been
HELD (`Tank.aimTicks`, `AiDecision.hasSolution`) for the profile's reaction
span; cover resets the clock, and so does anything that is not LIVE play. The
clock accumulates only while `roundPhase(world)` is `'live'` (issue #367): it
used to bank the round countdown as well, on the argument that an enemy which
watched the player through that phase had earned the shot at the bell — measured
on the golden trace's population, 12 of its 30 runs had an enemy at or past its
full span the moment the countdown ended, i.e. entitled to fire on the first
live tick the player could act on. The turret still tracks through the countdown
(that happens inside `decideAi`), so the shot stays telegraphed; only the clock
is held. `decidePlayerInput`'s mirror clock in `PlayerAiState` carries the same
gate — and `commitmentTime` (issue #222): the movement
COMMITMENT span, `Math.round(commitmentTime · TICK_HZ)`, applied centrally by
`decideAi` through `commitMove` (`ai/commitment.ts`) over whatever the behaviour
returned, never inside `dangerAvoidMove` (that helper is shared with
`decidePlayerInput` and must stay stateless). While a commitment is live the tank
moves on its held heading; it ends early only on a genuine emergency (the heading
now walks into a wall, or a required escape disagrees with it), and at expiry a
candidate inside `AI_COMMIT_HYSTERESIS_DOT` counts as the same decision. A BULLET
escape is compared sign-blind (`AI_COMMIT_DODGE_ALIGN_DOT`) because
`dangerAvoidMove` returns one of two exact opposite perpendiculars and both leave
the corridor; a mine escape keeps the signed test. The same layer reaches
bot-driven PLAYER tanks via `commitHeading`, with the state in the caller-owned
`PlayerAiState` rather than on the tank. `commitmentTime` is authored as a
personality axis and is deliberately NOT scored by `tankDifficultyBreakdown`
(committing longer is both more decisive and more predictable, so it is not
monotonic in threat); like `estimationAccuracy`, it is inert for STATIONARY
profiles, whose `desiredMove` is hardcoded zero so they never acquire an intent — and
`aimHoldTime` (issue #344): the AIM span, `Math.round(aimHoldTime · TICK_HZ)`, applied
centrally by `decideAi` through `holdAimFor` (`ai/aim-hold.ts`) over whatever
`turretAngle` the behaviour returned, with `stepAi` writing the held angle and its
countdown back to `Tank.aiAimHeld`/`aiAimHeldTicks`. While a hold is live the turret
slews toward the held angle rather than a freshly solved one, so the gun settles and
dwells instead of correcting every tick; the hold breaks early when the fresh solution
drifts past `AI_AIM_BREAK`, so acquiring a genuinely new target is immediate. A span of
zero re-arms to a zero countdown and re-solves every tick, which is the pre-#344
behaviour exactly — demonstrated, not assumed: setting every profile to zero reproduces
the previous `BASELINE_HASH` byte for byte. `hasSolution` and `fire` deliberately keep
reading the FRESH solution, so this holds where a tank POINTS, never what it believes it
can hit, and the dispatcher still re-vets friendly fire against the actual post-slew
angle. Unlike `commitmentTime`, `aimHoldTime` is NOT inert for STATIONARY profiles: a
turret that never moves its hull still tracks, and brown is the kind whose shimmer this
was measured against. **Every profile field is consumed by the
implementations it applies to** — a scoped claim since 2026-08-16, not a universal
one: `estimationAccuracy` is read only where hazard estimation happens, so
STATIONARY's two profiles (STATIC_BASIC, RICOCHET_SNIPER) carry a value nothing
reads, the same shape as their `preferredDistance`/`minimumDistance`/`retreatChance`
(see the estimation-error paragraph below). That includes
both shot weights in BOTH mobile and stationary implementations — `brown.ts`
gained bank shots gated on `bankShotWeight > 0`, which is what makes
RICOCHET_SNIPER (the **green** tank, level 4) a real enemy rather than authored
intent. It prefers the DIRECT shot and falls back to the bank, where `teal.ts`
alternates: a turret that can already see you has no reason to take the longer
path. Brown is unaffected because STATIC_BASIC carries `bankShotWeight` 0 — proven
by an identical trace hash over 4 arenas × 6 seeds × 2500 ticks, with a control
showing the probe moves when banking is switched on.

**`estimationAccuracy` (directive B, the 2026-08-16 owner ruling: AIs must not have
oracle knowledge of exact mine blast radii or perfect dodge positions) is the same
asymmetric-consumption shape `bankShotWeight` set the precedent for.** It is a REQUIRED
field on all 8 profiles, but only DEFENSIVE/TACTICAL/OFFENSIVE/BERSERKER behaviours ever
reach a site that reads it (`targeting.ts`'s `dangerAvoidMove`/`incomingThreats`/
`mineThreatensPlayer`/`friendlyInMineBlast`, all now taking an optional perceived-radius
parameter defaulted to today's exact constant); STATIONARY (brown, green/RICOCHET_SNIPER)
never imports `dangerAvoidMove` and never reaches `friendlyInMineBlast` (gated on
`TankAbility.MINE_LAYER`, which neither carries), so the field sits on their profile
unread by the SHARED path, same as `preferredDistance`/`minimumDistance`/`retreatChance`
already do for STATIONARY. The PLAYER rescues STATIC_BASIC's copy from being unread
everywhere: it also resolves to STATIC_BASIC and DOES consume its `estimationAccuracy`,
through an independently written mirror of the same gates in `player-profile.ts`
(oracle-knowledge site #5, drawn from the player's own injected `rnd`, never
`world.seed`) — so the field the shared AI path ignores for brown is exactly the field
the player's own code reads for the identical profile. Nothing rescues RICOCHET_SNIPER's
copy the same way: green is STATIONARY too, is never the player, and nothing else in the
tree reads `estimationAccuracy` off it — its 0.90 sits on the profile as inert as its own
`preferredDistance`/`minimumDistance`/`retreatChance` already are, not exempted by the
player-side path the way STATIC_BASIC's is. `AI_HAZARD_SPREAD` (`constants.ts`, sourced
from `balance.json` per the `AI_AIM_SPREAD` precedent) is the anchor a
perfect-estimationAccuracy profile would still misjudge by; every shipped profile that
reaches a consuming site sits below accuracy 1.

**A green tank changed what `structuralFailures` has to check.** "No enemy sees
the player spawn" tested `lineOfSight` only, which was the same as "no enemy can
SHOOT the player spawn" for exactly as long as no stationary enemy could bank.
There is now a second rule: no STATIONARY banking enemy may hold a ricochet path
onto the spawn. Restricted to stationary bankers on evidence, not taste — applied
to every banking profile it rejects shipped arena-01 (grey banks onto the spawn
off 1 wall, teal off 2) and arena-04's teals. Mobile tanks leave that geometry
within a second; a turret never does. `BANK_SIGHTLINE_ARENA` is the negative
control, and swapping its one spawn letter for `T` and `B` controls the
behaviour gate and the weight gate separately.

**`determinism.test.ts` does not catch AI behaviour changes**, which is easy to
assume it does. It asserts self-consistency — same seed, same result — and that
is invariant under behaviour changes: giving brown a 0.5 `bankShotWeight` leaves
all 7 of its tests passing while a trace probe moves. When that mutation was first
run it passed the WHOLE suite (1155 tests); it now fails 5 tests in 2 files,
because green's arrival added tests that watch the bank path — so the hole is
narrower than it was, and the general point stands. Any claim that an AI edit is
behaviour-preserving needs a golden trace comparison, not a green suite. The same blind
spot applies to `estimationAccuracy` (directive B): a broken wiring of the perceived-
radius sites would leave every unit test in `profile.test.ts`/`targeting.test.ts` green
by itself, since they inject the field directly rather than exercising the seeded
call-site draw. The hash move this PR records (`324aa9b5…` → `a5458ede…`) IS the proof
obligation, not a decorative side effect of the change — `determinism.test.ts` passed
before and after and could not have told the difference either way.

STATIONARY still ignores `preferredDistance`/`minimumDistance`/`retreatChance`,
and always will: they are a distance band for a tank that moves. "Every profile
field is consumed" means consumed by the implementations it applies to. The 9-type Wii taxonomy in `config/reference/` is reference
data only — nothing in the game reads it.

**Arenas are data too.** Grids, design rationale (`notes`) and machine-checkable
design `claims` live in `config/data/arenas.json`, validated at load by
`validateArenas` — a bad edit is a boot failure naming the exact path (e.g.
`arenas[2].grid[4]`). `arena.ts` keeps every export it always had; `SPAWN_LETTERS`
(`config/arena-types.ts`) is the single source of the spawn-letter map for the
validator and `loadArena` — green is `N`, because grey already holds `G` and
re-lettering grey would rewrite every shipped grid — `src/sim/sandbox.ts` keeps its own `KIND_LETTER`
table (plus a hardcoded `'P'`) for grid GENERATION, so re-lettering a kind in
`SPAWN_LETTERS` without also updating `sandbox.ts` would leave the dev sandbox
emitting a character `loadArena` rejects. Three claim types —
`sightlineAfterBreach`, `lane`, `spawnBlockRobust` — are verified by
`src/sim/arena-claims.ts` from the test layer (it imports the AI's
`lineOfSight`, so it must never be imported by `config/`). `sightlineAfterBreach`
is all-or-nothing per arena: declaring one commits the arena to declaring one
for EVERY enemy spawn, checked by set equality (both directions) in
`arena-validation.test.ts` — an arena's claims of this type are a COMPLETE
statement of its post-breach spawn lines, never a sample (an arena may still
declare zero, as arena-01 does). `spawnBlockRobust` checks more than its name
suggests: every enemy spawn against 4 cardinal nudges of the player, in BOTH
wall phases (intact and breached) — measured across all 6 scenarios that can
run it (arena-01, arena-02, arena-03, arena-04, and the two fixtures built in
`arena-claims.test.ts` to discriminate the phases), 0 failures were
intact-only, so the intact phase's value is labelling which wall state a
failure lives in, not added detection power on its own; the breached phase is
what actually catches a corner tangency. arena-04 contributes 0 failures in
either phase (0 of 24 probes each: 6 enemies × 4 cardinal nudges). Only 5 of
those 6 DECLARE the claim —
arena-02 does not, because checked the same way it fails 12 of its 16
breached-phase checks (0 of 16 intact): the level's design is to open
sightlines when its centre barrier breaches, not survive it. The switch case in
`arena-claims.ts` only runs a claim type an arena actually DECLARES, so nothing
about arena-02's number falls out of the claim runner — it is recomputed
instead by its own test in `arena-validation.test.ts` (denominator pinned at 4
enemies × 4 cardinal nudges), which fails if that grid changes. Deliberately
not a claim: making it one would assert a property arena-02 does not have. Adding a level is editing JSON: the generic runner in
`arena-validation.test.ts` picks up its claims automatically, and `npx vitest
watch src/sim/arena-validation.test.ts` is the authoring loop — though the
claim MIX itself is pinned separately by that file's `EXPECTED_CLAIMS` table,
so changing an arena's claims is a deliberate two-file edit. `spawnBlockRobust`
exists because arena-03 once shipped a corner tangency a 0.1-unit nudge opened.
A `lane` claim's `from`/`to` are LITERAL grid cells, not tied to a spawn by the
validator (`cell()`, not `enemySpawnCell()`) — moving the spawn a lane's `why`
refers to does not invalidate the claim, which keeps measuring the same two
cells and keeps passing; arena-03's two lanes and arena-04's seven survive this
only because every one of them has an enemy spawn at its `from` end carrying a
`sightlineAfterBreach` claim at that same cell, which DOES require a live spawn
there and so catches the move at load time instead. Their `to` ends are plain
floor cells and are pinned by nothing — moving a wall so a lane's target cell
stops meaning what its `why` says is a change no test can see. See the `lane`
variant's doc comment in `config/arena-types.ts`.

**arena-04 is the first shipped board that is not 33x27** (45x33; world dimensions are
unchanged by the 3x cell-size rescale — only the cell counts moved), so PR #53's
per-level render refit is now exercised by a level players actually reach rather
than only by a fixture. `WIDE_ARENA` moved 15x11 -> 17x13 when it landed, because
`arena-validation.test.ts` asserts the fixture differs from every shipped arena
and a fixture whose whole job is to be an unshipped size gives way to production
data. Three distinct board sizes are now covered.

**Adding a level moves more pins than the level file.** Five places moved when
arena-04 landed; arena-05 then proved that list stale in both directions, so the
checklist below is ARENA-05'S measured list, and the lesson is to re-derive it
each time rather than trust this paragraph: `cell-mapping.test.ts`'s cell and
spawn totals (5864 / 33 since arena-05); `EXPECTED_CLAIMS` in
`arena-validation.test.ts` (the claim mix, not a count); that file's cover-ratio
`EXPECTED` table (and its `tightest` assertion, which names one arena);
`framing.test.ts`'s two `ARENAS.length` pins; `difficulty.test.ts`'s per-arena
`EXPECTED` table and arena-list assertion (landed after arena-04, so the old
checklist never knew it); the `demolition` threshold in `achievements.ts`
(derived from the total destructible-cell count, which a new arena moves);
`BASELINE_HASH` in `tools/baseline/trace.test.ts` (the trace runs over ALL
shipped arenas); and the `framing-fit-bracket-4.5` entry's `expectFailures` in
`tools/mutate/manifest.json`. Two items from arena-04's list dropped off: the
`variable arena dimensions` fixture block only moves if the new size collides
with a fixture, and the "three size labels in `tools/gl/harness.ts`" no longer
exist — grep at arena-05 found no arena-size prose there to update. The harness
labels were prose, so nothing failed when one was missed — review caught it —
and the same class of miss is why this paragraph now says re-derive. Any number a `notes` string quotes is likewise unpinned by construction:
`notes` are validated as strings only. Three blocks in `arena-validation.test.ts`
exist purely to recompute quoted prose — arena-02's `12 of 16`, arena-04's cover
ratios, and arena-04's bank-reach count (275 cells reached by ricochet, covering
171 of the 284 nothing else sees) — because all three were measured once by hand
and nothing checked them again. Quote a measurement in `notes` and you owe it a
recomputing test. **This whole checklist is the `ARENA_DEFS` side only.** Since
issue #154, a new board joining the catalog (`arenas.json`) and a new LEVEL
joining the campaign (`config/data/campaign.json` / `CAMPAIGN_LEVELS`) are two
separate, consciously-linked edits — `campaign.test.ts`'s arenaId-set pin forces
the link (an arena shipped but not placed in the campaign, or the reverse, fails
there), but nothing on the list above does. Landing an arena without a matching
campaign entry is a legal, deliberate state (the campaign's own "out of scope":
not every shipped arena has to be in play), so a new arena alone does not
necessarily mean a new level's worth of pins moved — check `campaign.test.ts`
and `achievements.test.ts`'s demolition-threshold sum (now over `CAMPAIGN_LEVELS`,
not raw `ARENAS`) if it does.

**Walls load as geometry, not as cells.** `loadArena` merges SOLID cells into maximal
rectangles (`mergeSolidRuns`) and numbers tanks from a counter of their own. Both exist
because four parts of the sim read the wall ARRAY rather than the arena's shape, and
the 3x resolution upscale exposed all four: tank ids shared a counter with walls, so
wall count reseeded every per-tank RNG stream in `ai/targeting.ts`; `resolveWalls`
applied one push per overlapping wall, so a sliced wall pushed several times and its
interior seams offered phantom corners; `bankShot` chose the first reflector in
wall-array order; and `circleVsAABB`'s `inside` branch resolved a hull escape
differently depending on which sub-cell box it was handed.

**The bank-shot dependence turned out to live one function deeper**, which is worth
knowing before anyone "simplifies" it. `bankShot` now picks the SHORTEST muzzle ->
bounce -> target path, ties broken on the angle, so its answer is a property of the
arena rather than of the array. But the defect a subdivided wall actually triggered was
in `losIgnoring`: a bounce landing exactly on a seam put the segment's own ENDPOINT on
the neighbouring box's corner, and `raySegmentVsAABB` counts a boundary touch as a hit,
so a legitimate shot was reported blocked. `losIgnoring` now disambiguates with
`headingIntoBox` — the same direction-probe form `reflectSweep` already ships, NOT the
step-out-along-the-normal form this file records as tried and reverted. It is safe here
for a structural reason: `losIgnoring` has exactly two callers, both inside `bankShot`,
so it cannot reach `reflectSweep` and cannot reopen the escape bug.

An explicit `faceIsBuried` guard was written first and then DELETED, on evidence with a
stated DOMAIN — the unqualified version of this paragraph was falsified in review. With
both endpoints strictly outside every wall, which is the only state the sim produces
(`resolveWalls` keeps every hull centre out of the mass), removing the guard changed
0 of **4,195,692** (muzzle, target) probes across 12 synthetic shapes and all 4 shipped
arenas' real merged geometry. With an endpoint exactly ON a wall surface it is not a
no-op: **81 of 1,966,116** probes differ, all on arena-03. So the guard is unnecessary
because of REACHABILITY. The structural argument this file used to give — "if a face is
buried the neighbour occupies the space outside it, so any ray reaching it is already a
real penetration" — is FALSE, and there is a witness: an approach arriving exactly at the
seam CORNER only touches the neighbour, and the graze check correctly lets it through.
`targeting.ts:277` is the ledger of record. Do not re-add the guard without a fixture
that fails when it is removed — and such a fixture has to put an endpoint on a wall
surface, which is why none exists.

**Destructible walls are never merged**, and that is a rule, not an oversight. A
destructible cell is a destruction UNIT: mine blasts destroy by world-space radius
(`mines.ts`), so a finer grid means finer breaching. arena-02's centre barrier is
authored as adjacent blocks whose separate destruction is the level's design.

**The fourth is the hull-escape case: a hull INSIDE a wall escapes the mass, not the
sub-cell.** `circleVsAABB`'s `inside` branch pushes out through the nearest face of the
ONE box it is handed, which for a sub-cell is usually a buried internal seam — so the
same hull in the same place resolved differently depending only on the slicing
(measured: 780 of 1,681 interior centres on an isolated destructible mass).
`resolveWalls` now marches box to box along each axis to find where the wall MASS ends,
which is a property of the union. `circleVsAABB` itself is untouched, because
`bullets.ts` depends on it. This was reachable, not theoretical:
`separateTanks` drives hulls up to 0.375 units into a block and `stepMovement` calls
`resolveWalls` immediately afterwards.

**Two numbers in this section are NOT pinned by any test**, which by this file's own rule
is a debt: the 780 above (an independent reconstruction at the pre-fix commit measured
774, a 0.8% difference nobody has resolved — treat it as "most of an isolated destructible
mass's interior", not as a figure), and `targeting.ts`'s buried-face probe count, whose
guard is deleted so nothing can ever re-derive it. The decomposition GUARANTEES are pinned,
by `decomposition.test.ts`; these two provenance figures are not.

`src/sim/decomposition.test.ts` pins the property directly — the same geometry
expressed at two cell sizes must agree on `resolveWalls`, `lineOfSight` and `bankShot`.
`tools/baseline/trace.test.ts` is a golden trace over 5 arenas x 6 seeds x 2500 ticks
(4 until arena-05 joined — the trace runs over ALL shipped arenas, so adding a level
moves `BASELINE_HASH` by construction) and is now ASSERTED, not merely printed:
`determinism.test.ts` only proves
self-consistency, which is invariant under behaviour changes. **Know what it does not
cover, RE-MEASURED at the 4-arena tree (arena-05 has not re-measured these probes;
the hash values below predate it, and so does the "estimation error" PR that moved
`BASELINE_HASH` again — see below — so both figures are now unmeasured at TWO trees
past their own, not one).** Mutating `bankShot` to return the first
valid candidate instead of the shortest changed the then-current hash (to
`0cf1f76a14060992eb8763c9cd20e95b8c17cde2d1dbe3e8de6c87ff47137e9a`) and fails the test —
a later change to `resolveWalls` altered trajectories enough that bank shots now DO
influence the trace, even though the bank-shot rewrite itself did not move it when it
first landed. Mutating the inside-wall escape (disabling `resolveWalls`' union-mass
marching so a hull inside a wall resolves through the single sub-cell box instead) still
leaves the hash unchanged: the seeded replay never drives a hull inside a wall, so that
path stays uncovered. The lesson generalises: a coverage claim recorded at one commit can
go stale as later changes alter trajectories, so re-measure rather than carrying it
forward. The decomposition guarantees are held by `decomposition.test.ts`, not by this
hash.

**The trace body lives in `tools/baseline/trace.ts` and runs in a BROWSER too.** It
imports `src/sim` only and hashes through `crypto.subtle` + `TextEncoder` rather than
`node:crypto`, which is the whole reason it can: the same code under vitest and under
Playwright. `npm run trace:browser -- --all` serves `tools/baseline/page.html` on
localhost (secure context — `crypto.subtle` is undefined without one) and prints one hash
per engine. Measured on this box at the 5-ARENA trace (2026-08-16, the day directive B's
estimation error landed — see "AIs must not have oracle knowledge" below, the trace
arc's FIRST deliberate hash move; every prior entry in this history left the hash exactly
where it started): **chromium 151, firefox 153 and Playwright's webkit (JavaScriptCore,
UA-spoofed as macOS Safari but a Linux build) all produce `a5458ede…`, matching the pinned
baseline** — so V8, SpiderMonkey and JSC agree on this trace, on Linux x86-64, headless.
(The previous baseline, `324aa9b5…` (2026-08-11, the day arena-05 landed), and the one
before it, `015a5d17…` (the 4-arena trace), each had the identical three-engine agreement
measured in their own turn; a new arena moves the hash by construction, and this PR is
the first case of a BEHAVIOUR change doing the same — see the dedicated paragraph below.
This re-run is owed again after every arena or deliberate behaviour change. CI's
`Baseline trace (chromium)` step keeps V8 current on every
push; firefox and webkit re-verify on push to `main`, weekly, and on demand, via
`.github/workflows/engines.yml` ("Engines matrix") — a SEPARATE workflow from `CI`,
deliberately: see "The deploy waits for CI" above for why a checking job that can fail for
reasons unrelated to the tree must not sit inside `ci.yml`. It runs the angle probe
(`tools/baseline/angles.ts`, `ANGLE_HASH`) alongside the golden trace on every run, since
`--all` always runs both, and prints and uploads both hashes per (OS, engine) — the
acceptance harness issue #133's vendored-math work landed against, now a THIRD result on
the same run rather than a future one. **#133 is closed**: `src/sim/math/` ports
netlib.org/fdlibm's sin/cos/atan2 and V8's own Torque hypot formula, wired at all 17 of
the sim's former `Math.sin`/`cos`/`atan2`/`hypot` call sites (the 4 `Math.sqrt` sites
stay native — ES2025 correctly-rounded). `BASELINE_HASH` did **not** move — measured, not
assumed: `324aa9b5…` (the value pinned at the time, superseded by directive B's move to
`a5458ede…` above — this migration's own claim is about that specific pre-/post- pair and
stays true on its own terms) is unchanged pre- and post-migration, on Node and on all three
browser engines alike, which the plan's own Node/V8-13.6-provenance argument predicted as
plausible but not certain. `ANGLE_HASH` is unaffected by construction (it sweeps native
`Math.*`, never touched by this work) and the three engines still disagree on it, same
finding as before. The new **`VENDORED_ANGLE_HASH`** is the pin this paragraph used to
describe only as a future acceptance harness: `tools/baseline/angles.ts`'s vendored bands
(`vsin`/`vcos`/`vatan2`/`vhypot`), asserted equal ACROSS ENGINES rather than merely
self-stable on Node, and measured — chromium, firefox and webkit all produced
`a4fdbbfb32de…`, matching the pin — which is the actual demonstration that a JS port
built only from ECMA-262's exactly-specified operations achieves what native
`Math.sin`/`cos`/`atan2`/`hypot` cannot: bit-identical output on every engine. `npm run
trace:browser -- --all`'s exit code now reflects this: a vendored-hash mismatch counts
into `failed`, unlike a native `ANGLE_HASH` mismatch, which stays structural and
unfixable. **What #133 does not fix**: `InputState.aim`'s canvas-size dependence and
`SimEvent`'s missing tick field, both still open, both recorded in the multiplayer spike
in `docs/superpowers/backlog.md`.) **That is not the whole
question**: one matching hash is agreement on the sampled trajectory, not a proof about
`Math.hypot`. The shipped-Safari/iOS half is now MEASURED, not open: the engines
workflow's macOS legs (PR #168, first run at `15989dd`, 2026-08-15) drove real shipped
Safari 26.5.2 via safaridriver and real iOS WebKit (Mobile Safari, iOS 18.7 Simulator,
arm64) via the beacon, and both matched `BASELINE_HASH` and `VENDORED_ANGLE_HASH` **as
they stood that day** — against the pre-directive-B `324aa9b5…`, not the current
`a5458ede…`; that leg has not re-run since the hash moved, so shipped Safari/iOS agreement
on THIS baseline is unmeasured, not disproven. The
sole remaining gap is a physical iOS device — one URL away:
`npm run trace:browser -- --beacon`, open the printed URL on the phone.
