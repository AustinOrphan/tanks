/**
 * The HUD-visible surfaces the state machine's canonical AppLocation projects
 * down to. Renamed from the retired GameState union so no discriminant named
 * `title` still means Main Menu, and `win`/`lose` are split so the branch
 * between "intermediate clear" and "final win" copy no longer hides behind
 * one shared literal. `loop.ts` maps `AppLocation` -> `HudSurface` at the
 * boundary; the HUD itself does not import the state module (which now depends
 * on the pure `app-state.ts` model).
 */
export type HudSurface =
  | 'launch'
  | 'main-menu'
  | 'playing'
  | 'paused'
  | 'outcome-win'
  | 'outcome-lose';

/**
 * The layers that open OVER a surface (issue #318), by the name each has carried in its
 * classes since it was added. Recorded on the HUD's layer stack together with the surface
 * each was pushed over and the control that opened it, so Back returns to the true origin
 * and restores the invoking control. #243 still adds `developer-tools`: one member here
 * and one `LAYERS` row, and the exhaustive record makes a missing row a compile error.
 *
 * Issue #226 added `settings`, `about` and `confirm-new-campaign`. The first two are
 * ROUTES like the six before them; `confirm-new-campaign` is the file's first `overlay`,
 * and it is an overlay rather than a route for the reason `navigation.ts` states -- a
 * route may not be pushed over it, which is what stops a menu button opening a pane
 * UNDER the question it has not answered yet. It is deliberately not a general dialog
 * primitive; issue #327 owns that.
 *
 * `stats` and `achievements` are the two RECORDS tabs since #226. They stay two layer ids
 * rather than one because they are two panes; what changed is that only one Main Menu
 * control opens them, and each pane carries the tab row that reaches the other. Switching
 * tabs replaces the top layer, so both keep the Main Menu as their origin and Back from
 * either returns there -- which is exactly the shallow-tab contract the UI direction
 * asks for. Issue #322 owns the content and terminology inside them.
 */
export type HudLayerId =
  | 'stats'
  | 'customize'
  | 'achievements'
  | 'levelselect'
  | 'controllers'
  | 'versus-setup'
  | 'settings'
  | 'about'
  | 'confirm-new-campaign';

/**
 * WHAT IS BEING PLAYED -- the actual session kind, projected from the canonical
 * `SessionDescriptor.kind` (`app-state.ts`) by `loop.ts` at every world build.
 * Structurally the same three literals as `SessionDescriptorKind`, declared
 * here for the same reason `HudSurface` is: the HUD owns its own vocabulary and
 * does not import the model. A fourth descriptor kind is therefore a compile
 * error at `loop.ts`'s call site rather than a silent fold into `'campaign'`.
 *
 * Drives the GAMEPLAY surfaces only -- campaign Lives/Enemies stats and the
 * versus stock strip. It deliberately does NOT drive any button's label or
 * visibility; see `HudRelaunchTarget` for why those are a different question.
 */
export type HudSessionKind = 'campaign' | 'practice' | 'versus';

/**
 * WHICH GROUND the application screens stand on -- see `setBackdrop`. Projected by
 * `loop.ts` from `DevFlags.backdrop`, which is `BackdropTreatment | null`; the HUD owns
 * its own vocabulary and does not import the flag module, so the null-is-default half of
 * that mapping happens at the one call site rather than here.
 */
export type HudBackdrop = 'default' | 'felt';

/**
 * WHAT THE BUTTONS DO -- which system this session's menu and outcome ACTIONS
 * relaunch play through. Projected from `session-intent.ts`'s `RelaunchTarget`,
 * whose doc comment carries the full rationale.
 *
 * Separate from `HudSessionKind` because the two genuinely disagree for one
 * shipped boot: `?dev=1&mode=ffa` is a real Versus session (stock strip on,
 * campaign stats off) that still runs the CAMPAIGN level system, so Continue,
 * Levels and "Play Again" all still do the right campaign-shaped thing there.
 * Collapsing the two in either direction produces a lie: reporting that session
 * as Campaign hides its stock strip and mis-types its outcome, while reporting
 * its BUTTONS as versus labels a click "Versus Setup" when `loop.ts`'s
 * `onStartRestart` lands it on a campaign board.
 */
export type HudRelaunchTarget = 'campaign-levels' | 'versus-setup';

/**
 * EVERYTHING THE WIN/LOSE PANEL SAYS, as one push (issue #324, step S4).
 *
 * The panel used to be assembled from three unrelated setters: the attempt summary rode
 * `setStats`, whose real job is the Records table on an application route; the coop kill
 * line had `setCoopKills`; the versus tally had `setVersusResults`. Two of those existed
 * only for this panel, and nothing typed stopped them disagreeing -- a session could
 * leave a coop tally live under a versus one even though a world has exactly one
 * `rules.mode`, so "the two results lines are never both live at once" was a convention
 * `loop.ts` kept rather than a fact the HUD could rely on.
 *
 * One discriminated projection makes it a fact. `tally` names WHICH line this outcome
 * has, and the fields belonging to the other lines are not on the object at all. It
 * reuses the simulation's own `'ffa'`/`'teams'` words instead of pairing a `versus`
 * discriminant with a `mode` field beside it, because there is one question here -- what
 * does this panel tally? -- and it has exactly four answers.
 *
 * INDICES, NEVER COLOURS (issue #473). `kills` and `deaths` are indexed by slot
 * (`Tank.controlledBy`), and `'teams'` is summed per team through `teamOf(slot)`. The
 * HUD looks its hues up in `presentation/identity.ts`; a session hands over none.
 */
export type GameplayOutcome = {
  /**
   * The per-ATTEMPT tally the summary line reads (`stats.attempt()`, zeroed on every
   * world build) -- never the lifetime column, which belongs to Records and reaches the
   * HUD through `setStats`.
   */
  attempt: StatCounts;
  /**
   * What the panel's one action button DOES, in the same vocabulary the title screen's
   * buttons use -- see `HudRelaunchTarget`, and `setRelaunchTarget` for the title half.
   * It rides the outcome instead of being read back off the title's own copy because
   * this button is on a panel the SESSION owns, and the label has to be true about where
   * this session's click lands.
   */
  action: HudRelaunchTarget;
} & (
  | { tally: 'solo' }
  | { tally: 'coop'; kills: number[] }
  | { tally: 'ffa' | 'teams'; kills: number[]; deaths: number[] }
);

import type { StatCounts } from './stats';
import type { Assignment, SlotSource } from '../input/assignment';
import type { DetectedPad } from '../input/gamepad';
import { consumesKey, keyToUiAction, type UiAction } from '../input/ui-actions';
import { isDirection, spatialNext, type Direction, type Rect } from './spatial-focus';
import { keyHint, type Modality } from './modality';
import { teamOf } from '../sim/arena';
import { versusCatalogEntryById } from '../sim/config/versus-catalog';
import { IDENTITY_RING_COLORS, TEAM_COLORS, TEAM_LABELS } from '../presentation/identity';
import { createTransitionRunner } from './transitions';
import { menuTransitionClass, type MenuTransition } from './menu-transition';
import { createHistoryMirror, createLayerStack, type HistoryHost, type LayerEntry } from './navigation';
import { PALETTE, SKINS, ACCENTS, type HullColorId, type SkinId, type AccentId } from '../presentation/customization';
import { ACHIEVEMENTS, type AchievementDef, type AchievementId } from './achievements';
import type { RoundPhase } from '../sim/round';
import { VERSUS_STOCK } from '../sim/constants';
import { configFor } from '../sim/config';
import { versusMapChoices, type VersusConfig } from './versus-config';
import {
  defaultSlots,
  resizeSlots,
  resolveSources,
  versusSetupProblem,
  type VersusSlotRole,
  type VersusSetupProblem,
} from './versus-setup';
import type { VersusSetupStore } from './versus-setup-store';
// The motion preference's THREE-STATE vocabulary, from the store that owns it, for the
// same reason `TouchScheme` and `FireMode` come from `input/touch.ts` below: the control
// offers exactly the states the store accepts, and a fourth invented here would be
// refused on arrival with nothing to say why.
import type { MotionPreference } from './settings';
// The render-quality ids, from the presentation layer rather than from `render/quality.ts`
// (issue #540). The HUD offers exactly the presets the store accepts, and it must not
// import the Three.js table that says what each one costs -- see presentation/quality.ts.
import { DEFAULT_QUALITY_PRESET, type QualityPreset } from '../presentation/quality';
import {
  STICK_RADIUS_PX,
  stickVector,
  type TouchIndicator,
  type TouchScheme,
  type FireMode,
} from '../input/touch';
import './hud.css';
import { describeDisabledReason, setSelected } from './ui';
import { BOT_DIFFICULTIES, DEFAULT_BOT_DIFFICULTY, type BotDifficulty } from '../sim/ai/bot-difficulty';

export interface RoundPhaseInfo {
  phase: RoundPhase;
  /** Whole seconds left in this phase. */
  secondsLeft: number;
}

/**
 * The active campaign run, as the Main Menu and the replace-run confirmation describe it
 * (issue #226). See `Hud.setCampaignRun` for who resolves these numbers and why they are
 * not derived inside the HUD.
 */
export interface CampaignRunSummary {
  /** 1-based position in this build's campaign, or `null` when it cannot be resolved. */
  readonly mission: number | null;
  /** How many missions the campaign has. Only rendered beside a resolved `mission`. */
  readonly total: number;
  /** Lives left in the run, verbatim from the run store. */
  readonly lives: number;
}

export interface Hud {
  /**
   * The campaign topbar stat -- loop.ts pushes this every frame regardless of session
   * kind, since nothing marks "this is a versus world" as a `SimEvent`. The DOM element
   * itself is hidden for a versus session by `setSessionKind` (issue #282: `lives` reads
   * as the campaign default there, meaningless beside the stock readout), so this setter
   * stays unconditional -- the visibility gate lives entirely on the hidden class, not
   * here, the same division `setVersusStocks`'s data/gate split already uses.
   */
  setLives(n: number): void;
  /** Twin of `setLives` just above -- same unconditional setter, same
   *  `setSessionKind`-driven hidden class (a versus world has no enemy-kind tanks, so
   *  `countEnemies` is always 0 there and could not tell "cleared" apart from "versus"
   *  on its own). */
  setEnemiesRemaining(n: number): void;
  /**
   * Where the session stands in the level sequence: drives the topbar chip and the
   * win panel's copy (Next Level vs Play Again). A one-level total shows no chip --
   * "Level 1/1" is noise, and the sandbox is exactly that.
   */
  setLevel(current: number, total: number): void;
  /**
   * The main menu's level select: `unlocked` of `total` levels are pickable
   * (1-based count; level 1 is always open). A one-level total hides the Levels button
   * entirely -- the sandbox is not a choice. Locked buttons are DISABLED, not merely
   * grey.
   *
   * This is a PERMANENT-PROGRESS question ("which levels has the save unlocked"), not
   * an active-run one -- it used to also gate the Continue button (`unlocked > 1` iff
   * `highestCleared() > 0`), which was exactly the highestCleared/run conflation issue
   * #153 removes. See setContinueAvailable for that, now a separate signal.
   */
  setLevelSelect(unlocked: number, total: number): void;
  /**
   * Fired with the 0-BASED level index when an unlocked level button in the Levels
   * panel is clicked. This is PRACTICE (spec: "Selecting an unlocked level begins
   * practice with independent lives") -- New Game is a distinct, deliberate action and
   * fires onNewGame instead. The two used to share this one callback (New Game reported
   * `cb(0)`, indistinguishable from picking level 1 in the panel), which is exactly the
   * seam practice-vs-campaign needed to discriminate and could not.
   */
  onLevelSelect(cb: (level: number) => void): void;
  /**
   * Whether Continue has anything to resume: true iff an active campaign run exists.
   * A separate signal from setLevelSelect's `unlocked` on purpose -- see that doc
   * comment. `route-host.ts` pushes it at page construction and on every arrival at the
   * Main Menu, which since issue #324's step S5 is the only place it is pushed from: the
   * run changes while the player is in a match, and an arrival is both the first moment
   * the button can be seen and one that necessarily precedes seeing it.
   */
  setContinueAvailable(available: boolean): void;
  /**
   * WHERE THE ACTIVE RUN STANDS, for the Main Menu's one-line confidence summary and the
   * replace-run confirmation's copy (issue #226): "Mission 3 of 8 -- 2 lives left".
   *
   * A SECOND signal beside `setContinueAvailable`, not a replacement for it, and the
   * split is the same one #153 drew between "is there a run" and what the run contains.
   * `setContinueAvailable` is pushed from five places in `loop.ts` on every path where
   * the run's EXISTENCE can change, several of them mid-session where no menu is on
   * screen; this is pushed by the PAGE (`route-host.ts`) on every arrival at the Main
   * Menu, which is the only surface that renders it. Folding the two into one setter
   * would either make every one of those five loop call sites resolve a mission number
   * they have no reason to know, or make the page's paint the only one -- losing the
   * mid-session availability updates that already work.
   *
   * `mission` is 1-BASED and `total` is the campaign length, both resolved by the caller
   * against the level system; a run whose stored level id is not in this build's campaign
   * reports `mission: null` and the line degrades to the lives half rather than inventing
   * a position. The HUD owns the wording; the caller owns the numbers.
   */
  setCampaignRun(run: CampaignRunSummary | null): void;
  /**
   * New Game: the one deliberate, explicit action that starts (or replaces) the
   * active campaign run. Separate from onLevelSelect (see its doc comment) so the
   * loop can tell "start/replace the run" from "enter practice" apart -- before this
   * split they were the literal same event.
   *
   * SINCE ISSUE #226 THE BUTTON IS NOT THE EVENT. With a run active, "Start New
   * Campaign" opens the replace-run confirmation and this fires only when that
   * confirmation is answered; with no run it fires directly from "Start Campaign".
   * Every subscriber therefore still means the same thing -- the player has deliberately
   * asked to start a fresh run -- which is what let the confirmation be added without
   * touching a single caller.
   */
  onNewGame(cb: () => void): void;
  setState(s: HudSurface): void;
  /** Reflect the engine's mute state in the button. */
  setMuted(muted: boolean): void;
  /**
   * The input the player is actually using (issue #496), which decides whether a static
   * hint names a key, a button, or nothing at all. The page's tracker pushes this; the
   * HUD only repaints the labels that carry a hint, and never reflows a surface -- so
   * Settings is unaffected by a modality change, which is the ruling this obeys.
   */
  setModality(modality: Modality): void;
  /**
   * Reflect the effective master volume in BOTH sliders.
   *
   * The markup carries NO `value` (issue #324), so the slider has nothing to say until
   * this is called. It used to render at `DEFAULT_VOLUME`, which was the truth while
   * volume was a session-local field on the audio engine; since issue #320 it is a
   * persisted setting, so that default was a control lying about the state it controls
   * for as long as it took the first push to arrive. Removing it also takes `hud.ts`'s
   * last import from the audio layer, which is why the dependency allowlist no longer
   * lists this file. `route-host.ts` paints the stored value the moment the HUD exists.
   */
  setVolume(v: number): void;
  /**
   * Round-start countdown. `null` hides it; otherwise a bare number, centred and
   * transient -- it pops in and fades out (the `hud-count-pop` keyframes, applied via
   * the `.hud-count--pop` class, in hud.css) rather than sitting on screen, so it
   * never obscures the board it counts down over. Design
   * ruling: no word ("AIM"/"TAKE AIM"), just the number, and it shows on EVERY
   * round -- there is no "first round only" teaching form. `setRoundPhase` is
   * phase-agnostic: any phase other than `'live'` shows the number, unconditionally.
   *
   * `GRACE_TICKS` is 0 today, so the `'grace'` phase never actually occurs in play.
   * If it is ever switched back on, this will show a second 3-2-1 immediately after
   * the countdown's, with nothing distinguishing the two -- a known, deliberate gap.
   * Shipping phase-specific presentation for a phase nothing can currently reach
   * would be speculative CSS for code no test exercises.
   *
   * Shipped on: the round opens with 3.0s in which nothing moves, and without
   * this the player presses a direction and the game appears broken.
   */
  setRoundPhase(info: RoundPhaseInfo | null): void;
  /**
   * Dev only: shells in flight against the cap. `null` hides it.
   *
   * The cap is meant to be FELT, not read -- running dry is part of the game.
   * This exists so a developer can tell "the cap is working" from "the cannon
   * is broken", which are indistinguishable from the player's seat.
   */
  setShellCount(info: { inFlight: number; cap: number } | null): void;
  /**
   * Issue #516's `hud` arm of the blocked-fire comparison: a TRANSIENT capacity line,
   * shown for under a second when the active-shell cap refuses the controlling player's
   * shot, and gone again on its own.
   *
   * Deliberately NOT `setShellCount` with a nicer style. That one is a READOUT -- pushed
   * every frame behind `?dev=1&shellCount=1`, and it sits in the topbar until the flag is
   * turned off -- and #356's boundary is explicit that a permanent numeric ammunition HUD
   * is out of scope unless play evidence shows transient feedback is insufficient. This
   * is the transient half that evidence has to be gathered against: a signal (like
   * `signalPlayerDeath`), not a setter, with no state of its own and nothing to hide.
   *
   * The caller decides WHEN; `game/blocked-fire-hud.ts` owns the cue gate and the
   * controlling-player filter, exactly as the audio and haptic arms own theirs.
   */
  signalShellCapacity(info: { inFlight: number; cap: number }): void;
  /**
   * The player just lost a life. Losing one was previously invisible: the only
   * cue was the Lives number quietly decrementing in a corner, plus a sound --
   * and with no audio assets committed, that sound is a procedural blip.
   */
  signalPlayerDeath(color: number): void;
  onMuteToggle(cb: () => void): void;
  onVolumeChange(cb: (v: number) => void): void;
  /**
   * Extension: fired when the pause/win/lose panel's Resume/Next Level/Play
   * Again/Retry button is clicked -- and by the title panel's Continue button, which
   * shares this handler rather than a second one, since it IS that action ("resume at
   * `levels.start`") under a label that says what it does at the title screen.
   */
  onStartRestart(cb: () => void): void;
  /** Fired by the pause panel's Quit to Title button, and by nothing else. */
  onQuitToTitle(cb: () => void): void;
  /**
   * The touch-only pause button. Separate from the keyboard hotkey because it is an
   * affordance, not a binding: `loop.ts` routes both to the same guarded transition.
   */
  onPauseTap(cb: () => void): void;
  /** The touch-only Mine button. Routed to the input controller's own latch. */
  onMineTap(cb: () => void): void;
  /**
   * The touch-only Fire button, beside Mine. Routed to the input controller's own
   * `pressFire()` latch -- a tap here is indistinguishable downstream from a click or a
   * keypress. Touch aiming deliberately does NOT fire on its own; see TouchScheme.
   */
  onFireTap(cb: () => void): void;
  /**
   * THE RECORDS TABLE's two columns, pushed by the routes when the page is opened (see
   * `onRecordsOpen`) and after a reset. The HUD re-renders the table only while it is
   * visible, which is what makes an open-time push complete rather than a sampling of a
   * value that keeps moving.
   *
   * `attempt` (not `run`, see stats.ts): a level-sized tally, zeroed on every
   * switchTo. The visible copy still reads "This run" -- that is user-facing
   * wording, not the codebase's ambiguous use of the word issue #153 asks to
   * remove, and changing it is out of this change's scope (nit 4, adjudicated
   * review of #156: renaming `hud-run-summary`/`runSummaryEl`/`renderRunSummary`
   * to their attempt-scoped names was trivial and safe, and is done; the visible
   * "This run: ..." copy is a separate, user-facing decision and stays as-is).
   *
   * The win/lose panel's attempt summary used to ride here too, which is what made a
   * gameplay session push a Records-shaped payload just to keep one line of its own
   * outcome screen fresh. That line reads `setOutcome` since issue #324's step S4; the
   * same `attempt` counts reach the HUD twice because they answer two questions, on two
   * surfaces, with two owners.
   */
  setStats(data: { lifetime: StatCounts; attempt: StatCounts }): void;
  /**
   * THE WIN/LOSE PANEL, as one projection -- the attempt summary, whichever results line
   * this session has, and what its action button does. See `GameplayOutcome` for the
   * shape and for what the three setters it replaced could not say.
   *
   * `null` is "nothing to summarise": the three lines stay hidden even at win/lose, and
   * the action button keeps its campaign wording. That is the state every HUD which
   * never calls this is in -- every css and gallery fixture -- so a fixture renders
   * exactly as it did before this method existed. `loop.ts` pushes a real outcome from
   * boot onward and never pushes `null`.
   *
   * Pushed on every event-bearing frame, not once at the end: the winning kill is
   * recorded a beat AFTER the state machine flips to `outcome-win`, so the panel is
   * already open when the number that belongs on it arrives, and a push that lands then
   * must repaint rather than be dropped.
   */
  setOutcome(outcome: GameplayOutcome | null): void;
  /**
   * The in-match per-player STOCK readout (spec §3a, owner addition 2026-08-21) --
   * genuinely different lifecycle from the versus tally `setOutcome` carries: that one
   * is a win/lose-only summary; this is a LIVE strip in the topbar, visible only while a
   * versus session is actually being played (`playing`/`paused` -- wired into
   * setState's visibility toggles alongside every other state-gated element below),
   * hidden at title/win/lose/splash, where a live per-tick count would be meaningless
   * (the match has not begun or is already over). That opposite visibility rule is why
   * it stayed its own setter when the win/lose lines merged into one projection. `null`
   * hides it entirely -- "never show", not "hide right now"; campaign sessions call this
   * with `null` exactly once, at wiring, and never again (loop.ts).
   *
   * One entry per active slot, `{ slot, stock, team? }` -- `team` present only in
   * 'teams' mode (loop.ts derives it straight off `Tank.team`, which loadArena stamps
   * ffa-never/teams-always, arena.ts). Each entry renders its OWN element (a joined
   * string could not carry a per-slot inline tint) coloured from the SAME exported
   * constants the rest of the identity system already uses for this slot's ring --
   * `IDENTITY_RING_COLORS[slot]` in ffa, `TEAM_COLORS[team]` in teams -- imported here
   * rather than copied out as literal hex, which is the drift hud.test.ts's own tint
   * assertions are written to catch (retuning either palette must move this readout's
   * colour too, with no second place to remember to edit).
   *
   * Placement is the topbar -- the screen edge the layout already reserves for
   * `.hud-stat`/`.hud-shells` -- deliberately never an overlay on the arena; feel/size
   * evidence against a real render is Task 7's job (screenshots), not this file's.
   */
  setVersusStocks(stocks: { slot: number; stock: number; team?: number }[] | null): void;
  /**
   * The Records page just opened, on either of its two tabs.
   *
   * The hook that lets Records be painted by whoever OWNS the numbers rather than by
   * whoever happens to be playing (issue #324, step S5). Both tables re-render from this
   * HUD's own retained copy of the counts, and that copy has to come from somewhere: the
   * gameplay session used to push it on every event-bearing frame, which is what kept the
   * page's construction-time copy from going stale across a match. With the session's
   * push gone there is nothing between construction and the open -- and nothing needs to
   * be, because the page's stores are current at every instant and this pane is reachable
   * from the Main Menu alone. A per-frame push becomes a per-open read.
   *
   * Fired for the Stats tab and the Achievements tab alike, because Records is ONE entry
   * with two tabs (see `handleRecordsOpen`) and a tab switch reopens the sibling through
   * the same layer machinery. No paired close: unlike `onCustomizeClose` and
   * `onControllersClose`, nothing here owns a resource whose lifetime must match the
   * panel's -- see `onVersusOpen` for the same reasoning about the setup pane.
   */
  onRecordsOpen(cb: () => void): void;
  /** Two-click-confirmed on the stats page. */
  onResetStats(cb: () => void): void;
  /** Two-click-confirmed on the stats page. Re-locks levels; the loop refreshes. */
  onResetProgress(cb: () => void): void;
  /** The paint shop's current swatch, echoed back by the loop after an accepted pick. */
  setHullColor(id: HullColorId): void;
  /** Fired with the swatch id when the player clicks one. */
  onPickHullColor(cb: (id: HullColorId) => void): void;
  /** The paint shop's current skin, echoed back by the loop after an accepted pick. */
  setSkin(id: SkinId): void;
  /**
   * The paint shop's current accent (the pattern's second tone), echoed back by the
   * loop after an accepted pick -- same convention as `setHullColor`/`setSkin`.
   */
  setAccentColor(id: AccentId): void;
  /** Fired with the accent id when the player clicks one. */
  onPickAccentColor(cb: (id: AccentId) => void): void;
  /**
   * The paint shop's live tank preview canvas -- owned by the HUD (it is markup, same
   * as every other element here), driven by the caller. `render/preview.ts` builds a
   * SECOND WebGLRenderer against it, which is why the HUD only hands the element out
   * rather than doing any WebGL of its own: hud.ts constructs no WebGL context and
   * builds no `three` object of its own, which is what lets hud.test.ts keep running
   * under plain jsdom. (It DOES import render/entities' plain
   * IDENTITY_RING_COLORS/TEAM_COLORS number arrays -- see setVersusStocks' own doc
   * comment -- a value import, not a WebGL one; measured under this file's own jsdom
   * suite before landing, since `entities.ts` pulls in `three` at module scope too.)
   */
  readonly previewCanvas: HTMLCanvasElement;
  /**
   * The rotate cluster's four buttons, handed out with the canvas for the same reason:
   * the markup is the HUD's, the behaviour is `render/preview-controls.ts`'s. Each one
   * carries `data-rotate-part` / `data-rotate-dir`, which is what the controls read --
   * so this is an element list, not a callback API, and the HUD binds no click of its
   * own to them.
   */
  readonly previewRotateButtons: readonly HTMLButtonElement[];
  /**
   * The Customize panel just became visible/hidden. This is the ONE chokepoint for
   * both transitions -- the Back button (`showCustomize(false)`) and any OTHER state
   * change, which closes the panel unconditionally (see setState) -- so a caller that
   * builds the live preview on open and disposes it on close cannot leak a WebGL
   * context down the second path. Fired only on an actual transition, never on a
   * redundant call.
   */
  onCustomizeOpen(cb: () => void): void;
  onCustomizeClose(cb: () => void): void;
  /**
   * The earned set, pushed by the routes when the Records page is opened (see
   * `onRecordsOpen`) and after a progress reset. Re-renders if open.
   */
  setAchievements(earned: ReadonlySet<AchievementId>): void;
  /**
   * Announce newly earned achievements. One toast each, self-expiring; several
   * landing together stack rather than replacing one another.
   */
  showAchievementToasts(defs: readonly AchievementDef[]): void;
  /**
   * A single-line, self-expiring toast, reusing the same `.hud-toast` stack and timer as
   * `showAchievementToasts` but for a plain message with no achievement identity behind
   * it. Today's one caller: `?dev=1&gamepad=1`'s "gamepad connected" notice -- Firefox
   * hides a pad from `navigator.getGamepads()` until the player presses a button on it,
   * so the game has no other moment to confirm the pad was seen.
   */
  showToast(message: string): void;
  /**
   * Draw the player's thumbs back on screen: the driving stick where it landed, and a
   * dot on the point the turret is being sent to.
   *
   * Pushed every frame from the loop. Takes CLIENT pixels, which is why it is not part
   * of the sim's input at all -- see TouchIndicator.
   */
  setTouchIndicator(t: TouchIndicator): void;
  /**
   * Which touch aim scheme is active, echoed back by the loop after an accepted toggle --
   * same convention as `setHullColor`/`setSkin`: the HUD shows what was STORED, not what
   * was clicked. Also settles which shape `setTouchIndicator` draws for the aim thumb: a
   * second ring+knob under 'stick' (it IS a stick), a crosshair under 'point'.
   */
  setTouchScheme(scheme: TouchScheme): void;
  /** Fired with the OTHER scheme when the player taps the aim-style toggle. */
  onTouchSchemeChange(cb: (scheme: TouchScheme) => void): void;
  /**
   * Which touch fire mode is active (see `FireMode` in touch.ts), echoed back by the
   * loop after an accepted toggle -- same convention as `setTouchScheme`: the HUD shows
   * what was STORED, not what was clicked.
   */
  setFireMode(mode: FireMode): void;
  /** Fired with the NEXT mode in the cycle when the player taps the fire-mode toggle. */
  onFireModeChange(cb: (mode: FireMode) => void): void;
  /**
   * Whether haptics.ts's vibrate calls are allowed through, echoed back by the loop
   * after an accepted toggle -- same convention as `setTouchScheme`/`setFireMode`: the
   * HUD shows what was STORED, not what was clicked.
   */
  setHaptics(on: boolean): void;
  /** Fired with the FLIPPED value when the player taps the haptics toggle. */
  onHapticsChange(cb: (on: boolean) => void): void;
  /**
   * Which of the three motion states the player has CHOSEN (issue #289), echoed back by
   * the page after an accepted toggle -- same convention as `setTouchScheme`/`setFireMode`:
   * the control shows what was stored, not what was clicked.
   *
   * The stored preference, deliberately, not the boolean `setReducedMotion` carries. This
   * is the control that EDITS the preference, so it has to be able to show 'system' as
   * itself; a page painting it from the resolved policy would collapse 'system' into
   * whichever of 'full'/'reduced' the OS happened to say and leave the player no way back.
   * The resolved policy still reaches the label -- see `setReducedMotion` -- because
   * 'system' is the one state whose name does not say what is currently happening.
   */
  setMotion(preference: MotionPreference): void;
  /** Fired with the NEXT preference in the cycle when the player taps the motion toggle. */
  onMotionChange(cb: (preference: MotionPreference) => void): void;
  /**
   * Which render-quality preset the player has CHOSEN (issue #540), echoed back by the
   * page after an accepted toggle -- the same convention every other Settings control
   * follows: the button shows what was stored, not what was clicked.
   *
   * There is no resolved counterpart to push beside it, unlike `setMotion`. Quality has no
   * capability gate and no OS preference behind it (effective-settings.ts), so the stored
   * value IS the effective one and one setter carries the whole control.
   */
  setQuality(preset: QualityPreset): void;
  /** Fired with the NEXT preset in the cycle when the player taps the quality toggle. */
  onQualityChange(cb: (preset: QualityPreset) => void): void;
  /**
   * The player just fired. Pulses the aim mark, so a tap that produced a shot is
   * distinguishable from a tap that did not -- on a phone the muzzle is under the
   * player's own hand, and the shell is gone before the eye gets there.
   *
   * Driven by the sim's `fire` event rather than by the tap, so it confirms a shot that
   * ACTUALLY happened: a tap during the cooldown correctly does not pulse.
   */
  signalPlayerFire(): void;
  /** Fired with the skin id when the player clicks one. */
  onPickSkin(cb: (id: SkinId) => void): void;
  /**
   * The controller assignment UI's one write path: fired with the slot index and the
   * candidate `SlotSource` when a row's source button is clicked. `loop.ts`'s
   * `reassignSlot` is the one production subscriber -- see its own doc comment for what
   * happens on the other side (rebuild-don't-re-point, immediate position seeding, the
   * incremental `botSources` update).
   */
  onReassignSlot(cb: (slot: number, source: SlotSource) => void): void;
  /**
   * The `Assignment` to render, pushed by `route-host.ts` from what the live session
   * reports through its slot -- at the session's construction and after every accepted
   * `reassignSlot` (issue #324, step S5). Unconditional, unlike `setAchievements`: see
   * the implementation's own comment for why the rows stay current while hidden.
   */
  setControllers(assignment: Assignment): void;
  /**
   * The panel's live candidate-pad list, pushed by `route-ui.ts` while `.hud-controllers`
   * is open (see `onControllersOpen`/`onControllersClose`) -- one call on open (`getGamepads`
   * read once immediately, since the browser's `gamepadconnected`/`gamepaddisconnected`
   * events fire only on CHANGE) and one per hotplug event after that. A `'gamepad'`-kind
   * row's connected/disconnected display is DERIVED from this list, not a separate flag:
   * the panel's live pad list IS what "connected" means here.
   */
  setDetectedPads(pads: readonly DetectedPad[]): void;
  /**
   * Whether the panel may OFFER `'bot'` as a candidate source (`assignment.ts`'s
   * `botAssignmentAllowed`). Defaults to false and must be pushed in, so a wiring
   * omission fails CLOSED -- no bot option anywhere, which is visible -- rather than
   * open, which would restore the exact hole this exists to shut.
   */
  setBotAssignmentAllowed(allowed: boolean): void;
  /**
   * The Controllers panel just became visible/hidden -- the ONE chokepoint for both
   * transitions (the Back button and `setState`'s unconditional close), same shape as
   * `onCustomizeOpen`/`onCustomizeClose`. `loop.ts` adds/removes its
   * `gamepadconnected`/`gamepaddisconnected` window listeners here, scoped to exactly
   * while the panel that reads them is on screen -- the driver does not tick during
   * title/paused, so nothing else would refresh the panel's live pad list.
   */
  onControllersOpen(cb: () => void): void;
  onControllersClose(cb: () => void): void;
  /**
   * The title screen's Versus button was clicked -- a bare click passthrough, the
   * shape `onNewGame`/`onQuitToTitle` already use, NOT the transition-guarded
   * onCustomizeOpen/onControllersOpen shape. Those two pair with an onClose because an
   * external subscriber owns a resource whose lifecycle must match the panel's
   * (the paint shop's second WebGL context; the gamepad hotplug listeners) -- this
   * pane owns nothing like that, so there is no `onVersusClose`. The subscriber
   * (`route-ui.ts`) is what actually opens the pane, by calling `showVersusSetup` itself,
   * because only the loop knows which `VersusConfig` to retain across a rematch --
   * see `showVersusSetup`'s own doc comment for why the button click does not call it
   * directly.
   */
  onVersusOpen(cb: () => void): void;
  /**
   * The setup pane's Start button was clicked, fired with the PANE'S OWN selections
   * as a plain snapshot object -- not a live reference into this HUD's internal
   * state, so a caller cannot mutate the pane by mutating what it was handed.
   * `loop.ts`'s one production subscriber tears the running session down and boots a
   * fresh one from it (spec: "confirm tears down the running session and boots a new
   * one").
   */
  onVersusStart(cb: (config: VersusConfig) => void): void;
  /**
   * Show/hide the versus setup pane, following the exact panel-open template
   * `showControllers`/`showCustomize` use: focus-the-pane on open, closed
   * unconditionally by `setState` (every OTHER state change hides it, same as every
   * sibling subpanel). `initial`, when supplied and TRUTHY, reseeds the pane's own
   * selections; omitting the argument AND passing `null` (`route-ui.ts`'s own
   * `deps.initialVersusConfig ?? null` for "nothing retained yet") both leave the
   * pane's PERSISTED session-local selections untouched rather than resetting them to
   * a hardcoded default -- so Back, then Versus again, keeps whatever was last chosen
   * (spec ruling 4: "rematch-friendly"). No paired `showVersusSetup`-triggered close
   * callback: see `onVersusOpen`'s own doc comment for why none is needed.
   */
  showVersusSetup(show: boolean, initial?: VersusConfig | null): void;
  /**
   * WHAT IS BEING PLAYED. Projected from the canonical `SessionDescriptor.kind`
   * by `loop.ts` at every world build, so it tracks the descriptor rather than
   * a boot-time guess -- a Levels pick that turns a campaign session into
   * Practice arrives here, and so does the landing that turns it back.
   *
   * Gates the two GAMEPLAY surfaces whose correctness is a statement about the
   * world, not about a button:
   *
   *  - the campaign Lives/Enemies stats, hidden for `'versus'` alone (issue
   *    #282). Practice shows them, exactly as it always has -- a Level-Select
   *    board is a campaign board being played in isolation, and its lives and
   *    enemy count are as real there as anywhere;
   *  - the in-match versus stock strip (spec section 3a), shown for `'versus'`
   *    while playing or paused.
   *
   * NOT fixed for the session's life, and no caller may assume it is: both a
   * Levels pick and the landing back on a session's home board re-derive it.
   * Every consumer is recomputed from one place (`applySessionKindSurfaces`) so
   * a later change lands on all of them at once, whatever order the calls come
   * in.
   *
   * Deliberately NOT the gate for any button's label or visibility. A
   * developer-flag versus session (`?dev=1&mode=ffa`) is genuinely `'versus'`
   * here while its buttons stay campaign-shaped, because it still runs the
   * campaign level system -- see `setRelaunchTarget`.
   *
   * Defaults to `'campaign'`, so a HUD that never calls this (every css/gallery
   * fixture) renders byte-identical to before the method existed.
   */
  setSessionKind(kind: HudSessionKind): void;
  /**
   * WHAT THE TITLE SCREEN'S BUTTONS DO -- the affordance policy for every
   * kind-dependent control on the Main Menu:
   *
   *  - `'campaign-levels'` (the default): the shipped campaign title screen.
   *  - `'versus-setup'`: Continue hides -- it is the one title affordance that
   *    reaches gameplay WITHOUT rebuilding the world (`loop.ts`'s
   *    `onStartRestart`), so with the versus level system installed it would
   *    resume whatever frozen win/lose world is still in `driver.world` rather
   *    than a fresh board (the "corpse-world window" a versus win/lose -> Back
   *    -> title sequence opens; reachable whenever a real campaign run is also
   *    active, since `deps.run` is the SAME store both kinds share). The
   *    Levels-open button hides with it (its own `levelChoice` gate is already
   *    permanently false for a single synthetic level -- belt-and-suspenders,
   *    not a live fix), and a Campaign button shows instead, wired through
   *    `onCampaignOpen` to `boot.ts`'s `requestCampaignSession` seam.
   *
   * New Game is treated differently, DELIBERATELY NOT hidden: unlike Continue,
   * its handler (`loop.ts`'s `onNewGame`) always rebuilds the world via
   * `switchTo` before entering gameplay -- for a setup-pane versus session this
   * is the ONLY path from title into the just-configured match. Hiding it as
   * the controller ruling's literal text asked would have made a freshly
   * rebooted versus session unplayable through this UI. It is RELABELED "Start
   * Match" instead so it no longer reads as a campaign action while doing
   * exactly what it always has for a non-campaign session.
   *
   * The win/lose action button asks the SAME question -- "Play Again"/"Retry"
   * becomes "Versus Setup" for this target, because that click really does
   * reopen the pane instead of rebuilding a board -- but it no longer reads the
   * answer from here. That panel belongs to a gameplay session, so since issue
   * #324's step S4 the session states it on `GameplayOutcome.action`, which is
   * the same `HudRelaunchTarget` vocabulary and carries the same warning: the
   * word has to be true about the click's DESTINATION, and `onStartRestart`
   * routes a developer-flag versus session -- Versus by identity -- through
   * `landOnCampaignBoard`, so keying either surface on `setSessionKind` would
   * name a pane the click never opens.
   */
  setRelaunchTarget(target: HudRelaunchTarget): void;
  /**
   * WHICH TREATMENT the application backdrop draws (issue #317). A PAGE-lifetime fact,
   * pushed once by `route-host.ts` at construction: nothing in a session changes it, and
   * since issue #324's step S5 no session pushes it either -- the ground is chrome the
   * application routes stand on, so a page that never starts a match still has one.
   *
   * `'default'` is the flat application ground every player sees. `'felt'` is the green
   * tabletop the adopted ruling kept as a switchable alternative rather than as dead
   * CSS, reached through `?dev=1&backdrop=felt` -- the page reads the flag, so the HUD
   * takes a named treatment rather than a query string. A named union, not a boolean,
   * because #366 adds further treatments to this same layer.
   *
   * Says nothing about WHEN the backdrop is visible: `setState` owns that, and shows it
   * on the Main Menu only.
   */
  setBackdrop(treatment: HudBackdrop): void;
  /**
   * The RESOLVED reduced-motion policy (`effective-settings.ts`), never a media query.
   *
   * A setter rather than a `createHud` argument, for the same reason `setMuted` is one:
   * the player can change this in Settings with the menu open, and a construction
   * parameter would freeze whichever answer was true at boot -- which for this setting
   * means the toggle appears to do nothing until a reload. Pushed from `route-host.ts`'s
   * single `effectiveSettings` subscription alongside mute, volume, haptics and
   * `setMotion`.
   *
   * True drives every application transition to zero duration (issue #364, criterion 5),
   * and it also completes the Accessibility toggle's "Match device" label: that is the one
   * of the three motion states whose own name cannot say whether motion is being reduced
   * right now, and a player unable to tell is why issue #289 exists.
   */
  setReducedMotion(on: boolean): void;
  /**
   * The versus-kind title screen's Campaign button was clicked -- a bare click
   * passthrough, the exact shape `onVersusOpen`/`onNewGame` already use. `loop.ts`'s
   * one subscriber calls `deps.requestCampaignSession?.()`, `boot.ts`'s symmetric
   * counterpart to the versus reboot seam.
   */
  onCampaignOpen(cb: () => void): void;
  /**
   * Semantic Back (issue #318): pop exactly one layer -- close the pane on top, return
   * to the surface it was opened over, and restore focus to the control that opened it
   * when that control still exists. `true` when a layer was consumed; `false` when
   * nothing was open, and the caller decides what Back means there (Escape falls through
   * to the session's pause hotkey; issue #319's gamepad mapping supplies its own
   * fallback). The Back buttons, Escape and the browser's own Back all end here.
   */
  back(): boolean;
  /**
   * The semantic action dispatcher for the active layer (issue #494): a direction moves
   * the roving focus, `confirm` activates the focused control, `back` is `back()`, and
   * `pause` is reported unconsumed for the page to toggle. `true` when the HUD consumed
   * the action. The gamepad menu poller in `route-host.ts` is the one caller today;
   * the keyboard reaches the same verbs through the window-capture key handler.
   */
  act(action: UiAction): boolean;
  dispose(): void;
}

/**
 * WHO OWNS EACH MEMBER of `Hud` (issue #324).
 *
 * `Hud` is one interface with 71 members spanning two different lifetimes: the persistent
 * application shell, which exists before any match and outlives every match, and a single
 * gameplay session, which does not. Issue #468 separated those OWNERS in the code
 * (`route-host.ts` renders application routes with no session at all); this separates them
 * in the CONTRACT, so a session can no longer reach the Main Menu's level list or the
 * Settings sliders just because they happen to hang off the same object.
 *
 * Declared as `Pick`s of the one interface rather than by splitting the interface into
 * three physical declarations. That is deliberate on two counts. The member docs stay
 * where they are, beside the member, instead of being scattered across three blocks by a
 * 540-line move that no reviewer could read. And every mutation-manifest `find` string
 * anchored in those lines keeps working, so the coverage contract survives a change that
 * alters no behaviour at all.
 *
 * These say who SHOULD own each member. `loop.ts` today still calls a number of
 * `RouteHudKey` members directly -- that gap is the remaining work of #324, and it is
 * pinned as an explicit, shrinking list in `hud-ownership.test.ts` so each step of the
 * migration deletes a line from it rather than quietly moving the goalposts.
 */
export type HudFrameKey =
  // Page chrome and dispatch. The frame is what the shell paints around whatever is
  // showing; none of it belongs to any one route, and none of it to a session.
  | 'setState'
  | 'setModality'
  | 'setBackdrop'
  | 'setReducedMotion'
  | 'back'
  | 'act'
  | 'dispose'
  // The toast stack. The frame owns the element; a session is LENT the writer -- see
  // `GameplayHudKey`, the one member deliberately in two roles.
  | 'showToast';

/**
 * Application-route surfaces: Main Menu, Level Select, Records, Customize, Controllers,
 * Versus Setup and Settings. Owned by `route-host.ts` and `route-ui.ts`.
 *
 * The seven gameplay-FACING callbacks (`onStartRestart`, `onQuitToTitle`, `onPauseTap`,
 * `onMineTap`, `onFireTap`, `onMuteToggle`, `onVolumeChange`) are here rather than in
 * `GameplayHudKey` because ownership is about who REGISTERS them, not about what they
 * eventually do: `route-host.ts` registers each exactly once, as a trampoline into
 * whatever session is live. A session never touches them, and must not, or a handler
 * would outlive the session that installed it.
 */
export type RouteHudKey =
  | 'setLevelSelect' | 'onLevelSelect' | 'setContinueAvailable' | 'setCampaignRun'
  | 'onNewGame' | 'onCampaignOpen'
  | 'setMuted' | 'setVolume' | 'onMuteToggle' | 'onVolumeChange'
  | 'onStartRestart' | 'onQuitToTitle' | 'onPauseTap' | 'onMineTap' | 'onFireTap'
  | 'setStats' | 'onResetStats' | 'onResetProgress' | 'setAchievements' | 'onRecordsOpen'
  | 'setHullColor' | 'onPickHullColor' | 'setSkin' | 'onPickSkin'
  | 'setAccentColor' | 'onPickAccentColor'
  | 'previewCanvas' | 'previewRotateButtons' | 'onCustomizeOpen' | 'onCustomizeClose'
  | 'setTouchScheme' | 'onTouchSchemeChange' | 'setFireMode' | 'onFireModeChange'
  | 'setHaptics' | 'onHapticsChange' | 'setMotion' | 'onMotionChange'
  | 'setQuality' | 'onQualityChange'
  | 'onReassignSlot' | 'setControllers' | 'setDetectedPads' | 'setBotAssignmentAllowed'
  | 'onControllersOpen' | 'onControllersClose'
  | 'onVersusOpen' | 'onVersusStart' | 'showVersusSetup'
  | 'setRelaunchTarget';

/**
 * What a live match may write, and the ONLY part of `Hud` a gameplay session should ever
 * hold. Thirteen members plus the lent `showToast`.
 *
 * `setOutcome` is the first of the absorptions issue #324 promised: it replaced
 * `setCoopKills` and `setVersusResults`, which left the interface with them (step S4).
 * The per-kind status members still queued behind it -- `setLives`,
 * `setEnemiesRemaining`, `setLevel`, `setSessionKind`, `setVersusStocks` -- are
 * gameplay-owned today and stay gameplay-owned after, so they are classified here rather
 * than being left unclassified pending that work.
 */
export type GameplayHudKey =
  | 'setLives' | 'setEnemiesRemaining' | 'setLevel' | 'setSessionKind'
  | 'setOutcome' | 'setVersusStocks'
  | 'setRoundPhase' | 'setShellCount' | 'signalShellCapacity'
  | 'signalPlayerDeath' | 'signalPlayerFire' | 'setTouchIndicator'
  | 'showAchievementToasts'
  // Lent from the frame, which owns the stack itself. A session needs it for the gamepad
  // connect/disconnect edges, which are neither route changes nor gameplay events but do
  // happen mid-match and have nowhere else to report.
  | 'showToast';

export type HudFrame = Pick<Hud, HudFrameKey>;
export type RouteHud = Pick<Hud, RouteHudKey>;
export type GameplayHud = Pick<Hud, GameplayHudKey>;

/**
 * Every member of `Hud` is classified above. A member added without a role makes this
 * union non-`never` and the assignment below stops compiling -- which is the point: the
 * failure mode this guards against is not a wrong classification but an UNCLASSIFIED one,
 * silently reachable from everywhere, which is how it grew to the 67 members the
 * classification first had to sort.
 */
type UnclassifiedHudKey = Exclude<keyof Hud, HudFrameKey | RouteHudKey | GameplayHudKey>;
const _everyHudMemberHasAnOwner: UnclassifiedHudKey extends never ? true : never = true;
void _everyHudMemberHasAnOwner;

/** How long an unlock toast sits on screen. Feel, not measurement. */
const TOAST_MS = 3200;

/**
 * The classic red death vignette (matches the pre-tint `rgba(180, 30, 30, ...)` this
 * replaced -- 0xb4 = 180, 0x1e = 30). Single-player always passes this; `loop.ts` passes
 * a per-slot identity colour instead once a second player exists. Exported so tests
 * assert against the constant's own value rather than a copied-out literal red -- see
 * hud.test.ts's "single-player keeps the classic red" test.
 */
export const SINGLE_PLAYER_DEATH_VIGNETTE = 0xb41e1e;

/** `0xRRGGBB` -> `'#rrggbb'`, the CSS custom-property form `--hud-damage-color` wants. */
function cssColor(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

/**
 * The four rotate buttons' icons, built from two halves so the pairs cannot drift apart:
 * an arc arrow (mirrored for the left-hand button by a transform, NOT by a second
 * hand-written path -- a mirrored copy is where an asymmetric pair comes from) over the
 * silhouette of the part it turns.
 *
 * `currentColor` throughout, so the buttons' own hover/active colours carry the icon
 * with them, and `aria-hidden` because the accessible name lives on the button.
 */
const ROTATE_ARROW =
  '<path d="M5 9a9 7 0 0 1 14 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '<path d="M19 11.4l-2.3-3.8h4.6z" fill="currentColor"/>';
const ROTATE_HULL = '<rect x="7" y="13.5" width="10" height="7.5" rx="2" fill="currentColor"/>';
const ROTATE_TURRET =
  '<circle cx="10.5" cy="17.2" r="3.4" fill="currentColor"/>' +
  '<rect x="13" y="16.2" width="6.5" height="2" rx="1" fill="currentColor"/>';

function rotateIcon(part: 'hull' | 'turret', dir: 'left' | 'right'): string {
  const arrow =
    dir === 'right'
      ? ROTATE_ARROW
      : `<g transform="translate(24,0) scale(-1,1)">${ROTATE_ARROW}</g>`;
  return (
    '<svg class="hud-rotate-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    arrow +
    (part === 'hull' ? ROTATE_HULL : ROTATE_TURRET) +
    '</svg>'
  );
}

const ROTATE_ICON = {
  hullLeft: rotateIcon('hull', 'left'),
  hullRight: rotateIcon('hull', 'right'),
  turretLeft: rotateIcon('turret', 'left'),
  turretRight: rotateIcon('turret', 'right'),
};

/**
 * What `createHud` may be handed besides its root. Optional as a whole and optional
 * field by field, because `createHud(root)` is the shape ~200 existing tests call and
 * a required dependency would have made this change a rewrite of all of them rather
 * than a behavioural one.
 */
export interface HudOptions {
  /**
   * The retained VS setup (issue #260). WITHOUT it the pane still works and still
   * enforces its own gate -- it simply forgets between page loads, which is exactly
   * what a test that does not care about persistence wants. `createBrowserDeps`
   * (loop.ts) is the one production caller and always supplies it.
   */
  readonly versusSetup?: VersusSetupStore;
  /**
   * The browser-history mirror's host (issue #318). Absent -- every existing test -- means
   * the in-app layer stack alone, with no History call ever made. `createBrowserDeps`
   * passes `browserHistoryHost(window)`, which is `null` where `pushState` is missing.
   */
  readonly history?: HistoryHost | null;
  /**
   * How a control's on-screen rectangle is read for spatial focus movement (issue
   * #495). Defaults to `getBoundingClientRect`; a test hands in a drawn layout, because
   * jsdom reports every rect as empty and geometry then has nothing to follow.
   */
  readonly measure?: (el: HTMLElement) => Rect;
  /**
   * Which menu transition to run (issue #542's `?dev=1&menuTransition=` flag).
   * Absent, `null`, and `'rise'` are the same thing: the shipped crossfade-plus-lift.
   *
   * A CONSTRUCTION argument rather than a setter, which is the opposite of
   * `setReducedMotion` and for the opposite reason. Reduced motion is a player setting
   * that can change while the menu is open, so freezing it at boot would make the toggle
   * appear broken; this is a developer flag read once from the query string, and a
   * setter would add a member to the `Hud` interface, its three ownership `Pick`s and
   * every fake in `loop.test.ts` to model a value that never changes within a page load.
   */
  readonly menuTransition?: MenuTransition | null;
}

export function createHud(root: HTMLElement, opts: HudOptions = {}): Hud {
  const el = document.createElement('div');
  el.className = 'hud';
  /*
   * The alternative transition's modifier, on the HUD ROOT (issue #542).
   *
   * This element and no other, because it is the same element `transitionMs()` reads
   * `--ui-transition-duration` off: a treatment that moves the token (`fade-long`) is
   * picked up through that one existing read, with no second definition of the duration
   * in TypeScript and none needed. A class on `document.documentElement` would still
   * inherit the token down, but it would leak out of the HUD's own subtree and outlive
   * `dispose()`.
   *
   * `rise` and absent both yield `null` here and add nothing, so the SHIPPED transition
   * is literally the shipped path -- see `menuTransitionClass`.
   */
  const treatmentClass = menuTransitionClass(opts.menuTransition ?? null);
  if (treatmentClass !== null) el.classList.add(treatmentClass);
  el.innerHTML = `
    <!-- The application backdrop (issue #317). FIRST in the markup so it paints under
         every other layer, and aria-hidden because it is scenery: it carries no content
         and there is nothing here for a screen reader to announce. Shown on the Main
         Menu only -- see setState, and the .ui-app-ground rule for why not on Launch. -->
    <div class="ui-app-ground ui-app-ground--hidden" aria-hidden="true"></div>
    <div class="hud-topbar">
      <!-- hud-campaign-stat (issue #282): both are campaign-only concepts -- lives is
           the campaign default and a versus world has no enemy-kind tanks (countEnemies
           is always 0 there), so both would read as noise beside the stock readout below.
           The class carries no styling of its own (.hud-stat already does); only its
           --hidden modifier, toggled from applySessionKindSurfaces, does anything. -->
      <div class="hud-stat hud-campaign-stat">Lives: <span class="hud-lives">3</span></div>
      <div class="hud-stat hud-campaign-stat">Enemies: <span class="hud-enemies">3</span></div>
      <div class="hud-stat hud-level hud-level--hidden">Level: <span class="hud-level-num"></span></div>
      <div class="hud-shells hud-shells--hidden"></div>
      <!-- The in-match stock readout (spec §3a): a topbar chip, same tier as
           .hud-shells above -- never an overlay on the arena. Empty/hidden until
           setVersusStocks hands it entries; see that setter's own doc comment on the
           Hud interface for the full visibility rule. -->
      <div class="hud-versus-stocks hud-versus-stocks--hidden"></div>
      <!-- NO AUDIO PAIR HERE since issue #226. A Mute button and a volume slider sat in
           this bar on every surface including the Main Menu, which is what made audio
           the only setting with two permanent homes and no durable one. Both controls
           now live once, in Settings -> Audio; the M shortcut survives and reports
           through a toast ('route-host.ts'), which is the status feedback the button
           label used to carry. What is left in this bar is GAMEPLAY STATUS only, which
           is why the whole bar is now hidden at the Main Menu too -- see setState. -->
    </div>
    <div class="hud-count hud-count--hidden"></div>
    <!-- The blocked-fire capacity flash (issue #516's hud arm). Absolutely positioned
         under the topbar rather than placed IN it, on purpose: a chip in the topbar flow
         would reserve its width for the rest of the session after the first refusal,
         which is the permanent ammunition counter #356 rules out. Nothing here until
         signalShellCapacity fires, and nothing left of it afterwards. aria-hidden because
         it duplicates a state the arena already shows, on every refused trigger pull. -->
    <div class="hud-capacity" aria-hidden="true"></div>
    <div class="hud-damage" aria-hidden="true"></div>
    <!-- Where the thumbs are, drawn back on screen. Playtest feedback: with nothing
         rendered, the aiming thumb gave no clue which way the shot was going, and the
         driving thumb had only feel to go on. aria-hidden because they are a mirror of
         what the player is already doing with their hands. -->
    <div class="hud-touchviz hud-touchviz--hidden" aria-hidden="true">
      <div class="hud-stick hud-stick--hidden">
        <div class="hud-stick-base"></div>
        <div class="hud-stick-knob"></div>
      </div>
      <!-- The aim thumb under the 'stick' scheme: a SECOND ring+knob, structurally
           identical to the driving stick above and reusing its classes -- only the
           wrapper differs, so the clamping logic in setTouchIndicator is shared rather
           than duplicated. Under 'point' this stays hidden and hud-aimdot draws instead. -->
      <div class="hud-aimstick hud-aimstick--hidden">
        <div class="hud-stick-base"></div>
        <div class="hud-stick-knob"></div>
      </div>
      <div class="hud-aimdot hud-aimdot--hidden"></div>
    </div>
    <!-- Touch-only controls. Hidden by default and revealed by a (pointer: coarse)
         media query, so a mouse player never sees a Mine button that Space already
         does -- and a phone gets the only affordance it has for either action. -->
    <div class="hud-touch hud-touch--hidden">
      <button class="hud-pause-btn" type="button" aria-label="Pause">II</button>
      <button class="hud-fire-btn" type="button" aria-label="Fire">FIRE</button>
      <button class="hud-mine-btn" type="button" aria-label="Drop mine">MINE</button>
    </div>
    <!-- The title screen. Deliberately NOT a <button>: any key and any pointer press
         dismiss it, so the whole overlay is the target and a single focusable control
         would understate that. route-host.ts owns the listeners.
         role/aria-label because a screen reader is otherwise told nothing about a
         screen that is blocking the entire game behind it. -->
    <div class="hud-splash hud-splash--hidden" role="dialog" aria-modal="true"
         aria-label="Tanks! title screen. Press any key to begin.">
      <h1 class="hud-splash-title">TANKS!</h1>
      <p class="hud-splash-hint">Press any key or tap to begin</p>
    </div>
    <div class="hud-toasts" aria-live="polite"></div>
    <!-- tabindex="-1" for the same reason .hud-panel carries one: it is what lets
         showAchievements(true) focus the PANE on arrival rather than a control inside it
         (see .hud-panel's own note on why arrivals land on the container). -->
    <div class="hud-achievements hud-achievements--hidden" tabindex="-1" aria-labelledby="hud-achievements-title">
      <h1 id="hud-achievements-title">Records</h1>
      <!-- The Records tab row (issue #226). Both tabs appear in BOTH panes and each
           pane's own tab is the selected one, so the pair reads as one destination with
           two views rather than as two menu entries. 'ui-selectable--on' marks the
           current tab; 'aria-pressed' says the same thing to a screen reader, which is
           what a pair of buttons can honestly claim without a full tablist widget (the
           panes are siblings on the layer stack, not tabpanels inside one container). -->
      <div class="hud-records-tabs" role="group" aria-label="Records views">
        <button class="ui-btn ui-btn--sm ui-selectable hud-records-tab hud-records-tab-stats" type="button" aria-pressed="false">Stats</button>
        <button class="ui-btn ui-btn--sm ui-selectable ui-selectable--on hud-records-tab hud-records-tab-achievements" type="button" aria-pressed="true">Achievements</button>
      </div>
      <p class="hud-achievements-count"></p>
      <div class="hud-achievement-list"></div>
      <button class="ui-btn ui-btn--slab hud-achievements-back" type="button">Back</button>
    </div>
    <!-- The level select panel: reached from the "Levels" button on the main menu,
         following the Stats/Achievements/Customize pattern exactly (issue #135). The
         picker used to sit directly on the menu, competing for space with those three
         buttons; it is now the SAME kind of pane they are, closed unconditionally by
         setState like its siblings. The .hud-levels row carries no hidden class of its
         own -- the panel wrapper is the one chokepoint, same as .hud-achievement-list
         inside .hud-achievements. -->
    <div class="hud-levelselect hud-levelselect--hidden" tabindex="-1" aria-labelledby="hud-levelselect-title">
      <h1 id="hud-levelselect-title">Levels</h1>
      <div class="hud-levels"></div>
      <!-- A locked level is dimmed and unclickable, which says THAT it is unavailable
           and not why (#321). This line is the why, and every locked button points at
           it with aria-describedby; it is hidden outright once nothing is locked, so it
           never explains a state the player is not in. -->
      <p class="ui-hint hud-levels-note hud-levels-note--hidden" id="hud-levels-note">Clear a level to unlock the next.</p>
      <button class="ui-btn ui-btn--slab hud-levelselect-back" type="button">Back</button>
    </div>
    <!-- The controller assignment panel (docs/superpowers/plans/2026-08-17-controller-
         assignment.md): ONE panel, TWO entry points -- the title screen's own open
         button below, and its own presence at 'paused' too (in case a controller
         disconnects mid-round; since issue #226 the pause panel is where that button
         lives, and Settings -> Controls is the durable way in). Unlike its four siblings
         above/below, this one is NOT title-only, so its Back button cannot hardcode
         setState('main-menu') --
         see handleControllersBack, which routes to shownState instead. The heading
         text itself branches on shownState too, in showControllers. -->
    <div class="hud-controllers hud-controllers--hidden" tabindex="-1" aria-labelledby="hud-controllers-title">
      <h1 class="hud-controllers-title" id="hud-controllers-title"></h1>
      <!-- REPLACE, never append -- rebuilt on open and on every detection refresh, same
           convention setLevelSelect already uses for .hud-levels. -->
      <div class="hud-controller-rows"></div>
      <button class="ui-btn ui-btn--slab hud-controllers-back" type="button">Back</button>
    </div>
    <!-- The versus setup pane (docs/superpowers/plans/2026-08-21-versus-setup-menu.md,
         docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md §3): reached from
         the title screen's own Versus button above, following the exact panel template
         Controllers/Customize use (open guarded on actual transition, focus-the-pane,
         REPLACE-never-append rendering, setState's unconditional close below). Rows:
         Mode, Players, Map, Stock, Friendly fire (Teams only -- genuinely absent from
         the DOM under FFA, not merely hidden; see renderVersusFriendlyFireRow), and a
         who's-playing block that is now per-slot ROLE controls writing the retained
         setup (issue #260) -- see renderVersusSlotRows' doc comment for what it
         supersedes. It no longer reuses .hud-controller-row/.hud-controller-source-btn:
         those render a DEVICE assignment for the running session, and conflating the
         two is the divergence #260 removes. (.hud-controllers above still uses them.)
         The unused scoping note that stood here referred to the shared classes
         ancestor in every selector that reads them), the same trick
         .hud-aimstick .hud-stick-base already uses to share .hud-stick-base between
         the driving and aiming sticks. -->
    <div class="hud-versus-setup hud-versus-setup--hidden" tabindex="-1" aria-labelledby="hud-versus-setup-title">
      <h1 id="hud-versus-setup-title">Versus Setup</h1>
      <div class="hud-versus-row">
        <h2>Mode</h2>
        <div class="hud-versus-mode-row"></div>
        <!-- Why Teams is unavailable at this player count (issue #281). Empty and
             hidden whenever it IS available; describeDisabledReason points the Teams
             button at this id so the reason reaches a screen reader. NO BACKTICKS in
             this markup: it lives in a template literal, and one closes the string. -->
        <p class="ui-hint hud-versus-mode-note hud-versus-mode-note--hidden" id="hud-versus-mode-note"></p>
      </div>
      <div class="hud-versus-row">
        <h2>Players</h2>
        <div class="hud-versus-players-row"></div>
      </div>
      <div class="hud-versus-row">
        <h2>Map</h2>
        <div class="hud-versus-map-row"></div>
      </div>
      <div class="hud-versus-row">
        <h2>Stock</h2>
        <div class="hud-versus-stock-row"></div>
      </div>
      <!-- No static heading here -- renderVersusFriendlyFireRow builds the heading
           AND the button together, only under Teams, so the row is genuinely absent
           (not merely hidden) under FFA. -->
      <div class="hud-versus-row hud-versus-friendlyfire-row"></div>
      <!-- The FIXED ordnance limits (issue #268). Read out of the tank configuration at
           render time, never written here: the binding decision is that standard VS has
           no shell/mine cap controls and that the UI must derive the numbers rather than
           duplicate them. Text, not buttons, because it states a rule instead of offering
           one. NO BACKTICKS in this markup: it lives in a template literal. -->
      <div class="hud-versus-row">
        <h2>Standard rules</h2>
        <p class="ui-hint hud-versus-limits"></p>
      </div>
      <div class="hud-versus-row">
        <h2>Who's playing</h2>
        <!-- SUPERSEDED BY ISSUE #260, and the old comment is replaced rather than left
             to mislead. This block used to render the RUNNING session's live
             Assignment -- clicking a candidate reassigned the session behind the pane
             -- and showed this note only when the pane's player count disagreed with
             that session's. Both behaviours were the bug the issue opens with: the pane
             mutated a session that Start then disposes, so what was displayed and what
             launched could differ. The rows below are now SETUP controls that write the
             retained per-slot roles, so the note is unconditionally true and therefore
             unconditionally shown. -->
        <p class="ui-hint hud-versus-assignment-note" id="hud-versus-assignment-note">Devices are assigned to human slots when the match starts.</p>
        <div class="hud-versus-slot-rows"></div>
        <!-- The pane-level refusal, used for the ONE problem kind that names no slot
             (no-human). Per-slot reasons live on their own row; see
             renderVersusSlotRows. -->
        <p class="ui-hint hud-versus-start-reason hud-versus-start-reason--hidden" id="hud-versus-start-reason"></p>
      </div>
      <button class="ui-btn ui-btn--primary hud-versus-start" type="button">Start</button>
      <button class="ui-btn ui-btn--slab hud-versus-back" type="button">Back</button>
    </div>
    <div class="hud-customize hud-customize--hidden" tabindex="-1" aria-labelledby="hud-customize-title">
      <h1 id="hud-customize-title">Customize</h1>
      <!-- The live preview: render/preview.ts builds a SECOND small WebGL scene against
           this canvas, using the SAME tank-building code (render/entities.ts) and skin
           textures (render/skins.ts) the game itself uses -- not a depiction of the
           tank, the tank. Owned as markup here, driven from game/loop.ts via
           onCustomizeOpen/onCustomizeClose (hud.ts stays free of three.js, see the Hud
           interface doc comment on previewCanvas).

           It USED to be aria-hidden, on the reasoning that it only repaints choices
           already exposed as labelled buttons below. That stopped being true when it
           became interactive: render/preview-controls.ts gives it a keyboard scheme,
           and a focusable element inside an aria-hidden subtree is a focus trap for a
           screen-reader user -- tabbable but unannounced. So it is now a labelled,
           focusable control instead, and the label states the scheme, which is also
           one of two places a keyboard-only player could learn it. tabindex is what
           puts it in the pane's tab order at all; a canvas has none by default.
           No explicit role: it is a focusable element with an accessible name, which
           is enough to be announced. An img role would contradict the tabindex (an
           image is not interactive) and an application role hands the whole key
           stream over for the sake of two arrows.

           A focus-gated <p> used to sit here spelling out the keyboard scheme, because
           shift+arrows had no discoverability path for a sighted keyboard user. The row
           of buttons below replaces it and does the job better: it is on screen for
           everyone rather than only for whoever tabs to the canvas, it works for touch
           (which had no path to the scheme at all), and it teaches the hull/turret split
           by showing it as four controls. So the pane is back to no prose. -->
      <canvas class="hud-preview" tabindex="0" title="Drag to turn the hull. Point to aim the turret. Arrow keys turn the hull, shift+arrows turn the turret." aria-label="Tank preview. Drag to turn the hull, or use the left and right arrow keys. Move the pointer over it to aim the turret, or hold shift with the arrow keys."></canvas>
      <!-- The rotate cluster: hull left/right, turret left/right, in that order, with
           hold-to-repeat (render/preview-controls.ts, which reads the data attributes
           below -- an unrecognised pair leaves a button INERT, which is why the exact
           four are pinned in hud.test.ts).

           Four buttons and not a slider: a slider is a linear control for a circular
           quantity, so it needs endpoints that do not exist, wraps badly at 0/360, and
           eats width in a 260px pane.

           Icons only, no visible text: this is a control cluster, not prose, and the
           pane is pinned at two labelled sections. The accessible name is on the button
           via aria-label; the SVGs are aria-hidden so a screen reader reads the name
           once. Each icon carries the SHAPE of what it turns -- a hull plate, or a
           turret with its barrel -- under an arc arrow pointing the way the tank will
           go, which is the same direction the matching arrow key and drag send it. -->
      <div class="hud-preview-rotate">
        <button class="hud-rotate-btn" type="button" data-rotate-part="hull" data-rotate-dir="left" aria-label="Turn hull left" title="Turn hull left (hold to keep turning)">${ROTATE_ICON.hullLeft}</button>
        <button class="hud-rotate-btn" type="button" data-rotate-part="hull" data-rotate-dir="right" aria-label="Turn hull right" title="Turn hull right (hold to keep turning)">${ROTATE_ICON.hullRight}</button>
        <button class="hud-rotate-btn" type="button" data-rotate-part="turret" data-rotate-dir="left" aria-label="Turn turret left" title="Turn turret left (hold to keep turning)">${ROTATE_ICON.turretLeft}</button>
        <button class="hud-rotate-btn" type="button" data-rotate-part="turret" data-rotate-dir="right" aria-label="Turn turret right" title="Turn turret right (hold to keep turning)">${ROTATE_ICON.turretRight}</button>
      </div>
      <section class="hud-customize-section">
        <h2>Hull</h2>
        <div class="hud-swatches"></div>
      </section>
      <section class="hud-customize-section">
        <h2>Skin</h2>
        <div class="hud-skins"></div>
        <div class="hud-accents"></div>
      </section>
      <button class="ui-btn ui-btn--slab hud-customize-back" type="button">Back</button>
    </div>
    <!-- The Stats tab of Records (issue #226). The two RESET buttons that used to sit in
         .hud-stats-actions moved to Settings -> Data: the issue's ruling is that
         "destructive reset/import actions live under Data, not Records", and a page whose
         purpose is reading progress should not put deleting it one mis-click away. -->
    <div class="hud-stats hud-stats--hidden" tabindex="-1" aria-labelledby="hud-stats-title">
      <h1 id="hud-stats-title">Records</h1>
      <div class="hud-records-tabs" role="group" aria-label="Records views">
        <button class="ui-btn ui-btn--sm ui-selectable ui-selectable--on hud-records-tab hud-records-tab-stats" type="button" aria-pressed="true">Stats</button>
        <button class="ui-btn ui-btn--sm ui-selectable hud-records-tab hud-records-tab-achievements" type="button" aria-pressed="false">Achievements</button>
      </div>
      <table class="hud-stats-table"></table>
      <div class="hud-stats-actions">
        <button class="ui-btn ui-btn--slab hud-stats-back" type="button">Back</button>
      </div>
    </div>
    <!-- tabindex="-1" so the menu can RECEIVE focus on every panel-open transition
         (setState('main-menu'/'paused'/'outcome-win'/'outcome-lose')) without joining the
         tab order. An ARRIVAL lands on this container and not on a button inside it
         (Start, Resume, ...): nothing invoked the surface, so there is no control to
         return to, and moveFocus's first ArrowDown reaches control[0] from here as if
         focus had started there. A BACK is different since issue #318: it restores the
         control that opened the layer, which is only workable because loop.ts's
         isMuteHotkey/isPauseHotkey stopped treating a button as a control that consumes
         M, P and Escape -- the broader guard was why an earlier "land already on a
         control" version of this went dead the moment the panel opened, and was
         reverted. -->
    <!-- aria-labelledby on all seven focus-target containers (six as of the controller
         assignment panel, docs/superpowers/plans/2026-08-17-controller-assignment.md;
         seven as of the versus setup pane below): a bare tabindex="-1" div's
         accessible name is the flattened text of EVERYTHING inside it (measured via CDP
         Accessibility.queryAXTree in review -- role generic, name = heading + subtitle +
         every button label concatenated), so pointing each at its own h1 gives the
         screen reader a concise name instead. The panel's h1 changes text per state
         (TANKS!/Paused/You Win...), which is exactly what the name should be. aria-*
         attributes cannot match isMuteHotkey/isPauseHotkey's
         closest('input,select,textarea') guard, so this cannot make the hotkeys go dead
         on the container. -->
    <div class="hud-panel hud-panel--hidden" tabindex="-1" aria-labelledby="hud-panel-title">
      <h1 class="hud-title" id="hud-panel-title"></h1>
      <p class="hud-subtitle"></p>
      <p class="hud-attempt-summary hud-attempt-summary--hidden"></p>
      <p class="hud-coop-kills hud-coop-kills--hidden"></p>
      <p class="hud-versus-results hud-versus-results--hidden"></p>
      <!-- THE MAIN MENU HIERARCHY (issue #226), top to bottom and in exactly the order
           the issue names it: one dominant Campaign action with a run summary above it,
           the two direct play actions, the three compact utilities, and a footer.
           Everything below .hud-action is Main-Menu-only chrome; the pause and outcome
           screens reuse the same panel element and hide all of it (see setState).

           WHAT THIS REPLACED: nine peer .ui-btn--slab siblings in one flat column, plus a
           five-control settings row, all at the same visual weight -- which is the flat
           competition the issue exists to remove. Grouping them into three named regions
           is what lets CSS give each region its own weight without any button here
           learning about layout. -->
      <!-- Where the active run stands, above the primary action it describes. Main-Menu
           only and only while a run exists; setCampaignRun owns the text. -->
      <p class="hud-run-summary hud-run-summary--hidden"></p>
      <!-- The title state's action button, split in two (issue #135): Continue resumes
           at the furthest unlocked level and is offered only once there is something to
           resume; New Game always starts level 1. The .hud-action button itself survives
           for Resume/Next Level/Play Again/Retry -- see setState -- and hides at title.
           Both labels name CAMPAIGN since #226: "Continue"/"New Game" said nothing about
           which of the three play modes they entered, and Versus sat beside them. -->
      <button class="ui-btn ui-btn--primary hud-continue hud-continue--hidden" type="button">Continue Campaign</button>
      <button class="ui-btn ui-btn--primary hud-new-game hud-new-game--hidden" type="button">Start Campaign</button>
      <button class="ui-btn ui-btn--primary hud-action" type="button"></button>
      <!-- The two DIRECT play actions (issue #226 hierarchy step 2). Versus setup entry
           (docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md, ruling 1) is
           MAIN-MENU ONLY -- a live round's mode/players/stock are closed over for its
           whole session (levels.ts's own doc comment, loop.ts's startGameWith), so there
           is nothing it could offer mid-round. See onVersusOpen's own doc comment on the
           Hud interface for why its click handler is a bare passthrough rather than a
           local showX(true) call.

           "Practice", not "Levels": the button opens the level select, and what picking a
           level there DOES is enter practice (see onLevelSelect's own doc comment). The
           old label named the pane rather than the action, which is why a new player had
           no way to tell it from the campaign. -->
      <div class="hud-menu-play hud-menu-play--hidden">
        <button class="ui-btn ui-btn--slab hud-versus-open hud-versus-open--hidden" type="button">Versus</button>
        <button class="ui-btn ui-btn--slab hud-levelselect-open hud-levelselect-open--hidden" type="button">Practice</button>
      </div>
      <!-- The three COMPACT UTILITIES (hierarchy step 3). Records is ONE entry for what
           used to be two peers of the play actions, Stats and Achievements -- they are
           now its two tabs. Settings is the new durable home for audio and the input
           controls that used to be a row on this panel. -->
      <div class="hud-menu-utilities hud-menu-utilities--hidden">
        <button class="ui-btn ui-btn--slab hud-customize-open" type="button">Customize</button>
        <button class="ui-btn ui-btn--slab hud-records-open" type="button">Records</button>
        <button class="ui-btn ui-btn--slab hud-settings-open" type="button">Settings</button>
      </div>
      <!-- A setup-pane versus session's title has nothing for Continue/Practice-open to
           do (see setRelaunchTarget's own doc comment on the Hud interface) -- this
           replaces them with a reboot back to a plain campaign session instead. Hidden
           by default, same convention as every other gated button here; only shown once
           setRelaunchTarget('versus-setup') runs. -->
      <button class="ui-btn ui-btn--slab hud-campaign-open hud-campaign-open--hidden" type="button">Campaign</button>
      <!-- PAUSE ONLY since issue #226, where it used to show at the Main Menu too. The
           issue's ruling: "Controllers are contextual to VS/setup or Controls settings,
           not a permanent top-level destination." The contextual reasons survive -- the
           owner's original "in case controllers disconnect" mid-round is what this
           button is, and Settings -> Controls carries the durable entry point that the
           Main Menu no longer does. -->
      <button class="ui-btn ui-btn--slab hud-controllers-open hud-controllers-open--hidden" type="button">Controllers</button>
      <button class="ui-btn ui-btn--slab hud-quit hud-quit--hidden" type="button">Quit to Title</button>
      <!-- The compact About/Legal utility entry (hierarchy step 5), in its own footer
           region so it reads as the quietest thing on the screen. It opens the same pane
           Settings -> About & Legal does; one destination, two ways in, and the layer
           stack sends Back to whichever of them was used. -->
      <div class="hud-menu-footer hud-menu-footer--hidden">
        <button class="ui-btn ui-btn--sm hud-about-open" type="button">About &amp; Legal</button>
      </div>
    </div>
    <!-- SETTINGS (issue #226), the durable home for every preference that survives a
         reload. Reached from the Main Menu and from Pause, and the layer stack returns
         Back to whichever it was -- which is the spec's "Settings from Pause returns to
         Pause over the same session".

         SECTIONS ARE DECLARED, AND AN EMPTY ONE DOES NOT RENDER. Each section is a
         <section class="hud-settings-section"> whose controls live in one
         .hud-settings-controls child, and 'refreshSettingsSections' hides any section
         with no visible control in it. Accessibility shipped declared and EMPTY until
         issue #289, which is why the rule exists at all; it now carries the motion
         toggle and renders like the rest. The rule is what #227's per-control capability
         hiding leans on in the other direction -- hide every control in a section and it
         collapses with no further change here -- and #290's UI-scale control is the next
         thing to land beside the motion toggle. -->
    <div class="hud-settings hud-settings--hidden" tabindex="-1" aria-labelledby="hud-settings-title">
      <h1 id="hud-settings-title">Settings</h1>
      <section class="hud-settings-section" data-section="audio" aria-labelledby="hud-settings-audio">
        <h2 id="hud-settings-audio">Audio</h2>
        <div class="hud-settings-controls">
          <button class="ui-btn ui-btn--sm hud-settings-mute" type="button">Mute (M)</button>
          <!-- autocomplete="off": Firefox restores form-control values across a soft
               reload and bfcache restore. Without this the slider comes back at the
               user's last position while a freshly-built engine boots at DEFAULT_VOLUME,
               and no 'input' event fires to reconcile them -- reopening the exact
               "slider is lying" bug the retired topbar slider was fixed for. -->
          <input class="hud-settings-volume" type="range" min="0" max="1" step="0.01" autocomplete="off" aria-label="Volume" />
        </div>
      </section>
      <section class="hud-settings-section" data-section="controls" aria-labelledby="hud-settings-controls-h">
        <h2 id="hud-settings-controls-h">Controls</h2>
        <div class="hud-settings-controls">
          <!-- The right thumb's aim scheme. A phone player can only change this here,
               there being no keyboard to bind it to. Label/hint by renderSchemeToggle. -->
          <button class="ui-btn ui-btn--sm hud-scheme-toggle" type="button"></button>
          <!-- How the aim thumb pulls the trigger (see FireMode in touch.ts). The FIRE
               button works in EVERY mode; this only adds a gesture. Label/hint filled in
               by renderFireModeToggle. -->
          <button class="ui-btn ui-btn--sm hud-firemode-toggle" type="button"></button>
          <!-- Whether haptics.ts's vibrate calls fire at all. Filed under Controls rather
               than Accessibility deliberately: it is feedback FROM an input device and it
               lives under 'input' in the settings model, where Accessibility holds the
               presentation policies -- motion below, and the UI scale #290 adds. -->
          <button class="ui-btn ui-btn--sm hud-haptics-toggle" type="button"></button>
          <!-- The durable Controllers entry the Main Menu gave up. -->
          <button class="ui-btn ui-btn--sm hud-settings-controllers" type="button">Controllers</button>
        </div>
      </section>
      <section class="hud-settings-section" data-section="accessibility" aria-labelledby="hud-settings-a11y">
        <h2 id="hud-settings-a11y">Accessibility</h2>
        <div class="hud-settings-controls">
          <!-- How much nonessential movement the game plays (issue #289). Three states,
               because two would make "whatever this device asks for" unsayable. Label and
               hint by renderMotionToggle. -->
          <button class="ui-btn ui-btn--sm hud-motion-toggle" type="button"></button>
          <!-- How much the renderer draws (issue #540): the three presets that were
               reachable only through '?dev=1&quality=' until a preset started deciding
               whether muzzle smoke runs at all. Filed beside Motion because both answer
               "how much of this do you want drawn"; it is the closest existing home, and
               declaring a sixth section is issue #226's call, not this control's. Label
               and hint by renderQualityToggle. -->
          <button class="ui-btn ui-btn--sm hud-quality-toggle" type="button"></button>
        </div>
      </section>
      <section class="hud-settings-section" data-section="data" aria-labelledby="hud-settings-data">
        <h2 id="hud-settings-data">Data</h2>
        <p class="ui-hint">Progress, stats and customization are saved in this browser only.</p>
        <div class="hud-settings-controls">
          <button class="ui-btn ui-btn--sm ui-btn--danger hud-reset-stats hud-danger" type="button">Reset stats</button>
          <button class="ui-btn ui-btn--sm ui-btn--danger hud-reset-progress hud-danger" type="button">Reset progress</button>
        </div>
      </section>
      <section class="hud-settings-section" data-section="about" aria-labelledby="hud-settings-about">
        <h2 id="hud-settings-about">About &amp; Legal</h2>
        <div class="hud-settings-controls">
          <button class="ui-btn ui-btn--sm hud-settings-about" type="button">About &amp; Legal</button>
        </div>
      </section>
      <button class="ui-btn ui-btn--slab hud-settings-back" type="button">Back</button>
    </div>
    <!-- ABOUT & LEGAL (issue #226). One pane, two entry points: the Main Menu footer and
         Settings -> About & Legal. Static prose, so it is markup rather than a render
         function -- there is nothing here derived from state.

         THE STORAGE CLAIM IS CHECKED, NOT ASSERTED: 'src/' contains no 'fetch', no
         'XMLHttpRequest' and no 'sendBeacon', and every persistence path in the build
         goes through 'storage.ts' on an injected 'Storage' (CLAUDE.md's persistence
         invariant). If that stops being true this copy becomes false, which is what the
         guard in hud.controls.test.ts is for. -->
    <div class="hud-about hud-about--hidden" tabindex="-1" aria-labelledby="hud-about-title">
      <h1 id="hud-about-title">About &amp; Legal</h1>
      <p class="hud-about-line">Tanks! is a browser arena shooter.</p>
      <p class="hud-about-line">It runs entirely on this device. Your settings, campaign progress, stats, achievements and customization are saved in this browser's local storage and are never sent anywhere.</p>
      <p class="hud-about-line">Built with Three.js and Howler.js, which are used under their own licences.</p>
      <button class="ui-btn ui-btn--slab hud-about-back" type="button">Back</button>
    </div>
    <!-- THE REPLACE-RUN CONFIRMATION (issue #226): "Starting a replacement campaign
         requires confirmation only when an active run would be lost."

         An 'overlay' layer, not a route, and not a new dialog primitive -- issue #327
         owns dialogs. What 'overlay' buys here is 'navigation.ts''s one rule that a route
         may never be pushed over one, so no menu button can open a pane underneath a
         question the player has not answered. Everything else is the pane mechanism every
         other layer already uses, including Back.

         The DESTRUCTIVE choice is the second button and the safe one is first, so a
         gamepad Confirm on arrival (which lands focus on the first control rather than
         activating it -- see 'act') cannot be one press from deleting a run. -->
    <div class="hud-confirm hud-confirm--hidden" tabindex="-1" role="alertdialog" aria-modal="true" aria-labelledby="hud-confirm-title" aria-describedby="hud-confirm-body">
      <h1 id="hud-confirm-title">Start a new campaign?</h1>
      <p class="hud-confirm-body" id="hud-confirm-body"></p>
      <div class="hud-confirm-actions">
        <button class="ui-btn ui-btn--slab hud-confirm-cancel" type="button">Keep playing</button>
        <button class="ui-btn ui-btn--slab ui-btn--danger hud-confirm-accept" type="button">Start new campaign</button>
      </div>
    </div>
  `;
  root.appendChild(el);

  const appGroundEl = el.querySelector('.ui-app-ground') as HTMLElement;
  const countEl = el.querySelector('.hud-count') as HTMLElement;
  const shellsEl = el.querySelector('.hud-shells') as HTMLElement;
  const capacityEl = el.querySelector('.hud-capacity') as HTMLElement;
  const versusStocksEl = el.querySelector('.hud-versus-stocks') as HTMLElement;
  const damageEl = el.querySelector('.hud-damage') as HTMLElement;
  const splashEl = el.querySelector('.hud-splash') as HTMLElement;
  const touchRow = el.querySelector('.hud-touch') as HTMLElement;
  const pauseBtn = el.querySelector('.hud-pause-btn') as HTMLButtonElement;
  const mineBtn = el.querySelector('.hud-mine-btn') as HTMLButtonElement;
  const fireBtn = el.querySelector('.hud-fire-btn') as HTMLButtonElement;
  const topbarEl = el.querySelector('.hud-topbar') as HTMLElement;
  const touchVizEl = el.querySelector('.hud-touchviz') as HTMLElement;
  const stickEl = el.querySelector('.hud-stick') as HTMLElement;
  const stickBaseEl = el.querySelector('.hud-stick-base') as HTMLElement;
  const stickKnobEl = el.querySelector('.hud-stick-knob') as HTMLElement;
  const aimDotEl = el.querySelector('.hud-aimdot') as HTMLElement;
  const aimStickEl = el.querySelector('.hud-aimstick') as HTMLElement;
  const aimStickBaseEl = el.querySelector('.hud-aimstick .hud-stick-base') as HTMLElement;
  const aimStickKnobEl = el.querySelector('.hud-aimstick .hud-stick-knob') as HTMLElement;
  const livesEl = el.querySelector('.hud-lives') as HTMLElement;
  const enemiesEl = el.querySelector('.hud-enemies') as HTMLElement;
  // Both campaign-only topbar stats, hidden together for a versus session -- see
  // applySessionKindSurfaces below and the markup comment above.
  const campaignStatEls = Array.from(el.querySelectorAll('.hud-campaign-stat')) as HTMLElement[];
  const levelChip = el.querySelector('.hud-level') as HTMLElement;
  const levelNum = el.querySelector('.hud-level-num') as HTMLElement;
  const panel = el.querySelector('.hud-panel') as HTMLElement;
  const titleEl = el.querySelector('.hud-title') as HTMLElement;
  const subtitleEl = el.querySelector('.hud-subtitle') as HTMLElement;
  /**
   * The one write path for the panel subtitle. An empty string HIDES the element rather
   * than leaving it empty in the flow -- see `.hud-subtitle--hidden` in hud.css for why
   * blanking alone is not enough under a gapped flex column.
   */
  function setSubtitle(text: string): void {
    subtitleEl.textContent = text;
    subtitleEl.classList.toggle('hud-subtitle--hidden', text === '');
  }
  const actionBtn = el.querySelector('.hud-action') as HTMLButtonElement;
  const continueBtn = el.querySelector('.hud-continue') as HTMLButtonElement;
  const newGameBtn = el.querySelector('.hud-new-game') as HTMLButtonElement;
  const quitBtn = el.querySelector('.hud-quit') as HTMLButtonElement;
  const runSummaryEl = el.querySelector('.hud-run-summary') as HTMLElement;
  const menuPlayRow = el.querySelector('.hud-menu-play') as HTMLElement;
  const menuUtilitiesRow = el.querySelector('.hud-menu-utilities') as HTMLElement;
  const menuFooterRow = el.querySelector('.hud-menu-footer') as HTMLElement;
  const recordsOpenBtn = el.querySelector('.hud-records-open') as HTMLButtonElement;
  const statsView = el.querySelector('.hud-stats') as HTMLElement;
  const statsTable = el.querySelector('.hud-stats-table') as HTMLElement;
  const statsBackBtn = el.querySelector('.hud-stats-back') as HTMLButtonElement;
  const customizeOpenBtn = el.querySelector('.hud-customize-open') as HTMLButtonElement;
  const customizeView = el.querySelector('.hud-customize') as HTMLElement;
  const previewCanvasEl = el.querySelector('.hud-preview') as HTMLCanvasElement;
  const previewRotateBtns = Array.from(
    el.querySelectorAll('.hud-preview-rotate .hud-rotate-btn'),
  ) as HTMLButtonElement[];
  const swatchesRow = el.querySelector('.hud-swatches') as HTMLElement;
  const accentsRow = el.querySelector('.hud-accents') as HTMLElement;
  const customizeBackBtn = el.querySelector('.hud-customize-back') as HTMLButtonElement;
  const achView = el.querySelector('.hud-achievements') as HTMLElement;
  const achListEl = el.querySelector('.hud-achievement-list') as HTMLElement;
  const achCountEl = el.querySelector('.hud-achievements-count') as HTMLElement;
  const achBackBtn = el.querySelector('.hud-achievements-back') as HTMLButtonElement;
  const toastsEl = el.querySelector('.hud-toasts') as HTMLElement;
  const attemptSummaryEl = el.querySelector('.hud-attempt-summary') as HTMLElement;
  const coopKillsEl = el.querySelector('.hud-coop-kills') as HTMLElement;
  const versusResultsEl = el.querySelector('.hud-versus-results') as HTMLElement;
  const levelSelectOpenBtn = el.querySelector('.hud-levelselect-open') as HTMLButtonElement;
  const levelSelectView = el.querySelector('.hud-levelselect') as HTMLElement;
  const levelSelectBackBtn = el.querySelector('.hud-levelselect-back') as HTMLButtonElement;
  const levelsRow = el.querySelector('.hud-levels') as HTMLElement;
  const controllersOpenBtn = el.querySelector('.hud-controllers-open') as HTMLButtonElement;
  const controllersView = el.querySelector('.hud-controllers') as HTMLElement;
  const controllersTitleEl = el.querySelector('.hud-controllers-title') as HTMLElement;
  const controllerRowsEl = el.querySelector('.hud-controllers .hud-controller-rows') as HTMLElement;
  const controllersBackBtn = el.querySelector('.hud-controllers-back') as HTMLButtonElement;
  const versusOpenBtn = el.querySelector('.hud-versus-open') as HTMLButtonElement;
  const campaignOpenBtn = el.querySelector('.hud-campaign-open') as HTMLButtonElement;
  const versusSetupView = el.querySelector('.hud-versus-setup') as HTMLElement;
  const versusLimitsLine = el.querySelector('.hud-versus-limits') as HTMLElement;
  const versusModeRow = el.querySelector('.hud-versus-mode-row') as HTMLElement;
  const versusModeNoteEl = el.querySelector('.hud-versus-mode-note') as HTMLElement;
  const versusPlayersRow = el.querySelector('.hud-versus-players-row') as HTMLElement;
  const versusMapRow = el.querySelector('.hud-versus-map-row') as HTMLElement;
  const versusStockRow = el.querySelector('.hud-versus-stock-row') as HTMLElement;
  const versusFriendlyFireRow = el.querySelector('.hud-versus-friendlyfire-row') as HTMLElement;
  const versusSlotRowsEl = el.querySelector('.hud-versus-slot-rows') as HTMLElement;
  const versusStartReasonEl = el.querySelector('.hud-versus-start-reason') as HTMLElement;
  const levelsNoteEl = el.querySelector('.hud-levels-note') as HTMLElement;
  const versusStartBtn = el.querySelector('.hud-versus-start') as HTMLButtonElement;
  const versusBackBtn = el.querySelector('.hud-versus-back') as HTMLButtonElement;
  const settingsOpenBtn = el.querySelector('.hud-settings-open') as HTMLButtonElement;
  const settingsView = el.querySelector('.hud-settings') as HTMLElement;
  const settingsBackBtn = el.querySelector('.hud-settings-back') as HTMLButtonElement;
  const settingsSections = Array.from(
    el.querySelectorAll('.hud-settings-section'),
  ) as HTMLElement[];
  const settingsMuteBtn = el.querySelector('.hud-settings-mute') as HTMLButtonElement;
  const settingsVolumeEl = el.querySelector('.hud-settings-volume') as HTMLInputElement;
  const settingsControllersBtn = el.querySelector('.hud-settings-controllers') as HTMLButtonElement;
  const settingsAboutBtn = el.querySelector('.hud-settings-about') as HTMLButtonElement;
  const resetStatsBtn = el.querySelector('.hud-reset-stats') as HTMLButtonElement;
  const resetProgressBtn = el.querySelector('.hud-reset-progress') as HTMLButtonElement;
  const aboutOpenBtn = el.querySelector('.hud-about-open') as HTMLButtonElement;
  const aboutView = el.querySelector('.hud-about') as HTMLElement;
  const aboutBackBtn = el.querySelector('.hud-about-back') as HTMLButtonElement;
  const confirmView = el.querySelector('.hud-confirm') as HTMLElement;
  const confirmBodyEl = el.querySelector('.hud-confirm-body') as HTMLElement;
  const confirmAcceptBtn = el.querySelector('.hud-confirm-accept') as HTMLButtonElement;
  const confirmCancelBtn = el.querySelector('.hud-confirm-cancel') as HTMLButtonElement;
  const recordsTabStatsBtns = Array.from(
    el.querySelectorAll('.hud-records-tab-stats'),
  ) as HTMLButtonElement[];
  const recordsTabAchievementsBtns = Array.from(
    el.querySelectorAll('.hud-records-tab-achievements'),
  ) as HTMLButtonElement[];
  const schemeToggleBtn = el.querySelector('.hud-scheme-toggle') as HTMLButtonElement;
  const firemodeToggleBtn = el.querySelector('.hud-firemode-toggle') as HTMLButtonElement;
  const hapticsToggleBtn = el.querySelector('.hud-haptics-toggle') as HTMLButtonElement;
  const motionToggleBtn = el.querySelector('.hud-motion-toggle') as HTMLButtonElement;
  const qualityToggleBtn = el.querySelector('.hud-quality-toggle') as HTMLButtonElement;

  const muteCbs: Array<() => void> = [];
  const volumeCbs: Array<(v: number) => void> = [];
  const startRestartCbs: Array<() => void> = [];
  const quitCbs: Array<() => void> = [];
  const pauseTapCbs: Array<() => void> = [];
  const mineTapCbs: Array<() => void> = [];
  const fireTapCbs: Array<() => void> = [];
  const onPauseTapClick = (e: Event): void => {
    // Same reason as the Mine button below: without this the tap's compat mousemove
    // reaches the window-bound aim handler and yanks the turret to this corner.
    e.preventDefault();
    for (const cb of pauseTapCbs) cb();
  };
  const onMineTapClick = (e: Event): void => {
    // preventDefault suppresses the compatibility MOUSEMOVE this tap would otherwise
    // synthesise. Measured: it does NOT cause a stray shell -- the compat `mousedown`
    // targets this button and `onMouseDown` is bound to the canvas, a sibling, so it
    // never arrives. What it does do is drag `aim` to the button's corner, because
    // `onMouseMove` IS bound at the window.
    e.preventDefault();
    for (const cb of mineTapCbs) cb();
  };
  // Same call as Mine, but be honest about how much of the work it is doing. Review
  // removed this `preventDefault` and could NOT demonstrate any behavioural difference
  // over 6 trials: `onPointerEnd` is bound at the window and stamps `lastTouchAt` for
  // any touch pointer, including one that never reached the canvas, so this button's own
  // pointerup already refreshes the compat-mouse backstop. It is kept as belt to that
  // braces -- the backstop is a time window, and a tap is not obliged to end promptly.
  //
  // pointerdown, not click, and that part IS load-bearing: Chromium does not synthesise
  // a click for a touch tap while another touch point is active, so a click binding
  // would leave Fire dead whenever a thumb was already driving or aiming.
  const onFireTapClick = (e: Event): void => {
    e.preventDefault();
    for (const cb of fireTapCbs) cb();
  };
  /**
   * The title screen swallows the gesture that dismisses it.
   *
   * Without this, ONE tap in the centre of the screen both left the splash and pressed
   * Start underneath it, so the player never saw the menu -- measured on a Pixel 5, and
   * a centre mouse click does the same thing. The overlay hides on `pointerdown` (loop.ts
   * listens at the window), and the browser then completes the click on whatever is now
   * under the finger, which is exactly where `.hud-action` sits.
   *
   * preventDefault on pointerdown suppresses the compatibility mouse events and the
   * click for that gesture. The window listener still runs -- this does not stop
   * propagation -- so the screen still dismisses.
   */
  const onSplashPointerDown = (e: Event): void => {
    e.preventDefault();
    // Armed by the SPLASH'S OWN pointerdown, not by the state change. That is the
    // distinction that matters: only a pointer gesture landing on the overlay can
    // produce the stray click, so a keyboard dismissal arms nothing, and a later
    // deliberate press is never at risk.
    swallowNextPanelClick = true;
  };
  splashEl.addEventListener('pointerdown', onSplashPointerDown);

  /**
   * ...and swallow the click that same gesture completes on the menu underneath.
   *
   * preventDefault on pointerdown is not enough on its own: Chromium still delivers the
   * click, because the overlay is hidden by the time the finger lifts and the click is
   * then targeted at whatever is now under it -- which is exactly where `.hud-action`
   * sits. Measured on a Pixel 5: one centre tap left the splash AND started the game, so
   * the menu was never seen. A centre mouse click did the same.
   *
   * SCOPED TO THE GESTURE, NOT TO A CLOCK, and that distinction is the whole of it. A
   * first draft gave this a 700ms deadline; review measured the real pointerdown -> click
   * gap at 577-878ms and 16 of 24 taps still skipped the menu. The click is not delivered
   * until the main thread finishes the work that same pointerdown kicked off -- dismiss,
   * state change, music suite swap, HUD re-render -- so any deadline is racing the stall
   * it causes, and on a real phone that stall is longer, not shorter.
   *
   * So: armed by the overlay's own pointerdown, consumed by the next click, and cleared
   * by any pointerdown that is NOT on the overlay. A keyboard dismissal arms nothing, and
   * a stale flag cannot survive the player's next touch anywhere else.
   */
  let swallowNextPanelClick = false;
  const onPanelClickCapture = (e: Event): void => {
    if (!swallowNextPanelClick) return;
    swallowNextPanelClick = false;
    e.preventDefault();
    e.stopPropagation();
  };
  panel.addEventListener('click', onPanelClickCapture, true);

  // Capture phase on the HUD root, so it runs BEFORE the overlay's own handler: root to
  // target means this always disarms first, and the overlay re-arms afterwards only if
  // the press actually landed on it. So there is deliberately NO "was it on the splash?"
  // test here -- an earlier draft had one and it was dead by construction, unreachable by
  // any test, which is worse than not having it.
  const disarm = (): void => {
    swallowNextPanelClick = false;
  };
  el.addEventListener('pointerdown', disarm, true);
  // ...and on a key, because a DRAG dismissal delivers its click to the HUD root rather
  // than into the panel, so the arm is never consumed. Without this, a player who
  // dismissed by dragging and then tabbed to Start lost exactly one Enter -- measured;
  // it self-corrects on the second press, but a keyboard or AT user should not have to
  // press twice.
  el.addEventListener('keydown', disarm, true);

  // pointerdown, NOT click -- the same binding Mine and Fire use, and for a reason that
  // only shows up with two thumbs down. Chromium does not synthesise a `click` for a
  // touch tap while ANOTHER touch point is already active: measured, pointerup reaches
  // the button but no click follows, so a player could not pause while driving or
  // aiming. An isolated tap worked, which is why it survived earlier testing -- and this
  // change is exactly what makes both-thumbs-down the normal state of play, since aiming
  // no longer fires and thumbs linger.
  pauseBtn.addEventListener('pointerdown', onPauseTapClick);
  // pointerdown, not click: a mine wants to land the instant the thumb touches, and
  // click waits for the release.
  mineBtn.addEventListener('pointerdown', onMineTapClick);
  fireBtn.addEventListener('pointerdown', onFireTapClick);
  const resetStatsCbs: Array<() => void> = [];
  const resetProgressCbs: Array<() => void> = [];
  const pickHullCbs: Array<(id: HullColorId) => void> = [];
  let currentHull: HullColorId = PALETTE[0].id;

  // One button per palette entry, built once: the palette is a frozen constant.
  // Their click closures are deliberately NOT in dispose()'s removeEventListener
  // list: nothing outside this subtree holds them, so el.remove() reclaims all of
  // it -- the explicit removals elsewhere cover elements tests re-dispatch into.
  for (const swatch of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-selectable hud-swatch';
    b.dataset.hull = swatch.id;
    b.title = swatch.label;
    b.style.background = swatch.hex;
    b.addEventListener('click', (e) => {
      for (const cb of pickHullCbs) cb(swatch.id);
      if ((e as MouseEvent).detail > 0) b.blur();
    });
    swatchesRow.appendChild(b);
  }

  function renderSwatchSelection(): void {
    for (const b of Array.from(swatchesRow.children) as HTMLButtonElement[]) {
      setSelected(b, b.dataset.hull === currentHull);
    }
  }

  const skinsRow = el.querySelector('.hud-skins') as HTMLElement;
  const pickSkinCbs: Array<(id: SkinId) => void> = [];
  // The controller assignment UI's one write path -- see onReassignSlot's own doc
  // comment. The panel that fires this lands separately; the subscription exists now so
  // loop.ts's reassignSlot has somewhere real to register.
  const reassignSlotCbs: Array<(slot: number, source: SlotSource) => void> = [];
  let earnedIds: ReadonlySet<AchievementId> = new Set();
  let currentSkin: SkinId = SKINS[0].id;

  // One button per skin, built once, like the swatches above -- and like them,
  // the click closures live and die with the subtree.
  for (const skin of SKINS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-btn ui-selectable hud-skin';
    b.dataset.skin = skin.id;
    b.textContent = skin.label;
    b.addEventListener('click', (e) => {
      for (const cb of pickSkinCbs) cb(skin.id);
      if ((e as MouseEvent).detail > 0) b.blur();
    });
    skinsRow.appendChild(b);
  }

  function renderSkinSelection(): void {
    for (const b of Array.from(skinsRow.children) as HTMLButtonElement[]) {
      setSelected(b, b.dataset.skin === currentSkin);
    }
  }

  const pickAccentCbs: Array<(id: AccentId) => void> = [];
  let currentAccent: AccentId = ACCENTS[0].id;
  const customizeOpenCbs: Array<() => void> = [];
  const customizeCloseCbs: Array<() => void> = [];
  const controllersOpenCbs: Array<() => void> = [];
  const controllersCloseCbs: Array<() => void> = [];
  const recordsOpenCbs: Array<() => void> = [];
  let currentAssignment: Assignment = [];
  let currentDetectedPads: readonly DetectedPad[] = [];
  /** Fails closed: see setBotAssignmentAllowed's doc comment on the Hud interface. */
  let botAssignmentAllowedNow = false;

  // One button per accent entry, built once, exactly like the hull swatches above --
  // reusing `.hud-swatch` rather than a new class, since it IS the same control: a
  // colour circle with a selection ring. `auto`'s hex is null (it has none of its own --
  // it derives from whatever hull is picked), so it gets a fixed neutral fill instead of
  // a palette hex, distinguishing it from any real hull or accent colour on screen.
  for (const accentSwatch of ACCENTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-selectable hud-swatch';
    b.dataset.accent = accentSwatch.id;
    b.title = accentSwatch.label;
    b.style.background = accentSwatch.hex ?? '#4a4f58';
    b.addEventListener('click', (e) => {
      for (const cb of pickAccentCbs) cb(accentSwatch.id);
      if ((e as MouseEvent).detail > 0) b.blur();
    });
    accentsRow.appendChild(b);
  }

  function renderAccentSelection(): void {
    for (const b of Array.from(accentsRow.children) as HTMLButtonElement[]) {
      setSelected(b, b.dataset.accent === currentAccent);
    }
  }

  /** The Records table's two columns, and nothing else -- see setStats. */
  let statsData: { lifetime: StatCounts; attempt: StatCounts } | null = null;
  /**
   * The whole win/lose panel, as the session last stated it -- see `GameplayOutcome`.
   * `null` is "nothing to summarise", which is where every fixture that never calls
   * `setOutcome` stays, so all three lines below hide and the action button keeps its
   * campaign wording.
   */
  let outcomeData: GameplayOutcome | null = null;
  /**
   * Whether a SURFACE that shows the outcome panel is up, maintained by `setState`
   * alone.
   *
   * The `versusStocksVisible` variable further down documents, at length, the bug that
   * comes of asking an element's own `--hidden` class this question instead: each render
   * below re-hides its line whenever the data says the line has nothing to show, so the
   * class conflates "the surface wants this visible" with "the last render happened to
   * find data". The two disagree on exactly the path production takes -- `setState`
   * flips to `outcome-win` on the winning frame's `SimEvent`, and the tally that belongs
   * on the panel arrives afterwards in the same frame's `setOutcome` -- so a classList
   * guard here would drop the first push into a freshly opened panel whenever the line
   * was empty when it opened. Same lesson, written down once more because the three
   * setters merged into `setOutcome` each carried that classList guard of their own, so
   * a merge that kept the habit would have got it wrong three times at once.
   */
  let outcomeVisible = false;
  /** `null` means "never show" (not a versus session, campaign always passes this) --
   *  see setVersusStocks' own doc comment on the Hud interface. */
  let versusStocksData: { slot: number; stock: number; team?: number }[] | null = null;
  /**
   * The surface+sessionKind visibility GATE for the stock strip, maintained here as its
   * own variable rather than read back off `versusStocksEl`'s classList (fix, review of
   * this task's own first landing). The DOM class is not a safe proxy for "should this
   * be showing": `renderVersusStocks` ALSO writes that same class off `versusStocksData`
   * alone (it re-adds `--hidden` whenever there is no data yet, regardless of state), so
   * reading the class back conflated two different questions -- "are we in a state that
   * wants this visible" and "did the last render happen to find data" -- and production
   * hits exactly the case where they disagree: `setState('playing')` always runs BEFORE
   * the first `setVersusStocks` call (no `SimEvent` marks "a versus match just started";
   * `onFrameEvents` only fires once something has actually happened), so at that first
   * `setState('playing')`, `renderVersusStocks` ran with `versusStocksData` still `null`
   * and left the class `--hidden` -- and the OLD guard here
   * (`!versusStocksEl.classList.contains(...)`) then read that same `--hidden` and
   * refused to render the very first real `setVersusStocks` call, permanently (nothing
   * else touches the class until the next `setState` call -- a pause, if the player
   * happens to hit one). This variable is set ONLY by `setState`, never by
   * `renderVersusStocks`, so a data-driven re-hide can never masquerade as a state-driven
   * one.
   */
  let versusStocksVisible = false;

  const pct = (num: number, den: number): string =>
    den === 0 ? '--' : `${Math.round((num / den) * 100)}%`;

  /** The page's rows: label + a getter, so both columns derive from one list. */
  const STAT_ROWS: Array<[string, (c: StatCounts) => string]> = [
    ['Shell kills', (c) => String(c.shellKills)],
    ['Mine kills', (c) => String(c.mineKills)],
    ['Deaths', (c) => String(c.deaths)],
    ['Self kills', (c) => String(c.selfKills)],
    ['AI friendly fire', (c) => String(c.friendlyFireKills)],
    ['Shots fired', (c) => String(c.shotsFired)],
    ['Accuracy', (c) => pct(c.shellKills, c.shotsFired)],
    ['Mines laid', (c) => String(c.minesLaid)],
    ['Mine accuracy', (c) => pct(c.mineKills, c.minesLaid)],
    ['Walls destroyed', (c) => String(c.wallsDestroyed)],
    ['Ricochets', (c) => String(c.ricochets)],
  ];

  function renderStatsTable(): void {
    if (!statsData) return;
    const { lifetime, attempt } = statsData;
    const rows = STAT_ROWS.map(
      ([label, get]) => `<tr><th>${label}</th><td>${get(lifetime)}</td><td>${get(attempt)}</td></tr>`,
    ).join('');
    statsTable.innerHTML = `<tr><th></th><td>Lifetime</td><td>This run</td></tr>${rows}`;
  }

  function renderAttemptSummary(): void {
    if (!outcomeData) {
      attemptSummaryEl.classList.add('hud-attempt-summary--hidden');
      return;
    }
    const r = outcomeData.attempt;
    const kills = r.shellKills + r.mineKills;
    attemptSummaryEl.textContent =
      `This run: ${kills} kills · ${r.deaths} deaths · ${pct(r.shellKills, r.shotsFired)} accuracy`;
    attemptSummaryEl.classList.remove('hud-attempt-summary--hidden');
  }

  /**
   * Twin of renderAttemptSummary, one line below it, and the reason a solo outcome is
   * its own `tally` rather than a coop one with an empty array: a 1P session has no
   * second player to report, so the line is absent rather than showing zeroes for a
   * teammate who was never there.
   */
  function renderCoopKillLine(): void {
    if (outcomeData?.tally !== 'coop') {
      coopKillsEl.classList.add('hud-coop-kills--hidden');
      return;
    }
    const [p1, p2] = outcomeData.kills;
    coopKillsEl.textContent = `P1: ${p1 ?? 0} · P2: ${p2 ?? 0}`;
    coopKillsEl.classList.remove('hud-coop-kills--hidden');
  }

  /**
   * Twin of renderCoopKillLine, one line below it -- a separate element rather than a
   * branch inside that one, because the two say different things (enemies killed in
   * campaign coop; players killed and lost in versus) and a session has exactly one of
   * them, which is what `GameplayOutcome`'s `tally` now states.
   *
   * `'teams'` sums kills/deaths PER TEAM (`teamOf(slot)`) rather than showing one entry
   * per slot: teams mode cares which SIDE won. `'ffa'` shows one entry per slot,
   * kills/deaths as `k/d`.
   */
  function renderVersusResultsLine(): void {
    if (outcomeData?.tally !== 'ffa' && outcomeData?.tally !== 'teams') {
      versusResultsEl.classList.add('hud-versus-results--hidden');
      return;
    }
    const { tally, kills, deaths } = outcomeData;
    const slots = Math.max(kills.length, deaths.length);
    let text: string;
    if (tally === 'teams') {
      const teamKills = [0, 0];
      const teamDeaths = [0, 0];
      for (let slot = 0; slot < slots; slot++) {
        const team = teamOf(slot);
        teamKills[team] += kills[slot] ?? 0;
        teamDeaths[team] += deaths[slot] ?? 0;
      }
      text = `Team 1: ${teamKills[0]}/${teamDeaths[0]} · Team 2: ${teamKills[1]}/${teamDeaths[1]}`;
    } else {
      const parts: string[] = [];
      for (let slot = 0; slot < slots; slot++) {
        parts.push(`P${slot + 1}: ${kills[slot] ?? 0}/${deaths[slot] ?? 0}`);
      }
      text = parts.join(' · ');
    }
    versusResultsEl.textContent = text;
    versusResultsEl.classList.remove('hud-versus-results--hidden');
  }

  /**
   * The outcome panel's three lines, always together: they are one projection's three
   * views, and rendering a subset is how they used to drift apart.
   */
  function renderOutcomeLines(): void {
    renderAttemptSummary();
    renderCoopKillLine();
    renderVersusResultsLine();
  }

  /**
   * The in-match stock strip -- see setVersusStocks' own doc comment on the Hud
   * interface for the full contract. Rebuilt from scratch on every call (at most 4
   * entries, the identity palette's own cap -- entities.ts's own IDENTITY_RING_COLORS
   * comment) rather than diffed, the same "cheap enough to just rebuild" precedent
   * renderAchievements/renderVersusSlotRows already use elsewhere in this file.
   * ONE ELEMENT PER ENTRY, not one joined string like renderVersusResultsLine above:
   * each slot needs its OWN inline tint, which a single text node cannot carry part of.
   */
  function renderVersusStocks(): void {
    versusStocksEl.replaceChildren();
    if (!versusStocksData || versusStocksData.length === 0) {
      versusStocksEl.classList.add('hud-versus-stocks--hidden');
      return;
    }
    for (const entry of versusStocksData) {
      const span = document.createElement('span');
      span.className = 'hud-versus-stock-entry';
      // The TEAM LETTER beside the player number, in teams mode (issue #281). Colour is
      // not the only channel the readout carries the side on: a colour-blind player, a
      // forced-colours palette (#368 replaces authored hues outright) and a greyscale
      // screenshot all lose the hue and keep the letter. Same A/B/C the setup pane's team
      // selector shows, so the readout and the control that set it agree.
      const teamMark = entry.team !== undefined ? ` ${TEAM_LABELS[entry.team] ?? '?'}` : '';
      span.textContent = `P${entry.slot + 1}${teamMark} ${entry.stock}`;
      // teams: TEAM_COLORS[team]; ffa (no `team` on the entry): IDENTITY_RING_COLORS[
      // slot] -- the SAME dispatch entities.ts's own ring/tint colouring uses at its
      // `mode === 'teams' ? teamColor(...) : identityColor(...)` site, imported rather
      // than copied out as literal hex (see setVersusStocks' own doc comment). The
      // `?? 0xffffff` fallback is unreached today -- both palettes cover every slot the
      // n-player cap (4) allows, and TEAM_COLORS covers all three teams issue #281 permits
      // -- kept only so a future out-of-range slot degrades to a colour rather than an NaN
      // hex string. It was REACHABLE between #281's descriptor landing and TEAM_COLORS
      // gaining its third entry: a 2v1v1 rendered team 2's stock white, which is also the
      // unstyled-slot placeholder.
      const hex = entry.team !== undefined ? (TEAM_COLORS[entry.team] ?? 0xffffff) : (IDENTITY_RING_COLORS[entry.slot] ?? 0xffffff);
      span.style.color = cssColor(hex);
      versusStocksEl.appendChild(span);
    }
    versusStocksEl.classList.remove('hud-versus-stocks--hidden');
  }

  /**
   * Two-click confirm: the first click arms, the second within the window fires.
   * One armed button at a time -- arming Reset stats must not leave Reset progress
   * one accidental click from firing.
   */
  let armedReset: { btn: HTMLButtonElement; timer: ReturnType<typeof setTimeout> } | null = null;

  /**
   * The resolved reduced-motion policy (issue #364), pushed by `hud.setReducedMotion`.
   *
   * A SETTER, not a construction argument, and not the raw media query. The player can
   * change this in Settings while the menu is open, and `effective-settings.ts` is the
   * only place allowed to resolve `'system'` against the OS -- a `createHud` parameter
   * would freeze whichever answer was true at boot, which for this setting means the
   * change appears to do nothing until a reboot.
   */
  let reducedMotion = false;

  /**
   * How long one transition lasts, in milliseconds, READ FRESH each time.
   *
   * The value comes from `--ui-transition-duration` in `hud.css`, which is its single
   * definition (issue #364, criterion 1). Nothing here mirrors that number: an unreadable
   * or unparseable value yields 0, which the runner treats as instant. So a build whose
   * stylesheet failed to load loses the animation rather than gaining a second constant
   * that can drift from the one in the stylesheet -- and, usefully, every existing
   * `hud.test.ts` fixture (which mounts no stylesheet) keeps its original synchronous
   * behaviour for free.
   */
  function transitionMs(): number {
    if (reducedMotion) return 0;
    const raw = getComputedStyle(el).getPropertyValue('--ui-transition-duration').trim();
    if (raw === '') return 0;
    // `150ms` or `0.15s`; anything else is a stylesheet this build does not understand,
    // and instant is the safe reading of that.
    const ms = /^([\d.]+)ms$/.exec(raw);
    if (ms) return Number(ms[1]);
    const sec = /^([\d.]+)s$/.exec(raw);
    if (sec) return Number(sec[1]) * 1000;
    return 0;
  }

  const transitions = createTransitionRunner({
    durationMs: transitionMs,
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (h) => clearTimeout(h),
  });

  /**
   * The application surfaces this contract moves between. One entry per screen, so a
   * screen's hidden-class name is written once rather than at each of its call sites.
   */
  interface Surface {
    readonly el: HTMLElement;
    readonly hidden: string;
  }
  const PANEL_SURFACE: Surface = { el: panel, hidden: 'hud-panel--hidden' };
  const STATS_SURFACE: Surface = { el: statsView, hidden: 'hud-stats--hidden' };
  const CUSTOMIZE_SURFACE: Surface = { el: customizeView, hidden: 'hud-customize--hidden' };
  const ACH_SURFACE: Surface = { el: achView, hidden: 'hud-achievements--hidden' };
  const LEVELSELECT_SURFACE: Surface = { el: levelSelectView, hidden: 'hud-levelselect--hidden' };
  const CONTROLLERS_SURFACE: Surface = { el: controllersView, hidden: 'hud-controllers--hidden' };
  const VERSUS_SETUP_SURFACE: Surface = { el: versusSetupView, hidden: 'hud-versus-setup--hidden' };
  const SETTINGS_SURFACE: Surface = { el: settingsView, hidden: 'hud-settings--hidden' };
  const ABOUT_SURFACE: Surface = { el: aboutView, hidden: 'hud-about--hidden' };
  const CONFIRM_SURFACE: Surface = { el: confirmView, hidden: 'hud-confirm--hidden' };
  /**
   * The two surfaces `setState` moves between that are NOT in the panel family, plus the
   * backdrop underneath them (issue #317's shell-owned ground).
   *
   * Worth stating plainly, because it narrows what "screen to screen" can even mean here:
   * `main-menu`, `paused`, `outcome-win` and `outcome-lose` are four CONTENT states of the
   * one `.hud-panel` element, so moving between them changes no surface at all. The only
   * navigation in `setState` that swaps one element for another is `launch <-> main-menu`.
   */
  const SPLASH_SURFACE: Surface = { el: splashEl, hidden: 'hud-splash--hidden' };
  const GROUND_SURFACE: Surface = { el: appGroundEl, hidden: 'ui-app-ground--hidden' };

  /** Every surface the player can be ON, in the paint order `activePanelContainer` uses. */
  const PANEL_FAMILY: readonly Surface[] = [
    PANEL_SURFACE,
    CUSTOMIZE_SURFACE,
    STATS_SURFACE,
    ACH_SURFACE,
    LEVELSELECT_SURFACE,
    CONTROLLERS_SURFACE,
    VERSUS_SETUP_SURFACE,
    SETTINGS_SURFACE,
    ABOUT_SURFACE,
    CONFIRM_SURFACE,
  ];

  const ENTERING = 'ui-surface--entering';
  const LEAVING = 'ui-surface--leaving';

  /**
   * Replace one application surface with another, through the one contract.
   *
   * Every panel helper below is this call plus its own render step: they all had the
   * identical two `classList.toggle` lines and a focus, written out six times, which is
   * exactly what made "no screen has its own copy" false and left nothing able to
   * interrupt a transition already in flight.
   *
   * `onBegin` runs at the START -- so focus lands on the destination before the animation
   * ends (criterion 4) rather than racing it, and a panel that renders its contents does
   * so while it is fading in rather than popping afterwards.
   */
  /**
   * Is this surface currently the open one?
   *
   * NOT just "lacks its hidden class". A surface keeps that class off for the whole
   * crossfade out, so during those 150ms the bare check answers "open" for a screen the
   * player has already left -- which fired Customize's and Controllers' close callbacks a
   * second time when `setState`'s unconditional close followed a Back button through the
   * same window. Those callbacks build and dispose a live WebGL preview, so a duplicate is
   * not cosmetic.
   */
  function isSurfaceOpen(surface: { el: HTMLElement; hidden: string }): boolean {
    return !surface.el.classList.contains(surface.hidden) && !surface.el.classList.contains(LEAVING);
  }

  /**
   * ONE navigation, however many surfaces it moves.
   *
   * A single `run` per navigation and not one per element, which is a correctness point
   * rather than a saving: the runner settles whatever is outstanding before scheduling
   * anything new, so a second `run` for the same navigation would collapse the first into
   * the very cut this contract exists to remove. `launch -> main-menu` moves three
   * surfaces at once -- the title screen out, the menu and the backdrop in -- and they
   * have to crossfade together or the backdrop cuts in under a fading title.
   *
   * Takes the DESIRED end state rather than explicit leaving/entering lists, and diffs it
   * inside `begin`. That placement matters: `begin` runs after the runner has drained any
   * outstanding transition, so "is this surface already where I want it?" reads settled
   * classes rather than the half-applied state of a crossfade this call is superseding.
   * A surface already in the wanted state is left alone, so a repeated `setState` neither
   * re-animates nor re-arms a timer.
   */
  function transitionTo(
    desired: readonly (readonly [Surface, boolean])[],
    onBegin?: () => void,
    instant = false,
  ): void {
    /*
     * NOTHING TO MOVE IS NOT A NAVIGATION, and it must not disturb one that is in flight.
     *
     * `transitions.run` drains the outstanding chain before it begins -- that is the
     * interrupt rule criterion 3 needs. The cost of applying it unconditionally is that a
     * REDUNDANT call collapses a crossfade it has nothing to add to, and every panel's
     * Back button made exactly that call: `showX(false)` starts the close, and the
     * `setState('main-menu')` on the next line (there to re-render the panel's contents)
     * asks for a state the close is already arriving at. Back was its own interrupter, so
     * closing a panel cut while opening one faded -- five handlers, all of them.
     *
     * Measured in the shipped build rather than reasoned about: the open applied
     * `ui-surface-out` at `0.15s`, the close applied no `ui-surface-*` class at all, and
     * deleting the single `setState` line from one handler restored the crossfade for that
     * one panel.
     *
     * Checked BEFORE `run`, deliberately. Doing it inside `begin` -- where the same diff
     * already skips individual surfaces -- would be too late: the drain has happened by
     * then. `isSurfaceOpen` discounts a surface that is fading out, so a surface heading
     * for the state we want reads as already there and this stays a no-op for it.
     *
     * A genuine navigation still moves at least one surface, so it still drains and still
     * resolves to the second destination. `onBegin` still runs, matching `closeSurface`'s
     * own already-closed early return: the callback is owed either way.
     */
    if (!desired.some(([surface, want]) => want !== isSurfaceOpen(surface))) {
      onBegin?.();
      return;
    }
    let leaving: Surface[] = [];
    let entering: Surface[] = [];
    transitions.run(
      () => {
        leaving = [];
        entering = [];
        for (const [surface, want] of desired) {
          if (want === isSurfaceOpen(surface)) continue;
          if (want) {
            surface.el.classList.remove(surface.hidden);
            surface.el.classList.add(ENTERING);
            entering.push(surface);
          } else {
            // The outgoing surface keeps its `--hidden` OFF until the settle below: it has
            // to stay displayed to be seen fading, and `display: none` cannot be animated
            // out of.
            surface.el.classList.add(LEAVING);
            leaving.push(surface);
          }
        }
        onBegin?.();
      },
      () => {
        for (const surface of leaving) {
          surface.el.classList.add(surface.hidden);
          surface.el.classList.remove(LEAVING);
        }
        for (const surface of entering) surface.el.classList.remove(ENTERING);
      },
      instant,
    );
  }

  /** The pair case: replace one surface with another. */
  function swapSurface(
    from: Surface,
    to: Surface,
    onBegin?: () => void,
    instant = false,
  ): void {
    transitionTo(
      [
        [from, false],
        [to, true],
      ],
      onBegin,
      instant,
    );
  }

  /**
   * Close one panel and return to the menu -- the mirror of an `openSurface()` open.
   *
   * A NO-OP when that pane is not the one on screen, which is the half the old
   * unconditional `panel.classList.toggle('hud-panel--hidden', show)` got wrong for free
   * and a diffing transition cannot. `setState` closes all six panes on every state
   * change, so an unguarded close REVEALED the menu panel -- on the boot path into
   * `launch`, where the menu must stay hidden behind the title screen, and again on the
   * way into `playing`, where it must stay hidden behind the game. `setState` decides the
   * panel's own visibility a few lines later; a close's job is only to put its own pane
   * away.
   */
  function closeSurface(from: Surface, onBegin?: () => void, instant = false): void {
    if (!isSurfaceOpen(from)) {
      // Still owed: the callback half. `showCustomize`/`showControllers` guard their own
      // on `wasOpen`, so passing it through here would double-guard rather than skip.
      onBegin?.();
      return;
    }
    swapSurface(from, PANEL_SURFACE, onBegin, instant);
  }

  /**
   * The surface the player is actually ON, which is not always the one a panel helper
   * would assume it is leaving.
   *
   * Every `show*` helper below used to name `PANEL_SURFACE` as its source, because before
   * this contract a panel could only ever be reached from the menu. A transition is
   * interruptible now, so a second navigation can arrive while a THIRD screen is the one
   * on screen -- and issue #364's third criterion is that such an interrupt leaves no
   * intermediate screen visible. Sourcing the transition from whatever is genuinely open
   * makes that true for any pair, rather than only for the pairs that start at the menu.
   *
   * Safe to read before the runner drains: `isSurfaceOpen` already discounts a surface
   * that is fading out, so the answer does not change when the outstanding transition
   * settles.
   *
   * ONE DIRECTION ONLY. OPENING a panel leaves wherever the player happens to be, so this
   * is the honest source. CLOSING one is a statement about that specific pane, and names
   * its own surface. Using it for both was measured wrong rather than merely redundant:
   * `setState` closes Customize and then Controllers in sequence, so a Customize close
   * sourced from "whatever is open" hid the CONTROLLERS pane instead, and the controllers
   * close that followed saw nothing open and never fired `onControllersClose` -- leaking
   * the live gamepadconnected listeners that callback exists to tear down.
   */
  function openSurface(): Surface {
    for (const surface of PANEL_FAMILY) if (isSurfaceOpen(surface)) return surface;
    // Nothing open means `launch` or `playing`; the menu is where a panel Back lands.
    return PANEL_SURFACE;
  }

  function disarmReset(): void {
    if (!armedReset) return;
    clearTimeout(armedReset.timer);
    armedReset.btn.textContent = armedReset.btn === resetStatsBtn ? 'Reset stats' : 'Reset progress';
    armedReset.btn.classList.remove('hud-danger--armed');
    armedReset = null;
  }

  function handleDangerClick(btn: HTMLButtonElement, cbs: Array<() => void>): void {
    if (armedReset?.btn === btn) {
      disarmReset();
      for (const cb of cbs) cb();
      return;
    }
    disarmReset();
    btn.textContent = 'Really reset?';
    btn.classList.add('hud-danger--armed');
    armedReset = { btn, timer: setTimeout(disarmReset, 4000) };
  }

  /**
   * Hand the Records tables their numbers, immediately before the pane renders them.
   *
   * Placed before the render rather than after it (the order `showCustomize` and
   * `showControllers` use) so the pane is drawn once from the values it is about to show.
   * That is a saving, not a correctness point -- `setStats` and `setAchievements` both
   * re-render while their pane is visible, so either order settles on the same table.
   *
   * Unguarded, unlike those two callbacks: a redundant fire here re-reads a store and
   * re-renders a table, where theirs would build a second WebGL context or leak a pair of
   * window listeners. That is why Records needs no `wasOpen` snapshot and no close hook.
   */
  function paintRecords(): void {
    for (const cb of recordsOpenCbs) cb();
  }

  function showStats(show: boolean): void {
    disarmReset(); // entering OR leaving, no reset stays one click from firing
    if (show) {
      swapSurface(openSurface(), STATS_SURFACE, () => {
        paintRecords();
        renderStatsTable();
        // The PANE, not its first button -- see the roving-focus doc comment below on why
        // every panel-open transition focuses the container rather than a control.
        statsView.focus();
      });
    } else {
      closeSurface(STATS_SURFACE);
    }
  }

  // The single chokepoint for both the panel's own Back button AND setState's
  // unconditional close (below) -- see onCustomizeOpen/onCustomizeClose's doc comment.
  // Guarded on the ACTUAL transition so a caller building/disposing the live preview
  // off these never sees a redundant open or a redundant dispose.
  function showCustomize(show: boolean, instant = false): void {
    // Read BEFORE the transition begins -- see `isSurfaceOpen` for why "not hidden" alone
    // is the wrong question during a crossfade.
    const wasOpen = isSurfaceOpen(CUSTOMIZE_SURFACE);
    if (show) {
      swapSurface(openSurface(), CUSTOMIZE_SURFACE, () => {
        renderSwatchSelection();
        renderSkinSelection();
        renderAccentSelection();
        customizeView.focus(); // the pane, not the canvas -- see the roving-focus comment below
        if (!wasOpen) for (const cb of customizeOpenCbs) cb();
      });
    } else {
      closeSurface(
        CUSTOMIZE_SURFACE,
        () => {
          if (wasOpen) for (const cb of customizeCloseCbs) cb();
        },
        instant,
      );
    }
  }

  // Rebuilt on open rather than once: the earned set changes DURING a session, and
  // a list built at construction would show every row locked forever.
  function renderAchievements(): void {
    achListEl.replaceChildren();
    for (const a of ACHIEVEMENTS) {
      const got = earnedIds.has(a.id);
      const row = document.createElement('div');
      row.className = got ? 'hud-achievement hud-achievement--earned' : 'hud-achievement';
      row.dataset.achievement = a.id;
      const name = document.createElement('span');
      name.className = 'hud-achievement-label';
      name.textContent = a.label;
      const desc = document.createElement('span');
      desc.className = 'hud-achievement-desc';
      // Locked entries keep their criteria visible: the list doubles as the
      // to-do, and later as the place unlock gating is explained.
      desc.textContent = a.description;
      row.append(name, desc);
      achListEl.appendChild(row);
    }
    achCountEl.textContent = `${earnedIds.size} of ${ACHIEVEMENTS.length} earned`;
  }

  function showAchievements(show: boolean): void {
    if (show) {
      swapSurface(openSurface(), ACH_SURFACE, () => {
        paintRecords();
        renderAchievements();
        achView.focus();
      });
    } else {
      closeSurface(ACH_SURFACE);
    }
  }

  // Same shape as showAchievements: no open/close callbacks (nothing here owns a WebGL
  // context the way Customize does), and no re-render on open -- setLevelSelect already
  // keeps `.hud-levels` current regardless of visibility ("REPLACE, never append").
  function showLevelSelect(show: boolean): void {
    if (show) swapSurface(openSurface(), LEVELSELECT_SURFACE, () => levelSelectView.focus());
    else closeSurface(LEVELSELECT_SURFACE);
  }

  /**
   * ONLY SECTIONS WITH RELEVANT CONTROLS RENDER (issue #226).
   *
   * The rule reads the DOM rather than a maintained list of "which sections exist today":
   * a section is shown iff its own `.hud-settings-controls` holds at least one control
   * that `focusableControls` would sweep -- the SAME predicate that decides what a
   * keyboard or D-pad can reach, so a section that renders always has something to walk
   * to and a section that does not can never strand the roving focus inside a heading.
   *
   * Called on every open rather than once at construction, because the inputs are not
   * fixed for the HUD's life: #227 hides individual touch/haptic controls on capability,
   * and #290 still adds a UI-scale control beside the motion toggle #289 put in
   * Accessibility. Both land as changes to which controls are visible, with nothing to
   * add here.
   *
   * Deliberately NOT reading `getComputedStyle` on the section itself -- that is what
   * this function writes -- and deliberately counting controls, not children: the Data
   * section carries a `.ui-hint` paragraph that is content, not a control, and a section
   * that had only prose left would be a heading over an explanation of nothing.
   */
  function refreshSettingsSections(): void {
    for (const section of settingsSections) {
      const controls = section.querySelector('.hud-settings-controls') as HTMLElement | null;
      const populated = controls !== null && focusableControls(controls).length > 0;
      section.classList.toggle('hud-settings-section--hidden', !populated);
    }
  }

  // Same shape as showAchievements. The sections are refreshed at OPEN, inside `onBegin`,
  // so the pane is measured with its real content on the frame it arrives -- a refresh
  // after the transition settled would let a section pop in behind the fade.
  function showSettings(show: boolean): void {
    if (show) {
      swapSurface(openSurface(), SETTINGS_SURFACE, () => {
        refreshSettingsSections();
        settingsView.focus();
      });
    } else {
      closeSurface(SETTINGS_SURFACE);
    }
  }

  // Static prose: nothing to render on open, so this is the smallest of the panes.
  function showAbout(show: boolean): void {
    if (show) swapSurface(openSurface(), ABOUT_SURFACE, () => aboutView.focus());
    else closeSurface(ABOUT_SURFACE);
  }

  /**
   * The replace-run confirmation. Its body is written from the run summary the Main Menu
   * is already showing, so the question names the run it would destroy rather than
   * warning about runs in general.
   */
  function showConfirmNewCampaign(show: boolean): void {
    if (show) {
      swapSurface(openSurface(), CONFIRM_SURFACE, () => {
        confirmBodyEl.textContent = confirmNewCampaignBody();
        confirmView.focus();
      });
    } else {
      closeSurface(CONFIRM_SURFACE);
    }
  }

  /**
   * A candidate/current source's label. `'gamepad'` looks its `id` up in
   * `currentDetectedPads` -- the panel's own live list, not a cached name -- falling
   * back to `Controller ${padIndex}` when the browser reports an empty id (or, for a
   * currently-assigned-but-disconnected pad, when the index is not in the list at all:
   * a pad's id is unknowable once unplugged, so this is the honest fallback for both
   * cases, not two different ones).
   */
  function slotSourceLabel(source: SlotSource): string {
    switch (source.kind) {
      case 'keyboard':
        return 'Keyboard / Mouse / Touch';
      case 'bot':
        return 'Bot';
      case 'none':
        return 'Unassigned';
      case 'gamepad': {
        const live = currentDetectedPads.find((p) => p.padIndex === source.padIndex);
        const name = live && live.id.length > 0 ? live.id : `Controller ${source.padIndex}`;
        return `${name} (index ${source.padIndex})`;
      }
    }
  }

  /** The short label a CANDIDATE button carries -- `slotSourceLabel` minus the "Keyboard
   *  / Mouse / Touch" and "Unassigned" prose, which read fine as a current-state summary
   *  but not as a button someone is about to click. */
  function candidateLabel(source: SlotSource): string {
    switch (source.kind) {
      case 'keyboard':
        return 'Keyboard';
      case 'bot':
        return 'Bot';
      case 'none':
        return 'None';
      case 'gamepad':
        return slotSourceLabel(source);
    }
  }

  function sameSource(a: SlotSource, b: SlotSource): boolean {
    if (a.kind !== b.kind) return false;
    return a.kind === 'gamepad' && b.kind === 'gamepad' ? a.padIndex === b.padIndex : true;
  }

  /**
   * REPLACE, never append -- the same "REPLACE, never append" convention `setLevelSelect`
   * already uses, rebuilt on open and on every detection refresh (`setControllers`/
   * `setDetectedPads`, each gated on the panel being open). One row per slot; one button
   * per candidate source (Keyboard / Bot / None / one per currently detected pad index).
   *
   * Parameterized over the TARGET CONTAINER and the ASSIGNMENT to render.
   *
   * It USED to take an `interactive` flag too, for the second caller it was extracted
   * for: the versus pane's who's-playing preview, which rendered these same rows
   * disabled and pointed them at an explanatory note. That caller is gone as of issue
   * #260 -- the pane renders retained ROLES now, not a device assignment
   * (renderVersusSlotRows) -- which left `interactive: false` with no reachable caller.
   * Dropped rather than kept as contract, because an unreachable branch is dead code;
   * the manifest entry that pinned it (`ui-versus-preview-reason-left-on-the-real-rows`)
   * is retired in the same change rather than left killing through its other half. The
   * real Controllers panel below is now the only caller; nothing about its own
   * behaviour changes from this extraction.
   */
  /**
   * Remember which control inside `container` holds focus so a re-render can put it back
   * (issue #494). The Controllers and Versus Setup rows are rebuilt from scratch on every
   * hotplug and reassignment, and `replaceChildren` sends the focus of a removed button to
   * `<body>` -- a gamepad player who pressed Confirm on a pad candidate then had nothing
   * focused and nowhere to go. Controls are matched by their data attributes within their
   * `data-slot` row: the same candidate on the same row when it still exists, else the
   * first control of the same row (the pad whose button was focused just unplugged),
   * else the first control in the container. Returns the restore step, so a renderer
   * captures before its `replaceChildren` and restores after its loop with no wrapper.
   */
  function captureFocus(container: HTMLElement): () => void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !container.contains(active)) return () => {};
    const rowOf = (el: HTMLElement): string | null => el.closest<HTMLElement>('[data-slot]')?.dataset.slot ?? null;
    const keyOf = (el: HTMLElement): string =>
      `${rowOf(el)}|${JSON.stringify(Object.entries(el.dataset).sort())}`;
    const row = rowOf(active);
    const key = keyOf(active);
    return () => {
      const controls = focusableControls(container);
      const same = controls.find((el) => keyOf(el) === key);
      const sameRow = row === null ? undefined : controls.find((el) => rowOf(el) === row);
      (same ?? sameRow ?? controls[0])?.focus();
    };
  }

  function renderControllerRowsInto(container: HTMLElement, assignment: Assignment): void {
    const restoreFocus = captureFocus(container);
    container.replaceChildren();
    for (let slot = 0; slot < assignment.length; slot++) {
      const source = assignment[slot];
      const row = document.createElement('div');
      row.className = 'hud-controller-row';
      row.dataset.slot = String(slot);

      const label = document.createElement('span');
      label.className = 'hud-controller-row-label';
      label.textContent = `Player ${slot + 1}`;

      const current = document.createElement('span');
      current.className = 'hud-controller-row-current';
      current.textContent = slotSourceLabel(source);
      const disconnected =
        source.kind === 'gamepad' && !currentDetectedPads.some((p) => p.padIndex === source.padIndex);
      current.classList.toggle('hud-controller-row-current--disconnected', disconnected);
      if (disconnected) current.textContent += ' — disconnected';

      row.append(label, current);

      // `'bot'` is offered only where a bot may legitimately drive a player tank -- see
      // `botAssignmentAllowed`. Omitted from the list rather than rendered disabled: a
      // greyed-out control in the campaign advertises a capability the campaign does not
      // have, and `loop.ts` refuses the reassignment independently anyway.
      const candidates: SlotSource[] = [
        { kind: 'keyboard' },
        ...(botAssignmentAllowedNow ? [{ kind: 'bot' } as SlotSource] : []),
        { kind: 'none' },
        ...currentDetectedPads.map((p): SlotSource => ({ kind: 'gamepad', padIndex: p.padIndex })),
      ];
      for (const candidate of candidates) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ui-btn ui-selectable hud-controller-source-btn';
        btn.textContent = candidateLabel(candidate);
        btn.dataset.candidate = candidate.kind === 'gamepad' ? `gamepad-${candidate.padIndex}` : candidate.kind;
        setSelected(btn, sameSource(candidate, source));
        const forSlot = slot; // captured per-iteration, not the loop's shared binding
        btn.addEventListener('click', () => {
          for (const cb of reassignSlotCbs) cb(forSlot, candidate);
        });
        row.appendChild(btn);
      }
      container.appendChild(row);
    }
    restoreFocus();
  }

  function renderControllerRows(): void {
    renderControllerRowsInto(controllerRowsEl, currentAssignment);
  }

  /**
   * The single chokepoint for both the panel's own Back button AND setState's
   * unconditional close -- see onControllersOpen/onControllersClose's doc comment.
   * Guarded on the ACTUAL transition, same as showCustomize, so loop.ts's window
   * listener add/remove never sees a redundant open or close.
   */
  function showControllers(show: boolean, instant = false): void {
    // Read before the transition begins -- same reason as showCustomize.
    const wasOpen = isSurfaceOpen(CONTROLLERS_SURFACE);
    if (show) {
      swapSurface(openSurface(), CONTROLLERS_SURFACE, () => {
        // The only copy that differs between the two entry points -- see this panel's own
        // markup comment.
        controllersTitleEl.textContent =
          shownState === 'paused' ? 'Controllers' : "Choose who's playing";
        renderControllerRows();
        controllersView.focus();
        if (!wasOpen) for (const cb of controllersOpenCbs) cb();
      });
    } else {
      closeSurface(
        CONTROLLERS_SURFACE,
        () => {
          if (wasOpen) for (const cb of controllersCloseCbs) cb();
        },
        instant,
      );
    }
  }

  /**
   * Roving-tabindex keyboard (and future D-pad) navigation between the HUD's panels.
   *
   * Exactly one of `panel`/`customizeView`/`statsView`/`achView`/`levelSelectView`/
   * `controllersView`/`versusSetupView` is displayed AND not leaving at a time -- every
   * showX(true) hides `panel`, and setState's top unconditionally closes every subpanel
   * that does not own a hide chokepoint of its own (Customize and Controllers route
   * through their own showX(false) instead, to fire their close callbacks), so
   * `activePanelContainer` can return the first one that qualifies. The "and not leaving"
   * half arrived with issue #364's transition contract: a crossfade deliberately paints
   * two surfaces at once for its duration, and the one being replaced must not keep the
   * keyboard.
   * `null` (nothing visible, i.e. `splash` or `playing`) is the signal to do nothing and
   * let the key fall through to `input.ts` -- arrows must keep driving the tank while
   * playing, which this file must not regress.
   *
   * A control is anything `button, [tabindex]` finds that is not disabled and not
   * `display: none` -- the SAME predicate a reachability test can build from the DOM
   * itself, so a button added to a panel and never wired into this sweep cannot happen:
   * it is swept by construction, not by a maintained list. `input[type=range]` never
   * matches either selector (no default `tabindex` attribute, and it is not a
   * `<button>`), which is what keeps the two volume sliders out of the roving order --
   * input.ts's own `WIDGET_KEYS` already gives a focused slider full ownership of all
   * four arrow keys (see its doc comment on Right Arrow strafing instead of moving one),
   * and fighting that here would break the slider rather than extend it. A slider stays
   * reachable by Tab, exactly as it was before this file existed.
   *
   * EVERY panel-open transition focuses the CONTAINER, never a control inside it --
   * `showStats`/`showCustomize`/`showAchievements`/`showLevelSelect`/`showControllers`/
   * `showVersusSetup` above and setState's paused/win/lose/title branches below all
   * call `.focus()` on the pane itself, which is exactly what `.hud-panel`'s own
   * pre-existing `tabindex="-1"` did for the one transition this file used to handle
   * (splash -> title) -- the other six panes now carry the same attribute for the same
   * reason. Nothing invoked the surface on an arrival, so there is no control to return
   * to, and `moveFocus`'s `idx < 0` branch makes the container free: the first ArrowDown
   * from it lands on control[0] exactly as it would have if focus had started there.
   *
   * A BACK is the other case (issue #318): `restoreFocus` puts focus on the control that
   * opened the layer, when it still exists. An EARLIER version of this file focused each
   * pane's first CONTROL on arrival too, and was reverted because loop.ts's
   * `isMuteHotkey`/`isPauseHotkey` then ignored any key whose target was inside a
   * `button`, which made Escape-to-resume and M-to-mute go dead the moment a panel
   * opened. That guard now names `input,select,textarea` only -- a button consumes Space
   * and Enter and nothing else -- which is what makes restoring a button legal.
   */
  function activePanelContainer(): HTMLElement | null {
    for (const c of [
      panel,
      customizeView,
      statsView,
      achView,
      levelSelectView,
      controllersView,
      versusSetupView,
      settingsView,
      aboutView,
      confirmView,
    ]) {
      // A surface fading OUT is displayed but no longer active (issue #364). Before the
      // transition contract exactly one of these was ever displayed, and this loop could
      // return the first one it found; a crossfade puts two on screen at once for the
      // duration, and the outgoing one is listed first (`panel`), so without this the
      // arrow keys walked the screen the player just left. Restated invariant: exactly
      // one surface is displayed AND not leaving.
      if (c.classList.contains(LEAVING)) continue;
      if (getComputedStyle(c).display !== 'none') return c;
    }
    return null;
  }

  /**
   * Walks up from `el` to (not including) `container`, so a control whose own
   * `display` resolves to something other than `none` but sits inside a hidden
   * WRAPPER -- since issue #226 the three Main Menu regions on the win/lose panel, which
   * hide as groups rather than control by control -- is still excluded. Measured:
   * `getComputedStyle` on a `<button>` inside a `display:none` ancestor reports the
   * button's OWN resolved display (e.g. `inline-block`), not `none` -- computed style is
   * per-element, not "as rendered" -- so `focusableControls` checking only the control
   * itself would have walked the roving order onto three invisible buttons on every
   * win/lose screen.
   *
   * Deliberately does NOT also check for issue #364's `--leaving`. That was written here
   * first and removed after measuring: the class lands only on the seven surface
   * elements, and those are exactly the CONTAINERS this walk stops before, so the branch
   * cannot be taken. Proved rather than argued -- with it replaced by a `throw`, all 212
   * cases in hud.test.ts still pass. Keeping a surface that is fading out from taking the
   * keyboard is `activePanelContainer`'s job, one level up, where it is reachable.
   */
  function isHiddenWithin(el: HTMLElement, container: HTMLElement): boolean {
    for (let node: HTMLElement | null = el; node && node !== container; node = node.parentElement) {
      if (getComputedStyle(node).display === 'none') return true;
    }
    return false;
  }

  function focusableControls(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('button, [tabindex]')).filter(
      (el) => {
        if (el instanceof HTMLButtonElement && el.disabled) return false; // locked levels
        const ti = el.getAttribute('tabindex');
        if (ti !== null && Number(ti) < 0) return false; // none today, but future-proof
        return !isHiddenWithin(el, container);
      },
    );
  }

  const measure = opts.measure ?? ((el: HTMLElement): Rect => el.getBoundingClientRect());

  /**
   * Move the roving-tabindex focus one step in `direction` within whichever panel is
   * showing (issue #495): the geometrically nearest control that way, rows derived from
   * the controls' rectangles at the moment of the move, wrapping within a row and from
   * the last row back to the first -- see `spatial-focus.ts` for the model, including
   * what happens with no layout to follow. Shared by the arrow keys and the gamepad's
   * D-pad through `act`, so every panel inherits one traversal.
   *
   * Focus on the panel CONTAINER (just after `panel.focus()`, tabindex -1) or on
   * something this sweep does not track (the topbar's own Mute button) enters at the
   * first control going forward and the last going backward -- a reasonable default for
   * either case rather than a special error path.
   */
  function moveFocus(container: HTMLElement, direction: Direction): void {
    const list = focusableControls(container);
    if (list.length === 0) return;
    const active = document.activeElement;
    const from = active instanceof HTMLElement && list.includes(active) ? active : null;
    const next = spatialNext(
      list.map((el) => ({ item: el, rect: measure(el) })),
      from,
      direction,
    );
    next?.focus();
  }

  /**
   * The semantic dispatcher for the active layer (issue #494): every non-keyboard device
   * ends here, and the keyboard handler below is the same three verbs spelled as keys.
   *
   * Directions walk the active panel's roving focus exactly as the arrows do. `confirm`
   * activates the focused control through its own click handler -- `HTMLElement.click()`
   * dispatches a click with `detail === 0`, which `blurIfPointer` treats as a keyboard
   * activation, so focus survives the activation the way it does for Enter. With no
   * control focused (a panel just arrived, focus on its container) `confirm` lands
   * focus on the first control INSTEAD of activating it: a blind activation of whatever
   * happens to be first is how a gamepad accidentally starts a New Game. `back` is
   * `Hud.back()`. `pause` is never the HUD's -- the page's state machine owns it -- so
   * it reports unconsumed and the page toggles.
   *
   * Returns whether the action was consumed here, so the page knows when to fall through
   * to its own meaning (Back at Pause is Resume; a direction with nothing shown is
   * nothing at all).
   */
  function act(action: UiAction): boolean {
    if (action === 'back') return back();
    if (action === 'pause') return false;
    const container = activePanelContainer();
    if (!container) return false;
    if (isDirection(action)) {
      moveFocus(container, action);
      return true;
    }
    const controls = focusableControls(container);
    const active = document.activeElement;
    if (active instanceof HTMLElement && controls.includes(active)) {
      active.click();
      return true;
    }
    if (controls.length > 0) controls[0].focus();
    return true;
  }

  /**
   * The window-level keydown handler that drives roving focus. Bound at `window` in the
   * CAPTURE phase -- not on `el` -- for two reasons. Capture at `window` runs before the
   * event ever reaches its target, so it sees the key regardless of what currently holds
   * focus (including `<body>`, which an `el`-scoped bubble listener could never see: an
   * event whose target is outside `el`'s subtree never bubbles through `el` at all).
   * And capture always precedes bubble, so this handler is guaranteed to run before
   * input.ts's OWN `window.addEventListener('keydown', ...)` -- which is bubble-phase --
   * no matter which of the two modules happens to construct first; `stopPropagation`
   * here during capture cancels the rest of that dispatch outright, so input.ts's
   * listener never runs for a key this function has claimed.
   *
   * Up/Down (and W/S) always move the roving focus. Left/Right do too, EXCEPT while the
   * Customize preview canvas is focused: `render/preview-controls.ts` binds its own
   * `keydown` directly to that canvas to turn the hull (`Shift` for the turret), and
   * because that listener sits at the TARGET rather than at `window`, this capture-phase
   * handler would otherwise run first and steal Left/Right before the canvas ever saw
   * them. The one-element carve-out is what keeps that scheme intact; Up/Down are not
   * claimed by the canvas at all, so they still move focus off it in either direction.
   */
  const onNavKeyDown = (e: KeyboardEvent): void => {
    // The one consume rule (issue #494): a volume slider keeps its arrows and Home/End,
    // text entry keeps everything, and nothing keeps Escape -- so Back works with a
    // slider focused, which `e.target instanceof HTMLInputElement` used to forbid.
    if (consumesKey(e.target, e.key)) return;
    const action = keyToUiAction(e.key);
    /*
     * Escape is Back while a layer is open (issue #318), and NOT otherwise. Claimed here,
     * at window capture, for the same reason the arrows are: this runs before the page's
     * bubble-phase listener regardless of registration order, and `stopPropagation` ends
     * the dispatch, so the session's own `onKey` -- where Escape is the pause toggle --
     * never sees a key that closed a pane. With nothing to close the key is not claimed
     * and falls through untouched: Escape at Pause still resumes, Escape during play
     * still pauses, and at Launch it still dismisses the splash, all through the code
     * that always did that. P is never claimed here; hud.ts does not know it is Pause.
     */
    if (action === 'back') {
      if (e.repeat || layers.depth === 0) return;
      disarm();
      e.preventDefault();
      e.stopPropagation();
      back();
      return;
    }
    // Only the four directions are claimed from the keyboard. `confirm` is the browser's
    // own Enter/Space activation of the focused button, and `pause` is the session's
    // hotkey -- see `keyToUiAction`.
    if (action === null || !isDirection(action)) return;
    const isLateral = action === 'left' || action === 'right';
    if (isLateral && e.target === previewCanvasEl) return; // the preview owns its own scheme
    const container = activePanelContainer();
    if (!container) return; // nothing shown (splash/playing): let input.ts drive the tank
    // Claiming the key stops the WHOLE remaining dispatch -- including el's own
    // capture-phase `disarm` listener, which clears the pending drag-dismiss click
    // swallow on any key. Found by mutation in review: without this call, a player who
    // drag-dismissed the splash and then navigated by ARROW keys (rather than Tab,
    // which is not claimed here) had the next real click silently eaten. Any key that
    // moves focus must disarm exactly as an unclaimed key would have.
    disarm();
    e.preventDefault();
    e.stopPropagation();
    moveFocus(container, action);
  };
  window.addEventListener('keydown', onNavKeyDown, true);

  // Each toast owns its own timer, so several landing at once stack and expire
  // independently. Timers are tracked to be cleared in dispose(): a pending
  // callback firing into a removed DOM is the classic teardown leak.
  const toastTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Shared append+self-expire bookkeeping behind both showAchievementToasts and showToast. */
  const appendToast = (t: HTMLElement): void => {
    toastsEl.appendChild(t);
    const timer = setTimeout(() => {
      t.remove();
      toastTimers.delete(timer);
    }, TOAST_MS);
    toastTimers.add(timer);
  };

  const handleMute = (): void => {
    for (const cb of muteCbs) cb();
  };
  // ONE slider since issue #226. There used to be two -- the topbar's and the panel
  // row's -- kept in step by each handler writing the other's value before notifying
  // subscribers, which is the coupling that disappears when a setting has one home.
  const handleSettingsVolume = (): void => {
    const v = Number(settingsVolumeEl.value);
    for (const cb of volumeCbs) cb(v);
  };
  const handleAction = (): void => {
    for (const cb of startRestartCbs) cb();
  };
  const handleQuit = (): void => {
    for (const cb of quitCbs) cb();
  };

  // A focused control legitimately claims Space, Enter and the arrow keys -- input.ts
  // deliberately lets it have them. But a MOUSE player who clicks Mute never asked to hand
  // over their keyboard, and the control stays focused after a click, so arrow-key driving
  // and the Space mine-drop went dead with nothing on screen to explain it. Dropping focus
  // on pointer interactions only hands those keys back. `detail > 0` marks a real pointer
  // activation; keyboard activation reports 0 and keeps focus, so tabbing still works.
  const blurIfPointer = (e: MouseEvent): void => {
    if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
  };
  const blurAfterDrag = (e: Event): void => {
    (e.currentTarget as HTMLElement).blur();
  };

  actionBtn.addEventListener('click', handleAction);
  actionBtn.addEventListener('click', blurIfPointer);
  quitBtn.addEventListener('click', handleQuit);
  quitBtn.addEventListener('click', blurIfPointer);
  // ---- Navigation layers (issue #318) --------------------------------------------
  /**
   * The layer stack, composed here because this file owns the DOM the layers are made of.
   *
   * Before this the six panes were six pairs of `showX(true)`/`showX(false)` toggles, and
   * five of the six Back buttons hard-coded `setState('main-menu')` -- correct only while
   * every opener lived on the Main Menu, and already wrong for Controllers, which is
   * reachable from Pause and routed through the `shownState` proxy instead. Nothing
   * recorded which control opened a pane, so a keyboard player lost their place on every
   * Back. The stack records both: `origin` is the surface the layer was pushed over,
   * `restore.opener` the control that pushed it.
   *
   * The stack is HUD-owned rather than a route on the state machine, deliberately: a
   * machine route from gameplay drops the session (`state.ts`), so Controllers over Pause
   * could never be one; and the page's painter closes every pane on every surface change,
   * so a pane pushed as a route would be closed by the paint that announced it. The
   * invariant that keeps the two in step is the other way round: after every `setState`
   * the stack is EMPTY (`resetLayers` below), so a layer cannot outlive the surface it
   * opened over.
   */
  interface HudRestore {
    readonly opener: HTMLElement | null;
  }
  type HudLayer = LayerEntry<HudLayerId, HudSurface, HudRestore>;
  interface LayerRow {
    readonly container: HTMLElement;
    /** Today's `showX(true)` body, unchanged: one transition, focus on the pane. */
    open(initial?: VersusConfig | null): void;
    /** Today's ANIMATED `showX(false)`, so close callbacks fire through their guards. */
    close(): void;
    /** `'already-top'`: re-render in place, no transition. */
    refresh?(initial?: VersusConfig | null): void;
  }
  const LAYERS: Record<HudLayerId, LayerRow> = {
    stats: { container: statsView, open: () => showStats(true), close: () => showStats(false) },
    customize: { container: customizeView, open: () => showCustomize(true), close: () => showCustomize(false) },
    achievements: { container: achView, open: () => showAchievements(true), close: () => showAchievements(false) },
    levelselect: { container: levelSelectView, open: () => showLevelSelect(true), close: () => showLevelSelect(false) },
    controllers: { container: controllersView, open: () => showControllers(true), close: () => showControllers(false) },
    'versus-setup': {
      container: versusSetupView,
      open: (initial) => openVersusPane(initial),
      close: () => closeVersusPane(),
      refresh: (initial) => seedAndRenderVersus(initial),
    },
    settings: { container: settingsView, open: () => showSettings(true), close: () => showSettings(false) },
    about: { container: aboutView, open: () => showAbout(true), close: () => showAbout(false) },
    'confirm-new-campaign': {
      container: confirmView,
      open: () => showConfirmNewCampaign(true),
      close: () => showConfirmNewCampaign(false),
    },
  };
  /**
   * Which layers are BLOCKING (issue #226). Every pane in this file is a full-screen
   * route except the replace-run confirmation, which is an overlay so `navigation.ts`
   * refuses to push a route over it -- the one structural difference between the two
   * kinds, and the whole reason the confirmation is not simply a seventh route.
   *
   * A record rather than an `=== 'confirm-new-campaign'` check so a second overlay is one
   * row here and cannot be added by editing a condition that reads like a special case.
   */
  const OVERLAY_LAYERS: ReadonlySet<HudLayerId> = new Set<HudLayerId>(['confirm-new-campaign']);
  const layers = createLayerStack<HudLayerId, HudSurface, HudRestore>();
  /**
   * The browser's Back, kept in step with the stack (issue #318). With no `opts.history`
   * this is inert and the stack is the whole of navigation; with one, a layer open means
   * exactly one history entry, and the browser's Back consumes that layer through the
   * same `back()` the buttons use.
   */
  const mirror = createHistoryMirror(opts.history ?? null, {
    depth: () => layers.depth,
    back: () => {
      back();
    },
  });
  /**
   * The Versus button, while its click is being dispatched -- and `null` at every other
   * moment. `showVersusSetup(true)` is public and is also called for the post-match
   * "Versus Setup" reopen -- `route-ui.ts`'s `openVersusSetup`, reached through the route
   * host's slot -- where no control invoked the pane; recording the opener only around
   * the button's own callback loop is what keeps that reopen's Back landing on the
   * container rather than on a button nobody pressed.
   */
  let versusOpener: HTMLElement | null = null;

  /**
   * Open a layer over the current surface.
   *
   * A DIFFERENT pane already open is REPLACED, not covered and not refused: it leaves
   * through its own animated close -- so `onCustomizeClose`/`onControllersClose` fire and
   * the preview and gamepad listeners they own are released -- and the new pane opens
   * over the same origin. Covering it would keep those resources alive with no close
   * callback (issue #327 owns the covering-layer contract for the overlays that will
   * genuinely stack); refusing it would break issue #364's interrupt rule, under which a
   * second navigation inside one transition window resolves to the second destination.
   * Nothing in production reaches this today -- every opener lives in the panel the
   * open pane hides -- so the rule is pinned by the transition contract's own test.
   *
   * `false` when the stack refused (an id already open lower down, a route over an
   * overlay).
   */
  function openLayer(id: HudLayerId, opener: HTMLElement | null, initial?: VersusConfig | null): boolean {
    const top = layers.top();
    let origin = shownState;
    if (top !== null && top.id !== id) {
      /*
       * AN OVERLAY IS NOT REPLACED (issue #226). The replace-pane rule below is what makes
       * a second route resolve to the second destination (issue #364's interrupt rule);
       * applying it to an overlay would pop the blocking layer and then push the route
       * over the surface it was blocking, which is exactly the outcome `navigation.ts`'s
       * `push` refuses. Checked HERE rather than relying on that refusal, because the pop
       * happens first: by the time `push` could refuse, the confirmation the player has
       * not answered is already closed.
       */
      if (top.kind === 'overlay' && !OVERLAY_LAYERS.has(id)) return false;
      layers.pop();
      LAYERS[top.id].close();
      origin = top.origin;
    }
    const result = layers.push({
      id,
      kind: OVERLAY_LAYERS.has(id) ? 'overlay' : 'route',
      origin,
      restore: { opener },
    });
    if (result === 'refused') return false;
    disarmReset();
    if (result === 'already-top') {
      // Re-render only: a second open of the pane on top must not run a transition from
      // the pane to itself, which marks the one surface LEAVING and then ENTERING and hides
      // it when the crossfade settles.
      LAYERS[id].refresh?.(initial);
      return true;
    }
    LAYERS[id].open(initial);
    mirror.sync(layers.depth);
    return true;
  }

  /**
   * Pop one layer: the pane's own animated close, the origin surface re-rendered, focus
   * back on the opener. ONE crossfade: `setState`'s own transition hits the redundant-call
   * no-op because the close is already on its way to the surface `setState` asks for, and
   * its close-all skips the surface that is LEAVING.
   */
  function back(): boolean {
    const popped = layers.pop();
    if (popped === null) return false;
    LAYERS[popped.id].close();
    setState(popped.origin);
    restoreFocus(popped);
    mirror.sync(layers.depth);
    return true;
  }

  /**
   * Focus the control that opened the layer, when it still exists. Runs AFTER `setState`
   * has already focused the destination container, so the container is the fallback for
   * a programmatic open (no opener), a torn-down node, a disabled button, or an opener
   * the surface no longer shows -- `applyTitleAffordances` and `setLevelSelect` hide
   * openers, and a session's detach reshapes the menu.
   */
  function restoreFocus(layer: HudLayer): void {
    const opener = layer.restore.opener;
    if (opener === null) return;
    if (!opener.isConnected) return;
    if (opener instanceof HTMLButtonElement && opener.disabled) return;
    if (isHiddenWithin(opener, el)) return;
    opener.focus();
  }

  /** Every surface change empties the stack -- see the composition comment above. */
  function resetLayers(): void {
    layers.reset();
    mirror.sync(0);
  }

  /**
   * RECORDS IS ONE ENTRY WITH TWO TABS (issue #226).
   *
   * The Main Menu opens the Stats tab; each pane's tab row reaches the other. Both tab
   * handlers pass `recordsOpenBtn` as the opener rather than the tab that was clicked,
   * which is what makes Back land on the Main Menu control the player actually used --
   * the tab they pressed lives inside the pane they are leaving, so restoring it would
   * mean restoring a control the destination does not show (`restoreFocus` would fall
   * back to the container and silently lose the player's place).
   *
   * Switching tabs REPLACES the top layer (`openLayer`'s different-id branch), carrying
   * the replaced layer's `origin` forward, so Stats and Achievements are siblings over
   * the same origin rather than a two-deep stack. That is the shallow-tab shape the UI
   * direction asks for, and it is why no covering-layer support (issue #327) is needed.
   */
  const handleRecordsOpen = (): void => {
    openLayer('stats', recordsOpenBtn);
  };
  const handleRecordsTabStats = (): void => {
    openLayer('stats', recordsOpenBtn);
  };
  const handleRecordsTabAchievements = (): void => {
    openLayer('achievements', recordsOpenBtn);
  };
  const handleStatsBack = (): void => {
    back();
  };
  const handleResetStats = (): void => handleDangerClick(resetStatsBtn, resetStatsCbs);
  const handleResetProgress = (): void => handleDangerClick(resetProgressBtn, resetProgressCbs);
  const handleCustomizeOpen = (): void => {
    openLayer('customize', customizeOpenBtn);
  };
  const handleCustomizeBack = (): void => {
    back();
  };
  const handleAchBack = (): void => {
    back();
  };
  const handleSettingsOpen = (): void => {
    openLayer('settings', settingsOpenBtn);
  };
  const handleSettingsBack = (): void => {
    back();
  };
  // Two openers, one pane, and each records ITS OWN control -- Back from About returns to
  // the Main Menu footer or to the Settings row, whichever was used.
  const handleAboutOpen = (): void => {
    openLayer('about', aboutOpenBtn);
  };
  const handleSettingsAboutOpen = (): void => {
    openLayer('about', settingsAboutBtn);
  };
  const handleAboutBack = (): void => {
    back();
  };
  achBackBtn.addEventListener('click', handleAchBack);
  achBackBtn.addEventListener('click', blurIfPointer);
  customizeOpenBtn.addEventListener('click', handleCustomizeOpen);
  customizeOpenBtn.addEventListener('click', blurIfPointer);
  customizeBackBtn.addEventListener('click', handleCustomizeBack);
  customizeBackBtn.addEventListener('click', blurIfPointer);
  recordsOpenBtn.addEventListener('click', handleRecordsOpen);
  recordsOpenBtn.addEventListener('click', blurIfPointer);
  for (const btn of recordsTabStatsBtns) {
    btn.addEventListener('click', handleRecordsTabStats);
    btn.addEventListener('click', blurIfPointer);
  }
  for (const btn of recordsTabAchievementsBtns) {
    btn.addEventListener('click', handleRecordsTabAchievements);
    btn.addEventListener('click', blurIfPointer);
  }
  statsBackBtn.addEventListener('click', handleStatsBack);
  statsBackBtn.addEventListener('click', blurIfPointer);
  resetStatsBtn.addEventListener('click', handleResetStats);
  resetProgressBtn.addEventListener('click', handleResetProgress);
  settingsOpenBtn.addEventListener('click', handleSettingsOpen);
  settingsOpenBtn.addEventListener('click', blurIfPointer);
  settingsBackBtn.addEventListener('click', handleSettingsBack);
  settingsBackBtn.addEventListener('click', blurIfPointer);
  settingsAboutBtn.addEventListener('click', handleSettingsAboutOpen);
  settingsAboutBtn.addEventListener('click', blurIfPointer);
  aboutOpenBtn.addEventListener('click', handleAboutOpen);
  aboutOpenBtn.addEventListener('click', blurIfPointer);
  aboutBackBtn.addEventListener('click', handleAboutBack);
  aboutBackBtn.addEventListener('click', blurIfPointer);
  settingsMuteBtn.addEventListener('click', handleMute);
  settingsMuteBtn.addEventListener('click', blurIfPointer);
  settingsVolumeEl.addEventListener('input', handleSettingsVolume);
  settingsVolumeEl.addEventListener('mouseup', blurAfterDrag);

  // The aim-scheme toggle: one button, two states, cycling between them like a mute
  // button rather than offering two radio buttons for a binary choice. Labelled with
  // what each scheme DOES, not its internal name, so a player who has never seen the
  // word "scheme" still understands the difference.
  const SCHEME_LABEL: Record<TouchScheme, string> = { stick: 'Aim: Stick', point: 'Aim: Point' };
  const SCHEME_HINT: Record<TouchScheme, string> = {
    stick: 'A second thumbstick -- push toward where you want to aim.',
    point: 'Touch the spot you want the turret to point at.',
  };
  const OTHER_SCHEME: Record<TouchScheme, TouchScheme> = { stick: 'point', point: 'stick' };
  let currentScheme: TouchScheme = 'stick';
  function renderSchemeToggle(): void {
    schemeToggleBtn.textContent = SCHEME_LABEL[currentScheme];
    schemeToggleBtn.title = SCHEME_HINT[currentScheme];
    schemeToggleBtn.setAttribute(
      'aria-label',
      `Touch aim style: ${SCHEME_LABEL[currentScheme]}. ${SCHEME_HINT[currentScheme]} ` +
        `Tap to switch to ${SCHEME_LABEL[OTHER_SCHEME[currentScheme]]}.`,
    );
  }
  renderSchemeToggle();
  const schemeChangeCbs: Array<(scheme: TouchScheme) => void> = [];
  const handleSchemeToggle = (): void => {
    for (const cb of schemeChangeCbs) cb(OTHER_SCHEME[currentScheme]);
  };
  schemeToggleBtn.addEventListener('click', handleSchemeToggle);
  schemeToggleBtn.addEventListener('click', blurIfPointer);

  // The fire-mode toggle: one button, THREE states, cycling tap -> double -> button ->
  // tap. Unlike the binary scheme toggle this needs an explicit NEXT map rather than a
  // simple swap. Labelled in plain, user-facing terms -- a player who has never seen the
  // word "gesture" still needs to understand the difference, and the FIRE button working
  // in every mode is the one fact every hint below repeats.
  const FIREMODE_LABEL: Record<FireMode, string> = {
    tap: 'Fire: Tap to fire',
    double: 'Fire: Double-tap to fire',
    button: 'Fire: Button only',
  };
  const FIREMODE_HINT: Record<FireMode, string> = {
    tap: 'A tap on the aim side fires. The FIRE button still works too.',
    double: 'Two quick taps in the same spot fire; re-aiming does not. The FIRE button still works too.',
    button: 'Only the FIRE button fires -- the aim side never does.',
  };
  const NEXT_FIRE_MODE: Record<FireMode, FireMode> = { tap: 'double', double: 'button', button: 'tap' };
  let currentFireMode: FireMode = 'tap';
  function renderFireModeToggle(): void {
    firemodeToggleBtn.textContent = FIREMODE_LABEL[currentFireMode];
    firemodeToggleBtn.title = FIREMODE_HINT[currentFireMode];
    firemodeToggleBtn.setAttribute(
      'aria-label',
      `Touch fire style: ${FIREMODE_LABEL[currentFireMode]}. ${FIREMODE_HINT[currentFireMode]} ` +
        `Tap to switch to ${FIREMODE_LABEL[NEXT_FIRE_MODE[currentFireMode]]}.`,
    );
  }
  renderFireModeToggle();
  const fireModeChangeCbs: Array<(mode: FireMode) => void> = [];
  const handleFireModeToggle = (): void => {
    for (const cb of fireModeChangeCbs) cb(NEXT_FIRE_MODE[currentFireMode]);
  };
  firemodeToggleBtn.addEventListener('click', handleFireModeToggle);
  firemodeToggleBtn.addEventListener('click', blurIfPointer);

  // The haptics toggle: one button, two states, cycling like the aim-scheme toggle
  // rather than a checkbox -- same reasoning, a binary choice does not need a NEXT map.
  // Vibration only ever fires where the platform supports it (see resolveVibrate in
  // haptics.ts); this switch is for the player who wants it off regardless.
  const HAPTICS_LABEL: Record<'on' | 'off', string> = { on: 'Haptics: On', off: 'Haptics: Off' };
  const HAPTICS_HINT: Record<'on' | 'off', string> = {
    on: 'Firing, losing a life and nearby mine blasts pulse the device, where supported.',
    off: 'No vibration on firing, losing a life or nearby mine blasts.',
  };
  let currentHaptics = true;
  function renderHapticsToggle(): void {
    const state = currentHaptics ? 'on' : 'off';
    const nextState = currentHaptics ? 'off' : 'on';
    hapticsToggleBtn.textContent = HAPTICS_LABEL[state];
    hapticsToggleBtn.title = HAPTICS_HINT[state];
    hapticsToggleBtn.setAttribute(
      'aria-label',
      `Haptic feedback: ${HAPTICS_LABEL[state]}. ${HAPTICS_HINT[state]} ` +
        `Tap to switch to ${HAPTICS_LABEL[nextState]}.`,
    );
  }
  renderHapticsToggle();
  const hapticsChangeCbs: Array<(on: boolean) => void> = [];
  const handleHapticsToggle = (): void => {
    for (const cb of hapticsChangeCbs) cb(!currentHaptics);
  };
  hapticsToggleBtn.addEventListener('click', handleHapticsToggle);
  hapticsToggleBtn.addEventListener('click', blurIfPointer);

  // The motion toggle: one button, three states, cycling like the fire-mode toggle, and
  // the first control the Accessibility section has ever held (issue #289).
  //
  // Named for what the game DOES, never for the stored ids. 'system' in particular is an
  // implementation word for "whatever this device already asks for", and a player who has
  // never opened an OS accessibility pane has no reason to connect the two.
  const MOTION_LABEL: Record<MotionPreference, string> = {
    system: 'Motion: Match device',
    full: 'Motion: Full',
    reduced: 'Motion: Reduced',
  };
  const MOTION_HINT: Record<MotionPreference, string> = {
    system: 'Follow this device\'s own reduced-motion setting.',
    full: 'Play every menu transition and effect at full strength.',
    reduced: 'Cut menu transitions and nonessential movement, whatever the device asks for.',
  };
  const NEXT_MOTION: Record<MotionPreference, MotionPreference> = {
    system: 'full',
    full: 'reduced',
    reduced: 'system',
  };
  let currentMotion: MotionPreference = 'system';
  /**
   * 'Match device' is the ONE state whose name does not say what is currently happening,
   * so it -- and only it -- reports the resolved answer `setReducedMotion` pushed.
   *
   * That gap is the bug issue #289 was filed under: a player whose OS asks for reduced
   * motion had no control at all, and the first thing they need after finding one is to
   * know which way the device is currently pointing. 'Full' and 'Reduced' are their own
   * answers and get no suffix, which is also what keeps this from reading as noise on the
   * two states a player picked deliberately.
   */
  function renderMotionToggle(): void {
    const resolved = currentMotion === 'system' ? ` (${reducedMotion ? 'reduced' : 'full'})` : '';
    motionToggleBtn.textContent = MOTION_LABEL[currentMotion] + resolved;
    motionToggleBtn.title = MOTION_HINT[currentMotion];
    // No category word in front, unlike the three toggles above: theirs open with 'Aim:',
    // 'Fire:' and 'Haptics:', so a prefix names the thing being set. This label already
    // opens with 'Motion:', and prefixing it would read out 'Motion: Motion: Match device'.
    motionToggleBtn.setAttribute(
      'aria-label',
      `${MOTION_LABEL[currentMotion] + resolved}. ${MOTION_HINT[currentMotion]} ` +
        `Tap to switch to ${MOTION_LABEL[NEXT_MOTION[currentMotion]]}.`,
    );
  }
  renderMotionToggle();
  const motionChangeCbs: Array<(preference: MotionPreference) => void> = [];
  const handleMotionToggle = (): void => {
    for (const cb of motionChangeCbs) cb(NEXT_MOTION[currentMotion]);
  };
  motionToggleBtn.addEventListener('click', handleMotionToggle);
  motionToggleBtn.addEventListener('click', blurIfPointer);

  // The quality toggle: one button, three states, cycling like the motion toggle beside it
  // (issue #540). Unlike that one it has no resolved half to report -- nothing gates it --
  // so the label is a function of the stored preset alone.
  //
  // High/Medium/Low are the stored ids spelled as words, and that is a deliberate
  // exception to the rule 'Motion' follows: 'system' is an implementation word a player
  // cannot be expected to decode, whereas graphics quality is where every game a player
  // has ever opened puts exactly these three. The HINT is what carries the meaning, since
  // 'Medium' by itself says nothing about what is actually being cut.
  const QUALITY_LABEL: Record<QualityPreset, string> = {
    high: 'Quality: High',
    medium: 'Quality: Medium',
    low: 'Quality: Low',
  };
  const QUALITY_HINT: Record<QualityPreset, string> = {
    high: 'Every effect at full strength: smooth edges, soft shadows and full muzzle smoke.',
    medium: 'Cheaper shadows and edges, and lighter muzzle smoke.',
    low: 'The cheapest picture: no smoothing, hard shadows, and no muzzle smoke at all.',
  };
  /**
   * The one thing the label cannot show and the player would otherwise have to discover:
   * a session's renderer is built once, so a change made here reaches the next match and
   * not the one already running. Said on every state, because it is a property of the
   * control rather than of any preset.
   */
  const QUALITY_TIMING = 'Takes effect when the next match starts.';
  /**
   * DOWNWARDS, unlike every other cycling toggle here, which simply walk their own list in
   * declaration order. `high` is the default, and the player who goes looking for this
   * control is the one whose device is struggling -- one tap should be the cheaper picture,
   * not the same one they already have. It still wraps, so nothing is unreachable.
   */
  const NEXT_QUALITY: Record<QualityPreset, QualityPreset> = {
    high: 'medium',
    medium: 'low',
    low: 'high',
  };
  // The shipped preset, so the button reads correctly for the fraction of a tick before
  // `paintSettingsControls` pushes the stored one -- and reads correctly forever in a
  // fixture that never pushes at all.
  let currentQuality: QualityPreset = DEFAULT_QUALITY_PRESET;
  function renderQualityToggle(): void {
    qualityToggleBtn.textContent = QUALITY_LABEL[currentQuality];
    qualityToggleBtn.title = `${QUALITY_HINT[currentQuality]} ${QUALITY_TIMING}`;
    // No category word in front, for the same reason the motion toggle has none: the
    // label already opens with 'Quality:'.
    qualityToggleBtn.setAttribute(
      'aria-label',
      `${QUALITY_LABEL[currentQuality]}. ${QUALITY_HINT[currentQuality]} ${QUALITY_TIMING} ` +
        `Tap to switch to ${QUALITY_LABEL[NEXT_QUALITY[currentQuality]]}.`,
    );
  }
  renderQualityToggle();
  const qualityChangeCbs: Array<(preset: QualityPreset) => void> = [];
  const handleQualityToggle = (): void => {
    for (const cb of qualityChangeCbs) cb(NEXT_QUALITY[currentQuality]);
  };
  qualityToggleBtn.addEventListener('click', handleQualityToggle);
  qualityToggleBtn.addEventListener('click', blurIfPointer);

  // Where the session stands in the level sequence, for the win panel's copy. Null
  // until the loop calls setLevel, and a HUD never told about levels keeps its
  // original single-arena wording.
  let levelPos: { current: number; total: number } | null = null;
  // Whether level select has anything to offer (more than one level). Gates the
  // Levels button's visibility together with the title state.
  let levelChoice = false;
  // Whether Continue has anything to resume: pushed explicitly by setContinueAvailable,
  // a signal independent of setLevelSelect's `unlocked` -- see both doc comments. Used
  // to be derived from `unlocked > 1`, which was exactly the highestCleared/active-run
  // conflation issue #153 removes.
  let hasProgress = false;
  /**
   * Where the active run stands, for the Main Menu summary line and the replace-run
   * confirmation's copy (issue #226). Null until `setCampaignRun` says otherwise, which
   * is what makes a HUD that never calls it -- every css and gallery fixture -- render
   * exactly as it did before the setter existed.
   */
  let campaignRun: CampaignRunSummary | null = null;
  // What setState last showed: setLevelSelect may re-render while ANOTHER panel is
  // up (unlocks are recorded at the win event), and must not splash a button onto it.
  let shownState: HudSurface = 'launch';
  // WHAT IS BEING PLAYED -- see setSessionKind's own doc comment on the Hud
  // interface. Defaults to 'campaign' so a HUD that never calls setSessionKind
  // (every css/gallery fixture) renders byte-identical to before this method
  // existed.
  let sessionKind: HudSessionKind = 'campaign';
  // WHAT THE BUTTONS DO -- see setRelaunchTarget's own doc comment. A separate
  // variable from `sessionKind` on purpose: they disagree for `?dev=1&mode=ffa`,
  // which is a real versus session driven by campaign-shaped buttons.
  let relaunchTarget: HudRelaunchTarget = 'campaign-levels';
  /**
   * The surface `setState` was last CALLED with -- distinct from `shownState`,
   * which setState leaves untouched on its `playing`/`launch` early return
   * (both hide the whole panel, so the title affordances inside it have nothing
   * to recompute). The versus stock strip is not inside that panel and IS
   * visible while playing, so its gate needs the surface setState actually
   * reached, including the two `shownState` never records.
   */
  let currentSurface: HudSurface = 'launch';
  const levelSelectCbs: Array<(level: number) => void> = [];
  const newGameCbs: Array<() => void> = [];

  /**
   * The title-only affordances that depend on `relaunchTarget` -- Continue, New Game's
   * LABEL, Levels-open, and Campaign-open -- recomputed together from
   * `shownState`/`relaunchTarget`/`hasProgress`/`levelChoice`, whichever of the four last
   * changed. One function instead of four inline toggles because `setContinueAvailable`
   * and `setLevelSelect` each toggle their OWN button independent of `setState` (a
   * run/unlock can change while another panel is up) -- and both must ALSO respect
   * `relaunchTarget`: gating only inside `setState` would leave a later
   * `setContinueAvailable(true)` re-show Continue at a versus session's title, reopening
   * the exact corpse-world window this exists to close. That is not theoretical:
   * `deps.run` is the SAME store a versus session shares with campaign (loop.ts's
   * `versusAwareDeps`), so this fires whenever a real campaign run is ALSO active --
   * true for most returning players, not an edge case. Calling this from
   * `setRelaunchTarget` too makes the target itself order-independent: a caller may set
   * it before OR after `setState('main-menu')` and land on the same DOM either way.
   *
   * Reads `relaunchTarget`, NEVER `sessionKind`: every button here is a claim about
   * what the click DOES, and a developer-flag versus session's clicks are
   * campaign-shaped even though the session is Versus.
   */
  function applyTitleAffordances(): void {
    const atTitle = shownState === 'main-menu';
    const versusKind = relaunchTarget === 'versus-setup';
    continueBtn.classList.toggle('hud-continue--hidden', !atTitle || !hasProgress || versusKind);
    // New Game stays VISIBLE for a versus session, unlike Continue and Levels-open --
    // see setRelaunchTarget's own doc comment on the Hud interface for why: its handler
    // (loop.ts's onNewGame) always rebuilds the world via switchTo before
    // startPlaying(), so for a versus session it is the ONLY path from title into the
    // just-configured match. Only its LABEL changes.
    newGameBtn.classList.toggle('hud-new-game--hidden', !atTitle);
    /*
     * THREE LABELS, and the third is what issue #226 added. "Start Campaign" is the
     * primary action when nothing is running; with a run active the SAME button becomes
     * the tertiary "Start New Campaign" that the confirmation guards, and the word "New"
     * is the only warning a player gets before that pane appears. A versus session keeps
     * "Start Match" (see setRelaunchTarget), and `versusKind` is checked first because a
     * versus session shares the campaign run store -- `hasProgress` is routinely true
     * there and must not relabel a button that starts a match.
     */
    newGameBtn.textContent = versusKind
      ? 'Start Match'
      : hasProgress
        ? 'Start New Campaign'
        : 'Start Campaign';
    // TERTIARY while a run exists (issue #226's ruling), primary otherwise: with Continue
    // on screen this button is the destructive one and must not compete with it. A class
    // rather than a swapped element, so the button keeps its identity, its handlers and
    // its place in the roving order across the change.
    newGameBtn.classList.toggle('ui-btn--primary', !hasProgress || versusKind);
    newGameBtn.classList.toggle('hud-new-game--tertiary', hasProgress && !versusKind);
    // Symmetric with Continue, but inert today: a setup-pane versus session's single
    // synthetic level already keeps `levelChoice` false (setLevelSelect's own
    // `total > 1`), so this button is already hidden there without the target check. Added anyway for
    // defense-in-depth against a future multi-level versus system.
    levelSelectOpenBtn.classList.toggle('hud-levelselect-open--hidden', !atTitle || !levelChoice || versusKind);
    campaignOpenBtn.classList.toggle('hud-campaign-open--hidden', !atTitle || !versusKind);
    renderRunSummary();
  }

  /**
   * WHAT THE WIN/LOSE PANEL'S ONE ACTION BUTTON SAYS -- the outcome twin of
   * `applyTitleAffordances`, and the only place any of its four words are chosen.
   *
   * "Next Level" belongs to the level SEQUENCE, so it is read off `levelPos` and beats
   * everything else: an intermediate clear advances whatever kind of session produced
   * it. The final win and the loss both name where the relaunch LANDS, which is what
   * `GameplayOutcome.action` states -- a versus session that reopens its setup pane must
   * not promise "Play Again", and a developer-flag versus session, which `onStartRestart`
   * routes through `landOnCampaignBoard`, must not promise "Versus Setup".
   *
   * Reads the outcome's own `action`, never `sessionKind` and no longer `relaunchTarget`:
   * a session's outcome panel states its own destination now (issue #324, step S4), and
   * the title screen's copy of the same policy is `setRelaunchTarget`'s business. With no
   * outcome pushed at all -- every css and gallery fixture -- the campaign wording is the
   * default, which is what this panel said before either setter existed.
   */
  function outcomeActionLabel(win: boolean): string {
    if (win && levelPos && levelPos.current < levelPos.total) return 'Next Level';
    if ((outcomeData?.action ?? 'campaign-levels') === 'versus-setup') return 'Versus Setup';
    return win ? 'Play Again' : 'Retry';
  }

  /**
   * The Main Menu's one-line run summary (issue #226): "only the current mission and
   * remaining run lives needed to build confidence", and nothing else.
   *
   * MAIN MENU ONLY, and only with a run. The pause and outcome screens are the same
   * `.hud-panel` element and already say where the session stands in their own copy; a
   * second summary there would report the RUN's position while the panel above it reports
   * the session's, and the two legitimately disagree during practice.
   *
   * Hidden for a versus relaunch target for the same reason Continue is: that session
   * shares the campaign run store, so a real campaign run is usually active behind a
   * versus match and would otherwise put a campaign mission line over a versus menu.
   */
  function renderRunSummary(): void {
    const show =
      shownState === 'main-menu' && campaignRun !== null && relaunchTarget !== 'versus-setup';
    runSummaryEl.classList.toggle('hud-run-summary--hidden', !show);
    runSummaryEl.textContent = show && campaignRun !== null ? runSummaryText(campaignRun) : '';
  }

  /**
   * "Mission 3 of 8 -- 2 lives left", or just the lives half when the run's stored level
   * is not a mission this build knows (see `setCampaignRun`). Singular "1 life left" is
   * not a flourish: the number is at its most alarming exactly when it is one, and
   * "1 lives" is the reading a player is least likely to trust.
   */
  function runSummaryText(run: CampaignRunSummary): string {
    const lives = `${run.lives} ${run.lives === 1 ? 'life' : 'lives'} left`;
    if (run.mission === null) return lives;
    return `Mission ${run.mission} of ${run.total} -- ${lives}`;
  }

  /**
   * The confirmation's body. It names the run it would replace, because "are you sure?"
   * over an unnamed loss is the wording that makes a player click through without
   * reading. Falls back to the generic sentence when no summary has been pushed -- a HUD
   * whose page never calls `setCampaignRun` still gets a truthful question.
   */
  function confirmNewCampaignBody(): string {
    if (campaignRun === null) return 'Your campaign run will be replaced. This cannot be undone.';
    return `${runSummaryText(campaignRun)}. Starting a new campaign replaces it. This cannot be undone.`;
  }

  /**
   * The GAMEPLAY surfaces that depend on `sessionKind` -- the campaign
   * Lives/Enemies stats and the versus stock strip -- recomputed together, for
   * the same order-independence reason `applyTitleAffordances` exists: both
   * `setState` and `setSessionKind` can be the call that last changed one of
   * the two inputs, and a session's kind is no longer fixed for its life (a
   * Levels pick makes a campaign session Practice; landing back on its home
   * board makes it Campaign again). Whichever arrives last, the DOM lands in
   * the same place.
   *
   * Reads `sessionKind`, NEVER `relaunchTarget`: both surfaces are statements
   * about the world being played, and `?dev=1&mode=ffa` really is a versus
   * world -- the strip belongs on screen there even though that session's
   * buttons stay campaign-shaped. It staying hidden was the defect this split
   * removes.
   *
   * `hideCampaignStats` is `=== 'versus'`, NOT `!== 'campaign'`: Practice is a
   * campaign board played in isolation and its lives/enemy count are as real
   * there as in a run. Widening this to Practice would be a shipped-behaviour
   * regression on the Level-Select path.
   *
   * The stock strip's own gate needs the surface too (it is in-match chrome,
   * not a menu affordance): visible ONLY while a versus session is actually
   * being played -- `playing` or `paused` -- never at main-menu/outcome/launch.
   * Assigns the OUTER `versusStocksVisible` variable (see its own doc comment
   * for why this must be a variable, never a classList read) -- `setVersusStocks`
   * reads the SAME variable to decide whether to render, so the two can never
   * disagree about "should this be showing" the way a class read could.
   * `renderVersusStocks` still independently re-adds `--hidden` when there is no
   * data yet (`setState('playing')` fires before the first real `setVersusStocks`
   * call in production -- no `SimEvent` marks a versus match's own start): that
   * is a SEPARATE, legitimate reason to hide ("nothing to show"), and is exactly
   * why `versusStocksVisible` must not be read back off the DOM. Doing so once
   * mistook that data-driven hide for a state-driven one and refused every
   * subsequent `setVersusStocks` call until the next `setState` (a pause)
   * revived it.
   */
  function applySessionKindSurfaces(): void {
    const versusSession = sessionKind === 'versus';
    for (const statEl of campaignStatEls) {
      statEl.classList.toggle('hud-campaign-stat--hidden', versusSession);
    }
    versusStocksVisible =
      versusSession && (currentSurface === 'playing' || currentSurface === 'paused');
    versusStocksEl.classList.toggle('hud-versus-stocks--hidden', !versusStocksVisible);
    if (versusStocksVisible) renderVersusStocks();
  }

  const handleLevelSelectOpen = (): void => {
    openLayer('levelselect', levelSelectOpenBtn);
  };
  const handleLevelSelectBack = (): void => {
    back();
  };
  levelSelectOpenBtn.addEventListener('click', handleLevelSelectOpen);
  levelSelectOpenBtn.addEventListener('click', blurIfPointer);
  levelSelectBackBtn.addEventListener('click', handleLevelSelectBack);
  levelSelectBackBtn.addEventListener('click', blurIfPointer);

  const handleControllersOpen = (): void => {
    openLayer('controllers', controllersOpenBtn);
  };
  // The Settings -> Controls entry (issue #226), and the durable one now that the Main
  // Menu no longer carries a Controllers peer. It REPLACES the Settings pane rather than
  // covering it, like every other pane-to-pane move in this file, so Back returns to the
  // surface Settings was opened over -- Main Menu, or Pause. A genuinely nested Back
  // (Controllers -> Settings -> Main Menu) needs the covering-layer contract issue #327
  // owns; nothing here fakes one.
  const handleSettingsControllersOpen = (): void => {
    openLayer('controllers', settingsControllersBtn);
  };
  // Reachable from 'paused' as well as the Main Menu (owner ruling: "in case controllers
  // disconnect"), which is why this panel's Back was the one that could never hard-code
  // its destination. The layer records the surface it was opened over, so Back from a
  // paused round returns to the paused round -- the same rule every other pane now
  // follows rather than a special case for this one.
  const handleControllersBack = (): void => {
    back();
  };
  controllersOpenBtn.addEventListener('click', handleControllersOpen);
  controllersOpenBtn.addEventListener('click', blurIfPointer);
  settingsControllersBtn.addEventListener('click', handleSettingsControllersOpen);
  settingsControllersBtn.addEventListener('click', blurIfPointer);
  controllersBackBtn.addEventListener('click', handleControllersBack);
  controllersBackBtn.addEventListener('click', blurIfPointer);

  // ---- Versus setup pane (docs/superpowers/specs/2026-08-21-versus-setup-menu-
  // design.md) --------------------------------------------------------------------

  const VERSUS_MODE_OPTIONS: ReadonlyArray<{ id: VersusConfig['mode']; label: string }> = [
    { id: 'ffa', label: 'FFA' },
    { id: 'teams', label: 'Teams' },
  ];
  const VERSUS_PLAYERS_OPTIONS: ReadonlyArray<VersusConfig['players']> = [2, 3, 4];

  /**
   * Is Teams a real choice at this player count? (issue #281)
   *
   * The issue's first binding rule: "Teams mode is not a distinct option for two players
   * because it is equivalent to FFA." Two players on two teams IS free-for-all, and two on
   * one team is a match nobody can win -- which the Start gate would then have to refuse,
   * turning an offer into a trap. Named here rather than inlined at its three call sites so
   * the rule has one home.
   */
  const teamsOfferedAt = (players: number): boolean => players > 2;

  /** How many teams a slot may be put on. Two-team and three-team splits, per the issue's
   *  "four-player Teams can use two or three teams, including 2v2 and 2v1v1". */
  const VERSUS_TEAM_OPTIONS: readonly number[] = [0, 1, 2];
  const VERSUS_TEAM_LABELS: readonly string[] = ['A', 'B', 'C'];
  const VERSUS_STOCK_OPTIONS: readonly number[] = [1, 2, 3, 4, 5];

  /** `'arena-01'` -> `'Arena 1'`, matching the spec's own "Arena 1-5" wording. Falls
   *  back to the raw id for anything that does not match the pattern -- defensive,
   *  not reachable against the shipped catalog (`arena-01`..`arena-05`; measured via
   *  `versusBoardCatalog()`, see versus-config.ts's own doc comment: all 15 of 15
   *  (arena, playerCount) rows pass `suitable` today). */
  /**
   * The map button's copy, READ FROM THE CATALOG (issue #271, criterion 5).
   *
   * This was `/^arena-(\d+)$/` -> `Arena N`, a second implementation of data the catalog
   * already carried: every migrated entry's `displayName` is exactly the string that
   * regex produced, which is what makes this swap behaviour-preserving rather than a
   * retitling (asserted in hud.test.ts, both directions). The regex was fine while every
   * board was `arena-NN`; the first board that is not fell through to its raw id, so
   * `vs-duel-01` would have been the name on screen instead of `Pinwheel`.
   *
   * `intent` and `preview` are declared beside `displayName` and are NOT read here --
   * the selector that shows them is #274's, and inventing a place for them in this row
   * would be building that selector early. The name is what this row renders today.
   */
  function arenaLabel(id: string): string {
    try {
      return versusCatalogEntryById(id).displayName;
    } catch {
      // Not a catalog id at all -- a campaign-only arena reached through some other
      // path. The id is a worse label than a name, and a better one than a crash.
      return id;
    }
  }

  // Pane-local selection state, session-scoped (spec ruling 4: "no seventh store,
  // same posture as controller assignment"). Lives in THIS closure, never reset by
  // showVersusSetup(false) or by setState's close-all discipline below -- only
  // showVersusSetup(true, initial) with a TRUTHY `initial` ever overwrites it -- so a
  // trip through Back and back to Versus keeps whatever was last chosen.
  //
  // Default map is 'random': every (arena, playerCount) combination in the shipped
  // catalog passes `suitable` today (measured, see arenaLabel's own comment above), so
  // there is no "the default arena is not offered at this player count" case for a
  // fallback to handle -- not coded, since a fallback branch nothing can reach is
  // exactly what this repo's review flags as dead.
  let versusConfigState: VersusConfig = opts.versusSetup
    ? { ...opts.versusSetup.get() }
    : {
        mode: 'ffa',
        players: 2,
        arenaId: 'random',
        stock: VERSUS_STOCK,
        friendlyFire: false,
        slots: defaultSlots(2),
      };

  /**
   * The ONE place `versusConfigState` is replaced, and therefore the one place the
   * retained setup is written (issue #260).
   *
   * A helper rather than six inlined `versusConfigState = {...}; store.set(...)` pairs,
   * because that shape only has to be forgotten ONCE -- at the sixth call site added
   * later -- for a selection to stop persisting with every other one still working, and
   * for the resulting test to look like an unrelated flake. Funnelling the write makes
   * "changing anything persists it" structural instead of a convention.
   *
   * `VersusSetup` and `VersusConfig` carry the same six fields today, so this hands the
   * config over directly; the store sanitizes on the way IN (see its `set`), which is
   * what keeps a mid-edit slots/players mismatch from ever reaching storage.
   */
  function setVersusConfig(next: VersusConfig): void {
    versusConfigState = next;
    opts.versusSetup?.set({ ...next });
  }

  function renderVersusModeSelection(): void {
    const offered = teamsOfferedAt(versusConfigState.players);
    for (const b of Array.from(versusModeRow.children) as HTMLButtonElement[]) {
      setSelected(b, b.dataset.mode === versusConfigState.mode);
      // DISABLED, not removed. The row is built once and a vanishing button would shift
      // the one beside it under the pointer mid-interaction; `:disabled` already has a
      // treatment in this kit (#260) and `describeDisabledReason` can say why, which a
      // missing control cannot.
      const unofferable = b.dataset.mode === 'teams' && !offered;
      b.disabled = unofferable;
      describeDisabledReason(b, unofferable ? 'hud-versus-mode-note' : null);
    }
    versusModeNoteEl.textContent = offered ? '' : 'Teams needs three or more players.';
    versusModeNoteEl.classList.toggle('hud-versus-mode-note--hidden', offered);
  }
  function renderVersusPlayersSelection(): void {
    for (const b of Array.from(versusPlayersRow.children) as HTMLButtonElement[]) {
      setSelected(b, Number(b.dataset.players) === versusConfigState.players);
    }
  }
  function renderVersusStockSelection(): void {
    for (const b of Array.from(versusStockRow.children) as HTMLButtonElement[]) {
      setSelected(b, Number(b.dataset.stock) === versusConfigState.stock);
    }
  }

  /**
   * REPLACE, never append -- rebuilt whenever `players` OR `mode` changes (the map
   * list is filtered by both declared dimensions -- `versusMapChoices`,
   * versus-config.ts, issue #270) and whenever the pane is (re)seeded, same
   * convention `renderControllerRows` already uses for its own per-slot rows.
   * A retained selection dropping out of the rebuilt list has no reset branch for
   * the same reason the 'random' default comment above gives: every shipped entry
   * declares all of {2,3,4} x both modes, so nothing can reach it --
   * `resolveVersusConfig`'s launch gate is the loud backstop, and the reset ships
   * with the first narrower entry (#271-#273).
   */
  function renderVersusMapRow(): void {
    versusMapRow.replaceChildren();
    const choices: string[] = [
      ...versusMapChoices(versusConfigState.players, versusConfigState.mode),
      'random',
    ];
    for (const choice of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ui-btn ui-selectable hud-versus-option-btn';
      b.dataset.map = choice;
      b.textContent = choice === 'random' ? 'Random' : arenaLabel(choice);
      setSelected(b, choice === versusConfigState.arenaId);
      b.addEventListener('click', () => {
        setVersusConfig({ ...versusConfigState, arenaId: choice });
        renderVersusMapRow(); // REPLACE -- rebuilds the whole row for the new selection ring
      });
      b.addEventListener('click', blurIfPointer);
      versusMapRow.appendChild(b);
    }
  }

  /**
   * The standard ordnance limits, in words (issue #268).
   *
   * READ FROM THE SAME CONFIGURATION THE SIMULATION ENFORCES, every time: `spawnBullet`
   * gates on `configFor(kind).weapon.maxActiveProjectiles` and `dropMine` on
   * `configFor(kind).mineCapacity`, and those are the two values printed here. No UI
   * constant, no second copy -- issue #268's criterion is that approved config changes
   * move this line with them, and a literal here is exactly the drift it forbids.
   *
   * `'player'` is the right kind for every VS slot: FFA and Teams strip enemy tanks
   * entirely (arena.ts's loadArena), so every tank in a versus match -- human or bot --
   * occupies a player slot and carries the player profile.
   *
   * Deliberately plain language. The decision asks for the effective limits "without
   * requiring players to understand implementation terminology", so this says shells and
   * mines in play rather than active projectiles or capacity.
   */
  function renderVersusLimits(): void {
    const cfg = configFor('player');
    const shells = cfg.weapon.maxActiveProjectiles;
    const mines = cfg.mineCapacity;
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    versusLimitsLine.textContent =
      `Every tank can have ${plural(shells, 'shell')} and ${plural(mines, 'mine')} in play at once.`;
  }

  function renderVersusFriendlyFireLabel(b: HTMLButtonElement): void {
    b.textContent = versusConfigState.friendlyFire ? 'Friendly fire: On' : 'Friendly fire: Off';
  }

  /**
   * Built (and torn down) only under Teams -- GENUINELY absent from the DOM under FFA
   * rather than merely hidden by a class: the spec's own wording is "rendered only
   * when Teams selected", and a `.hud-versus-friendlyfire-btn` query answers that
   * literally. `friendlyFire` itself is NOT reset when leaving Teams (versus-
   * config.ts's own doc comment: `loadArena`/`createWorld` already ignore it outside
   * `'teams'`, so carrying it unconditionally is harmless) -- so Teams -> FFA -> Teams
   * does not lose the setting.
   */
  function renderVersusFriendlyFireRow(): void {
    versusFriendlyFireRow.replaceChildren();
    if (versusConfigState.mode !== 'teams') return;
    const heading = document.createElement('h2');
    heading.textContent = 'Friendly fire';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-btn ui-btn--sm hud-versus-friendlyfire-btn';
    renderVersusFriendlyFireLabel(b);
    b.addEventListener('click', () => {
      setVersusConfig({ ...versusConfigState, friendlyFire: !versusConfigState.friendlyFire });
      renderVersusFriendlyFireLabel(b);
    });
    b.addEventListener('click', blurIfPointer);
    versusFriendlyFireRow.append(heading, b);
  }

  /** The label a role button carries, and the order the three are offered in. */
  const VERSUS_ROLE_OPTIONS: ReadonlyArray<{ role: VersusSlotRole; label: string }> = [
    { role: 'human', label: 'Human' },
    { role: 'bot', label: 'Bot' },
    { role: 'none', label: 'Off' },
  ];

  /**
   * Bot competence (issue #267). Offer order is difficulty order, taken from the sim's own
   * `BOT_DIFFICULTIES` rather than restated, so a preset added there cannot be missing here.
   */
  const VERSUS_DIFFICULTY_LABELS: Record<BotDifficulty, string> = {
    easy: 'Easy', normal: 'Normal', hard: 'Hard',
  };

  /**
   * The sentence a refused Start puts on the offending card. One per problem KIND,
   * because "not ready" is not actionable: each of the three has a different fix, and
   * `versusSetupProblem` distinguishes them precisely so this function can.
   */
  function versusProblemText(problem: VersusSetupProblem): string {
    switch (problem.kind) {
      case 'unassigned':
        return `Player ${problem.slot + 1} is off. Choose Human or Bot to start.`;
      case 'device-missing':
        return `Player ${problem.slot + 1} is Human but no device is free. Connect a controller, or choose Bot.`;
      case 'no-human':
        return 'At least one slot must be Human.';
      case 'one-team':
        return 'Teams needs at least two teams. Move a player to another team.';
    }
  }

  /**
   * The who's-playing SETUP rows -- per-slot role controls, issue #260's remaining gap.
   *
   * SUPERSEDES A PREVIOUS RULING, and its comment is rewritten rather than left in
   * place: these rows used to render the RUNNING session's live `Assignment` through
   * `renderControllerRowsInto`, and clicking a candidate reassigned that session via
   * `onReassignSlot`. That is the exact divergence the issue is about -- Start disposes
   * the session those clicks were editing, then rebuilt its assignment from defaults,
   * so what the pane displayed was not what launched.
   *
   * What a row edits now is the RETAINED ROLE (`VersusSlotSetup.role`), which Start
   * carries through in `versusConfigState.slots`. The DEVICE is not editable here at
   * all: it is derived, every render, by `resolveSources` from the roles plus whatever
   * pads are connected right now. That derivation is the whole reason a stale pad index
   * can never be honoured -- there is no stored index to honour (see versus-setup.ts).
   *
   * Re-rendered on: a role click, a player-count change, pane open, and
   * `setDetectedPads` -- the last is what makes a controller unplugged WHILE the pane is
   * open move a slot to "Unassigned" and refuse Start, rather than leaving a readout
   * that was true a moment ago.
   */
  function renderVersusSlotRows(): void {
    const slots = versusConfigState.slots;
    const sources = resolveSources(slots, currentDetectedPads.map((p) => p.padIndex));
    // The MODE is passed, which is what makes issue #281's team rule reachable at all --
    // `versusSetupProblem` defaults to `'ffa'`, under which it never runs.
    const problem = versusSetupProblem(slots, sources, versusConfigState.mode);

    const restoreFocus = captureFocus(versusSlotRowsEl);
    versusSlotRowsEl.replaceChildren();
    for (let slot = 0; slot < slots.length; slot++) {
      const row = document.createElement('div');
      row.className = 'hud-versus-slot-row';
      row.dataset.slot = String(slot);

      const label = document.createElement('span');
      label.className = 'hud-versus-slot-label';
      label.textContent = `Player ${slot + 1}`;
      row.appendChild(label);

      for (const opt of VERSUS_ROLE_OPTIONS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ui-btn ui-selectable hud-versus-role-btn';
        btn.dataset.role = opt.role;
        btn.textContent = opt.label;
        setSelected(btn, slots[slot].role === opt.role);
        const forSlot = slot; // captured per-iteration, not the loop's shared binding
        btn.addEventListener('click', () => {
          const next = slots.map((s, i) => (i === forSlot ? { ...s, role: opt.role } : { ...s }));
          setVersusConfig({ ...versusConfigState, slots: next });
          renderVersusSlotRows(); // REPLACE -- selection, derived devices and the gate all move
        });
        btn.addEventListener('click', blurIfPointer);
        row.appendChild(btn);
      }

      // Team, in Teams mode only (issue #281). Same row and same idiom as the role and
      // difficulty controls beside it, for the reason #267's comment gives: it is a
      // property OF this slot, and a player should not have to match two lists by
      // position. Absent in FFA rather than disabled -- a team means nothing there, so
      // there is no refusal to explain.
      if (versusConfigState.mode === 'teams') {
        for (const team of VERSUS_TEAM_OPTIONS) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ui-btn ui-btn--sm ui-selectable hud-versus-team-btn';
          btn.dataset.team = String(team);
          // A LETTER, not a colour name and not a bare number. The issue asks for the
          // choice to be reinforced "with label/marker in addition to color", and a letter
          // is the reinforcement that survives both a colour-blind reader and the
          // forced-colours palette (#368), where the swatch hues are replaced outright.
          btn.textContent = VERSUS_TEAM_LABELS[team];
          // `?? teamOf(slot)` -- the EFFECTIVE team, matching what `loadArena` stamps and
          // what `representedTeams` counts. An untouched slot shows the team it would
          // actually play on rather than showing nothing chosen, which would read as an
          // unmade decision the Start gate was ignoring.
          setSelected(btn, (slots[slot].team ?? teamOf(slot)) === team);
          const forSlot = slot; // captured per-iteration, as the loops above do
          btn.addEventListener('click', () => {
            const next = slots.map((sl, i) => (i === forSlot ? { ...sl, team } : { ...sl }));
            setVersusConfig({ ...versusConfigState, slots: next });
            renderVersusSlotRows(); // REPLACE -- selection AND the one-team gate both move
          });
          btn.addEventListener('click', blurIfPointer);
          row.appendChild(btn);
        }
      }

      // Competence, for a BOT slot only (issue #267). Built inside the same row rather
      // than as a second row: it is a property OF this slot, and a player scanning the
      // pane should not have to match two lists by position. A human slot has no
      // difficulty, so the control is absent rather than disabled -- there is nothing to
      // explain, which is the case `ui-hint` exists for and this is not.
      if (slots[slot].role === 'bot') {
        for (const level of BOT_DIFFICULTIES) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ui-btn ui-btn--sm ui-selectable hud-versus-difficulty-btn';
          btn.dataset.difficulty = level;
          btn.textContent = VERSUS_DIFFICULTY_LABELS[level];
          // `?? DEFAULT_BOT_DIFFICULTY`, so an untouched slot shows Normal as chosen
          // rather than showing nothing chosen -- absence IS normal, and a row with no
          // selection would read as an unmade decision the Start gate was ignoring.
          setSelected(btn, (slots[slot].difficulty ?? DEFAULT_BOT_DIFFICULTY) === level);
          const forSlot = slot; // captured per-iteration, as the role loop above does
          btn.addEventListener('click', () => {
            const next = slots.map((sl, i) => (i === forSlot ? { ...sl, difficulty: level } : { ...sl }));
            setVersusConfig({ ...versusConfigState, slots: next });
            renderVersusSlotRows();
          });
          btn.addEventListener('click', blurIfPointer);
          row.appendChild(btn);
        }
      }

      // The DERIVED device, not a choice. `slotSourceLabel` is reused rather than
      // reimplemented so a gamepad reads with the same name the Controllers panel
      // gives it.
      const device = document.createElement('span');
      device.className = 'hud-versus-slot-device';
      device.textContent = slotSourceLabel(sources[slot]);
      row.appendChild(device);

      // ONE reason is shown, on the FIRST offending card, because `versusSetupProblem`
      // returns the first problem and not a list. That is a deliberate choice, not a
      // limitation worked around: two simultaneous refusals would give a player two
      // sentences and no order to fix them in, and the second becomes visible the
      // moment the first is resolved. `versus-setup.test.ts` pins the first-problem
      // contract; the pane test pins that the second card stays silent.
      const reason = document.createElement('p');
      reason.className = 'ui-hint hud-versus-slot-reason';
      reason.id = `hud-versus-slot-reason-${slot}`;
      const ownsProblem =
        problem !== null && problem.kind !== 'no-human' && problem.kind !== 'one-team' && problem.slot === slot;
      reason.textContent = ownsProblem ? versusProblemText(problem) : '';
      reason.classList.toggle('hud-versus-slot-reason--hidden', !ownsProblem);
      row.appendChild(reason);

      versusSlotRowsEl.appendChild(row);
    }
    restoreFocus();

    // `no-human` names no slot, so it is the one refusal that belongs to the pane
    // rather than to a card.
    const paneLevel = problem !== null && (problem.kind === 'no-human' || problem.kind === 'one-team');
    versusStartReasonEl.textContent = paneLevel ? versusProblemText(problem) : '';
    versusStartReasonEl.classList.toggle('hud-versus-start-reason--hidden', !paneLevel);

    // "Never accept Start with an inert required slot" -- and the reason is ASSOCIATED
    // (#321's rule), not merely on screen somewhere: aria-describedby points at the one
    // element that is actually showing text, so a screen-reader user hears why Start is
    // refused instead of only that it is.
    versusStartBtn.disabled = problem !== null;
    describeDisabledReason(
      versusStartBtn,
      problem === null
        ? null
        : problem.kind === 'no-human' || problem.kind === 'one-team'
          ? 'hud-versus-start-reason'
          : `hud-versus-slot-reason-${problem.slot}`,
    );
  }

  // Mode/Players/Stock are FIXED-size option sets (unlike Map/who's-playing, they
  // never change count), so -- like the paint shop's swatch/skin/accent rows -- their
  // buttons are built ONCE here and only ever toggle `ui-selectable--on` afterward.
  for (const opt of VERSUS_MODE_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-btn ui-selectable hud-versus-option-btn';
    b.dataset.mode = opt.id;
    b.textContent = opt.label;
    b.addEventListener('click', () => {
      setVersusConfig({ ...versusConfigState, mode: opt.id });
      renderVersusModeSelection();
      renderVersusFriendlyFireRow(); // absent <-> present follows mode directly
      renderVersusMapRow(); // REPLACE -- Mode filters the map list too (issue #270)
      // ...and the per-slot team controls, which exist only under Teams (issue #281).
      // Without this the selector stays on screen after switching to FFA, and -- worse --
      // the one-team refusal keeps its Start button disabled in a mode that has no teams.
      renderVersusSlotRows();
    });
    b.addEventListener('click', blurIfPointer);
    versusModeRow.appendChild(b);
  }
  renderVersusModeSelection();

  for (const players of VERSUS_PLAYERS_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-btn ui-selectable hud-versus-option-btn';
    b.dataset.players = String(players);
    b.textContent = String(players);
    b.addEventListener('click', () => {
      // `slots` MUST follow the count, or Start emits a config whose slot array does not
      // describe the match being started (issue #260). Resized rather than rebuilt so
      // going 2 -> 3 -> 2 gives back the roles that were chosen, not fresh defaults.
      // Dropping to two players leaves Teams unofferable, so the MODE follows the count
      // rather than being left in a state the pane no longer offers (issue #281). The
      // per-slot team choices are NOT cleared -- `resizeSlots` keeps them, and the issue
      // requires that switching modes does not corrupt retained choices, which includes
      // the round trip 4 -> 2 -> 4.
      const mode = teamsOfferedAt(players) ? versusConfigState.mode : 'ffa';
      setVersusConfig({
        ...versusConfigState,
        players,
        mode,
        slots: resizeSlots(versusConfigState.slots, players),
      });
      renderVersusPlayersSelection();
      renderVersusModeSelection(); // the Teams button's availability follows the count
      renderVersusFriendlyFireRow(); // ...and the friendly-fire row follows the mode
      renderVersusMapRow(); // REPLACE -- Players filters the map list
      renderVersusSlotRows(); // REPLACE -- the slot row COUNT follows players
    });
    b.addEventListener('click', blurIfPointer);
    versusPlayersRow.appendChild(b);
  }
  renderVersusPlayersSelection();

  for (const stock of VERSUS_STOCK_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-btn ui-selectable hud-versus-option-btn';
    b.dataset.stock = String(stock);
    b.textContent = String(stock);
    b.addEventListener('click', () => {
      setVersusConfig({ ...versusConfigState, stock });
      renderVersusStockSelection();
    });
    b.addEventListener('click', blurIfPointer);
    versusStockRow.appendChild(b);
  }
  renderVersusStockSelection();
  // Once, not per change: these limits are configuration, and nothing in the pane can
  // alter them -- that is the whole point of issue #268's binding decision.
  renderVersusLimits();

  // Map and the who's-playing preview both depend on external/derived data
  // (versusMapChoices(players), currentAssignment) rather than a fixed option set, so
  // -- unlike Mode/Players/Stock above -- they need an initial render here rather than
  // waiting for the pane's first open, mirroring setControllers/setDetectedPads'
  // "unconditional, not gated on the panel being open" convention for the real
  // Controllers panel.
  renderVersusMapRow();
  renderVersusFriendlyFireRow();
  renderVersusSlotRows();

  const versusOpenCbs: Array<() => void> = [];
  const versusStartCbs: Array<(config: VersusConfig) => void> = [];

  // A bare click passthrough -- see onVersusOpen's own doc comment on the Hud
  // interface for why this does NOT call showVersusSetup itself.
  const handleVersusOpen = (): void => {
    // The subscriber (route-ui.ts) calls `showVersusSetup(true, retained)` synchronously
    // inside this loop, which is the one moment the pane's opener is this button.
    versusOpener = versusOpenBtn;
    try {
      for (const cb of versusOpenCbs) cb();
    } finally {
      versusOpener = null;
    }
  };
  const handleVersusStart = (): void => {
    // A snapshot, not the live state object -- see onVersusStart's own doc comment.
    for (const cb of versusStartCbs) cb({ ...versusConfigState });
  };
  const handleVersusBack = (): void => {
    back();
  };
  versusOpenBtn.addEventListener('click', handleVersusOpen);
  versusOpenBtn.addEventListener('click', blurIfPointer);
  versusStartBtn.addEventListener('click', handleVersusStart);
  versusStartBtn.addEventListener('click', blurIfPointer);
  versusBackBtn.addEventListener('click', handleVersusBack);
  versusBackBtn.addEventListener('click', blurIfPointer);

  // Task 5b's Campaign button -- a bare click passthrough, the same shape as
  // handleVersusOpen just above. See onCampaignOpen's own doc comment on the Hud
  // interface for what loop.ts's one subscriber does with it.
  const campaignOpenCbs: Array<() => void> = [];
  const handleCampaignOpen = (): void => {
    for (const cb of campaignOpenCbs) cb();
  };
  campaignOpenBtn.addEventListener('click', handleCampaignOpen);
  campaignOpenBtn.addEventListener('click', blurIfPointer);

  /**
   * The versus setup pane's own show/hide, and the ONE place pane-local selections
   * get (re)seeded from an `initial` config -- called by setState's unconditional
   * close (below, `show=false`) and by Back (`show=false`), and, per Task 5's own
   * wiring, by loop.ts's `onVersusOpen` subscriber and by the versus match-end
   * "return to setup" path (both `show=true`).
   *
   * `initial` seeds ONLY when truthy: both omitting the argument and passing `null`
   * (Task 5's own `deps.initialVersusConfig ?? null`, the "nothing retained yet" case)
   * fall through to the pane's OWN persisted state rather than overwrite it with a
   * hardcoded default -- see versusConfigState's own doc comment. Kills the mutation
   * "seed unconditionally from `initial ?? DEFAULTS`", which would silently wipe a
   * returning player's own selections on every open.
   *
   * No paired onVersusClose callback (see onVersusOpen's own doc comment): nothing
   * here owns a resource that must tear down on close, so there is no transition-
   * guarded firing the way showCustomize/showControllers need.
   */
  function showVersusSetup(show: boolean, initial?: VersusConfig | null): void {
    if (!show) {
      // A public close is a Back: the pane leaves through the same path its own button
      // uses, so the origin is re-rendered and focus is restored.
      if (layers.top()?.id === 'versus-setup') back();
      return;
    }
    openLayer('versus-setup', versusOpener, initial);
  }

  function seedAndRenderVersus(initial?: VersusConfig | null): void {
    if (initial) setVersusConfig({ ...initial });
    renderVersusModeSelection();
    renderVersusPlayersSelection();
    renderVersusStockSelection();
    renderVersusMapRow();
    renderVersusFriendlyFireRow();
    renderVersusSlotRows();
  }

  function openVersusPane(initial?: VersusConfig | null): void {
    swapSurface(openSurface(), VERSUS_SETUP_SURFACE, () => {
      seedAndRenderVersus(initial);
      versusSetupView.focus();
    });
  }

  function closeVersusPane(): void {
    closeSurface(VERSUS_SETUP_SURFACE);
  }

  // Continue shares the Resume/Next Level/Play Again/Retry button's own handler: it IS
  // that action, under a label that says what it does at the title screen specifically.
  continueBtn.addEventListener('click', handleAction);
  continueBtn.addEventListener('click', blurIfPointer);
  // New Game fires its OWN callback list now -- see onNewGame's doc comment for why it
  // no longer reuses onLevelSelect's.
  const startNewCampaign = (): void => {
    for (const cb of newGameCbs) cb();
  };
  /**
   * "Starting a replacement campaign requires confirmation only when an active run would
   * be lost" (issue #226).
   *
   * The condition is `hasProgress` -- the same signal that decides whether Continue is
   * offered, which is `run.active() !== null` at every one of its call sites. Deriving
   * both from one signal is what makes the button's own promise honest: the confirmation
   * appears exactly when there is a Continue beside it to contradict.
   *
   * NOT gated on `relaunchTarget`. A setup-pane versus session labels this button "Start
   * Match" and its click starts a match, replacing nothing -- and `applyTitleAffordances`
   * already forces `hasProgress`'s effects off for that target, so the versus branch
   * reaches the direct path without a second condition here. See the `versusKind` term in
   * `confirmsNewCampaign`.
   */
  const confirmsNewCampaign = (): boolean =>
    hasProgress && relaunchTarget !== 'versus-setup';
  const handleNewGame = (): void => {
    if (!confirmsNewCampaign()) {
      startNewCampaign();
      return;
    }
    openLayer('confirm-new-campaign', newGameBtn);
  };
  /**
   * The confirmed answer. The overlay is closed FIRST and the callbacks fire afterwards,
   * for the same reason every other exit from this file does it in that order: a
   * subscriber starts a session, whose `setState` empties the layer stack, and a stack
   * emptied out from under an open pane leaves the pane on screen with nothing to pop it.
   */
  const handleConfirmAccept = (): void => {
    back();
    startNewCampaign();
  };
  const handleConfirmCancel = (): void => {
    back();
  };
  newGameBtn.addEventListener('click', handleNewGame);
  newGameBtn.addEventListener('click', blurIfPointer);
  confirmAcceptBtn.addEventListener('click', handleConfirmAccept);
  confirmAcceptBtn.addEventListener('click', blurIfPointer);
  confirmCancelBtn.addEventListener('click', handleConfirmCancel);
  confirmCancelBtn.addEventListener('click', blurIfPointer);

  /**
   * Put a pane away as part of `setState`'s close-all cleanup.
   *
   * SKIPS a surface that is already `--leaving`: it is mid-crossfade on its way out, and
   * the transition that owns it will hide it when it settles. Without this the four bare
   * `classList.add` calls below slam `--hidden` onto the very surface `showX(false)` is
   * fading, and the close cuts -- which is what every panel's Back button did, because it
   * calls `showX(false)` and then `setState` on the next line.
   *
   * Closure is still guaranteed, which is the whole point of the close-all. A surface
   * skipped here is hidden by its own settle 150ms later; and on the one path where that
   * would be too late -- gameplay entry -- `setState`'s own `transitionTo` runs with
   * `instant`, whose drain settles the outstanding close in the same frame.
   */
  function cleanupHide(el: HTMLElement, hiddenClass: string): void {
    if (el.classList.contains(LEAVING)) return;
    el.classList.add(hiddenClass);
  }

  function setState(s: HudSurface): void {
    // Recorded FIRST and unconditionally, unlike `shownState` further down --
    // see this variable's own doc comment for why the two differ.
    currentSurface = s;
    // Any state change closes the stats and customize pages FIRST -- including the
    // playing early-return below, or an overlay opened on the Main Menu would
    // sit over the live game. They are Main-Menu affairs.
    cleanupHide(statsView, 'hud-stats--hidden');
    // Routed through showCustomize (not a bare class add, unlike its stats/achievements
    // siblings above/below) so this path fires onCustomizeClose too -- the common exit
    // from the panel is Start, which arrives here, not through the Back button.
    // INSTANT. This is `setState`'s unconditional cleanup, not a navigation the player
    // asked for -- three of the five closes around it are already bare class adds -- and
    // issue #364 forbids a transition during gameplay entry or exit, which this path is
    // on every time. Animating it also left the panel painted over the live game for the
    // duration, and its close callbacks (which tear down window listeners) landed a frame
    // late.
    showCustomize(false, true);
    cleanupHide(achView, 'hud-achievements--hidden');
    cleanupHide(levelSelectView, 'hud-levelselect--hidden');
    // Routed through showControllers for the same reason as showCustomize above -- it
    // must fire onControllersClose (loop.ts's window listener teardown) on EVERY exit,
    // not only the panel's own Back button. Omitted, the panel -- and its live
    // gamepadconnected/disconnected listeners -- would leak onto the live game on
    // Resume, since 'paused' -> 'playing' is one of this function's own early returns.
    showControllers(false, true); // instant, same reason as showCustomize above
    // A bare class add, not routed through showVersusSetup(false) -- unlike Customize/
    // Controllers just above, this pane has no onVersusClose to fire (see its own doc
    // comment), so there is nothing a transition-guarded call would buy here that a
    // plain toggle does not already give the stats/achievements/level-select siblings.
    cleanupHide(versusSetupView, 'hud-versus-setup--hidden');
    // The three panes issue #226 added, closed on the same terms as their siblings: none
    // of them owns a close callback or a live resource, so each is a bare class add. The
    // confirmation is included deliberately -- a surface change is never an answer to it,
    // so it must not survive one and leave a question hanging over the next screen.
    cleanupHide(settingsView, 'hud-settings--hidden');
    cleanupHide(aboutView, 'hud-about--hidden');
    cleanupHide(confirmView, 'hud-confirm--hidden');
    disarmReset();
    // ...and the layer stack with them (issue #318): a surface change is never a Back,
    // so every layer is dropped rather than popped, and the history mirror retires its
    // entry. After this line the stack is empty on every path through this function.
    resetLayers();
    const atLaunch = s === 'launch';
    const atMainMenu = s === 'main-menu';
    const isOutcome = s === 'outcome-win' || s === 'outcome-lose';
    /*
     * THE application-surface navigation, as one transition (issue #364, criterion 2).
     *
     * Three surfaces, one `transitionTo`, because they move together or they cut against
     * each other: the title screen leaving, the menu arriving, and the backdrop coming up
     * underneath both. Two `run` calls would settle the first instantly -- see
     * `transitionTo`'s own comment.
     *
     * The panel's visibility is decided HERE rather than at the two `classList` lines this
     * replaced, one of which sat after an early return; keeping it in the transition is
     * what lets `launch -> main-menu` crossfade instead of swapping in a single frame.
     *
     * INSTANT into `playing`, by the issue's own rule that no transition may run during
     * gameplay entry or exit in a way that delays the countdown or the first input. Leaving
     * gameplay -- pause, and the outcome screens -- keeps the fade: `begin` is synchronous,
     * so focus and input have already moved by the time the animation starts, and the panel
     * arriving over the board it belongs to is the case this contract is for.
     */
    transitionTo(
      [
        [SPLASH_SURFACE, atLaunch],
        [PANEL_SURFACE, !(s === 'playing' || atLaunch)],
        // On for the Main Menu and nothing else (issue #317). Deliberately NOT
        // `!atLaunch`-shaped like the splash line above: Launch keeps the arena behind its
        // own scrim, and pause and the outcome screens are read over the board the player
        // was just on. This is also what makes a quit that no longer rebuilds the world
        // invisible -- the abandoned board is behind an opaque ground by the time the menu
        // is on screen.
        [GROUND_SURFACE, atMainMenu],
      ],
      undefined,
      s === 'playing',
    );
    // Only while playing. Pausing from the pause panel is what its own buttons are for,
    // and a Mine button on the menu lays nothing.
    touchRow.classList.toggle('hud-touch--hidden', s !== 'playing');
    /*
     * GAMEPLAY STATUS DOES NOT LEAK ONTO APPLICATION SCREENS (issue #226's named gap:
     * "the persistent top bar can leak gameplay status into application screens").
     *
     * The bar used to hide at Launch alone, so the Main Menu carried the last session's
     * Lives, Enemies and Level chip -- numbers about a world that is no longer being
     * played, sitting above a menu offering to start a different one. Everything left in
     * the bar since the audio pair moved to Settings is in-match status, so the honest
     * rule is the surface: hidden at Launch and at the Main Menu, shown while playing,
     * paused, or reading an outcome over the board it belongs to.
     */
    topbarEl.classList.toggle('hud-topbar--hidden', atLaunch || atMainMenu);
    // The in-match stock readout and the campaign stat row -- both keyed on the
    // SESSION KIND, both recomputed in one place (`applySessionKindSurfaces`, see
    // its own doc comment) so `setSessionKind` and `setState` cannot disagree
    // whichever arrives last. Placed here, BEFORE the playing/launch early return
    // just below, specifically so 'playing' itself is covered; `paused` is covered
    // too since it falls through this far (its own early return is further down).
    applySessionKindSurfaces();
    // Launch and playing both want the menu panel gone. Launch returns BEFORE the
    // branches below for the same reason `paused` returns early: the final `else`
    // renders a Game Over corpse screen, so any state that falls through to it gets
    // "Out of lives." written into the panel -- on a fresh page load, that is the
    // first thing a player would see.
    // Panel visibility is already settled by the transition above; this is the CONTENT
    // gate. Launch returns BEFORE the branches below for the same reason `paused` returns
    // early: the final `else` renders a Game Over corpse screen, so any state that falls
    // through to it gets "Out of lives." written into the panel -- on a fresh page load,
    // that is the first thing a player would see.
    // BEFORE the early return, because the flag is a claim about the SURFACE and both
    // states this returns for are surfaces with no outcome panel. Assigning it only after
    // the return left it stuck `true` across the outcome -> playing transition, which is
    // the ordinary restart path: every later push then re-rendered the three lines and
    // rewrote the action button behind a panel the surface transition had already hidden.
    // Invisible, because `.hud-panel` is hidden during play whatever these lines say --
    // but it made the variable's own doc comment false, and a gate that does not gate is
    // worse than no gate the moment someone relies on it.
    outcomeVisible = isOutcome;
    if (s === 'playing' || atLaunch) return;
    // Quit belongs to the pause panel AND the level-cleared panel. It used to be pause
    // alone, on the reasoning that "a quit button on the win panel would be a second,
    // untested path out of a finished game" -- a directive overrides that: clearing a
    // level must offer the main menu, not only Next Level. The objection was about
    // TESTING, not about the path being wrong, so it is answered rather than ignored --
    // hud.test.ts pins the visibility and label per state and loop.test.ts pins that the
    // run survives the trip, which is the half a CSS class could never have guaranteed.
    //
    // Only the INTERMEDIATE win: a final win or a loss has already called endRun, so
    // there is no run to return to and the panel is genuinely verdict-only there. Lose
    // stays verdict-only for the same reason. Level select is a menu affair -- and only
    // when there is a choice to make (see setLevelSelect).
    const clearedIntermediate =
      s === 'outcome-win' && !!levelPos && levelPos.current < levelPos.total;
    shownState = s;
    /*
     * THE THREE MAIN-MENU REGIONS (issue #226), hidden as GROUPS rather than one button
     * at a time. Customize, Records and Settings used to carry a `--hidden` modifier
     * each, which is what let the menu's information architecture live in three
     * independent class toggles instead of anywhere a reader could see it. The group is
     * now the unit: a button added to a region inherits the region's visibility, and
     * `isHiddenWithin` already excludes every control inside a hidden wrapper from the
     * roving focus, so a group hide is complete for the keyboard and the D-pad too.
     *
     * Versus and Practice keep their OWN modifiers inside the play region because each
     * has a second condition of its own -- see applyTitleAffordances.
     */
    menuPlayRow.classList.toggle('hud-menu-play--hidden', !atMainMenu);
    menuFooterRow.classList.toggle('hud-menu-footer--hidden', !atMainMenu);
    /*
     * The utilities region is the ONE that also shows at Pause, because Settings lives in
     * it and Settings must be reachable from a paused session -- the spec's "Settings
     * opened from Pause returns to Pause over the same session" is not reachable
     * otherwise, and the layer stack's origin is what makes the return true once it is.
     * Customize and Records keep their own modifiers so the row is Settings alone there:
     * repainting a tank or reading lifetime statistics is not something a paused round
     * has any claim on, and the old panel row's precedent is that a Pause-visible group
     * carries only the controls Pause needs.
     */
    menuUtilitiesRow.classList.toggle(
      'hud-menu-utilities--hidden',
      s !== 'paused' && !atMainMenu,
    );
    recordsOpenBtn.classList.toggle('hud-records-open--hidden', !atMainMenu);
    quitBtn.classList.toggle('hud-quit--hidden', s !== 'paused' && !clearedIntermediate);
    // "Quit" is the wrong word for leaving a level you just WON -- the run is preserved
    // either way, but the copy should not imply abandoning it.
    quitBtn.textContent = clearedIntermediate ? 'Main Menu' : 'Quit to Title';
    /*
     * PAUSE ONLY since issue #226 -- the inverse of the old rule, which showed it at the
     * Main Menu AND at Pause. The issue removes it as a permanent top-level destination
     * and keeps it where it is contextual: a controller that disconnects mid-round, which
     * is the case the owner ruling named. The durable entry now lives in
     * Settings -> Controls, which Pause can also reach.
     *
     * Settings itself is the button that took over the "Main Menu and Pause" shape; it
     * sits in the utilities region at the Main Menu and gets its own toggle here so a
     * paused player still has one, which is what makes "Settings from Pause returns to
     * Pause" reachable rather than merely implemented.
     */
    controllersOpenBtn.classList.toggle('hud-controllers-open--hidden', s !== 'paused');
    customizeOpenBtn.classList.toggle('hud-customize-open--hidden', !atMainMenu);
    // MAIN-MENU ONLY, unlike Controllers just above -- see this button's own markup
    // comment for why a live round has nothing this could offer.
    versusOpenBtn.classList.toggle('hud-versus-open--hidden', !atMainMenu);
    // Continue/New Game replace the single action button AT MAIN-MENU ONLY -- Resume, Next
    // Level, Play Again and Retry all still route through actionBtn below, which is why
    // this toggles on the Main Menu alone rather than joining the group above.
    // Continue, New Game (its label), Levels-open, and Campaign-open all also depend on
    // `relaunchTarget` -- see applyTitleAffordances' own doc comment for why they are
    // one function rather than four inline toggles here.
    applyTitleAffordances();
    actionBtn.classList.toggle('hud-action--hidden', atMainMenu);
    // THE OUTCOME PANEL'S THREE LINES belong to the END screens alone. The surface's
    // half of the answer is recorded above, before the `playing` early return, in the
    // variable `setOutcome` reads -- so a later push into an already-open panel repaints
    // instead of consulting a class each render may have written for a reason of its own
    // (see `outcomeVisible`), and a push during play repaints nothing at all.
    attemptSummaryEl.classList.toggle('hud-attempt-summary--hidden', !isOutcome);
    coopKillsEl.classList.toggle('hud-coop-kills--hidden', !isOutcome);
    versusResultsEl.classList.toggle('hud-versus-results--hidden', !isOutcome);
    // Each render re-hides its own line when the outcome has nothing for it -- a solo
    // session has no coop line, a campaign one no versus line, and a HUD that was never
    // told an outcome has none of the three.
    if (isOutcome) renderOutcomeLines();
    if (s === 'paused') {
      titleEl.textContent = 'Paused';
      setSubtitle('The arena waits.');
      actionBtn.textContent = 'Resume';
      // The PANEL, not actionBtn -- see the tabindex note on the element and the
      // roving-focus doc comment above `activePanelContainer`: an arrival lands on the
      // container. (A Back from a layer opened over Pause then restores its opener --
      // `restoreFocus`, issue #318 -- after this call.)
      panel.focus();
      return; // do NOT fall through: the final else renders a Game Over corpse screen
    }
    // The panel, NOT actionBtn/Continue/New Game -- see the tabindex note on the element
    // and the roving-focus doc comment above `activePanelContainer`. Without this,
    // `document.activeElement` is still <body> when the menu appears (leaving the Launch
    // route with nothing focused), or -- on a route back from a subpanel's Back button --
    // whatever the subpanel's own container last held, in both cases stranding a
    // keyboard-only player with no visible position and a screen reader announcing
    // nothing.
    panel.focus();
    if (atMainMenu) {
      titleEl.textContent = 'TANKS!';
      setSubtitle('');
    } else if (s === 'outcome-win') {
      // An intermediate win advances; only the LAST level's win is the game's.
      if (levelPos && levelPos.current < levelPos.total) {
        titleEl.textContent = `Level ${levelPos.current} cleared!`;
        setSubtitle('On to the next.');
      } else {
        titleEl.textContent = 'You Win!';
        setSubtitle('Arena cleared.');
      }
      actionBtn.textContent = outcomeActionLabel(true);
    } else {
      titleEl.textContent = 'Game Over';
      setSubtitle('Out of lives.');
      actionBtn.textContent = outcomeActionLabel(false);
    }
  }

  // The boot state, and it must match the state machine's own initial state
  // (`state.ts`), which is now the splash screen rather than the menu. `loop.ts` also
  // pushes `hud.setState(sm.state)` at boot precisely because that path bypasses
  // `sm.onChange`; this call is what the HUD looks like before it arrives.
  setState('launch');

  // The button is the only indication of mute state, and there is genuinely no
  // music shipped, so "silent" is the normal condition -- without this a muted
  // game and a broken game look identical.
  /** The last modality the page reported; null until the first input (see `keyHint`). */
  let currentModality: Modality | null = null;
  let currentMuted = false;

  function setMuted(muted: boolean): void {
    currentMuted = muted;
    // `Mute (M)` on a keyboard or mouse, plain `Mute` on touch AND on a pad -- one
    // policy, in `modality.ts`, so every hint in the HUD answers the same question the
    // same way. The pad button is null because nothing binds one to mute: `loop.ts` has
    // M and this button, and a pad reaches the button through focus like any control.
    // Naming a button here would instruct a player to press something inert.
    const hint = keyHint(currentModality, 'M', null);
    // ONE button since issue #226, in Settings -> Audio. The topbar's copy is gone, so
    // this is the only place mute is ever WRITTEN; `route-host.ts` toasts the M key's
    // result, which is the status feedback the always-visible button used to provide.
    settingsMuteBtn.setAttribute('aria-pressed', String(muted));
    settingsMuteBtn.textContent = `${muted ? 'Muted' : 'Mute'}${hint}`;
    settingsMuteBtn.classList.toggle('hud-mute--active', muted);
  }

  function setModality(modality: Modality): void {
    if (modality === currentModality) return;
    currentModality = modality;
    setMuted(currentMuted); // repaint the hints, nothing else: no surface is re-rendered
  }

  setMuted(false);

  /**
   * The one slider, from one call (issue #226 retired the topbar's twin).
   *
   * Writes `String(v)` rather than trusting the caller's formatting: `value` is a string
   * attribute, and the browser re-snaps it to the step grid on read. The guard survives
   * the collapse to a single control on purpose -- `loop.ts` pushes settings on every
   * subscription fire, and writing `value` while the player is dragging the thumb resets
   * the drag.
   */
  function setVolume(v: number): void {
    const text = String(v);
    if (settingsVolumeEl.value !== text) settingsVolumeEl.value = text;
  }

  // textContent's setter tears down and rebuilds the text node even when the
  // string is identical. loop.ts calls these every frame for values that change
  // a handful of times a round, so skip the write when nothing changed.
  let lastLives: number | null = null;
  let lastEnemies: number | null = null;
  // Same reasoning as lastLives/lastEnemies, plus a second job: it is the signal
  // setRoundPhase uses to tell "still the same second" from "a new one arrived",
  // which is what decides whether the pop animation restarts. Reset to null
  // whenever the countdown hides, so the next time it shows -- even mid-count,
  // e.g. resuming from pause -- reads as a fresh number and pops.
  let lastCountShown: number | null = null;

  /**
   * Position a ring+knob pair from a `{originX, originY, x, y}` thumb reading. Shared by
   * the driving stick and the aim stick under 'stick' scheme, so the CLAMP -- past
   * STICK_RADIUS_PX the tank (or turret) is already at full deflection, and a knob that
   * kept following would show a throw that buys nothing -- lives in exactly one place.
   */
  function drawStick(
    baseEl: HTMLElement,
    knobEl: HTMLElement,
    thumb: { originX: number; originY: number; x: number; y: number },
  ): void {
    baseEl.style.transform = `translate(${thumb.originX}px, ${thumb.originY}px)`;
    // Positioned by `stickVector` -- the SAME function the tank obeys -- rather than by
    // a parallel clamp of its own. Review caught the parallel version disagreeing inside
    // the dead zone: a thumb drifting up to ~10px visibly moved the knob while the tank
    // sat still, which is the opposite of what the ring is for. Now the knob IS the
    // speed: at the origin the tank is stopped, at the ring's edge it is at full pace.
    const v = stickVector({ x: thumb.originX, y: thumb.originY }, { x: thumb.x, y: thumb.y });
    knobEl.style.transform =
      `translate(${thumb.originX + v.x * STICK_RADIUS_PX}px, ${thumb.originY + v.y * STICK_RADIUS_PX}px)`;
  }

  return {
    setLives(n: number): void {
      if (n === lastLives) return;
      lastLives = n;
      livesEl.textContent = String(n);
    },
    setLevel(current: number, total: number): void {
      levelPos = { current, total };
      const show = total > 1;
      levelChip.classList.toggle('hud-level--hidden', !show);
      if (show) levelNum.textContent = `${current}/${total}`;
    },
    setLevelSelect(unlocked: number, total: number): void {
      levelChoice = total > 1;
      // The reason line follows the locked buttons exactly: shown while any level is
      // still locked, gone the moment none is. Toggled here rather than in setState,
      // because `unlocked` is only known at this call.
      levelsNoteEl.classList.toggle('hud-levels-note--hidden', unlocked >= total);
      // REPLACE, never append: this re-renders after every unlock.
      levelsRow.textContent = '';
      for (let i = 0; i < total; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ui-btn hud-level-btn';
        btn.textContent = String(i + 1);
        if (i + 1 > unlocked) {
          // Disabled, not merely grey: a locked level must be unclickable, and a
          // disabled button never fires click handlers.
          btn.disabled = true;
          btn.classList.add('hud-level-btn--locked');
          describeDisabledReason(btn, 'hud-levels-note');
        } else {
          btn.addEventListener('click', (e) => {
            for (const cb of levelSelectCbs) cb(i);
            if ((e as MouseEvent).detail > 0) btn.blur();
          });
        }
        levelsRow.appendChild(btn);
      }
      // setLevelSelect may re-render while ANOTHER panel is up (unlocks are recorded at
      // the win event) and must not splash the button onto it -- same `shownState`
      // convention the row itself used to follow directly. Routed through
      // applyTitleAffordances so this also respects `relaunchTarget` (see its own doc
      // comment for why gating only inside `setState` is not enough).
      applyTitleAffordances();
    },
    onLevelSelect(cb: (level: number) => void): void {
      levelSelectCbs.push(cb);
    },
    setContinueAvailable(available: boolean): void {
      hasProgress = available;
      // Same `shownState` convention as setLevelSelect just above: this can be pushed
      // while another panel is up (a game-over/completion transition ends the run
      // before the player is back at the title screen to see it). Routed through
      // applyTitleAffordances for the same `relaunchTarget` reason as setLevelSelect above.
      applyTitleAffordances();
    },
    setCampaignRun(run: CampaignRunSummary | null): void {
      campaignRun = run;
      // Through `renderRunSummary` alone, NOT `applyTitleAffordances`: this setter says
      // what the run contains, never whether one exists. Which buttons the Main Menu
      // offers stays `setContinueAvailable`'s single answer, so a page that pushed a
      // summary without an availability -- or the reverse -- cannot make Continue and its
      // own description disagree.
      renderRunSummary();
    },
    onNewGame(cb: () => void): void {
      newGameCbs.push(cb);
    },
    setEnemiesRemaining(n: number): void {
      if (n === lastEnemies) return;
      lastEnemies = n;
      enemiesEl.textContent = String(n);
    },
    setState,
    setMuted,
    setModality,
    setVolume,
    setRoundPhase(info: RoundPhaseInfo | null): void {
      if (!info || info.phase === 'live') {
        countEl.classList.add('hud-count--hidden');
        lastCountShown = null;
        return;
      }
      countEl.classList.remove('hud-count--hidden');
      if (info.secondsLeft === lastCountShown) return; // same second, still popping
      lastCountShown = info.secondsLeft;
      countEl.textContent = String(info.secondsLeft);
      // Restart the pop animation even if one is already running -- same trick as
      // signalPlayerDeath: consecutive seconds must each read as a fresh pop, not a
      // continuation of the last one's fade-out.
      countEl.classList.remove('hud-count--pop');
      void countEl.offsetWidth;
      countEl.classList.add('hud-count--pop');
    },
    setShellCount(info): void {
      if (!info) {
        shellsEl.classList.add('hud-shells--hidden');
        return;
      }
      shellsEl.textContent = `shells ${info.inFlight}/${info.cap}`;
      // At the cap the cannon silently stops responding, which is exactly the
      // state worth seeing while developing.
      shellsEl.classList.toggle('hud-shells--full', info.inFlight >= info.cap);
      shellsEl.classList.remove('hud-shells--hidden');
    },
    signalShellCapacity(info: { inFlight: number; cap: number }): void {
      // BOTH numbers, not just the cap: `5/5` says what the capacity is AND that all of
      // it is spent, which is the inference #356 asks a treatment to produce (capacity
      // full, rather than cooldown, lag or lost input). The wording matches the dev
      // readout's on purpose -- the comparison is between placements and lifetimes, and a
      // second vocabulary for the same fact would confound it.
      capacityEl.textContent = `shells ${info.inFlight}/${info.cap}`;
      // Restart the animation even if one is already running: two refusals in quick
      // succession must read as two, the same trick signalPlayerDeath documents.
      capacityEl.classList.remove('hud-capacity--flash');
      void capacityEl.offsetWidth;
      capacityEl.classList.add('hud-capacity--flash');
    },
    signalPlayerDeath(color: number): void {
      // Set before the (re)trigger below, so the very first paint of the replayed
      // animation already carries the right colour rather than one frame of the old one.
      damageEl.style.setProperty('--hud-damage-color', cssColor(color));
      // Restart the animation even if one is already running: two deaths in
      // quick succession must read as two, not one. Removing the class and
      // forcing a reflow is what makes the browser replay it.
      damageEl.classList.remove('hud-damage--hit');
      livesEl.classList.remove('hud-lives--hit');
      void damageEl.offsetWidth;
      damageEl.classList.add('hud-damage--hit');
      livesEl.classList.add('hud-lives--hit');
    },
    signalPlayerFire(): void {
      // Same restart trick as signalPlayerDeath: two shots in quick succession must read
      // as two, not one.
      aimDotEl.classList.remove('hud-aimdot--fired');
      void aimDotEl.offsetWidth;
      aimDotEl.classList.add('hud-aimdot--fired');
    },
    onMuteToggle(cb: () => void): void {
      muteCbs.push(cb);
    },
    onVolumeChange(cb: (v: number) => void): void {
      volumeCbs.push(cb);
    },
    onStartRestart(cb: () => void): void {
      startRestartCbs.push(cb);
    },
    onQuitToTitle(cb: () => void): void {
      quitCbs.push(cb);
    },
    onPauseTap(cb: () => void): void {
      pauseTapCbs.push(cb);
    },
    onMineTap(cb: () => void): void {
      mineTapCbs.push(cb);
    },
    onFireTap(cb: () => void): void {
      fireTapCbs.push(cb);
    },
    setStats(data: { lifetime: StatCounts; attempt: StatCounts }): void {
      statsData = data;
      if (!statsView.classList.contains('hud-stats--hidden')) renderStatsTable();
    },
    setOutcome(outcome: GameplayOutcome | null): void {
      outcomeData = outcome;
      // Nothing to repaint unless an outcome surface is actually up: the panel is where
      // all four of these live, and `setState` renders them itself on the way in.
      if (!outcomeVisible) return;
      renderOutcomeLines();
      // The action button too, because the destination rides the same push. In today's
      // production this never changes a word -- `loop.ts` derives `action` from a
      // boot-time relaunch target and re-sends the same value every frame -- but a panel
      // that painted the tally from the newest push and the label from the oldest would
      // be exactly the kind of half-applied projection this merge exists to rule out.
      actionBtn.textContent = outcomeActionLabel(shownState === 'outcome-win');
    },
    setVersusStocks(stocks: { slot: number; stock: number; team?: number }[] | null): void {
      versusStocksData = stocks;
      // Reads the `versusStocksVisible` VARIABLE (set only by setState), NOT the
      // element's own classList -- see that variable's doc comment for the production
      // bug this fixes: `renderVersusStocks` writes `--hidden` for an ORTHOGONAL reason
      // (no data yet), and a classList read here could not tell that apart from "the
      // state says hide this", which meant the very first real call in a fresh versus
      // match -- arriving after `setState('playing')` already rendered once against
      // null data -- was silently dropped.
      if (versusStocksVisible) renderVersusStocks();
    },
    onResetStats(cb: () => void): void {
      resetStatsCbs.push(cb);
    },
    onResetProgress(cb: () => void): void {
      resetProgressCbs.push(cb);
    },
    setHullColor(id: HullColorId): void {
      currentHull = id;
      renderSwatchSelection();
    },
    onPickHullColor(cb: (id: HullColorId) => void): void {
      pickHullCbs.push(cb);
    },
    setSkin(id: SkinId): void {
      currentSkin = id;
      renderSkinSelection();
    },
    setAccentColor(id: AccentId): void {
      currentAccent = id;
      renderAccentSelection();
    },
    onPickAccentColor(cb: (id: AccentId) => void): void {
      pickAccentCbs.push(cb);
    },
    previewCanvas: previewCanvasEl,
    previewRotateButtons: previewRotateBtns,
    onCustomizeOpen(cb: () => void): void {
      customizeOpenCbs.push(cb);
    },
    onCustomizeClose(cb: () => void): void {
      customizeCloseCbs.push(cb);
    },
    setTouchIndicator(t: TouchIndicator): void {
      // Hidden entirely until a touch has happened, so a mouse player never sees it.
      touchVizEl.classList.toggle('hud-touchviz--hidden', !t.used);
      if (!t.used) return;

      stickEl.classList.toggle('hud-stick--hidden', t.stick === null);
      if (t.stick) {
        drawStick(stickBaseEl, stickKnobEl, t.stick);
      }

      // The aim thumb draws as a SECOND ring+knob under 'stick' -- it IS a stick, and
      // t.aim.origin{X,Y} is where it landed -- reusing drawStick's clamping exactly as
      // the driving stick above does. Under 'point' it stays hidden and the crosshair
      // (hud-aimdot) draws instead.
      const aimIsStick = t.scheme === 'stick';
      aimStickEl.classList.toggle('hud-aimstick--hidden', !(aimIsStick && t.aim !== null));
      if (aimIsStick && t.aim) {
        drawStick(aimStickBaseEl, aimStickKnobEl, t.aim);
      }

      aimDotEl.classList.toggle('hud-aimdot--hidden', aimIsStick || t.aim === null);
      if (!aimIsStick && t.aim) {
        aimDotEl.style.transform = `translate(${t.aim.x}px, ${t.aim.y}px)`;
      }
    },
    onPickSkin(cb: (id: SkinId) => void): void {
      pickSkinCbs.push(cb);
    },
    onReassignSlot(cb: (slot: number, source: SlotSource) => void): void {
      reassignSlotCbs.push(cb);
    },
    // Unconditional, like setLevelSelect -- NOT gated on the panel being open (unlike
    // setAchievements/setOutcome's convention): "REPLACE, never append" means .hud-
    // controller-rows stays current regardless of visibility, so a boot-time push (before
    // the panel has ever opened) and a mid-session hotplug both land correctly whenever
    // the panel is next shown, with no separate "refresh on open" path to keep in sync.
    setControllers(assignment: Assignment): void {
      currentAssignment = assignment;
      renderControllerRows();
      // NO versus-pane refresh here any more (issue #260). These rows used to mirror
      // `currentAssignment`, so a session reassignment had to repaint them; they now
      // render the RETAINED ROLES and a device derived from `currentDetectedPads`,
      // neither of which this setter touches. `setDetectedPads` below is the one that
      // still has to repaint them, because pads ARE an input to that derivation.
    },
    setDetectedPads(pads: readonly DetectedPad[]): void {
      currentDetectedPads = pads;
      renderControllerRows();
      // The versus pane's derived device column AND its Start gate both read the pad
      // list (`resolveSources`), so a hotplug or an unplug while the pane is open has
      // to repaint them -- that is what turns a controller pulled mid-setup into a
      // refused Start with a reason, rather than a readout that was true a moment ago.
      renderVersusSlotRows();
    },
    setBotAssignmentAllowed(allowed: boolean): void {
      botAssignmentAllowedNow = allowed;
      renderControllerRows();
      // Not the versus pane: this flag gates whether a bot may drive a player tank in
      // the RUNNING session (the campaign refuses it), and the setup pane is a versus
      // pane, where Bot is always a legitimate slot role -- `defaultSlots` makes it the
      // default for every slot after the first.
    },
    onRecordsOpen(cb: () => void): void {
      recordsOpenCbs.push(cb);
    },
    onControllersOpen(cb: () => void): void {
      controllersOpenCbs.push(cb);
    },
    onControllersClose(cb: () => void): void {
      controllersCloseCbs.push(cb);
    },
    onVersusOpen(cb: () => void): void {
      versusOpenCbs.push(cb);
    },
    onVersusStart(cb: (config: VersusConfig) => void): void {
      versusStartCbs.push(cb);
    },
    showVersusSetup,
    setSessionKind(kind: HudSessionKind): void {
      sessionKind = kind;
      // Both kind-dependent gameplay surfaces, recomputed together and
      // order-independently -- see applySessionKindSurfaces' own doc comment.
      // Nothing here touches a button: a session's kind says what is being
      // played, never what a click does.
      applySessionKindSurfaces();
    },
    setRelaunchTarget(target: HudRelaunchTarget): void {
      relaunchTarget = target;
      // Every consumer of this policy is a title/outcome BUTTON. The title ones
      // recompute here so the target is order-independent against
      // `setState`/`setContinueAvailable`/`setLevelSelect` (see
      // applyTitleAffordances' own doc comment); the outcome action button's
      // label is read live inside `setState`, which cannot be showing an
      // outcome panel at the moment this is called from `loop.ts`'s
      // construction.
      applyTitleAffordances();
    },
    setBackdrop(treatment: HudBackdrop): void {
      // A class toggle, not a style write: the two treatments are stylesheet rules, so a
      // build that drops `hud.css` shows the same unstyled HUD here as everywhere else
      // rather than one layer that still paints.
      appGroundEl.classList.toggle('ui-app-ground--felt', treatment === 'felt');
    },
    setReducedMotion(on: boolean): void {
      reducedMotion = on;
      // The Accessibility toggle's 'Match device' state reads this, so the label has to
      // move when the resolved answer does -- which happens with the pane open whenever
      // the OS preference flips, and no click is involved. See renderMotionToggle.
      renderMotionToggle();
    },
    onCampaignOpen(cb: () => void): void {
      campaignOpenCbs.push(cb);
    },
    setTouchScheme(scheme: TouchScheme): void {
      currentScheme = scheme;
      renderSchemeToggle();
    },
    onTouchSchemeChange(cb: (scheme: TouchScheme) => void): void {
      schemeChangeCbs.push(cb);
    },
    setFireMode(mode: FireMode): void {
      currentFireMode = mode;
      renderFireModeToggle();
    },
    onFireModeChange(cb: (mode: FireMode) => void): void {
      fireModeChangeCbs.push(cb);
    },
    setHaptics(on: boolean): void {
      currentHaptics = on;
      renderHapticsToggle();
    },
    onHapticsChange(cb: (on: boolean) => void): void {
      hapticsChangeCbs.push(cb);
    },
    setMotion(preference: MotionPreference): void {
      currentMotion = preference;
      renderMotionToggle();
    },
    onMotionChange(cb: (preference: MotionPreference) => void): void {
      motionChangeCbs.push(cb);
    },
    setQuality(preset: QualityPreset): void {
      currentQuality = preset;
      renderQualityToggle();
    },
    onQualityChange(cb: (preset: QualityPreset) => void): void {
      qualityChangeCbs.push(cb);
    },
    setAchievements(earned: ReadonlySet<AchievementId>): void {
      earnedIds = earned;
      // Only if the page is open: rebuilding a hidden list every frame-batch is
      // wasted work, and the open path already rebuilds on show.
      if (!achView.classList.contains('hud-achievements--hidden')) renderAchievements();
    },
    showAchievementToasts(defs: readonly AchievementDef[]): void {
      for (const d of defs) {
        const t = document.createElement('div');
        t.className = 'hud-toast';
        t.dataset.achievement = d.id;
        const head = document.createElement('span');
        head.className = 'hud-toast-head';
        head.textContent = 'Achievement unlocked';
        const name = document.createElement('span');
        name.className = 'hud-toast-label';
        name.textContent = d.label;
        t.append(head, name);
        appendToast(t);
      }
    },
    showToast(message: string): void {
      const t = document.createElement('div');
      t.className = 'hud-toast';
      t.textContent = message;
      appendToast(t);
    },
    back,
    act,
    dispose(): void {
      // SETTLES the outstanding transition rather than dropping it -- see
      // `TransitionRunner.dispose`. A HUD torn down mid-crossfade would otherwise leave a
      // live timer pointing at elements this teardown is about to discard, which is the
      // exact leak issue #364's sixth criterion asks to be asserted rather than observed.
      transitions.dispose();
      disarmReset(); // a pending confirm timer must not outlive the HUD
      for (const t of toastTimers) clearTimeout(t);
      toastTimers.clear();
      window.removeEventListener('keydown', onNavKeyDown, true);
      mirror.dispose(); // the popstate listener, on the same page-teardown path
      splashEl.removeEventListener('pointerdown', onSplashPointerDown);
      panel.removeEventListener('click', onPanelClickCapture, true);
      el.removeEventListener('pointerdown', disarm, true);
      el.removeEventListener('keydown', disarm, true);
      pauseBtn.removeEventListener('pointerdown', onPauseTapClick);
      mineBtn.removeEventListener('pointerdown', onMineTapClick);
      fireBtn.removeEventListener('pointerdown', onFireTapClick);
      schemeToggleBtn.removeEventListener('click', handleSchemeToggle);
      schemeToggleBtn.removeEventListener('click', blurIfPointer);
      firemodeToggleBtn.removeEventListener('click', handleFireModeToggle);
      firemodeToggleBtn.removeEventListener('click', blurIfPointer);
      hapticsToggleBtn.removeEventListener('click', handleHapticsToggle);
      hapticsToggleBtn.removeEventListener('click', blurIfPointer);
      motionToggleBtn.removeEventListener('click', handleMotionToggle);
      motionToggleBtn.removeEventListener('click', blurIfPointer);
      qualityToggleBtn.removeEventListener('click', handleQualityToggle);
      qualityToggleBtn.removeEventListener('click', blurIfPointer);
      achBackBtn.removeEventListener('click', handleAchBack);
      achBackBtn.removeEventListener('click', blurIfPointer);
      levelSelectOpenBtn.removeEventListener('click', handleLevelSelectOpen);
      levelSelectOpenBtn.removeEventListener('click', blurIfPointer);
      levelSelectBackBtn.removeEventListener('click', handleLevelSelectBack);
      levelSelectBackBtn.removeEventListener('click', blurIfPointer);
      controllersOpenBtn.removeEventListener('click', handleControllersOpen);
      controllersOpenBtn.removeEventListener('click', blurIfPointer);
      settingsControllersBtn.removeEventListener('click', handleSettingsControllersOpen);
      settingsControllersBtn.removeEventListener('click', blurIfPointer);
      controllersBackBtn.removeEventListener('click', handleControllersBack);
      controllersBackBtn.removeEventListener('click', blurIfPointer);
      versusOpenBtn.removeEventListener('click', handleVersusOpen);
      versusOpenBtn.removeEventListener('click', blurIfPointer);
      versusStartBtn.removeEventListener('click', handleVersusStart);
      versusStartBtn.removeEventListener('click', blurIfPointer);
      versusBackBtn.removeEventListener('click', handleVersusBack);
      versusBackBtn.removeEventListener('click', blurIfPointer);
      campaignOpenBtn.removeEventListener('click', handleCampaignOpen);
      campaignOpenBtn.removeEventListener('click', blurIfPointer);
      continueBtn.removeEventListener('click', handleAction);
      continueBtn.removeEventListener('click', blurIfPointer);
      newGameBtn.removeEventListener('click', handleNewGame);
      newGameBtn.removeEventListener('click', blurIfPointer);
      confirmAcceptBtn.removeEventListener('click', handleConfirmAccept);
      confirmAcceptBtn.removeEventListener('click', blurIfPointer);
      confirmCancelBtn.removeEventListener('click', handleConfirmCancel);
      confirmCancelBtn.removeEventListener('click', blurIfPointer);
      customizeOpenBtn.removeEventListener('click', handleCustomizeOpen);
      customizeOpenBtn.removeEventListener('click', blurIfPointer);
      customizeBackBtn.removeEventListener('click', handleCustomizeBack);
      customizeBackBtn.removeEventListener('click', blurIfPointer);
      recordsOpenBtn.removeEventListener('click', handleRecordsOpen);
      recordsOpenBtn.removeEventListener('click', blurIfPointer);
      for (const btn of recordsTabStatsBtns) {
        btn.removeEventListener('click', handleRecordsTabStats);
        btn.removeEventListener('click', blurIfPointer);
      }
      for (const btn of recordsTabAchievementsBtns) {
        btn.removeEventListener('click', handleRecordsTabAchievements);
        btn.removeEventListener('click', blurIfPointer);
      }
      settingsOpenBtn.removeEventListener('click', handleSettingsOpen);
      settingsOpenBtn.removeEventListener('click', blurIfPointer);
      settingsBackBtn.removeEventListener('click', handleSettingsBack);
      settingsBackBtn.removeEventListener('click', blurIfPointer);
      settingsAboutBtn.removeEventListener('click', handleSettingsAboutOpen);
      settingsAboutBtn.removeEventListener('click', blurIfPointer);
      aboutOpenBtn.removeEventListener('click', handleAboutOpen);
      aboutOpenBtn.removeEventListener('click', blurIfPointer);
      aboutBackBtn.removeEventListener('click', handleAboutBack);
      aboutBackBtn.removeEventListener('click', blurIfPointer);
      statsBackBtn.removeEventListener('click', handleStatsBack);
      statsBackBtn.removeEventListener('click', blurIfPointer);
      resetStatsBtn.removeEventListener('click', handleResetStats);
      resetProgressBtn.removeEventListener('click', handleResetProgress);
      quitBtn.removeEventListener('click', handleQuit);
      quitBtn.removeEventListener('click', blurIfPointer);
      settingsMuteBtn.removeEventListener('click', handleMute);
      settingsMuteBtn.removeEventListener('click', blurIfPointer);
      settingsVolumeEl.removeEventListener('input', handleSettingsVolume);
      settingsVolumeEl.removeEventListener('mouseup', blurAfterDrag);
      actionBtn.removeEventListener('click', handleAction);
      actionBtn.removeEventListener('click', blurIfPointer);
      el.remove();
    },
  };
}
