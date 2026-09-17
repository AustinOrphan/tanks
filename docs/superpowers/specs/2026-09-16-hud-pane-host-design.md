---
status: proposed
date: 2026-09-16
last-reviewed: 2026-09-16
scope: What an extracted HUD pane module receives from hud.ts, how it registers, where its markup lives, and how the first extraction proves no behaviour change
implementation-issues: [556, 765]
implementation-prs: []
supersedes: []
superseded-by: []
---

# The seam hud.ts hands to an extracted pane

**Proposed, 2026-09-16.** Issue #556 splits `src/game/hud.ts`. It asks for a design of what the
shared state becomes before any file is created. Issue #765 asks for that design as a spec
that a pane extraction can be built and reviewed against.

Four of the rules below need an owner ruling before this spec becomes `active`: the markup
rule (rule 3) and the three cross-pane couplings (rule 4). The other rules follow from
measurement and from the precedents in #755 and #759.

## 1. What this is measured against

Every figure here was measured with `npm run hud:closure`, the tool PR #768 checks in for
#767. The run is on that PR's head, where `hud.ts` is unchanged from `main` at `43adf28`. Until
#768 merges, treat the tables as candidate evidence.

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

### Rule 1: What a pane module receives

**A pane module exports one factory. It takes a typed host and the elements it cannot find by
itself, and never takes a `hud.ts` binding.**

```ts
// src/game/pane-host.ts -- a new leaf module. It imports nothing from hud.ts.
export interface Surface {
  readonly el: HTMLElement;
  readonly hidden: string;
}

export interface PaneHost {
  swapSurface(from: Surface, to: Surface, onBegin?: () => void, instant?: boolean): void;
  openSurface(): Surface;
  closeSurface(from: Surface, onBegin?: () => void, instant?: boolean): void;
  isSurfaceOpen(surface: Surface): boolean;
  /** Push THIS pane's layer. hud.ts binds the layer id, so the pane never names one. */
  open(opener: HTMLElement | null): boolean;
  back(): boolean;
  captureFocus(container: HTMLElement): () => void;
}
```

- **Each pane declares its own `Pick<PaneHost, ...>`,** such as `CustomizeHost`. The factory
  takes that type, so the compiler rejects a call to a host function the pane did not declare.
  The key list of the `Pick` is the pane's shared-state cost, and a reviewer reads it in one
  line.
- **Host functions are the closure's own navigation functions, passed by reference.** They are
  function declarations, which are hoisted. That is why the factory can run where the pane's
  element lookups run today, before `PANEL_FAMILY` is built.
- **A factory does not navigate during construction.** Host functions read `transitions` and
  `PANEL_FAMILY`, which do not exist yet at that point.
- **`open` is bound per pane:** hud.ts passes `(opener) => openLayer('customize', opener)`.
  This keeps `HudLayerId` out of the pane module and keeps the module graph acyclic.
- **A value a pane needs from shared state arrives as an accessor.** The accessor returns a
  plain value in the pane's own vocabulary, never the binding. For example, Controllers gets
  `isPaused(): boolean` rather than `shownState`.
- **A pane owns every binding it writes.** At the extraction PR's base, `npm run hud:closure --
  --strict --pane <pane>` must exit 0 for the pane being moved. At `43adf28` it exits 0 for
  Customize. If a pane-named owner writes a shared binding, the writer stays in `hud.ts` with
  its binding.
- **Closure-free helpers are imported, not handed in.** `blurIfPointer` and `blurAfterDrag`
  (`hud.ts` 4630 and 4633) read nothing from the closure. They move to module scope in the
  first PR that needs them, and `hud.ts` imports them under the same names. No manifest entry
  pins either one.
- **`el` is not handed in.** hud.ts looks up the pane's root after the template is written,
  and passes the root.

**Why this shape:** #556 warns that splitting panes into files, when each file still reaches
into one shared mutable scope, is worse than the status quo. A `Pick` over a host with no
bindings makes that reach impossible to write. It also turns the account's "navigation core"
list into a type the compiler checks.

### Rule 2: How a pane registers

**hud.ts keeps every shared table, its key set and its order. The table's entry for the pane
names the pane's exports.**

| Shared owner | Today | After extraction |
| --- | --- | --- |
| `PANEL_FAMILY` (3425) | `CUSTOMIZE_SURFACE` | `customize.surface`, at the same index |
| `activePanelContainer` (4384) | `customizeView` | `customize.surface.el`, at the same index |
| `LAYERS.customize` (4697) | lambdas over `showCustomize` and an inline `release` | `open: () => customize.show(true)`, `close: () => customize.show(false)`, `release: customize.release` |
| `onNavKeyDown` (4576) | `e.target === previewCanvasEl` | `e.target === customize.previewCanvas` |
| `setState` (7376) | `showCustomize(false, true)` | `customize.show(false, true)`, at the same point in the ordered close |
| `dispose` (8374-8377) | four `removeEventListener` calls | `customize.dispose()`, at the same point |
| returned `Hud` object | ten members | ten explicit delegations, in the same order |

- **Why ordering stays central:** paint order (`PANEL_FAMILY`) and `setState`'s close order
  are properties of the whole set of panes, not of any one pane. The comment on
  `openSurface` (3610-3626) records what happens when a close is sourced from the wrong
  place: a Customize close once hid the Controllers pane. If panes self-registered, order
  would depend on call order spread across files.
- **Why members stay explicit:** the member list stays visible in `hud.ts`, property order
  does not change, and each delegation is checked against `Hud` where it is written.
- **An opener that lives in another surface's markup belongs to that surface.** The Main Menu's
  Customize button is shown and hidden by `setState` (7631). So hud.ts looks it up, keeps the
  toggle, and passes the element to the pane. The pane wires the opener's click and removes
  that listener in `dispose`.
- **Listener order on one element is preserved** when the pane adds the open handler and then
  `blurIfPointer`, in today's order. Registering earlier in construction does not reorder
  dispatch, because listeners on different elements fire by propagation path, not by
  registration time.

### Rule 3: Where markup lives *(needs an owner ruling)*

**Proposed: the fragment moves with the pane as an exported string constant. That constant is
interpolated into the one template at the fragment's current position, so the string assigned
to `el.innerHTML` is identical.**

- **Why:** a surface whose markup stays in another file is the half-extraction #755 and #759
  already did. #556 asks for a whole surface. Interpolating keeps the runtime string, and so
  the DOM, byte-identical. That can be checked rather than hoped.
- **Customize's fragment** is `hud.ts` 1926-1985. It uses `ROTATE_ICON`, which is built by
  `rotateIcon` and the `ROTATE_*` constants at 1402-1436. Customize is their only user, so
  they move with it.
- **HTML comments inside the fragment are DOM nodes,** so they move verbatim.
- **Obligations in the PR that moves the first fragment:**
  - `hud.css.test.ts` line 775 collects every `*--hidden` class written in `hud.ts`'s source.
    It must also read pane modules, with a named negative control: a pane module that writes
    an undeclared `--hidden` class fails the test.
  - Any other test that reads `hud.ts`'s raw source for a string that moves must read the pane
    module too. At `43adf28` the raw readers are `hud.css.test.ts` and `hud-ownership.test.ts`.
    The latter reads only the interface and unions, which do not move.
- **The alternative, if the owner prefers it:** the fragment stays in the template, and the pane
  receives its root. This is cheaper by one manifest entry and one test change. It leaves
  Customize split across two files.

### Rule 4: The three cross-pane couplings *(each needs an owner ruling)*

1. **Detected pads.** Today Versus Setup reads `currentDetectedPads` and `slotSourceLabel` from
   the Controllers code, and `setDetectedPads` (8107) repaints both panes.
   - **Proposed:** the pad list stays shared in `hud.ts`, because the page pushes it through a
     `Hud` member.
   - Both panes receive `detectedPads(): readonly DetectedPad[]`.
   - `slotSourceLabel` becomes a pure helper that takes the pad list as an argument.
   - `setDetectedPads` calls each pane's repaint.
   - **Why:** neither pane is the source of the list. If Versus imported from Controllers, pane
     modules would depend on each other.
2. **Armed confirmation.** This is `armedReset`, `disarmReset` (3726), `handleDangerClick`
   (3740) and `restingLabel` (3660).
   - **Proposed:** it is navigation core, because `openLayer` and `setState` both disarm. It
     stays in `hud.ts`.
   - Settings, Records and Developer Tools receive `arm(button, restingLabel, callbacks)` and
     `disarm()`.
   - **`restingLabel` inverts.** The caller supplies the label when it arms, so the core stops
     naming five buttons from three panes. Do this in the first PR that extracts one of those
     three panes.
3. **Input modality.**
   - **Proposed:** `currentModality` stays shared, and Settings receives
     `modality(): Modality`.
   - `Modality` comes from the leaf module `modality.ts`, so this adds no cycle.

### Rule 5: How the guards keep working

- **The types stay where they are.** `Hud`, `HudFrameKey`, `RouteHudKey`, `GameplayHudKey`,
  `HudLayerId` and `HudSurface` stay in `hud.ts`. `hud-ownership.test.ts` reads its fixed
  `./hud.ts` glob key, and nothing it scans moves.
- **An extraction does not change the guard's counts** of 88 role entries and 10 gameplay
  members. If a count changes, the PR changed the interface, and it is not a pure move.
- **A pane module imports nothing from `hud.ts`,** neither type nor value. It declares its own
  member interface, as `customize-choices.ts` does. The first extraction PR adds a source-scan
  test for this, with a planted-import negative control. The test sits beside the existing
  import scans in `hud-ownership.test.ts` or `dependency-direction.test.ts`.
- **Manifest entries** whose `find` text moves are re-pointed in the same PR. The `find`,
  `replace` and `tests` stay unchanged unless the text itself changed. The shipped-manifest
  test in `verify:quick` already fails an entry whose `find` no longer occurs exactly once.

### Rule 6: How a pane module is tested

**The module test builds the pane's DOM from its own markup constant and drives it through a
recording host.**
- `swapSurface` and `closeSurface` toggle the hidden class and run `onBegin` synchronously.
- `open` and `back` record their calls.

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
pane module that survives the existing `createHud` tests. This is the procedure in #755's
table. The recording host is test scaffolding, not the subject: if a behaviour's correctness
depends on the real host, its assertion stays in a `createHud` test.

## 3. First application: the rest of Customize

**Why Customize first:**
- it has the fewest outside values (8);
- it has no cross-pane coupling;
- it has no write across its boundary under either attribution;
- 2 manifest entries pin its remainder.

**The 8 outside values, measured, and what each becomes:**

| Outside value at `43adf28` | Under the seam |
| --- | --- |
| `swapSurface`, `openSurface`, `closeSurface`, `isSurfaceOpen` | host functions |
| `back` | host function |
| `openLayer` | host `open`, bound to `'customize'` |
| `blurIfPointer` | imported from module scope |
| `el` | replaced by the pane root that hud.ts passes |

**The hand-in:**
- a `CustomizeHost` of 6 host functions: `swapSurface`, `openSurface`, `closeSurface`,
  `isSurfaceOpen`, `open` and `back`;
- 2 elements: the pane root and the Main Menu opener;
- the `Surface` type, from `pane-host.ts`.

```ts
// src/game/customize-pane.ts
export type CustomizeHost = Pick<
  PaneHost,
  'swapSurface' | 'openSurface' | 'closeSurface' | 'isSurfaceOpen' | 'open' | 'back'
>;

export const CUSTOMIZE_MARKUP: string; // hud.ts 1926-1985, verbatim

export interface CustomizePane extends CustomizeChoices {
  readonly surface: Surface;
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
  dom: { readonly root: HTMLElement; readonly opener: HTMLButtonElement },
): CustomizePane;
```

**What moves out of `hud.ts`** (line numbers at `43adf28`):
- the fragment, 1926-1985, and the rotate icons, 1402-1436;
- the pane's element lookups (2523-2530) and `skinsRow` (2792). The opener's lookup at 2522
  stays.
- the `renderCustomizeChoices` call, 2796-2800. `customize-choices.ts` and its tests are
  unchanged.
- `customizeOpenCbs` and `customizeCloseCbs`, 2806-2807;
- `CUSTOMIZE_SURFACE`, 3398;
- `showCustomize`, 3791-3810;
- the body of the `LAYERS.customize` release, 4701-4707;
- `handleCustomizeOpen` and `handleCustomizeBack`, 5027-5032;
- the listener wiring, 5487-5490, and its removal in `dispose`, 8374-8377.

**What stays:**
- the opener lookup and its `setState` toggle (7631);
- the six shared owners of rule 2, each naming the pane's exports;
- the ten `Hud` members, delegating;
- the `Hud` interface and the key unions.

**Manifest entries to re-point:** 2 of the 201 that name `hud.ts`. At `43adf28`, these are the
only entries whose `find` names a Customize identifier or falls in the fragment or icon lines.
- `a-replaced-customize-pane-keeps-its-webgl-context`: its `find` is the release guard at 4706.
- `a11y-panes-stop-being-landmarks`: its `find` is the fragment's opening tag at 1926.

**An obligation this spec could not discharge by reading.** The `renderCustomizeChoices` call
moves from 2796 to the factory's call site, near 2530. The PR must show that nothing between
those two lines reads the pane's subtree during construction. For example, a focus list or
`equalizeMenuRows` measuring the rows would see an empty row today and a filled one after.
The byte-identity proof below would catch a visible difference, but the PR should name what it
checked.

## 4. Proving no behaviour change

#556's last criterion asks for proof the way #551 gave it: byte-identical captures of every
surface at every supported layout. The first extraction PR gives three pieces of evidence.

1. **A DOM serialization, not committed, as #755 did it.** Serialize `createHud`'s DOM at
   construction, then after opening and closing Customize and each other pane. Do this on the
   base commit and on the head commit, and compare the two files with `cmp`. Not committing it
   keeps a baseline out of the repository; baselines belong to #326.
2. **The #766 sweep.** Build `dist` at the base commit and at the head commit, and capture every
   catalogue state at every layout in the matrix. Compare byte for byte. Report identical,
   different, missing and unstable pairs separately. Run a same-build control, so an unstable
   pair is not read as a regression.
3. **The gates:**
   - `npm run verify:quick` and `npm run verify:build`;
   - `npm run mutate -- --only` for the re-pointed entries and every new entry;
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
