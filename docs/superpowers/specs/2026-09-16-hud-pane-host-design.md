---
status: active
date: 2026-09-16
last-reviewed: 2026-09-17
scope: What an extracted HUD pane module receives from hud.ts, how it registers, where its markup lives, and how the first extraction proves no behaviour change
implementation-issues: [556, 765]
implementation-prs: [779]
supersedes: []
superseded-by: []
---

# The seam hud.ts hands to an extracted pane

**Proposed 2026-09-16; active since the rulings of 2026-09-17.** Issue #556 splits `src/game/hud.ts`. It asks for a design of what the
shared state becomes before any file is created. Issue #765 asks for that design as a spec
that a pane extraction can be built and reviewed against.

Four decisions below needed an owner ruling before this spec became `active`: the markup
rule (rule 3) and the three cross-pane couplings (rule 4). **All four were ruled on
2026-09-17, each for the recommended option.** The recommendations below are the rules; the
alternatives are kept as the record of what was rejected. #779 extracted Customize under rule
3 before the ruling, stating that assumption, and the ruling confirms it. The other rules follow from
measurement, from the precedents in #755 and #759, and from a panel of three independent
designs that two judges scored against the source.

## 1. What this is measured against

Every figure here was measured with `npm run hud:closure`, the tool PR #768 checks in for
#767. The run is on that PR's head, where `hud.ts` is unchanged from `main` at `43adf28`. #768
merged as `024a0be` on 2026-09-17, so the tool is on `main`; the tables stay a reading of
`43adf28`, before #779 moved Customize out.

**How it counts.** The tool loads `hud.ts` into a TypeScript program, then walks every direct
statement of `createHud`'s body.
- **Owner:** each statement, and each member of the returned `Hud` object.
- **Reference:** resolved through the checker, so a local that shadows a closure name is not
  counted.
- **Write:** an assignment target, an operand of `++` or `--`, a destructuring target, or a
  loop variable.

At `43adf28`, `createHud` has **761 owners**:

| Kind | Owners |
| --- | --- |
| `const` | 347 |
| `let` | 46 |
| `function` | 112 |
| `Hud` member | 87 |
| other statement | 165 |
| local type | 4 |

**How owners are attributed to panes.** The attribution is data in
`tools/hud-closure/attribution.mjs`. It keeps the #556 account's rules:
- the noun table, first match wins;
- the account's hand corrections;
- a statement belongs to a pane when every pane-owned name it references is that pane's.

It adds three corrections, each with its reason:
- the 17 names of #754's Controller Layout pane, which opens from Settings and landed after
  the account, go to Settings;
- `recordStockLosses` and `setReducedMotion` are shared, for the reasons in the table below;
- the `ach*` names, which no noun matches, go to Records.

| Pane | Owners | Owner lines | Members | Places | Outside values | Cross-pane | Writes across | Inbound | Manifest entries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Customize | 29 | 74 | 10 | 9 | 8 | 0 | 0 | 6 | 0 |
| Controllers | 37 | 199 | 6 | 11 | 12 | 1 | 0 | 6 | 5 |
| Records | 40 | 198 | 4 | 19 | 10 | 1 | 0 | 8 | 16 |
| Versus Setup | 72 | 547 | 3 | 8 | 11 | 2 | 0 | 7 | 19 |
| Developer Tools | 132 | 419 | 10 | 24 | 10 | 1 | 0 | 13 | 17 |
| Settings | 157 | 452 | 25 | 33 | 15 | 0 | 0 | 14 | 10 |
| shared | 294 | 3031 | 29 | 47 | | | | | 129 |

- **Owner lines** add up each owner's line span. They leave out markup inside the one
  `el.innerHTML` template, which is a single shared owner.
- **Places** counts runs of consecutive owners that belong to the pane.
- **Outside values** are the non-type owners outside the pane that the pane reads or writes.
  Each pane also reads the local `Surface` type, which is not counted here.
- **Inbound** counts owners outside the pane that reference it.
- **Manifest entries** counts entries naming `hud.ts` whose `find` starts inside one of the
  pane's owners, counting a statement's leading comments as part of it. All 201 such entries
  were found, and 5 of them start outside `createHud`.
- **Only the Customize row was also checked name by name** against the source.

**Why these differ from the account on #556.** The account measured `21f554e`. Since then,
#753, #755 and #759 changed `hud.ts` by 380 lines. #755 moved Customize's three choice rows
out, which is why Customize has 29 owners here against 40 there. Customize's 8 outside values
and 6 inbound users match the account.

### The account's headline is contingent on attribution

The account found that no pane writes a binding outside itself. The tool's prototype applied
the account's rules alone, without the three new corrections, at `43adf28`. That run found
three such writes. Each one is an artifact of the naming heuristic, not a pane reaching into
shared state:

| Writer | Binding written | Why it crosses a line |
| --- | --- | --- |
| `showControllerLayout` | `let layoutOpen` | #754's names say "controller", but its state belongs to a Settings sub-pane. |
| `recordStockLosses` | `let stockBaseline` | "records" matches inside "recordStockLosses", which is gameplay stock-strip code from #753. |
| `setReducedMotion` (member) | `let reducedMotion` | The account keeps `reducedMotion` shared, while its setter's name matches Settings' "motion". |

With the corrections, the count is zero. But zero is then a result of attribution choices, not
a property of the file. So this spec does not state the guarantee as a fact about `hud.ts`. It
states it as a rule each extraction must meet, in rule 1.

## 2. The rules

These rules were checked against three independent designs for the same questions, each
scored by two adversarial judges who re-read the cited lines. The designs disagreed about
where types live and how much moves in the first step. They agreed on the points marked
**(all three)**, and the judges' corrections are folded in.

### Rule 1: What a pane module receives

**A pane module exports one factory. The factory takes a typed host, its own surface, and any
element outside its container that it wires. It never takes a `hud.ts` binding.**

```ts
// src/game/pane-host.ts -- a new leaf module. It imports nothing from hud.ts.
export interface Surface {
  readonly el: HTMLElement;
  readonly hidden: string;
}

export interface PaneHost {
  /** Show `to`, leaving whatever surface the player is on: `swapSurface(openSurface(), to, ...)`. */
  enterSurface(to: Surface, onBegin?: () => void, instant?: boolean): void;
  /** Put `from` away and return to the Main Menu; a no-op when `from` is not the open surface. */
  closeSurface(from: Surface, onBegin?: () => void, instant?: boolean): void;
  isSurfaceOpen(surface: Surface): boolean;
  /** Push THIS pane's layer. hud.ts binds the layer id, so the pane never names one. */
  open(opener: HTMLElement | null): boolean;
  back(): boolean;
}
```

- **Each pane declares its own `Pick<PaneHost, ...>`,** such as `CustomizeHost`, and the factory
  takes that type **(all three)**. The compiler rejects a call to a host member the pane did not
  declare. The `Pick`'s key list is the pane's shared-state cost.
- **The key list is also pinned by a source scan.** A cast reaches past a `Pick` at run time. So
  the first extraction PR adds a test that reads each pane module's source, parses its
  `Pick<PaneHost, ...>`, and compares the keys with a table in the test. It has a planted
  wider-`Pick` string as its negative control, and adding `| 'back'` to a pane that does not use
  it as its production mutation.
- **`enterSurface` replaces raw `swapSurface` and `openSurface`.** At `43adf28`, all 15
  `swapSurface` calls outside the core pass `openSurface()` as their source. Only the declaration
  (3567) and `closeSurface`'s own call (3602) do not. The comment on `openSurface` (3610-3626)
  records that a pane naming any other source was measured wrong, so the host offers only the
  safe shape. hud.ts's own call sites may keep their current form.
- **The roster grows with the panes that need it.** It does not start with every member a later
  pane will need. An unused host member is an implementation no test can reach, so a mutation of
  it could only survive. The per-pane scan table is what keeps the costs comparable.
- **Members a later pane will add** follow the same rule: a function, returning a plain value in
  the pane's vocabulary, never a binding.
  - `captureFocus`, for Controllers and Versus Setup;
  - `appendToast`, for Records;
  - `isPaused()` rather than `shownState`, for Controllers;
  - `isOnTop()` rather than `layers`, for Versus Setup, bound per pane like `open`;
  - `reducedMotion()` and `modality()`, for Settings;
  - the armed-confirmation pair in rule 4.
- **Host members are functions passed by reference, or deferred wrappers.**
  - `swapSurface`, `closeSurface`, `isSurfaceOpen`, `openLayer` and `back` are function
    declarations, which are hoisted, so a factory can be constructed where its element lookups
    run today.
  - A member over a binding initialised later is a wrapper that reads it at call time:
    `layers` (4787), `shownState` (5875), and the `const` arrows `appendToast` (4598),
    `blurIfPointer` (4630) and `blurAfterDrag` (4633).
- **A factory does not navigate during construction.** The core reads `transitions` and
  `PANEL_FAMILY` at call time, and neither exists yet at that point.
- **`open` is bound per pane.** hud.ts builds each pane's host with
  `open: (opener) => openLayer('<id>', opener)`. `HudLayerId` stays out of the pane module, and
  `pane-host.ts` imports nothing from `hud.ts`.
- **A pane owns every binding it writes.** At the extraction PR's base, `npm run hud:closure --
  --strict --pane <pane>` must exit 0 for the pane being moved. At `43adf28` it exits 0 for
  Customize. If a pane-named owner writes a shared binding, the writer stays in `hud.ts` with its
  binding.
- **Closure-free helpers are imported, not handed in.** `blurIfPointer` and `blurAfterDrag`
  (4630, 4633) read nothing from the closure. They move to module scope in the first PR that
  needs them, and `hud.ts` imports them under the same names. No manifest entry names either
  one's text.
- **`el`, the HUD root, is not handed in (all three).** A pane queries only inside the surface
  it is given. An element elsewhere that the pane wires arrives as a parameter, such as the Main
  Menu's Customize button.

**Why this shape:** #556 warns that splitting panes into files is worse than the status quo if
each file still reaches into one shared mutable scope. A `Pick` over a host that holds no
bindings makes that reach impossible to write. It also turns the account's "navigation core"
list into a type the compiler checks and a table a test pins.

**Where the types live, and the alternative a judge preferred.** One design, and one judge's
graft, put `PaneHost` and `Surface` in `hud.ts` as exports. Pane modules would then take a
type-only import from the file that imports them. `src/dependency-direction.test.ts` tolerates
that, because it classifies by layer. This spec keeps a leaf module instead, because binding
`open` per pane removes the only reason `pane-host.ts` would import from `hud.ts`
(`HudLayerId`). A pane module then imports nothing from `hud.ts`, and a test can say so without
exceptions.

### Rule 2: How a pane registers

**hud.ts keeps every shared table, its key set and its order. The table's entry for the pane
names the pane's exports (all three).**

| Shared owner | Today | After extraction |
| --- | --- | --- |
| `PANEL_FAMILY` (3425) | `CUSTOMIZE_SURFACE` | unchanged: hud.ts keeps the surface of the container it owns |
| `activePanelContainer` (4384) | `customizeView` | unchanged, for the same reason |
| `LAYERS.customize` (4697) | lambdas over `showCustomize`, and an inline `release` | `open: () => customize.show(true)`, `close: () => customize.show(false)`, `release: customize.release` |
| `onNavKeyDown` (4576) | `e.target === previewCanvasEl` | `e.target === customize.previewCanvas` |
| `setState` (7376) | `showCustomize(false, true)` | `customize.show(false, true)`, at the same point in the ordered close |
| `dispose` (8374-8377) | four `removeEventListener` calls | `customize.dispose()`, at the same point |
| returned `Hud` object | ten members | ten explicit delegations, in the same order |

- **Why ordering stays central:** paint order (`PANEL_FAMILY`) and `setState`'s close order are
  properties of the whole set of panes. The comment on `openSurface` (3610-3626) records the
  cost of a close sourced from the wrong place: a Customize close once hid the Controllers pane.
  If panes registered themselves, order would depend on call order across files.
- **Why members stay explicit:** the member list stays visible in `hud.ts`, property order does
  not change, and each delegation is checked against `Hud` where it is written.
- **The container is the host's.** The container `<div>` stays in the template, with its role,
  tabindex, label and hidden class (rule 3). So hud.ts looks the container up, builds its
  `Surface` as it does today (3398), and passes that surface to the factory.
- **An opener in another surface's markup is passed in.** The Main Menu's Customize button is
  shown and hidden by `setState` (7631), so hud.ts looks it up and keeps that toggle. The pane
  wires the opener's click and removes that listener in `dispose`.
  - One design keeps the opener's handler in `hud.ts` until a Main Menu pane exists. That is
    also consistent. This spec gives the handler to the pane, because the layer it opens is the
    pane's.
- **Listener order on one element is preserved** when the pane adds the open handler, then
  `blurIfPointer`, as today. `customizeOpenBtn` carries exactly those two listeners at `43adf28`:
  it is named at 2522, 5028, 5487, 5488, 7631, 8374 and 8375. Registering earlier in construction
  does not reorder dispatch, because listeners on different elements fire by propagation path.

### Rule 3: Where markup lives *(ruled 2026-09-17: the recommended option)*

**Ruled: the pane's body moves with the pane as an exported string. The container line stays
in the one template. hud.ts interpolates the body at its exact position, so the string assigned
to `el.innerHTML` is identical character for character, and one parse produces the DOM.**

```ts
// hud.ts template, where lines 1926-1986 are today:
<div class="hud-customize hud-customize--hidden" role="region" tabindex="-1" aria-labelledby="hud-customize-title">${CUSTOMIZE_BODY}</div>
```

- **The body** is every character between the `>` that ends line 1926 and the `</div>` on line
  1986: newlines, indentation and HTML comments included. The HTML comments are DOM nodes. At
  `43adf28` it contains no backtick, no backslash and no `--hidden` class name.
- **The rotate icons move with it:** `rotateIcon` and the `ROTATE_*` constants at 1402-1436.
  Their only users are the four buttons at 1971-1974.
- **What keeping the container line buys:**
  - `a11y-panes-stop-being-landmarks`, whose `find` is that line, needs no re-pointing;
  - `hud-customize--hidden` is still written in `hud.ts`, so `hud.css.test.ts`'s scan at line
    775 sees what it saw;
  - `PANEL_FAMILY` and `activePanelContainer` keep naming a host element.
- **Why interpolation and not a second write:** the body was designed as a string the pane writes
  into its container at construction, and the judges rejected that. A second parse is a claim
  about parser equivalence that nobody measured. Interpolation leaves the string unchanged.
- **One obligation first.** `hud.css.test.ts` line 775 collects `*--hidden` names only from
  `hud.ts`. It must also read every pane module, with a planted-class negative control, before
  any pane whose body writes a `--hidden` class is extracted. Versus Setup's body writes
  `hud-versus-mode-note--hidden`. Customize's writes none, so its PR may widen the scan or leave
  that to Versus Setup's PR. The spec recommends doing it in the first PR, while it is cheap.
- **The rejected alternative:** the whole fragment stays in the template, and the
  pane scopes its lookups to the container it receives. This is the smallest step, and one design
  argued for it. It leaves Customize's markup in `hud.ts`, which is the half-extraction #755 and
  #759 already did.

### Rule 4: The three cross-pane couplings *(each ruled 2026-09-17: the recommended option)*

1. **Detected pads.** Versus Setup reads Controllers' `currentDetectedPads` and
   `slotSourceLabel`, and `setDetectedPads` (8107) repaints both panes.
   - **Ruled (two of three designs proposed it):** the pad list stays a host binding, because a `Hud` member
     writes it. Both panes read it through `detectedPads()`.
   - `setDetectedPads` repaints Controllers, then Versus Setup, in today's order.
   - `slotSourceLabel` becomes a pure `(source, pads)` function in a small shared module that both
     panes import. Its only closure read is `currentDetectedPads`, at 4140. **(all three)**
   - **The rejected third design:** Controllers owns the list and exposes a feed that Versus Setup subscribes
     to. That makes the dependency explicit, but it makes one pane depend on another.
2. **Armed confirmation.** This is `armedReset`, `disarmReset` (3726), `handleDangerClick` (3740)
   and `restingLabel` (3642).
   - **Ruled (all three designs proposed it):** it is host-owned, because the core disarms from `showStats` (3773),
     `openLayer` (4925) and `setState` (7414).
   - Settings, Records and Developer Tools receive `arm(button, restingLabel, callbacks)` and
     `disarm()`.
   - **`restingLabel` inverts.** The caller supplies the label when it arms, so the core stops
     naming five buttons from three panes. Do this in the first PR that extracts one of those
     three panes.
3. **Input modality.**
   - **Ruled (all three designs proposed it):** `currentModality` stays shared, and Settings receives
     `modality(): Modality`.
   - `Modality` comes from the leaf module `modality.ts`.

### Rule 5: How the guards keep working

- **The types stay where they are.** `Hud`, `HudFrameKey`, `RouteHudKey`, `GameplayHudKey`,
  `HudLayerId` and `HudSurface` stay in `hud.ts`. `hud-ownership.test.ts` reads its fixed
  `./hud.ts` glob key, and nothing it scans moves.
- **An extraction does not change that test's counts** of 88 role entries and 10 gameplay
  members. If a count changes, the PR changed the interface, and it is not a pure move.
- **A pane module imports nothing from `hud.ts`,** neither a type nor a value. It declares the
  member types it implements, as `customize-choices.ts` does. The first extraction PR adds the
  source-scan test from rule 1. The same scan asserts this, with a planted-import negative
  control.
- **Manifest entries** whose `find` text moves are re-pointed in the same PR. `find`, `replace`
  and `tests` stay unchanged unless the text itself changed. The shipped-manifest test in
  `verify:quick` already fails an entry whose `find` no longer occurs exactly once. A
  re-pointed entry stays reachable while its `tests` construct `createHud`, because `hud.ts`
  imports the pane module. `npm run mutate -- --only` confirms it.

### Rule 6: How a pane module is tested

**The module test builds its DOM from the pane's own body constant inside a container, and
drives it through a recording host.**
- `enterSurface` and `closeSurface` toggle the hidden class and run `onBegin` synchronously.
- `open` and `back` record their calls.
- Building from the constant, not from hand-written markup, means the fixture cannot drift
  from the classes the pane actually uses.

**What the module test owns:**
- open and close callbacks fire once per real transition;
- `release` fires only when the pane is open;
- the exported handles, such as `previewCanvas` and the rotate buttons;
- `dispose` removes every listener the pane added.

**What stays tested through `createHud` and is not rewritten:**
- the transition runner;
- one surface at a time;
- layer replace and release sequencing;
- `setState`'s instant close and its order;
- focus restoration;
- the navigation-key exception.

**A new module case must close a proven gap.** Before adding the case, run a mutation of the
pane module that survives the existing `createHud` tests, as #755's table did. The recording
host is test scaffolding, not the subject: if a behaviour's correctness depends on the real
host, its assertion stays in a `createHud` test.

## 3. First application: the rest of Customize

**Why Customize first:**
- it has the fewest outside values (8);
- it has no cross-pane coupling;
- it has no write across its boundary, with or without the new corrections;
- no manifest entry names text inside its owners. Two name its markup and its layer row, and both
  are placed in the shared owners.

**The 8 outside values, measured, and what each becomes:**

| Outside value at `43adf28` | Under the seam |
| --- | --- |
| `swapSurface` and `openSurface`, used together at 3796 | host `enterSurface` |
| `closeSurface`, `isSurfaceOpen`, `back` | host members of the same names |
| `openLayer` | host `open`, bound to `'customize'` |
| `blurIfPointer` | imported from module scope |
| `el` | not needed: the pane queries inside the surface it receives |

**The hand-in:**
- a `CustomizeHost` of 5 members: `enterSurface`, `closeSurface`, `isSurfaceOpen`, `open` and
  `back`;
- `surface`, the host's `CUSTOMIZE_SURFACE`;
- `opener`, the Main Menu button;
- the `Surface` type, from `pane-host.ts`.

```ts
// src/game/customize-pane.ts
export type CustomizeHost = Pick<
  PaneHost,
  'enterSurface' | 'closeSurface' | 'isSurfaceOpen' | 'open' | 'back'
>;

export const CUSTOMIZE_BODY: string; // hud.ts 1926-1986, between the container's tags, verbatim

export interface CustomizePane extends CustomizeChoices {
  readonly previewCanvas: HTMLCanvasElement;
  readonly previewRotateButtons: readonly HTMLButtonElement[];
  onCustomizeOpen(cb: () => void): void;
  onCustomizeClose(cb: () => void): void;
  show(show: boolean, instant?: boolean): void;
  release(): void;
  dispose(): void;
}

export function createCustomizePane(
  host: CustomizeHost,
  surface: Surface,
  opener: HTMLButtonElement,
): CustomizePane;
```

**What moves out of `hud.ts`** (line numbers at `43adf28`):
- the body inside the container, 1927-1985, and the rotate icons, 1402-1436;
- the lookups inside the pane, 2524-2530 and `skinsRow` (2792). The container (2523) and opener
  (2522) lookups stay.
- the `renderCustomizeChoices` call, 2796-2800. `customize-choices.ts` and its tests are
  unchanged.
- `customizeOpenCbs` and `customizeCloseCbs`, 2806-2807;
- `showCustomize`, 3791-3810;
- the body of the `LAYERS.customize` release, 4701-4707;
- `handleCustomizeOpen` and `handleCustomizeBack`, 5027-5032;
- the listener wiring, 5487-5490, and its removal in `dispose`, 8374-8377.

**What stays:**
- the container line in the template, and `CUSTOMIZE_SURFACE` (3398);
- the opener lookup and its `setState` toggle (7631);
- the rule 2 table's entries, naming the pane's exports;
- the ten `Hud` members, delegating;
- the `Hud` interface and the key unions.

**Manifest entries to re-point: 1** of the 201 that name `hud.ts`.
- `a-replaced-customize-pane-keeps-its-webgl-context`: its `find` is the release guard at 4706,
  which moves into the pane.
- `a11y-panes-stop-being-landmarks` stays, because its `find` is the container line.
- At `43adf28`, these are the only two entries whose `find` names a Customize identifier or falls
  in the fragment or icon lines.

**A stale comment moves with the body.** The rotate-cluster comment (1958) says the four buttons
are "pinned in hud.test.ts". No such file exists, and the pin is in `hud.controls.test.ts`.
Correcting that comment changes the body's text, so the PR corrects it in a separate commit,
after the byte-identity proof has been taken.

**An obligation this spec could not discharge by reading.** The `renderCustomizeChoices` call
moves from 2796 to the factory's call site. The PR must show that nothing between those two
lines reads the pane's subtree during construction. For example, a focus list or
`equalizeMenuRows` measuring the rows would see an empty row today and a filled one after. The
proof below would catch a visible difference, but the PR should name what it checked.

## 4. Proving no behaviour change

#556's last criterion asks for proof the way #551 gave it: byte-identical captures of every
surface at every supported layout. The first extraction PR gives three pieces of evidence, and
states its claim no wider than they reach.

1. **A DOM serialization, not committed, as #755 did it.** Serialize `createHud`'s DOM on the
   base commit and on the head commit, and compare the two files with `cmp`. Take it at each of
   these moments:
   - after construction;
   - after `setState('main-menu')`;
   - after `setHullColor`, `setSkin` and `setAccentColor`, then opening Customize;
   - after a pointer pick in each row;
   - after Back;
   - after reopening, then `setState('playing')`, which is the instant close at 7376;
   - after reopening, then `showVersusSetup(true)`, which is the release path at 4706.

   Record the open and close callback counts at the same moments. Also check
   `hud.previewCanvas === root.querySelector('.hud-customize .hud-preview')` on both commits.
   Not committing this keeps a baseline out of the repository; baselines belong to #326.
2. **The #766 sweep.** Build `dist` at the base commit and at the head commit, and capture every
   catalogue state at every layout in the matrix. Sweep the base build a second time as a
   control. Compare the base and head sweeps byte for byte. Report identical, different, missing
   and unstable pairs separately.
   - **The Customize preview is a live WebGL canvas.** If a control shows its states unstable,
     the PR says "screenshots equal outside the unstable states, which are listed", not
     "byte-identical".
3. **The gates:**
   - `npm run verify:quick` and `npm run verify:build`;
   - `npm run mutate -- --only` for the re-pointed entry and every new entry;
   - `npm run hud:closure -- --strict --pane Customize` at the base;
   - `hud-ownership.test.ts` still at 88 and 10.

## 5. Not decided here

- **`activePanelContainer` omits `galleryView`,** although `PANEL_FAMILY` includes
  `GALLERY_SURFACE`. An extraction preserves both lists as they are. Whether the difference
  is intended is a separate question.
- **The shared layer's own structure is out of scope.** It is 294 owners and 3031 lines under
  this attribution.
- **The `Hud` interface stays in `hud.ts`.** Moving it would need `hud-ownership.test.ts`'s
  glob key changed, and nothing here needs that.
- **Remaining attribution gaps belong in the tool's data, not in this seam.** For example,
  `STAT_ROWS` is used by Records and by the ending tally, and it is attributed as shared.
