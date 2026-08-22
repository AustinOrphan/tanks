import type { GameState } from './state';
import type { StatCounts } from './stats';
import type { Assignment, SlotSource } from '../input/assignment';
import type { DetectedPad } from '../input/gamepad';
import { teamOf } from '../sim/arena';
import { PALETTE, SKINS, ACCENTS, type HullColorId, type SkinId, type AccentId } from './customization';
import { ACHIEVEMENTS, type AchievementDef, type AchievementId } from './achievements';
import type { RoundPhase } from '../sim/round';
import { DEFAULT_VOLUME } from '../audio/manifest';
import { VERSUS_STOCK } from '../sim/constants';
import { versusMapChoices, type VersusConfig } from './versus-config';
import {
  STICK_RADIUS_PX,
  stickVector,
  type TouchIndicator,
  type TouchScheme,
  type FireMode,
} from '../input/touch';
import './hud.css';

export interface RoundPhaseInfo {
  phase: RoundPhase;
  /** Whole seconds left in this phase. */
  secondsLeft: number;
}

export interface Hud {
  setLives(n: number): void;
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
   * comment. The loop pushes this from wherever the run's existence can change: boot,
   * New Game, quitting to title, and game-over/campaign-completion.
   */
  setContinueAvailable(available: boolean): void;
  /**
   * New Game: the one deliberate, explicit action that starts (or replaces) the
   * active campaign run. Separate from onLevelSelect (see its doc comment) so the
   * loop can tell "start/replace the run" from "enter practice" apart -- before this
   * split they were the literal same event.
   */
  onNewGame(cb: () => void): void;
  setState(s: GameState): void;
  /** Reflect the engine's mute state in the button. */
  setMuted(muted: boolean): void;
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
   * Both tallies, pushed by the loop whenever they change. The HUD re-renders the
   * stats table only while it is visible, and keeps the win/lose attempt-summary
   * line live -- the winning kill is recorded a beat AFTER the state flips.
   *
   * `attempt` (not `run`, see stats.ts): a level-sized tally, zeroed on every
   * switchTo. The visible copy still reads "This run" -- that is user-facing
   * wording, not the codebase's ambiguous use of the word issue #153 asks to
   * remove, and changing it is out of this change's scope (nit 4, adjudicated
   * review of #156: renaming `hud-run-summary`/`runSummaryEl`/`renderRunSummary`
   * to their attempt-scoped names was trivial and safe, and is done; the visible
   * "This run: ..." copy is a separate, user-facing decision and stays as-is).
   */
  setStats(data: { lifetime: StatCounts; attempt: StatCounts }): void;
  /**
   * Coop's per-player kill tally, indexed by slot (coop semantics plan,
   * docs/superpowers/plans/2026-08-15-coop-semantics.md). `null` means "never show" --
   * a 1P session, or coop that has not started -- not merely "hide right now"; the
   * caller (loop.ts) derives this off the world's real player count, mirroring
   * `setStats`' own attempt/lifetime split. Twin of `renderAttemptSummary`, toggled
   * by the same win/lose visibility rule.
   */
  setCoopKills(counts: number[] | null): void;
  /**
   * Versus's per-player kill/death tally (n-player arc PR 4), the FFA/teams twin of
   * `setCoopKills` -- same `null`-means-never-show convention, same toggle-on-win/lose
   * lifecycle, but a genuinely different selector/line: `setCoopKills` is enemy-kill-
   * only and campaign-coop-scoped; this is player-vs-player and ffa/teams-scoped. The
   * two are mutually exclusive per session (a world has exactly one `mode`), but kept
   * as separate calls/selectors rather than one payload with a mode field, so neither
   * line's rendering has to branch on data it was never given for its own mode.
   * `kills`/`deaths` are per-slot (`Tank.controlledBy`); `mode === 'teams'` renders a
   * PER-TEAM sum (`teamOf(slot)`, sim/arena.ts) instead of per-slot, since teams mode
   * cares which SIDE won, not which teammate scored -- see arena.ts's `teamOf`.
   */
  setVersusResults(data: { mode: 'ffa' | 'teams'; kills: number[]; deaths: number[] } | null): void;
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
   * rather than doing any WebGL of its own: keeping hud.ts free of `three` is what
   * lets hud.test.ts keep running under plain jsdom.
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
  /** The earned set, pushed by the loop whenever it changes. Re-renders if open. */
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
   * The session-held `Assignment` to render, pushed by `loop.ts` at boot and after every
   * accepted `reassignSlot`. Only re-renders if the panel is open (same convention
   * `setAchievements` uses) -- rebuilding a hidden panel's rows on every tick's worth of
   * reassignments would be wasted work.
   */
  setControllers(assignment: Assignment): void;
  /**
   * The panel's live candidate-pad list, pushed by `loop.ts` while `.hud-controllers` is
   * open (see `onControllersOpen`/`onControllersClose`) -- one call on open (`getGamepads`
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
   * (`loop.ts`) is what actually opens the pane, by calling `showVersusSetup` itself,
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
   * selections; omitting the argument AND passing `null` (`loop.ts`'s own
   * `deps.initialVersusConfig ?? null` for "nothing retained yet") both leave the
   * pane's PERSISTED session-local selections untouched rather than resetting them to
   * a hardcoded default -- so Back, then Versus again, keeps whatever was last chosen
   * (spec ruling 4: "rematch-friendly"). No paired `showVersusSetup`-triggered close
   * callback: see `onVersusOpen`'s own doc comment for why none is needed.
   */
  showVersusSetup(show: boolean, initial?: VersusConfig | null): void;
  dispose(): void;
}

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

export function createHud(root: HTMLElement): Hud {
  const el = document.createElement('div');
  el.className = 'hud';
  el.innerHTML = `
    <div class="hud-topbar">
      <div class="hud-stat">Lives: <span class="hud-lives">3</span></div>
      <div class="hud-stat">Enemies: <span class="hud-enemies">3</span></div>
      <div class="hud-stat hud-level hud-level--hidden">Level: <span class="hud-level-num"></span></div>
      <div class="hud-shells hud-shells--hidden"></div>
      <div class="hud-audio">
        <button class="hud-mute" type="button">Mute (M)</button>
        <!-- autocomplete="off": Firefox restores form-control values across a
             soft reload and bfcache restore. Without this the slider comes back
             at the user's last position while a freshly-built engine boots at
             DEFAULT_VOLUME, and no 'input' event fires to reconcile them --
             reopening the exact "slider is lying" bug this markup was fixed for. -->
        <input class="hud-volume" type="range" min="0" max="1" step="0.01" value="${DEFAULT_VOLUME}" autocomplete="off" />
      </div>
    </div>
    <div class="hud-count hud-count--hidden"></div>
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
         would understate that. loop.ts owns the listeners.
         role/aria-label because a screen reader is otherwise told nothing about a
         screen that is blocking the entire game behind it. -->
    <div class="hud-splash hud-splash--hidden" role="dialog" aria-modal="true"
         aria-label="Tanks! title screen. Press any key to begin.">
      <h1 class="hud-splash-title">TANKS!</h1>
      <p class="hud-splash-hint">Press any key or tap to begin</p>
    </div>
    <div class="hud-toasts" aria-live="polite"></div>
    <!-- tabindex="-1" for the same reason .hud-panel carries one: it is what lets
         showAchievements(true) focus the PANE rather than its first button, keeping
         isMuteHotkey/isPauseHotkey's target.closest('button,...') guard from going dead
         the moment this pane opens (see setState's own comment on the same trick). -->
    <div class="hud-achievements hud-achievements--hidden" tabindex="-1" aria-labelledby="hud-achievements-title">
      <h1 id="hud-achievements-title">Achievements</h1>
      <p class="hud-achievements-count"></p>
      <div class="hud-achievement-list"></div>
      <button class="hud-achievements-back" type="button">Back</button>
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
      <button class="hud-levelselect-back" type="button">Back</button>
    </div>
    <!-- The controller assignment panel (docs/superpowers/plans/2026-08-17-controller-
         assignment.md): ONE panel, TWO entry points -- the title screen's own open
         button below, and .hud-panel-settings' presence at 'paused' too (in case a
         controller disconnects mid-round). Unlike its four siblings above/below, this
         one is NOT title-only, so its Back button cannot hardcode setState('title') --
         see handleControllersBack, which routes to shownState instead. The heading
         text itself branches on shownState too, in showControllers. -->
    <div class="hud-controllers hud-controllers--hidden" tabindex="-1" aria-labelledby="hud-controllers-title">
      <h1 class="hud-controllers-title" id="hud-controllers-title"></h1>
      <!-- REPLACE, never append -- rebuilt on open and on every detection refresh, same
           convention setLevelSelect already uses for .hud-levels. -->
      <div class="hud-controller-rows"></div>
      <button class="hud-controllers-back" type="button">Back</button>
    </div>
    <!-- The versus setup pane (docs/superpowers/plans/2026-08-21-versus-setup-menu.md,
         docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md §3): reached from
         the title screen's own Versus button above, following the exact panel template
         Controllers/Customize use (open guarded on actual transition, focus-the-pane,
         REPLACE-never-append rendering, setState's unconditional close below). Rows:
         Mode, Players, Map, Stock, Friendly fire (Teams only -- genuinely absent from
         the DOM under FFA, not merely hidden; see renderVersusFriendlyFireRow), and a
         who's-playing preview that REUSES the Controllers panel's own row machinery
         (renderControllerRowsInto) rather than forking it -- see
         renderVersusControllerRows' doc comment for the interactive/preview split.
         .hud-controller-rows/.hud-controller-row/.hud-controller-source-btn are the
         SAME classes .hud-controllers above uses (scoped by the .hud-versus-setup
         ancestor in every selector that reads them), the same trick
         .hud-aimstick .hud-stick-base already uses to share .hud-stick-base between
         the driving and aiming sticks. -->
    <div class="hud-versus-setup hud-versus-setup--hidden" tabindex="-1" aria-labelledby="hud-versus-setup-title">
      <h1 id="hud-versus-setup-title">Versus Setup</h1>
      <div class="hud-versus-row">
        <h2>Mode</h2>
        <div class="hud-versus-mode-row"></div>
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
      <div class="hud-versus-row">
        <h2>Who's playing</h2>
        <!-- Shown only when the pane's chosen player count does not match the
             running session's real Assignment -- see renderVersusControllerRows. -->
        <p class="hud-versus-assignment-note hud-versus-assignment-note--hidden">Assignment applies after Start.</p>
        <div class="hud-controller-rows"></div>
      </div>
      <button class="hud-versus-start" type="button">Start</button>
      <button class="hud-versus-back" type="button">Back</button>
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
      <button class="hud-customize-back" type="button">Back</button>
    </div>
    <div class="hud-stats hud-stats--hidden" tabindex="-1" aria-labelledby="hud-stats-title">
      <h1 id="hud-stats-title">Stats</h1>
      <table class="hud-stats-table"></table>
      <div class="hud-stats-actions">
        <button class="hud-reset-stats hud-danger" type="button">Reset stats</button>
        <button class="hud-reset-progress hud-danger" type="button">Reset progress</button>
        <button class="hud-stats-back" type="button">Back</button>
      </div>
    </div>
    <!-- tabindex="-1" so the menu can RECEIVE focus on every panel-open transition
         (setState('title'/'paused'/'win'/'lose')) without joining the tab order. It must
         be this container and not a button inside it (Start, Resume, ...):
         isMuteHotkey/isPauseHotkey both ignore a key whose target is inside input,
         button, select or textarea, so focusing a button leaves M and Escape dead the
         moment the panel opens -- measured in a browser, and a regression against main
         that was tried once for the "land already on a control" version of this and
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
         closest('input,button,select,textarea') guard, so this cannot reopen the dead-
         hotkey bug the container-focus decision exists to avoid. -->
    <div class="hud-panel hud-panel--hidden" tabindex="-1" aria-labelledby="hud-panel-title">
      <h1 class="hud-title" id="hud-panel-title"></h1>
      <p class="hud-subtitle"></p>
      <p class="hud-attempt-summary hud-attempt-summary--hidden"></p>
      <p class="hud-coop-kills hud-coop-kills--hidden"></p>
      <p class="hud-versus-results hud-versus-results--hidden"></p>
      <!-- The title state's action button, split in two (issue #135): Continue resumes
           at the furthest unlocked level and is offered only once there is something to
           resume; New Game always starts level 1. The .hud-action button itself survives
           for Resume/Next Level/Play Again/Retry -- see setState -- and hides at title. -->
      <button class="hud-continue hud-continue--hidden" type="button">Continue</button>
      <button class="hud-new-game hud-new-game--hidden" type="button">New Game</button>
      <button class="hud-action" type="button"></button>
      <button class="hud-stats-open hud-stats-open--hidden" type="button">Stats</button>
      <button class="hud-achievements-open hud-achievements-open--hidden" type="button">Achievements</button>
      <button class="hud-customize-open hud-customize-open--hidden" type="button">Customize</button>
      <button class="hud-levelselect-open hud-levelselect-open--hidden" type="button">Levels</button>
      <!-- Visible at title AND paused -- the one new variant of this file's per-button
           visibility pattern, precedented by .hud-panel-settings itself already showing
           at both those states (see setState). -->
      <button class="hud-controllers-open hud-controllers-open--hidden" type="button">Controllers</button>
      <!-- Versus setup entry (docs/superpowers/specs/2026-08-21-versus-setup-menu-
           design.md, ruling 1): TITLE ONLY, unlike Controllers just above (title AND
           paused) -- a live round's mode/players/stock are closed over for its whole
           session (levels.ts's own doc comment, loop.ts's startGameWith), so there is
           nothing this button could offer mid-round. See onVersusOpen's own doc
           comment on the Hud interface for why its click handler is a bare
           passthrough rather than a local showX(true) call. -->
      <button class="hud-versus-open hud-versus-open--hidden" type="button">Versus</button>
      <button class="hud-quit hud-quit--hidden" type="button">Quit to Title</button>
      <!-- The panel settings row, shown on the main menu AND the pause panel: the
           seed of the settings pane. Mirrors the topbar audio pair (same engine, same
           callbacks) rather than moving it, so audio stays adjustable mid-game too.
           autocomplete="off" for the same Firefox bfcache reason as the topbar slider. -->
      <div class="hud-panel-settings hud-panel-settings--hidden">
        <button class="hud-panel-mute" type="button">Mute (M)</button>
        <input class="hud-panel-volume" type="range" min="0" max="1" step="0.01" value="${DEFAULT_VOLUME}" autocomplete="off" />
        <!-- The right thumb's aim scheme, reachable from both the title screen and the
             pause panel -- a phone player can only change this here, there being no
             keyboard to bind it to. Label/hint text is filled in by renderSchemeToggle. -->
        <button class="hud-scheme-toggle" type="button"></button>
        <!-- How the aim thumb pulls the trigger (see FireMode in touch.ts) -- beside the
             aim-scheme toggle, same row, same reachability. The FIRE button works in
             EVERY mode; this only adds a gesture. Label/hint filled in by
             renderFireModeToggle. -->
        <button class="hud-firemode-toggle" type="button"></button>
        <!-- Whether haptics.ts's vibrate calls fire at all -- same row, same
             reachability as the two toggles above (a phone player can only reach this
             here). Label/hint text is filled in by renderHapticsToggle. -->
        <button class="hud-haptics-toggle" type="button"></button>
      </div>
    </div>
  `;
  root.appendChild(el);

  const countEl = el.querySelector('.hud-count') as HTMLElement;
  const shellsEl = el.querySelector('.hud-shells') as HTMLElement;
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
  const levelChip = el.querySelector('.hud-level') as HTMLElement;
  const levelNum = el.querySelector('.hud-level-num') as HTMLElement;
  const muteBtn = el.querySelector('.hud-mute') as HTMLButtonElement;
  const volumeEl = el.querySelector('.hud-volume') as HTMLInputElement;
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
  const statsOpenBtn = el.querySelector('.hud-stats-open') as HTMLButtonElement;
  const statsView = el.querySelector('.hud-stats') as HTMLElement;
  const statsTable = el.querySelector('.hud-stats-table') as HTMLElement;
  const resetStatsBtn = el.querySelector('.hud-reset-stats') as HTMLButtonElement;
  const resetProgressBtn = el.querySelector('.hud-reset-progress') as HTMLButtonElement;
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
  const achOpenBtn = el.querySelector('.hud-achievements-open') as HTMLButtonElement;
  const achView = el.querySelector('.hud-achievements') as HTMLElement;
  const achListEl = el.querySelector('.hud-achievement-list') as HTMLElement;
  const achCountEl = el.querySelector('.hud-achievements-count') as HTMLElement;
  const achBackBtn = el.querySelector('.hud-achievements-back') as HTMLButtonElement;
  const toastsEl = el.querySelector('.hud-toasts') as HTMLElement;
  const attemptSummaryEl = el.querySelector('.hud-attempt-summary') as HTMLElement;
  const coopKillsEl = el.querySelector('.hud-coop-kills') as HTMLElement;
  const versusResultsEl = el.querySelector('.hud-versus-results') as HTMLElement;
  const panelSettings = el.querySelector('.hud-panel-settings') as HTMLElement;
  const levelSelectOpenBtn = el.querySelector('.hud-levelselect-open') as HTMLButtonElement;
  const levelSelectView = el.querySelector('.hud-levelselect') as HTMLElement;
  const levelSelectBackBtn = el.querySelector('.hud-levelselect-back') as HTMLButtonElement;
  const levelsRow = el.querySelector('.hud-levels') as HTMLElement;
  const controllersOpenBtn = el.querySelector('.hud-controllers-open') as HTMLButtonElement;
  const controllersView = el.querySelector('.hud-controllers') as HTMLElement;
  const controllersTitleEl = el.querySelector('.hud-controllers-title') as HTMLElement;
  const controllerRowsEl = el.querySelector('.hud-controller-rows') as HTMLElement;
  const controllersBackBtn = el.querySelector('.hud-controllers-back') as HTMLButtonElement;
  const versusOpenBtn = el.querySelector('.hud-versus-open') as HTMLButtonElement;
  const versusSetupView = el.querySelector('.hud-versus-setup') as HTMLElement;
  const versusModeRow = el.querySelector('.hud-versus-mode-row') as HTMLElement;
  const versusPlayersRow = el.querySelector('.hud-versus-players-row') as HTMLElement;
  const versusMapRow = el.querySelector('.hud-versus-map-row') as HTMLElement;
  const versusStockRow = el.querySelector('.hud-versus-stock-row') as HTMLElement;
  const versusFriendlyFireRow = el.querySelector('.hud-versus-friendlyfire-row') as HTMLElement;
  const versusControllerRowsEl = el.querySelector('.hud-versus-setup .hud-controller-rows') as HTMLElement;
  const versusAssignmentNoteEl = el.querySelector('.hud-versus-assignment-note') as HTMLElement;
  const versusStartBtn = el.querySelector('.hud-versus-start') as HTMLButtonElement;
  const versusBackBtn = el.querySelector('.hud-versus-back') as HTMLButtonElement;
  const panelMuteBtn = el.querySelector('.hud-panel-mute') as HTMLButtonElement;
  const panelVolumeEl = el.querySelector('.hud-panel-volume') as HTMLInputElement;
  const schemeToggleBtn = el.querySelector('.hud-scheme-toggle') as HTMLButtonElement;
  const firemodeToggleBtn = el.querySelector('.hud-firemode-toggle') as HTMLButtonElement;
  const hapticsToggleBtn = el.querySelector('.hud-haptics-toggle') as HTMLButtonElement;

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
    b.className = 'hud-swatch';
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
      b.classList.toggle('hud-swatch--selected', b.dataset.hull === currentHull);
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
    b.className = 'hud-skin';
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
      b.classList.toggle('hud-skin--selected', b.dataset.skin === currentSkin);
    }
  }

  const pickAccentCbs: Array<(id: AccentId) => void> = [];
  let currentAccent: AccentId = ACCENTS[0].id;
  const customizeOpenCbs: Array<() => void> = [];
  const customizeCloseCbs: Array<() => void> = [];
  const controllersOpenCbs: Array<() => void> = [];
  const controllersCloseCbs: Array<() => void> = [];
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
    b.className = 'hud-swatch';
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
      b.classList.toggle('hud-swatch--selected', b.dataset.accent === currentAccent);
    }
  }

  let statsData: { lifetime: StatCounts; attempt: StatCounts } | null = null;
  /** `null` means "never show" (1P, or coop that has not started) -- see setCoopKills. */
  let coopKillsData: number[] | null = null;
  /** `null` means "never show" (not a versus session, or one that has not started) --
   *  see setVersusResults. */
  let versusResultsData: { mode: 'ffa' | 'teams'; kills: number[]; deaths: number[] } | null = null;

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
    if (!statsData) {
      attemptSummaryEl.classList.add('hud-attempt-summary--hidden');
      return;
    }
    const r = statsData.attempt;
    const kills = r.shellKills + r.mineKills;
    attemptSummaryEl.textContent =
      `This run: ${kills} kills · ${r.deaths} deaths · ${pct(r.shellKills, r.shotsFired)} accuracy`;
    attemptSummaryEl.classList.remove('hud-attempt-summary--hidden');
  }

  /**
   * Twin of renderAttemptSummary, one line below it. `coopKillsData === null` means
   * "never show" -- covers both a 1P session and coop before its first setCoopKills
   * call -- so the line stays hidden even at win/lose, unlike the attempt summary
   * which only depends on statsData ever having been set once at boot.
   */
  function renderCoopKillLine(): void {
    if (!coopKillsData) {
      coopKillsEl.classList.add('hud-coop-kills--hidden');
      return;
    }
    const [p1, p2] = coopKillsData;
    coopKillsEl.textContent = `P1: ${p1 ?? 0} · P2: ${p2 ?? 0}`;
    coopKillsEl.classList.remove('hud-coop-kills--hidden');
  }

  /**
   * Twin of renderCoopKillLine, one line below it -- see setVersusResults' own doc
   * comment for why this is a separate line rather than a mode branch inside that one.
   * `mode === 'teams'` sums kills/deaths PER TEAM (`teamOf(slot)`) rather than showing
   * one entry per slot: teams mode cares which SIDE won. ffa shows one entry per slot,
   * kills/deaths as `k/d`.
   */
  function renderVersusResultsLine(): void {
    if (!versusResultsData) {
      versusResultsEl.classList.add('hud-versus-results--hidden');
      return;
    }
    const { mode, kills, deaths } = versusResultsData;
    const slots = Math.max(kills.length, deaths.length);
    let text: string;
    if (mode === 'teams') {
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
   * Two-click confirm: the first click arms, the second within the window fires.
   * One armed button at a time -- arming Reset stats must not leave Reset progress
   * one accidental click from firing.
   */
  let armedReset: { btn: HTMLButtonElement; timer: ReturnType<typeof setTimeout> } | null = null;

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

  function showStats(show: boolean): void {
    disarmReset(); // entering OR leaving, no reset stays one click from firing
    statsView.classList.toggle('hud-stats--hidden', !show);
    panel.classList.toggle('hud-panel--hidden', show);
    if (show) {
      renderStatsTable();
      // The PANE, not its first button -- see the roving-focus doc comment below on why
      // every panel-open transition focuses the container rather than a control.
      statsView.focus();
    }
  }

  // The single chokepoint for both the panel's own Back button AND setState's
  // unconditional close (below) -- see onCustomizeOpen/onCustomizeClose's doc comment.
  // Guarded on the ACTUAL transition so a caller building/disposing the live preview
  // off these never sees a redundant open or a redundant dispose.
  function showCustomize(show: boolean): void {
    const wasOpen = !customizeView.classList.contains('hud-customize--hidden');
    customizeView.classList.toggle('hud-customize--hidden', !show);
    panel.classList.toggle('hud-panel--hidden', show);
    if (show) {
      renderSwatchSelection();
      renderSkinSelection();
      renderAccentSelection();
      customizeView.focus(); // the pane, not the canvas -- see the roving-focus comment below
      if (!wasOpen) for (const cb of customizeOpenCbs) cb();
    } else if (wasOpen) {
      for (const cb of customizeCloseCbs) cb();
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
    achView.classList.toggle('hud-achievements--hidden', !show);
    panel.classList.toggle('hud-panel--hidden', show);
    if (show) {
      renderAchievements();
      achView.focus();
    }
  }

  // Same shape as showAchievements: no open/close callbacks (nothing here owns a WebGL
  // context the way Customize does), and no re-render on open -- setLevelSelect already
  // keeps `.hud-levels` current regardless of visibility ("REPLACE, never append").
  function showLevelSelect(show: boolean): void {
    levelSelectView.classList.toggle('hud-levelselect--hidden', !show);
    panel.classList.toggle('hud-panel--hidden', show);
    if (show) levelSelectView.focus();
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
   * Parameterized over the TARGET CONTAINER, the ASSIGNMENT to render, and whether the
   * candidate buttons are INTERACTIVE -- extracted so the versus setup pane's who's-
   * playing preview (`renderVersusControllerRows`) can reuse this exact renderer
   * against its OWN pane-local player count rather than forking it (task 4 brief: "do
   * not fork it"). The real Controllers panel below is simply the `interactive: true`
   * caller against the session's own `currentAssignment`; nothing about its own
   * behaviour changes from this extraction.
   */
  function renderControllerRowsInto(
    container: HTMLElement,
    assignment: Assignment,
    interactive: boolean,
  ): void {
    container.replaceChildren();
    for (let slot = 0; slot < assignment.length; slot++) {
      const source = assignment[slot];
      const row = document.createElement('div');
      row.className = 'hud-controller-row';

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
        btn.className = 'hud-controller-source-btn';
        btn.textContent = candidateLabel(candidate);
        btn.classList.toggle('hud-controller-source-btn--selected', sameSource(candidate, source));
        const forSlot = slot; // captured per-iteration, not the loop's shared binding
        if (interactive) {
          btn.addEventListener('click', () => {
            for (const cb of reassignSlotCbs) cb(forSlot, candidate);
          });
        } else {
          // The versus pane's PREVIEW rows (renderVersusControllerRows): the pane's
          // chosen player count does not match the running session's, so this cannot
          // possibly be the real assignment -- disabled so a click (even a
          // programmatic one) can never reassign a slot that does not exist yet.
          btn.disabled = true;
        }
        row.appendChild(btn);
      }
      container.appendChild(row);
    }
  }

  function renderControllerRows(): void {
    renderControllerRowsInto(controllerRowsEl, currentAssignment, true);
  }

  /**
   * The single chokepoint for both the panel's own Back button AND setState's
   * unconditional close -- see onControllersOpen/onControllersClose's doc comment.
   * Guarded on the ACTUAL transition, same as showCustomize, so loop.ts's window
   * listener add/remove never sees a redundant open or close.
   */
  function showControllers(show: boolean): void {
    const wasOpen = !controllersView.classList.contains('hud-controllers--hidden');
    controllersView.classList.toggle('hud-controllers--hidden', !show);
    panel.classList.toggle('hud-panel--hidden', show);
    if (show) {
      // The only copy that differs between the two entry points -- see this panel's own
      // markup comment.
      controllersTitleEl.textContent =
        shownState === 'paused' ? 'Controllers' : "Choose who's playing";
      renderControllerRows();
      controllersView.focus();
      if (!wasOpen) for (const cb of controllersOpenCbs) cb();
    } else if (wasOpen) {
      for (const cb of controllersCloseCbs) cb();
    }
  }

  /**
   * Roving-tabindex keyboard (and future D-pad) navigation between the HUD's panels.
   *
   * Only ONE of `panel`/`customizeView`/`statsView`/`achView`/`levelSelectView`/
   * `controllersView`/`versusSetupView` is ever visible at a time -- every showX(true)
   * hides `panel`, and setState's top unconditionally closes every subpanel that does
   * not own a hide chokepoint of its own (Customize and Controllers route through
   * their own showX(false) instead, to fire their close callbacks), so
   * `activePanelContainer` can just return the first one found visible.
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
   * reason. An EARLIER version of this focused each
   * pane's first CONTROL instead, on the reasoning that arriving already positioned saves
   * a keypress. That reasoning was wrong: `isMuteHotkey`/`isPauseHotkey`
   * (`game/loop.ts`) both ignore any key whose `target.closest('input,button,select,
   * textarea')` matches, so focusing a real button on entry -- Resume on the pause panel,
   * Continue/New Game back at title -- silently killed Escape-to-resume and M-to-mute the
   * moment the panel opened. A plain `<div tabindex="-1">` never matches that selector, so
   * the container is the one target that can carry focus without going near that guard.
   * `moveFocus`'s `idx < 0` branch is what makes this free: the first ArrowDown from the
   * container lands on control[0] exactly as it would have if this landed there directly.
   */
  function activePanelContainer(): HTMLElement | null {
    for (const c of [panel, customizeView, statsView, achView, levelSelectView, controllersView, versusSetupView]) {
      if (getComputedStyle(c).display !== 'none') return c;
    }
    return null;
  }

  /**
   * Walks up from `el` to (not including) `container`, so a control whose own
   * `display` resolves to something other than `none` but sits inside a hidden
   * WRAPPER -- `.hud-panel-settings` on the win/lose panel, which hides the audio row
   * as a group rather than each control individually -- is still excluded. Measured:
   * `getComputedStyle` on a `<button>` inside a `display:none` ancestor reports the
   * button's OWN resolved display (e.g. `inline-block`), not `none` -- computed style is
   * per-element, not "as rendered" -- so `focusableControls` checking only the control
   * itself would have walked the roving order onto three invisible buttons on every
   * win/lose screen.
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

  /**
   * Move the roving-tabindex focus one step within whichever panel is showing.
   * `dir` is +1 (the direction Down/Right/S move) or -1 (Up/Left/W). Factored out from
   * the key handler so a gamepad D-pad -- issue #114, not built here -- can call this
   * exact function later and inherit every panel's traversal for free.
   *
   * Wrapping, not clamping: with no "past the end" state to fall off, the exact same
   * ArrowDown press that reaches the last control also proves the cycle closes, which
   * is what the reachability test asserts.
   *
   * `idx < 0` covers two real starting points, not one: focus sitting on the panel
   * CONTAINER itself (just after `panel.focus()`, tabindex -1, not in the control list)
   * and focus sitting on something this sweep does not track at all (the topbar's own
   * Mute button, reachable by Tab independently of the panel). Both land on the first
   * control going forward and the last one going backward, which is a reasonable
   * default for either case rather than a special error path.
   */
  function moveFocus(container: HTMLElement, dir: 1 | -1): void {
    const list = focusableControls(container);
    if (list.length === 0) return;
    const active = document.activeElement;
    const idx = active instanceof HTMLElement ? list.indexOf(active) : -1;
    const next = idx < 0 ? (dir > 0 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length;
    list[next].focus();
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
    if (e.target instanceof HTMLInputElement) return; // the two volume sliders keep all four arrows
    const key = e.key.toLowerCase();
    const isVertical = key === 'arrowdown' || key === 'arrowup' || key === 's' || key === 'w';
    const isLateral = key === 'arrowleft' || key === 'arrowright';
    if (!isVertical && !isLateral) return;
    if (isLateral && e.target === previewCanvasEl) return; // the preview owns its own scheme
    const container = activePanelContainer();
    if (!container) return; // nothing shown (splash/playing): let input.ts drive the tank
    const dir: 1 | -1 = key === 'arrowup' || key === 'w' ? -1 : key === 'arrowleft' ? -1 : 1;
    // Claiming the key stops the WHOLE remaining dispatch -- including el's own
    // capture-phase `disarm` listener, which clears the pending drag-dismiss click
    // swallow on any key. Found by mutation in review: without this call, a player who
    // drag-dismissed the splash and then navigated by ARROW keys (rather than Tab,
    // which is not claimed here) had the next real click silently eaten. Any key that
    // moves focus must disarm exactly as an unclaimed key would have.
    disarm();
    e.preventDefault();
    e.stopPropagation();
    moveFocus(container, dir);
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
  // Two sliders, one truth: whichever moves, the other follows before subscribers
  // hear about it -- reopening the pause panel must never show a stale level.
  const handleVolume = (): void => {
    panelVolumeEl.value = volumeEl.value;
    const v = Number(volumeEl.value);
    for (const cb of volumeCbs) cb(v);
  };
  const handlePanelVolume = (): void => {
    volumeEl.value = panelVolumeEl.value;
    const v = Number(panelVolumeEl.value);
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

  muteBtn.addEventListener('click', handleMute);
  muteBtn.addEventListener('click', blurIfPointer);
  volumeEl.addEventListener('input', handleVolume);
  volumeEl.addEventListener('mouseup', blurAfterDrag);
  actionBtn.addEventListener('click', handleAction);
  actionBtn.addEventListener('click', blurIfPointer);
  quitBtn.addEventListener('click', handleQuit);
  quitBtn.addEventListener('click', blurIfPointer);
  const handleStatsOpen = (): void => showStats(true);
  const handleStatsBack = (): void => {
    showStats(false);
    setState('title'); // re-render the title panel it covered
  };
  const handleResetStats = (): void => handleDangerClick(resetStatsBtn, resetStatsCbs);
  const handleResetProgress = (): void => handleDangerClick(resetProgressBtn, resetProgressCbs);
  const handleCustomizeOpen = (): void => showCustomize(true);
  const handleCustomizeBack = (): void => {
    showCustomize(false);
    setState('title');
  };
  const handleAchOpen = (): void => showAchievements(true);
  const handleAchBack = (): void => {
    showAchievements(false);
    setState('title');
  };
  achOpenBtn.addEventListener('click', handleAchOpen);
  achOpenBtn.addEventListener('click', blurIfPointer);
  achBackBtn.addEventListener('click', handleAchBack);
  achBackBtn.addEventListener('click', blurIfPointer);
  customizeOpenBtn.addEventListener('click', handleCustomizeOpen);
  customizeOpenBtn.addEventListener('click', blurIfPointer);
  customizeBackBtn.addEventListener('click', handleCustomizeBack);
  customizeBackBtn.addEventListener('click', blurIfPointer);
  statsOpenBtn.addEventListener('click', handleStatsOpen);
  statsOpenBtn.addEventListener('click', blurIfPointer);
  statsBackBtn.addEventListener('click', handleStatsBack);
  statsBackBtn.addEventListener('click', blurIfPointer);
  resetStatsBtn.addEventListener('click', handleResetStats);
  resetProgressBtn.addEventListener('click', handleResetProgress);
  panelMuteBtn.addEventListener('click', handleMute);
  panelMuteBtn.addEventListener('click', blurIfPointer);
  panelVolumeEl.addEventListener('input', handlePanelVolume);
  panelVolumeEl.addEventListener('mouseup', blurAfterDrag);

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
  // What setState last showed: setLevelSelect may re-render while ANOTHER panel is
  // up (unlocks are recorded at the win event), and must not splash a button onto it.
  let shownState: GameState = 'splash';
  const levelSelectCbs: Array<(level: number) => void> = [];
  const newGameCbs: Array<() => void> = [];

  const handleLevelSelectOpen = (): void => showLevelSelect(true);
  const handleLevelSelectBack = (): void => {
    showLevelSelect(false);
    setState('title'); // re-render the title panel it covered
  };
  levelSelectOpenBtn.addEventListener('click', handleLevelSelectOpen);
  levelSelectOpenBtn.addEventListener('click', blurIfPointer);
  levelSelectBackBtn.addEventListener('click', handleLevelSelectBack);
  levelSelectBackBtn.addEventListener('click', blurIfPointer);

  const handleControllersOpen = (): void => showControllers(true);
  // Back must route to `shownState`, NOT a hardcoded 'title' -- unlike every sibling
  // panel above, this one is reachable from 'paused' too (owner ruling: "in case
  // controllers disconnect"). Hardcoding 'title' would abandon a paused round on Back
  // and desync the HUD's panel from the state machine -- CLAUDE.md names this exact
  // class of defect as one this repo has shipped green before. `shownState` is already
  // 'paused' or 'title' at open time -- it is what gated the open button's own
  // visibility in the first place.
  const handleControllersBack = (): void => {
    showControllers(false);
    setState(shownState);
  };
  controllersOpenBtn.addEventListener('click', handleControllersOpen);
  controllersOpenBtn.addEventListener('click', blurIfPointer);
  controllersBackBtn.addEventListener('click', handleControllersBack);
  controllersBackBtn.addEventListener('click', blurIfPointer);

  // ---- Versus setup pane (docs/superpowers/specs/2026-08-21-versus-setup-menu-
  // design.md) --------------------------------------------------------------------

  const VERSUS_MODE_OPTIONS: ReadonlyArray<{ id: VersusConfig['mode']; label: string }> = [
    { id: 'ffa', label: 'FFA' },
    { id: 'teams', label: 'Teams' },
  ];
  const VERSUS_PLAYERS_OPTIONS: ReadonlyArray<VersusConfig['players']> = [2, 3, 4];
  const VERSUS_STOCK_OPTIONS: readonly number[] = [1, 2, 3, 4, 5];

  /** `'arena-01'` -> `'Arena 1'`, matching the spec's own "Arena 1-5" wording. Falls
   *  back to the raw id for anything that does not match the pattern -- defensive,
   *  not reachable against the shipped catalog (`arena-01`..`arena-05`; measured via
   *  `versusBoardCatalog()`, see versus-config.ts's own doc comment: all 15 of 15
   *  (arena, playerCount) rows pass `suitable` today). */
  function arenaLabel(id: string): string {
    const m = /^arena-(\d+)$/.exec(id);
    return m ? `Arena ${Number(m[1])}` : id;
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
  let versusConfigState: VersusConfig = {
    mode: 'ffa',
    players: 2,
    arenaId: 'random',
    stock: VERSUS_STOCK,
    friendlyFire: false,
  };

  function renderVersusModeSelection(): void {
    for (const b of Array.from(versusModeRow.children) as HTMLButtonElement[]) {
      b.classList.toggle('hud-versus-option-btn--selected', b.dataset.mode === versusConfigState.mode);
    }
  }
  function renderVersusPlayersSelection(): void {
    for (const b of Array.from(versusPlayersRow.children) as HTMLButtonElement[]) {
      b.classList.toggle(
        'hud-versus-option-btn--selected',
        Number(b.dataset.players) === versusConfigState.players,
      );
    }
  }
  function renderVersusStockSelection(): void {
    for (const b of Array.from(versusStockRow.children) as HTMLButtonElement[]) {
      b.classList.toggle('hud-versus-option-btn--selected', Number(b.dataset.stock) === versusConfigState.stock);
    }
  }

  /**
   * REPLACE, never append -- rebuilt whenever `players` changes (the arena list is
   * filtered by it -- `versusMapChoices`, versus-config.ts) and whenever the pane is
   * (re)seeded, same convention `renderControllerRows` already uses for its own
   * per-slot rows.
   */
  function renderVersusMapRow(): void {
    versusMapRow.replaceChildren();
    const choices: string[] = [...versusMapChoices(versusConfigState.players), 'random'];
    for (const choice of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hud-versus-option-btn';
      b.dataset.map = choice;
      b.textContent = choice === 'random' ? 'Random' : arenaLabel(choice);
      b.classList.toggle('hud-versus-option-btn--selected', choice === versusConfigState.arenaId);
      b.addEventListener('click', () => {
        versusConfigState = { ...versusConfigState, arenaId: choice };
        renderVersusMapRow(); // REPLACE -- rebuilds the whole row for the new selection ring
      });
      b.addEventListener('click', blurIfPointer);
      versusMapRow.appendChild(b);
    }
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
    b.className = 'hud-versus-friendlyfire-btn';
    renderVersusFriendlyFireLabel(b);
    b.addEventListener('click', () => {
      versusConfigState = { ...versusConfigState, friendlyFire: !versusConfigState.friendlyFire };
      renderVersusFriendlyFireLabel(b);
    });
    b.addEventListener('click', blurIfPointer);
    versusFriendlyFireRow.append(heading, b);
  }

  /**
   * The who's-playing PREVIEW: reuses `renderControllerRowsInto` exactly (task 4
   * brief: "do not fork it"), rendered against the PANE's own chosen player count,
   * which may differ from the RUNNING session's real `Assignment`
   * (`currentAssignment.length`) -- e.g. the pane defaults to 2 players while a
   * 3-player session is still live behind it.
   *
   * Controller ruling adopted for this task: when the counts MATCH, these rows show
   * (and can reassign) the session's own real assignment -- clicking a candidate here
   * IS reassigning the running session, exactly as the Controllers panel itself does,
   * via the same `onReassignSlot` path. When they DIFFER, this cannot possibly be the
   * running session's assignment (there is no slot 3 to reassign in a 2-player
   * session), so it renders as a non-interactive PREVIEW instead: synthetic
   * `{ kind: 'none' }` placeholders, one per pane slot, with every candidate button
   * disabled and a note that the real assignment is seeded fresh at reboot
   * (`deriveInitialAssignment`, boot.ts) once Start is pressed.
   *
   * `VersusConfig` deliberately carries no assignment field of its own -- wiring the
   * pane's preview THROUGH to the new session's actual assignment is out of scope for
   * this task (see the PR body / backlog for that residual).
   */
  function renderVersusControllerRows(): void {
    const paneCount = versusConfigState.players;
    const matchesSession = currentAssignment.length === paneCount;
    const assignment: Assignment = matchesSession
      ? currentAssignment
      : Array.from({ length: paneCount }, (): SlotSource => ({ kind: 'none' }));
    versusAssignmentNoteEl.classList.toggle('hud-versus-assignment-note--hidden', matchesSession);
    renderControllerRowsInto(versusControllerRowsEl, assignment, matchesSession);
  }

  // Mode/Players/Stock are FIXED-size option sets (unlike Map/who's-playing, they
  // never change count), so -- like the paint shop's swatch/skin/accent rows -- their
  // buttons are built ONCE here and only ever toggle a `--selected` class afterward.
  for (const opt of VERSUS_MODE_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hud-versus-option-btn';
    b.dataset.mode = opt.id;
    b.textContent = opt.label;
    b.addEventListener('click', () => {
      versusConfigState = { ...versusConfigState, mode: opt.id };
      renderVersusModeSelection();
      renderVersusFriendlyFireRow(); // absent <-> present follows mode directly
    });
    b.addEventListener('click', blurIfPointer);
    versusModeRow.appendChild(b);
  }
  renderVersusModeSelection();

  for (const players of VERSUS_PLAYERS_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hud-versus-option-btn';
    b.dataset.players = String(players);
    b.textContent = String(players);
    b.addEventListener('click', () => {
      versusConfigState = { ...versusConfigState, players };
      renderVersusPlayersSelection();
      renderVersusMapRow(); // REPLACE -- Players filters the map list
      renderVersusControllerRows(); // REPLACE -- the preview row COUNT follows players
    });
    b.addEventListener('click', blurIfPointer);
    versusPlayersRow.appendChild(b);
  }
  renderVersusPlayersSelection();

  for (const stock of VERSUS_STOCK_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hud-versus-option-btn';
    b.dataset.stock = String(stock);
    b.textContent = String(stock);
    b.addEventListener('click', () => {
      versusConfigState = { ...versusConfigState, stock };
      renderVersusStockSelection();
    });
    b.addEventListener('click', blurIfPointer);
    versusStockRow.appendChild(b);
  }
  renderVersusStockSelection();

  // Map and the who's-playing preview both depend on external/derived data
  // (versusMapChoices(players), currentAssignment) rather than a fixed option set, so
  // -- unlike Mode/Players/Stock above -- they need an initial render here rather than
  // waiting for the pane's first open, mirroring setControllers/setDetectedPads'
  // "unconditional, not gated on the panel being open" convention for the real
  // Controllers panel.
  renderVersusMapRow();
  renderVersusFriendlyFireRow();
  renderVersusControllerRows();

  const versusOpenCbs: Array<() => void> = [];
  const versusStartCbs: Array<(config: VersusConfig) => void> = [];

  // A bare click passthrough -- see onVersusOpen's own doc comment on the Hud
  // interface for why this does NOT call showVersusSetup itself.
  const handleVersusOpen = (): void => {
    for (const cb of versusOpenCbs) cb();
  };
  const handleVersusStart = (): void => {
    // A snapshot, not the live state object -- see onVersusStart's own doc comment.
    for (const cb of versusStartCbs) cb({ ...versusConfigState });
  };
  // TITLE ONLY (unlike handleControllersBack): the Versus button itself is visible
  // only at 'title' (see setState below), so Back always has exactly one place to
  // return to -- same shape as handleCustomizeBack/handleAchBack/handleStatsBack/
  // handleLevelSelectBack just above, not handleControllersBack's shownState routing.
  const handleVersusBack = (): void => {
    showVersusSetup(false);
    setState('title');
  };
  versusOpenBtn.addEventListener('click', handleVersusOpen);
  versusOpenBtn.addEventListener('click', blurIfPointer);
  versusStartBtn.addEventListener('click', handleVersusStart);
  versusStartBtn.addEventListener('click', blurIfPointer);
  versusBackBtn.addEventListener('click', handleVersusBack);
  versusBackBtn.addEventListener('click', blurIfPointer);

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
    versusSetupView.classList.toggle('hud-versus-setup--hidden', !show);
    panel.classList.toggle('hud-panel--hidden', show);
    if (!show) return;
    if (initial) versusConfigState = { ...initial };
    renderVersusModeSelection();
    renderVersusPlayersSelection();
    renderVersusStockSelection();
    renderVersusMapRow();
    renderVersusFriendlyFireRow();
    renderVersusControllerRows();
    versusSetupView.focus();
  }

  // Continue shares the Resume/Next Level/Play Again/Retry button's own handler: it IS
  // that action, under a label that says what it does at the title screen specifically.
  continueBtn.addEventListener('click', handleAction);
  continueBtn.addEventListener('click', blurIfPointer);
  // New Game fires its OWN callback list now -- see onNewGame's doc comment for why it
  // no longer reuses onLevelSelect's.
  const handleNewGame = (): void => {
    for (const cb of newGameCbs) cb();
  };
  newGameBtn.addEventListener('click', handleNewGame);
  newGameBtn.addEventListener('click', blurIfPointer);

  function setState(s: GameState): void {
    // Any state change closes the stats and customize pages FIRST -- including the
    // playing early-return below, or an overlay opened on the title screen would
    // sit over the live game. They are title-screen affairs.
    statsView.classList.add('hud-stats--hidden');
    // Routed through showCustomize (not a bare class add, unlike its stats/achievements
    // siblings above/below) so this path fires onCustomizeClose too -- the common exit
    // from the panel is Start, which arrives here, not through the Back button.
    showCustomize(false);
    achView.classList.add('hud-achievements--hidden');
    levelSelectView.classList.add('hud-levelselect--hidden');
    // Routed through showControllers for the same reason as showCustomize above -- it
    // must fire onControllersClose (loop.ts's window listener teardown) on EVERY exit,
    // not only the panel's own Back button. Omitted, the panel -- and its live
    // gamepadconnected/disconnected listeners -- would leak onto the live game on
    // Resume, since 'paused' -> 'playing' is one of this function's own early returns.
    showControllers(false);
    // A bare class add, not routed through showVersusSetup(false) -- unlike Customize/
    // Controllers just above, this pane has no onVersusClose to fire (see its own doc
    // comment), so there is nothing a transition-guarded call would buy here that a
    // plain toggle does not already give the stats/achievements/level-select siblings.
    versusSetupView.classList.add('hud-versus-setup--hidden');
    disarmReset();
    splashEl.classList.toggle('hud-splash--hidden', s !== 'splash');
    // Only while playing. Pausing from the pause panel is what its own buttons are for,
    // and a Mine button on the menu lays nothing.
    touchRow.classList.toggle('hud-touch--hidden', s !== 'playing');
    // The topbar is the only chrome that outranks the menu panel, so it is also the
    // only thing that would show through on the title screen.
    topbarEl.classList.toggle('hud-topbar--hidden', s === 'splash');
    // Splash and playing both want the menu panel gone. Splash returns BEFORE the
    // branches below for the same reason `paused` returns early: the final `else`
    // renders a Game Over corpse screen, so any state that falls through to it gets
    // "Out of lives." written into the panel -- on a fresh page load, that is the
    // first thing a player would see.
    if (s === 'playing' || s === 'splash') {
      panel.classList.add('hud-panel--hidden');
      return;
    }
    panel.classList.remove('hud-panel--hidden');
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
    const clearedIntermediate = s === 'win' && !!levelPos && levelPos.current < levelPos.total;
    shownState = s;
    statsOpenBtn.classList.toggle('hud-stats-open--hidden', s !== 'title');
    customizeOpenBtn.classList.toggle('hud-customize-open--hidden', s !== 'title');
    achOpenBtn.classList.toggle('hud-achievements-open--hidden', s !== 'title');
    levelSelectOpenBtn.classList.toggle('hud-levelselect-open--hidden', s !== 'title' || !levelChoice);
    quitBtn.classList.toggle('hud-quit--hidden', s !== 'paused' && !clearedIntermediate);
    // "Quit" is the wrong word for leaving a level you just WON -- the run is preserved
    // either way, but the copy should not imply abandoning it.
    quitBtn.textContent = clearedIntermediate ? 'Main Menu' : 'Quit to Title';
    panelSettings.classList.toggle('hud-panel-settings--hidden', s !== 'paused' && s !== 'title');
    // Visible at title AND paused -- the one new variant of this per-button visibility
    // pattern, precedented by panelSettings itself just above.
    controllersOpenBtn.classList.toggle('hud-controllers-open--hidden', s !== 'paused' && s !== 'title');
    // TITLE ONLY, unlike Controllers just above -- see this button's own markup
    // comment for why a live round has nothing this could offer.
    versusOpenBtn.classList.toggle('hud-versus-open--hidden', s !== 'title');
    // Continue/New Game replace the single action button AT TITLE ONLY -- Resume, Next
    // Level, Play Again and Retry all still route through actionBtn below, which is why
    // this toggles on `s === 'title'` alone rather than joining the group above.
    continueBtn.classList.toggle('hud-continue--hidden', s !== 'title' || !hasProgress);
    newGameBtn.classList.toggle('hud-new-game--hidden', s !== 'title');
    actionBtn.classList.toggle('hud-action--hidden', s === 'title');
    // The attempt summary belongs to the END screens alone.
    attemptSummaryEl.classList.toggle('hud-attempt-summary--hidden', s !== 'win' && s !== 'lose');
    if (s === 'win' || s === 'lose') renderAttemptSummary();
    // Twin toggle for coop's kill line -- renderCoopKillLine re-hides it if
    // coopKillsData is null (1P, or coop that has not started), even at win/lose.
    coopKillsEl.classList.toggle('hud-coop-kills--hidden', s !== 'win' && s !== 'lose');
    versusResultsEl.classList.toggle('hud-versus-results--hidden', s !== 'win' && s !== 'lose');
    if (s === 'win' || s === 'lose') renderCoopKillLine();
    if (s === 'win' || s === 'lose') renderVersusResultsLine();
    if (s === 'paused') {
      titleEl.textContent = 'Paused';
      setSubtitle('The arena waits.');
      actionBtn.textContent = 'Resume';
      // The PANEL, not actionBtn -- see the tabindex note on the element and the
      // roving-focus doc comment above `activePanelContainer`. Focusing Resume directly
      // used to be tried here and reverted: `isPauseHotkey` ignores any key whose target
      // sits inside a button, so it made Escape-to-resume go dead the instant the pause
      // panel opened -- measured by constructing the same event that guard reads and
      // finding it return false. A div can never match that guard.
      panel.focus();
      return; // do NOT fall through: the final else renders a Game Over corpse screen
    }
    // The panel, NOT actionBtn/Continue/New Game -- see the tabindex note on the element
    // and the roving-focus doc comment above `activePanelContainer`. Without this,
    // `document.activeElement` is still <body> when the menu appears (leaving the splash
    // screen with nothing focused), or -- on a route back from a subpanel's Back button --
    // whatever the subpanel's own container last held, in both cases stranding a
    // keyboard-only player with no visible position and a screen reader announcing
    // nothing.
    panel.focus();
    if (s === 'title') {
      titleEl.textContent = 'TANKS!';
      setSubtitle('');
    } else if (s === 'win') {
      // An intermediate win advances; only the LAST level's win is the game's.
      if (levelPos && levelPos.current < levelPos.total) {
        titleEl.textContent = `Level ${levelPos.current} cleared!`;
        setSubtitle('On to the next.');
        actionBtn.textContent = 'Next Level';
      } else {
        titleEl.textContent = 'You Win!';
        setSubtitle('Arena cleared.');
        actionBtn.textContent = 'Play Again';
      }
    } else {
      titleEl.textContent = 'Game Over';
      setSubtitle('Out of lives.');
      actionBtn.textContent = 'Retry';
    }
  }

  // The boot state, and it must match the state machine's own initial state
  // (`state.ts`), which is now the splash screen rather than the menu. `loop.ts` also
  // pushes `hud.setState(sm.state)` at boot precisely because that path bypasses
  // `sm.onChange`; this call is what the HUD looks like before it arrives.
  setState('splash');

  // The button is the only indication of mute state, and there is genuinely no
  // music shipped, so "silent" is the normal condition -- without this a muted
  // game and a broken game look identical.
  function setMuted(muted: boolean): void {
    for (const btn of [muteBtn, panelMuteBtn]) {
      btn.setAttribute('aria-pressed', String(muted));
      btn.textContent = muted ? 'Muted (M)' : 'Mute (M)';
      btn.classList.toggle('hud-mute--active', muted);
    }
  }

  setMuted(false);

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
      // REPLACE, never append: this re-renders after every unlock.
      levelsRow.textContent = '';
      for (let i = 0; i < total; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hud-level-btn';
        btn.textContent = String(i + 1);
        if (i + 1 > unlocked) {
          // Disabled, not merely grey: a locked level must be unclickable, and a
          // disabled button never fires click handlers.
          btn.disabled = true;
          btn.classList.add('hud-level-btn--locked');
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
      // convention the row itself used to follow directly.
      levelSelectOpenBtn.classList.toggle('hud-levelselect-open--hidden', shownState !== 'title' || !levelChoice);
    },
    onLevelSelect(cb: (level: number) => void): void {
      levelSelectCbs.push(cb);
    },
    setContinueAvailable(available: boolean): void {
      hasProgress = available;
      // Same `shownState` convention as setLevelSelect just above: this can be pushed
      // while another panel is up (a game-over/completion transition ends the run
      // before the player is back at the title screen to see it).
      continueBtn.classList.toggle('hud-continue--hidden', shownState !== 'title' || !hasProgress);
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
      if (!attemptSummaryEl.classList.contains('hud-attempt-summary--hidden')) renderAttemptSummary();
    },
    setCoopKills(counts: number[] | null): void {
      coopKillsData = counts;
      if (!coopKillsEl.classList.contains('hud-coop-kills--hidden')) renderCoopKillLine();
    },
    setVersusResults(data: { mode: 'ffa' | 'teams'; kills: number[]; deaths: number[] } | null): void {
      versusResultsData = data;
      if (!versusResultsEl.classList.contains('hud-versus-results--hidden')) renderVersusResultsLine();
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
    // setAchievements/setCoopKills' convention): "REPLACE, never append" means .hud-
    // controller-rows stays current regardless of visibility, so a boot-time push (before
    // the panel has ever opened) and a mid-session hotplug both land correctly whenever
    // the panel is next shown, with no separate "refresh on open" path to keep in sync.
    setControllers(assignment: Assignment): void {
      currentAssignment = assignment;
      renderControllerRows();
      // The versus pane's who's-playing PREVIEW reads `currentAssignment` too (see
      // renderVersusControllerRows) -- refreshed here for the same "stays current
      // regardless of visibility" reason as the real panel just above, so a session
      // reassignment while the setup pane is open is reflected immediately, and a
      // match/mismatch against the pane's own player count is never left stale from
      // whatever it was at construction.
      renderVersusControllerRows();
    },
    setDetectedPads(pads: readonly DetectedPad[]): void {
      currentDetectedPads = pads;
      renderControllerRows();
      renderVersusControllerRows();
    },
    setBotAssignmentAllowed(allowed: boolean): void {
      botAssignmentAllowedNow = allowed;
      renderControllerRows();
      renderVersusControllerRows();
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
    dispose(): void {
      disarmReset(); // a pending confirm timer must not outlive the HUD
      for (const t of toastTimers) clearTimeout(t);
      toastTimers.clear();
      window.removeEventListener('keydown', onNavKeyDown, true);
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
      achOpenBtn.removeEventListener('click', handleAchOpen);
      achOpenBtn.removeEventListener('click', blurIfPointer);
      achBackBtn.removeEventListener('click', handleAchBack);
      achBackBtn.removeEventListener('click', blurIfPointer);
      levelSelectOpenBtn.removeEventListener('click', handleLevelSelectOpen);
      levelSelectOpenBtn.removeEventListener('click', blurIfPointer);
      levelSelectBackBtn.removeEventListener('click', handleLevelSelectBack);
      levelSelectBackBtn.removeEventListener('click', blurIfPointer);
      controllersOpenBtn.removeEventListener('click', handleControllersOpen);
      controllersOpenBtn.removeEventListener('click', blurIfPointer);
      controllersBackBtn.removeEventListener('click', handleControllersBack);
      controllersBackBtn.removeEventListener('click', blurIfPointer);
      versusOpenBtn.removeEventListener('click', handleVersusOpen);
      versusOpenBtn.removeEventListener('click', blurIfPointer);
      versusStartBtn.removeEventListener('click', handleVersusStart);
      versusStartBtn.removeEventListener('click', blurIfPointer);
      versusBackBtn.removeEventListener('click', handleVersusBack);
      versusBackBtn.removeEventListener('click', blurIfPointer);
      continueBtn.removeEventListener('click', handleAction);
      continueBtn.removeEventListener('click', blurIfPointer);
      newGameBtn.removeEventListener('click', handleNewGame);
      newGameBtn.removeEventListener('click', blurIfPointer);
      customizeOpenBtn.removeEventListener('click', handleCustomizeOpen);
      customizeOpenBtn.removeEventListener('click', blurIfPointer);
      customizeBackBtn.removeEventListener('click', handleCustomizeBack);
      customizeBackBtn.removeEventListener('click', blurIfPointer);
      statsOpenBtn.removeEventListener('click', handleStatsOpen);
      statsOpenBtn.removeEventListener('click', blurIfPointer);
      statsBackBtn.removeEventListener('click', handleStatsBack);
      statsBackBtn.removeEventListener('click', blurIfPointer);
      resetStatsBtn.removeEventListener('click', handleResetStats);
      resetProgressBtn.removeEventListener('click', handleResetProgress);
      quitBtn.removeEventListener('click', handleQuit);
      quitBtn.removeEventListener('click', blurIfPointer);
      panelMuteBtn.removeEventListener('click', handleMute);
      panelMuteBtn.removeEventListener('click', blurIfPointer);
      panelVolumeEl.removeEventListener('input', handlePanelVolume);
      panelVolumeEl.removeEventListener('mouseup', blurAfterDrag);
      muteBtn.removeEventListener('click', handleMute);
      muteBtn.removeEventListener('click', blurIfPointer);
      volumeEl.removeEventListener('input', handleVolume);
      volumeEl.removeEventListener('mouseup', blurAfterDrag);
      actionBtn.removeEventListener('click', handleAction);
      actionBtn.removeEventListener('click', blurIfPointer);
      el.remove();
    },
  };
}
