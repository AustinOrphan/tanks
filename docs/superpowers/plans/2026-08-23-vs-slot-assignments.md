---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Per-slot source assignment carried in VersusConfig from the setup pane through Start into the new session, with bot offering and Start-gating validation
implementation-issues: [260]
implementation-prs: []
supersedes: []
superseded-by: []
---
# VS slot assignments through Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The setup pane's who's-playing rows edit a pane-owned per-slot assignment that
Start hands, inside `VersusConfig`, to the new session — so a chosen Bot slot actually
reaches the match it configures, Bot is offerable before any versus session has run, and
an invalid assignment (inert required slots) cannot Start.

**Architecture:** `VersusConfig` gains a required `slots: SlotSource[]` (per-slot source,
length === `players` — the owner-recorded canonical model on issue #260). The pane owns
and edits its own copy via the existing `reassign` machinery; Start snapshots it into the
config; `applyVersusToDeps` structurally validates it at the Start boundary;
`startGameWith` seeds the session `Assignment` from it instead of
`deriveInitialAssignment` whenever a pane-started config is present. Start is disabled,
with a visible reason, while pure validation helpers report structural or readiness
problems.

**Tech Stack:** TypeScript, Vitest, existing HUD DOM machinery. No `src/sim/` changes, no
new persistence, no new dev flags.

**Spec:** issue #260 (defect + acceptance criteria + owner configuration ruling), issue
#261 (binding owner decision: validation must gate Start; direct-start depends on this
plan), `docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md` (pane reuses the
Controllers row machinery incl. bot/none per slot; "Changing Players … re-derives slot
rows; selections persist").

## Global Constraints

- `src/sim/` untouched; this is `src/game/` + `src/input/` work only. `BASELINE_HASH`
  must not change.
- No persistence: assignment stays session-only (owner ruling "no seventh store", same
  posture as controller assignment). `VersusConfig` remains unpersisted.
- Simulation-authoritative one-way flow is unaffected — everything here is game-layer
  configuration threading.
- The Controllers panel's campaign behavior is unchanged: `botAssignmentAllowed` still
  gates the OFFER there and `reassignSlot` still enforces it; the versus PANE offers Bot
  unconditionally because the config it edits is always an `ffa`/`teams` match
  (`botAssignmentAllowed` is true for every non-campaign mode by definition).
- Dev-flag precedence (issue AC "explicit, deterministic"): a pane-started session
  (`deps.initialVersusConfig` set) seeds its assignment from `config.slots`, and
  `devFlags.bots` is NOT consulted for it; a dev-flag versus session with no pane config
  (`?dev=1&mode=ffa…`, `initialVersusConfig` absent) keeps today's
  `deriveInitialAssignment(playerCount, botSlots)` path unchanged. Documented at the
  `startGameWith` read site, proven by tests in both directions.
- Every new assertion gets a named negative control; new behavior gets manifest
  mutations proven killed (`.claude/rules/testing.md`).
- Out of scope (do not build): team selection (#281, owner-flagged), per-player caps
  (#268, owner-flagged), the direct-start/Quit lifecycle (#261), bot difficulty (#267),
  gamepad hotplug listeners while the pane is open (residual — pads are refreshed at
  each pane open), writing mid-match Controllers-panel reassignments back into the
  retained config (residual), rejecting an all-bot config (residual for owner ruling).

## File map

- `src/input/assignment.ts` — add three pure helpers: `defaultVersusSlots`,
  `versusSlotStructureProblems`, `versusSlotReadinessProblems`.
- `src/input/assignment.test.ts` — their tests.
- `src/game/versus-config.ts` — `VersusConfig` gains required `slots: SlotSource[]`.
- `src/game/loop.ts` — Start-boundary structural validation in `applyVersusToDeps`;
  `startGameWith` assignment seeding precedence; pad refresh on the two
  `showVersusSetup(true, …)` call sites.
- `src/game/hud.ts` — pane-local slot editing (always interactive, never the running
  session), Bot offered unconditionally in the pane, Start disabled+reason, players
  resize, deep-copied snapshots, untouched-defaults-follow-hardware.
- `src/game/hud.css` — Start-note style + disabled Start signal.
- Tests swept for the new required field: `versus-config.test.ts`, `loop.test.ts`,
  `levels.test.ts`, `hud.test.ts`, `boot.test.ts` (fixture literals gain `slots`).
- `tools/mutate/manifest.json` — new mutation entries (Task 5).
- `docs/superpowers/backlog/spike-versus-mode-rest.md` — narrow item 5's #260 residual
  text in the same PR (repo rule).

---

### Task 1: Pure assignment helpers

**Files:**
- Modify: `src/input/assignment.ts` (append after `botAssignmentAllowed`)
- Test: `src/input/assignment.test.ts`

**Interfaces:**
- Consumes: existing `SlotSource`, `Assignment` types in the same file.
- Produces (exact signatures later tasks import):
  - `defaultVersusSlots(players: number, detectedPadIndices: ReadonlySet<number>): Assignment`
  - `versusSlotStructureProblems(slots: readonly SlotSource[], players: number): string[]`
  - `versusSlotReadinessProblems(slots: readonly SlotSource[], detectedPadIndices: ReadonlySet<number>): string[]`

- [ ] **Step 1: Write the failing tests** in `src/input/assignment.test.ts` (append a new
  `describe`; follow the file's existing style):

```ts
describe('defaultVersusSlots', () => {
  it('slot 0 is keyboard; a slot whose own pad index is detected gets that pad; others get a bot', () => {
    expect(defaultVersusSlots(3, new Set([1]))).toEqual([
      { kind: 'keyboard' },
      { kind: 'gamepad', padIndex: 1 },
      { kind: 'bot' },
    ]);
  });
  it('with no pads detected every non-P1 slot is a bot — the keyboard-only default is playable, never inert', () => {
    expect(defaultVersusSlots(4, new Set())).toEqual([
      { kind: 'keyboard' },
      { kind: 'bot' },
      { kind: 'bot' },
      { kind: 'bot' },
    ]);
  });
});

describe('versusSlotStructureProblems', () => {
  it('accepts a clean keyboard/pad/bot assignment', () => {
    expect(
      versusSlotStructureProblems(
        [{ kind: 'keyboard' }, { kind: 'gamepad', padIndex: 1 }, { kind: 'bot' }],
        3,
      ),
    ).toEqual([]);
  });
  it('reports a length/players mismatch and stops there (per-slot checks would misindex)', () => {
    expect(versusSlotStructureProblems([{ kind: 'keyboard' }], 2)).toEqual([
      'config carries 1 slot(s) for 2 players',
    ]);
  });
  it('reports keyboard claimed twice', () => {
    expect(
      versusSlotStructureProblems([{ kind: 'keyboard' }, { kind: 'keyboard' }], 2),
    ).toEqual(['Keyboard is assigned to more than one player']);
  });
  it('reports one pad claimed by two slots, naming the pad', () => {
    expect(
      versusSlotStructureProblems(
        [{ kind: 'gamepad', padIndex: 0 }, { kind: 'gamepad', padIndex: 0 }],
        2,
      ),
    ).toEqual(['Controller 1 is assigned to more than one player']);
  });
});

describe('versusSlotReadinessProblems', () => {
  it('accepts keyboard + connected pad + bot', () => {
    expect(
      versusSlotReadinessProblems(
        [{ kind: 'keyboard' }, { kind: 'gamepad', padIndex: 1 }, { kind: 'bot' }],
        new Set([1]),
      ),
    ).toEqual([]);
  });
  it("reports a 'none' slot by player number", () => {
    expect(
      versusSlotReadinessProblems([{ kind: 'keyboard' }, { kind: 'none' }], new Set()),
    ).toEqual(['Player 2 has no controls']);
  });
  it('reports a gamepad slot whose pad is not currently detected', () => {
    expect(
      versusSlotReadinessProblems(
        [{ kind: 'keyboard' }, { kind: 'gamepad', padIndex: 1 }],
        new Set(),
      ),
    ).toEqual(["Player 2's controller is disconnected"]);
  });
});
```

- [ ] **Step 2: Run to verify they fail** —
  `npx vitest run src/input/assignment.test.ts` → FAIL (helpers not exported).

- [ ] **Step 3: Implement** in `src/input/assignment.ts` (doc comments in the file's
  voice; state that pad-index==slot-index mirrors `deriveInitialAssignment`'s
  `pad[i] -> slot[i]` rule, and that the bot fallback is what makes the keyboard-only
  default playable — issue #260's third defect):

```ts
export function defaultVersusSlots(
  players: number,
  detectedPadIndices: ReadonlySet<number>,
): Assignment {
  const out: Assignment = [];
  for (let i = 0; i < players; i++) {
    if (i === 0) out.push({ kind: 'keyboard' });
    else if (detectedPadIndices.has(i)) out.push({ kind: 'gamepad', padIndex: i });
    else out.push({ kind: 'bot' });
  }
  return out;
}

export function versusSlotStructureProblems(
  slots: readonly SlotSource[],
  players: number,
): string[] {
  if (slots.length !== players) {
    return [`config carries ${slots.length} slot(s) for ${players} players`];
  }
  const problems: string[] = [];
  let keyboardClaims = 0;
  const padClaims = new Map<number, number>();
  for (const s of slots) {
    if (s.kind === 'keyboard') keyboardClaims++;
    if (s.kind === 'gamepad') padClaims.set(s.padIndex, (padClaims.get(s.padIndex) ?? 0) + 1);
  }
  if (keyboardClaims > 1) problems.push('Keyboard is assigned to more than one player');
  for (const [padIndex, claims] of padClaims) {
    if (claims > 1) problems.push(`Controller ${padIndex + 1} is assigned to more than one player`);
  }
  return problems;
}

export function versusSlotReadinessProblems(
  slots: readonly SlotSource[],
  detectedPadIndices: ReadonlySet<number>,
): string[] {
  const problems: string[] = [];
  slots.forEach((s, i) => {
    if (s.kind === 'none') problems.push(`Player ${i + 1} has no controls`);
    if (s.kind === 'gamepad' && !detectedPadIndices.has(s.padIndex)) {
      problems.push(`Player ${i + 1}'s controller is disconnected`);
    }
  });
  return problems;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/input/assignment.test.ts`.
- [ ] **Step 5: Commit** — `vs-slots: pure default/structure/readiness helpers for per-slot config`.

---

### Task 2: `VersusConfig.slots` (required) + consumer sweep

**Files:**
- Modify: `src/game/versus-config.ts`
- Modify (compile sweep — every `VersusConfig` literal gains `slots`):
  `src/game/versus-config.test.ts`, `src/game/levels.test.ts`, `src/game/loop.test.ts`,
  `src/game/hud.test.ts`, `src/boot.test.ts`, and `src/game/hud.ts`'s
  `versusConfigState` initializer (minimal compile fix here; Task 4 owns the real HUD
  behavior).

**Interfaces:**
- Produces: `VersusConfig.slots: SlotSource[]` — required; length === `players`;
  treated immutably by every reader (copies happen at the hud Start snapshot and the
  `startGameWith` seeding, Tasks 3–4).

- [ ] **Step 1: Widen the type** in `src/game/versus-config.ts`:

```ts
import type { SlotSource } from '../input/assignment';
// … inside VersusConfig:
  /**
   * Per-slot input source for every active slot, length === `players` — issue #260's
   * owner-recorded canonical model (per-slot sources, not a bot count; a bot count is
   * derivable from it). Session-only like the rest of this config. Structurally
   * validated (length, keyboard/pad exclusivity) at the Start boundary by
   * `applyVersusToDeps` (loop.ts); READINESS (no 'none' slots, pads actually
   * connected) is the setup pane's Start gate (hud.ts), not enforced here — hardware
   * can change between click and boot, and a disconnected pad slot is already a
   * recoverable state in-session (reclaim via pause → Controllers).
   * `resolveVersusConfig`'s shallow copy shares this array by reference; every owner
   * treats it immutably.
   */
  slots: SlotSource[];
```

- [ ] **Step 2: Run typecheck to enumerate the sweep** — `npx tsc --noEmit` (via
  `npm run verify:quick`'s typecheck half). Every error is a literal to update.
- [ ] **Step 3: Sweep the literals.** In test fixtures, prefer an explicit array when
  the test's behavior touches slots, else
  `slots: defaultVersusSlots(<players>, new Set())` (import from
  `../input/assignment`). In `src/game/hud.ts`, set the initializer to
  `slots: defaultVersusSlots(2, new Set())` (matches its `players: 2`). Do NOT change
  any behavior in this task — reads of `config.slots` come in Tasks 3–4.
- [ ] **Step 4: Run** `npm run verify:quick` → green (type sweep complete, no behavior
  change so the whole suite must stay green).
- [ ] **Step 5: Commit** — `vs-slots: VersusConfig carries a required per-slot source array`.

---

### Task 3: Start-boundary validation + session seeding in loop.ts

**Files:**
- Modify: `src/game/loop.ts` (`applyVersusToDeps` ~:706; `startGameWith`'s
  `assignment` init ~:809; `hud.onVersusOpen` ~:1561 and the match-end
  `hud.showVersusSetup(true, …)` site ~:1542)
- Test: `src/game/loop.test.ts`

**Interfaces:**
- Consumes: `versusSlotStructureProblems`, `defaultVersusSlots` (Task 1),
  `config.slots` (Task 2).
- Produces: the seeding precedence later tests and the manifest mutation target:
  `deps.initialVersusConfig?.slots` wins; `deriveInitialAssignment` remains the
  no-pane-config path.

- [ ] **Step 1: Write the failing tests** in `src/game/loop.test.ts`, using the file's
  existing versus-boot harness (the tests around `applyVersusToDeps` /
  `initialVersusConfig`). Follow existing fixture helpers; the assertions that matter:

```ts
it('a pane-started session seeds its assignment from config.slots, not deriveInitialAssignment', () => {
  // boot with initialVersusConfig whose slots are [keyboard, bot]
  // (players: 2, devFlags.bots null — the issue #260 rematch defect shape)
  // assert the hud stub's setControllers received [{kind:'keyboard'},{kind:'bot'}] at boot
});

it('config.slots wins over the bots dev flag (explicit precedence, pane direction)', () => {
  // devFlags.bots = 1 (botSlots would claim the last slot) AND initialVersusConfig
  // with slots [keyboard, gamepad 1] — assert setControllers shows NO bot slot.
});

it('a dev-flag versus session with no pane config keeps the derive path (precedence, flag direction)', () => {
  // devFlags mode 'ffa', players 2, bots 1, initialVersusConfig absent —
  // assert setControllers shows [keyboard, bot] exactly as today (negative control:
  // this test must FAIL if the derive fallback is deleted).
});

it('the seeded assignment copies each SlotSource — mutating the config after boot cannot move a slot', () => {
  // boot from config.slots, then mutate the passed config.slots[1].kind;
  // assert the session assignment (via setControllers) is unchanged.
});

it('applyVersusToDeps throws on a slots/players length mismatch', () => {
  // config players 3, slots length 2 → expect throw naming the problem
});

it('applyVersusToDeps throws when two slots claim one pad', () => {
  // slots [gamepad 0, gamepad 0] → expect throw
});

it('opening the versus pane refreshes the detected-pad list first', () => {
  // stub readDetectedPads to return one pad; fire hud.onVersusOpen's callback;
  // assert hud.setDetectedPads received that pad list BEFORE showVersusSetup ran
  // (order matters: the pane's untouched-default derivation reads it — Task 4).
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/game/loop.test.ts`.
- [ ] **Step 3: Implement** in `src/game/loop.ts`:

In `applyVersusToDeps`, first thing in the versus branch (fail fast, same loud-backstop
posture as `resolveVersusConfig`'s own throws — unreachable from the shipped pane, which
gates Start on the same predicate):

```ts
const structure = versusSlotStructureProblems(config.slots, config.players);
if (structure.length > 0) {
  throw new Error(`versus-config: invalid slots: ${structure.join('; ')}`);
}
```

In `startGameWith`, replace the `assignment` initializer (keep the existing doc comment
and extend it with the precedence rule):

```ts
/**
 * Precedence (issue #260, explicit and deterministic): a pane-started versus session
 * (`initialVersusConfig` set) is seeded from the config's OWN per-slot sources — the
 * `bots` dev flag is not consulted for it. Every other session (campaign, and
 * dev-flag-driven versus with no pane config) keeps the derived default. Each
 * SlotSource is copied: the config snapshot must not share slot objects with the
 * session's mutable assignment.
 */
const configSlots = deps.initialVersusConfig?.slots;
let assignment: Assignment = configSlots
  ? configSlots.map((s): SlotSource => ({ ...s }))
  : deriveInitialAssignment(playerCount, botSlots);
```

(`configSlots.length === playerCount` holds by construction: `playerCount` reads
`devFlags.players`, which `applyVersusToDeps` set from the same `config.players` it
validated the slots against.)

At BOTH `showVersusSetup(true, …)` call sites (`hud.onVersusOpen`'s subscriber and the
match-end return-to-setup path), add one line before the show call:

```ts
hud.setDetectedPads(deps.readDetectedPads());
```

- [ ] **Step 4: Run** `npx vitest run src/game/loop.test.ts`, then
  `npm run verify:quick` → green.
- [ ] **Step 5: Commit** — `vs-slots: Start-boundary structure gate; session assignment seeded from config slots`.

---

### Task 4: Pane-local slot editing, Bot offering, Start gate (hud.ts + css)

**Files:**
- Modify: `src/game/hud.ts` (`renderControllerRowsInto` ~:1405, `renderControllerRows`
  ~:1465, `renderVersusControllerRows` ~:2048, `versusConfigState` ~:1937, players
  option handler ~:2085, `handleVersusStart` ~:2128, `showVersusSetup` ~:2175, the
  versus-pane note element)
- Modify: `src/game/hud.css` (start note + disabled Start signal)
- Test: `src/game/hud.test.ts` (and `hud.css.test.ts` if its structural guards
  enumerate pane classes — check before editing)

**Interfaces:**
- Consumes: `reassign`, `defaultVersusSlots`, `versusSlotStructureProblems`,
  `versusSlotReadinessProblems` (Task 1; `hud.ts` must import `reassign`, which it does
  not today), `versusConfigState.slots` (Task 2).
- Produces: `renderControllerRowsInto(container, assignment, onPick, offerBot)` where
  `onPick: ((slot: number, source: SlotSource) => void) | null` (null = disabled
  preview) and `offerBot: boolean` replaces the closure read of
  `botAssignmentAllowedNow`.

- [ ] **Step 1: Write the failing tests** in `src/game/hud.test.ts` (existing DOM-test
  idioms; each bullet is one `it`, with the named negative control where shown):

```ts
// 1. First-time bot offering (issue defect 2): with setBotAssignmentAllowed(false)
//    (a fresh campaign boot), the VERSUS pane's rows still offer a Bot candidate.
//    CONTRAST/negative control in the same test: the Controllers panel's rows do NOT.
// 2. Pane rows edit pane state, not the session: click Bot on pane slot 1 →
//    no onReassignSlot callback fires (spy stays uncalled), and the pane row now
//    shows Bot selected.
// 3. Session pushes don't clobber pane edits: after (2), call setControllers([...])
//    with a different assignment → pane slot 1 still shows Bot.
// 4. Start disabled with a reason when a slot is 'none': click None on slot 1 →
//    versus Start button disabled, note text 'Player 2 has no controls'.
//    Fixing the slot (click Bot) re-enables Start and hides the note.
// 5. Start disabled for a disconnected pad, live to setDetectedPads: prefill via
//    showVersusSetup(true, config with slots [keyboard, gamepad 1]) and no detected
//    pads → disabled, note "Player 2's controller is disconnected";
//    setDetectedPads([{padIndex: 1, …}]) → enabled.
// 6. Start snapshot carries the pane slots and does not alias them: subscribe
//    onVersusStart, make slot 1 Bot, click Start → received config.slots deep-equals
//    [keyboard, bot]; then mutate the RECEIVED slots array/objects and click Start
//    again → second snapshot unaffected (kills a shallow-copy regression).
// 7. A disabled Start never fires: with a 'none' slot, dispatch a click on the Start
//    button programmatically → onVersusStart subscriber not called.
// 8. Prefill preserves retained assignments (issue AC: returning to setup):
//    showVersusSetup(true, config with slots [keyboard, bot]) → rows render those
//    selections.
// 9. Untouched defaults follow hardware: with NO pane edits and setDetectedPads
//    ([pad 1]), showVersusSetup(true) (no initial) → slot 1 shows Controller 2
//    (pad-index==slot-index rule); negative control: after ANY pane row click,
//    reopening does not re-derive (the edited selection survives).
// 10. Players resize: edit slot 1 to Bot, then click Players 3 → slot 1 still Bot,
//     new slot 2 default-filled (bot with no pads). Collision guard: with slot 1
//     edited to gamepad 2 and pad 2 detected, growing to 3 players gives slot 2 a
//     BOT, not a second claim on pad 2.
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/game/hud.test.ts`.
- [ ] **Step 3: Implement** in `src/game/hud.ts`:

1. `renderControllerRowsInto(container, assignment, onPick, offerBot)`: candidates use
   `...(offerBot ? [{ kind: 'bot' } as SlotSource] : [])`; `if (onPick)` wires
   `btn.addEventListener('click', () => onPick(forSlot, candidate))`, else
   `btn.disabled = true`. `renderControllerRows()` passes
   `(slot, source) => { for (const cb of reassignSlotCbs) cb(slot, source); }` and
   `botAssignmentAllowedNow` — the Controllers panel is behaviorally unchanged.
2. Pane state: add `let versusSlotsEdited = false;` beside `versusConfigState`, and

```ts
function detectedPadIndexSet(): ReadonlySet<number> {
  return new Set(currentDetectedPads.map((p) => p.padIndex));
}

function renderVersusControllerRows(): void {
  renderControllerRowsInto(
    versusControllerRowsEl,
    versusConfigState.slots,
    (slot, source) => {
      versusSlotsEdited = true;
      versusConfigState = {
        ...versusConfigState,
        slots: reassign(versusConfigState.slots, slot, source),
      };
      renderVersusControllerRows();
    },
    // The pane configures an ffa/teams match: botAssignmentAllowed is true for every
    // non-campaign mode, so Bot is ALWAYS offerable here — independent of the RUNNING
    // session's botAssignmentAllowedNow (issue #260 defect 2: first-time setup from a
    // campaign boot must offer Bot).
    true,
  );
  renderVersusStartValidation();
}
```

   Delete the `matchesSession` preview logic and the old assignment-note handling; the
   old note element becomes (or is replaced by) `versusStartNoteEl`.
3. Start gate:

```ts
function renderVersusStartValidation(): void {
  const problems = [
    ...versusSlotStructureProblems(versusConfigState.slots, versusConfigState.players),
    ...versusSlotReadinessProblems(versusConfigState.slots, detectedPadIndexSet()),
  ];
  versusStartBtn.disabled = problems.length > 0;
  versusStartNoteEl.textContent = problems[0] ?? '';
  versusStartNoteEl.classList.toggle('hud-versus-start-note--hidden', problems.length === 0);
}
```

4. `handleVersusStart`: `if (versusStartBtn.disabled) return;` then snapshot with a
   deep-copied slots array:
   `cb({ ...versusConfigState, slots: versusConfigState.slots.map((s) => ({ ...s })) })`.
5. `showVersusSetup(true, initial)`: truthy `initial` →
   `versusConfigState = { ...initial, slots: initial.slots.map((s) => ({ ...s })) }; versusSlotsEdited = true;`
   else if `!versusSlotsEdited` →
   `versusConfigState = { ...versusConfigState, slots: defaultVersusSlots(versusConfigState.players, detectedPadIndexSet()) };`
   (defaults follow hardware until the player takes ownership of the rows).
6. Players option click handler: replace the bare `players` write with

```ts
const defaults = defaultVersusSlots(players, detectedPadIndexSet());
let slots: Assignment;
if (!versusSlotsEdited) {
  slots = defaults;
} else {
  slots = versusConfigState.slots.slice(0, players);
  const claimedPads = new Set(
    slots.filter((s): s is Extract<SlotSource, { kind: 'gamepad' }> => s.kind === 'gamepad')
      .map((s) => s.padIndex),
  );
  for (let i = slots.length; i < players; i++) {
    const d = defaults[i];
    slots.push(d.kind === 'gamepad' && claimedPads.has(d.padIndex) ? { kind: 'bot' } : d);
  }
}
versusConfigState = { ...versusConfigState, players, slots };
```

   and ensure the handler's re-renders include `renderVersusControllerRows()`.
7. `hud.css`: add `.hud-versus-start-note` (reuse the pane's small-copy style) and a
   disabled-Start signal following the `hud-level-btn--locked` convention (the style is
   the signal, the `disabled` attribute is the mechanism — `opacity: 0.35; cursor: default`
   on `.hud-versus-start-btn:disabled` or the pane's Start selector). Check
   `hud.css.test.ts`'s structural guards for whether the new class must be enumerated.
- [ ] **Step 4: Run** `npx vitest run src/game/hud.test.ts src/game/hud.css.test.ts`,
  then `npm run verify:quick` → green.
- [ ] **Step 5: Commit** — `vs-slots: pane-owned rows with unconditional Bot offer and a validated Start gate`.

---

### Task 5: Mutation manifest entries (prove the new coverage can fail)

**Files:**
- Modify: `tools/mutate/manifest.json`
- Reference: invoke the `mutation-check` skill for manifest format, runner usage, and
  count-measurement protocol.

Add four entries; for each, apply the mutation via `npm run mutate -- --only <id>` and
record the MEASURED killing-test count (state populations beside counts — repo rule):

- [ ] 1. `vs-slots-drop-config-seed` — `src/game/loop.ts`: the seeding ternary's
  `configSlots ? configSlots.map(…) : deriveInitialAssignment(playerCount, botSlots)`
  → always `deriveInitialAssignment(playerCount, botSlots)`. Expected killers: Task 3's
  seeds-from-config and precedence tests.
- [ ] 2. `vs-slots-pane-bot-gate` — `src/game/hud.ts`: the pane's
  `renderControllerRowsInto(…, true)` bot-offer argument → `botAssignmentAllowedNow`.
  Expected killer: Task 4 test 1.
- [ ] 3. `vs-slots-start-gate-open` — `src/game/hud.ts`:
  `versusStartBtn.disabled = problems.length > 0` → `= false`. Expected killers: Task 4
  tests 4/5/7.
- [ ] 4. `vs-slots-snapshot-alias` — `src/game/hud.ts`: the Start snapshot's
  `slots: versusConfigState.slots.map((s) => ({ ...s }))` →
  `slots: versusConfigState.slots`. Expected killer: Task 4 test 6.
- [ ] Verify each mutation is KILLED, then run the full manifest check the way
  `verify:full` does. Commit — `vs-slots: manifest mutations with measured kill counts`.

---

### Task 6: Docs, visual evidence, full gate, PR

- [ ] Narrow `docs/superpowers/backlog/spike-versus-mode-rest.md` item 5's residual
  text: the "who's-playing rows … do NOT carry through Start / no Bot option before any
  versus session" sentences now describe SHIPPED behavior — rewrite to record closure
  via issue #260 (leave #261 and the other residuals as-is). Run `npm run docs:check`
  (or the backlog guard tests) to confirm the guarded index still passes.
- [ ] Stamp this plan's header: `status: completed`, `implementation-prs: [<PR#>]`.
- [ ] Visual evidence (user-visible pane change): with the dev server or the visual
  tooling (`visual-check` skill), capture the pane showing (a) a Bot-selected row on
  first-time setup and (b) a disabled Start with its reason note. Attach via the
  pr-media branch convention.
- [ ] Risk tier: standard-plus (game code, cross-session contract; `risk:high` label on
  the issue) → from a clean candidate tree run `npm run verify:full` (captured to a log
  with `> log 2>&1; echo $?` — never piped through tail/grep) and `npm run verify:build`.
  Re-measure headline counts after the final tree.
- [ ] PR: title `Carry VS setup slot assignments and bot fill through Start` (the title
  is the complete squash message; no attribution trailers), body `Closes #260`, gates
  evidence comment, residuals stated explicitly (no hotplug listener while the pane is
  open; all-bot configs allowed pending an owner ruling; mid-match Controllers
  reassignments are session-local and not written back to the retained config). Push
  the branch at every task boundary.

## Self-review notes

- Spec coverage against #260's acceptance criteria: validated per-slot config (Tasks
  1–2), Bot in first-time setup (Task 4 test 1), Start uses displayed assignments
  (Task 3 tests 1–2 + Task 4 test 6), keyboard-only cannot launch inert (Task 1
  bot-default + Task 4 tests 4/7), returning preserves assignments (Task 4 test 8 +
  boot's existing `lastVersusConfig` retention), dev-flag precedence (Task 3 tests 2–3),
  test coverage for first launch / rematch / mixed slots / keyboard-only (Tasks 3–4).
- Type consistency: `onPick`/`offerBot` parameters, helper names, and
  `versusStartNoteEl` are used with the same names in every task that touches them.
- Known deliberate exclusions are listed under Global Constraints and restated as PR
  residuals.
