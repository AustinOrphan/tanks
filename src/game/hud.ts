import type { GameState } from './state';
import type { StatCounts } from './stats';
import { PALETTE, SKINS, ACCENTS, type HullColorId, type SkinId, type AccentId } from './customization';
import { ACHIEVEMENTS, type AchievementDef, type AchievementId } from './achievements';
import type { RoundPhase } from '../sim/round';
import { DEFAULT_VOLUME } from '../audio/manifest';
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
  /** Centred banner when true, topbar chip when false. */
  prominent: boolean;
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
   * (1-based count; level 1 is always open). A one-level total hides the row --
   * the sandbox is not a choice. Locked buttons are DISABLED, not merely grey.
   */
  setLevelSelect(unlocked: number, total: number): void;
  /** Fired with the 0-BASED level index when an unlocked level button is clicked. */
  onLevelSelect(cb: (level: number) => void): void;
  setState(s: GameState): void;
  /** Reflect the engine's mute state in the button. */
  setMuted(muted: boolean): void;
  /**
   * Round-start phase feedback. `null` hides it. `prominent` picks the centred
   * banner over the topbar chip; the caller decides which, not the HUD.
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
  signalPlayerDeath(): void;
  onMuteToggle(cb: () => void): void;
  onVolumeChange(cb: (v: number) => void): void;
  /** Extension: fired when the title/win/lose panel's start/restart button is clicked. */
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
   * stats table only while it is visible, and keeps the win/lose run-summary line
   * live -- the winning kill is recorded a beat AFTER the state flips.
   */
  setStats(data: { lifetime: StatCounts; run: StatCounts }): void;
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
  dispose(): void;
}

/** How long an unlock toast sits on screen. Feel, not measurement. */
const TOAST_MS = 3200;

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
      <div class="hud-phase hud-phase--hidden"></div>
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
    <div class="hud-banner hud-banner--hidden">
      <div class="hud-banner-word"></div>
      <div class="hud-banner-count"></div>
    </div>
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
    <div class="hud-achievements hud-achievements--hidden">
      <h1>Achievements</h1>
      <p class="hud-achievements-count"></p>
      <div class="hud-achievement-list"></div>
      <button class="hud-achievements-back" type="button">Back</button>
    </div>
    <div class="hud-customize hud-customize--hidden">
      <h1>Customize</h1>
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
    <div class="hud-stats hud-stats--hidden">
      <h1>Stats</h1>
      <table class="hud-stats-table"></table>
      <div class="hud-stats-actions">
        <button class="hud-reset-stats hud-danger" type="button">Reset stats</button>
        <button class="hud-reset-progress hud-danger" type="button">Reset progress</button>
        <button class="hud-stats-back" type="button">Back</button>
      </div>
    </div>
    <!-- tabindex="-1" so the menu can RECEIVE focus when the title screen is dismissed
         without joining the tab order. It must be this container and not the Start
         button: isMuteHotkey/isPauseHotkey both ignore a key whose target is inside
         input, button, select or textarea, so focusing the button leaves M and Escape
         dead at the menu -- measured in a browser, and a regression against main. -->
    <div class="hud-panel hud-panel--hidden" tabindex="-1">
      <h1 class="hud-title"></h1>
      <p class="hud-subtitle"></p>
      <div class="hud-levels hud-levels--hidden"></div>
      <p class="hud-run-summary hud-run-summary--hidden"></p>
      <button class="hud-action" type="button"></button>
      <button class="hud-stats-open hud-stats-open--hidden" type="button">Stats</button>
      <button class="hud-achievements-open hud-achievements-open--hidden" type="button">Achievements</button>
      <button class="hud-customize-open hud-customize-open--hidden" type="button">Customize</button>
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
      </div>
    </div>
  `;
  root.appendChild(el);

  const phaseEl = el.querySelector('.hud-phase') as HTMLElement;
  const bannerEl = el.querySelector('.hud-banner') as HTMLElement;
  const bannerWordEl = el.querySelector('.hud-banner-word') as HTMLElement;
  const bannerCountEl = el.querySelector('.hud-banner-count') as HTMLElement;
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
  const actionBtn = el.querySelector('.hud-action') as HTMLButtonElement;
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
  const runSummaryEl = el.querySelector('.hud-run-summary') as HTMLElement;
  const panelSettings = el.querySelector('.hud-panel-settings') as HTMLElement;
  const levelsRow = el.querySelector('.hud-levels') as HTMLElement;
  const panelMuteBtn = el.querySelector('.hud-panel-mute') as HTMLButtonElement;
  const panelVolumeEl = el.querySelector('.hud-panel-volume') as HTMLInputElement;
  const schemeToggleBtn = el.querySelector('.hud-scheme-toggle') as HTMLButtonElement;
  const firemodeToggleBtn = el.querySelector('.hud-firemode-toggle') as HTMLButtonElement;

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

  let statsData: { lifetime: StatCounts; run: StatCounts } | null = null;

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
    const { lifetime, run } = statsData;
    const rows = STAT_ROWS.map(
      ([label, get]) => `<tr><th>${label}</th><td>${get(lifetime)}</td><td>${get(run)}</td></tr>`,
    ).join('');
    statsTable.innerHTML = `<tr><th></th><td>Lifetime</td><td>This run</td></tr>${rows}`;
  }

  function renderRunSummary(): void {
    if (!statsData) {
      runSummaryEl.classList.add('hud-run-summary--hidden');
      return;
    }
    const r = statsData.run;
    const kills = r.shellKills + r.mineKills;
    runSummaryEl.textContent =
      `This run: ${kills} kills · ${r.deaths} deaths · ${pct(r.shellKills, r.shotsFired)} accuracy`;
    runSummaryEl.classList.remove('hud-run-summary--hidden');
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
    if (show) renderStatsTable();
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
    if (show) renderAchievements();
  }

  // Each toast owns its own timer, so several landing at once stack and expire
  // independently. Timers are tracked to be cleared in dispose(): a pending
  // callback firing into a removed DOM is the classic teardown leak.
  const toastTimers = new Set<ReturnType<typeof setTimeout>>();

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

  // Where the session stands in the level sequence, for the win panel's copy. Null
  // until the loop calls setLevel, and a HUD never told about levels keeps its
  // original single-arena wording.
  let levelPos: { current: number; total: number } | null = null;
  // Whether level select has anything to offer (more than one level). Gates the row's
  // visibility together with the title state.
  let levelChoice = false;
  // What setState last showed: setLevelSelect may re-render while ANOTHER panel is
  // up (unlocks are recorded at the win event), and must not splash the row onto it.
  let shownState: GameState = 'splash';
  /** Previous state, so leaving the splash can hand focus somewhere useful. */
  let lastState: GameState = 'splash';
  const levelSelectCbs: Array<(level: number) => void> = [];

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
    disarmReset();
    splashEl.classList.toggle('hud-splash--hidden', s !== 'splash');
    // Only while playing. Pausing from the pause panel is what its own buttons are for,
    // and a Mine button on the menu lays nothing.
    touchRow.classList.toggle('hud-touch--hidden', s !== 'playing');
    // Leaving the title screen hands focus to the menu's primary action. Without it
    // `document.activeElement` is still <body> when the menu appears, so a
    // keyboard-only player has to Tab in from nowhere and a screen reader announces
    // nothing at all -- the overlay simply vanishes.
    const leavingSplash = lastState === 'splash' && s !== 'splash';
    lastState = s;
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
    // Quit belongs to the pause panel ALONE: a quit button on the win panel would be
    // a second, untested path out of a finished game. The settings row serves the
    // title (the main menu) and pause; win/lose stay verdict-only. Level select is a
    // menu affair -- and only when there is a choice to make (see setLevelSelect).
    shownState = s;
    statsOpenBtn.classList.toggle('hud-stats-open--hidden', s !== 'title');
    customizeOpenBtn.classList.toggle('hud-customize-open--hidden', s !== 'title');
    achOpenBtn.classList.toggle('hud-achievements-open--hidden', s !== 'title');
    quitBtn.classList.toggle('hud-quit--hidden', s !== 'paused');
    panelSettings.classList.toggle('hud-panel-settings--hidden', s !== 'paused' && s !== 'title');
    levelsRow.classList.toggle('hud-levels--hidden', s !== 'title' || !levelChoice);
    // The run summary belongs to the END screens alone.
    runSummaryEl.classList.toggle('hud-run-summary--hidden', s !== 'win' && s !== 'lose');
    if (s === 'win' || s === 'lose') renderRunSummary();
    if (s === 'paused') {
      titleEl.textContent = 'Paused';
      subtitleEl.textContent = 'The arena waits.';
      actionBtn.textContent = 'Resume';
      return; // do NOT fall through: the final else renders a Game Over corpse screen
    }
    if (s === 'title') {
      titleEl.textContent = 'TANKS!';
      subtitleEl.textContent = 'Clear the arena. One shot kills anything.';
      actionBtn.textContent = 'Start';
      // The panel, NOT actionBtn -- see the tabindex note on the element.
      if (leavingSplash) panel.focus();
    } else if (s === 'win') {
      // An intermediate win advances; only the LAST level's win is the game's.
      if (levelPos && levelPos.current < levelPos.total) {
        titleEl.textContent = `Level ${levelPos.current} cleared!`;
        subtitleEl.textContent = 'On to the next.';
        actionBtn.textContent = 'Next Level';
      } else {
        titleEl.textContent = 'You Win!';
        subtitleEl.textContent = 'Arena cleared.';
        actionBtn.textContent = 'Play Again';
      }
    } else {
      titleEl.textContent = 'Game Over';
      subtitleEl.textContent = 'Out of lives.';
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
      levelsRow.classList.toggle('hud-levels--hidden', shownState !== 'title' || !levelChoice);
    },
    onLevelSelect(cb: (level: number) => void): void {
      levelSelectCbs.push(cb);
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
        bannerEl.classList.add('hud-banner--hidden');
        phaseEl.classList.add('hud-phase--hidden');
        return;
      }
      const word = info.phase === 'countdown' ? 'TAKE AIM' : 'MOVE';
      const short = info.phase === 'countdown' ? 'AIM' : 'MOVE';
      if (info.prominent) {
        bannerWordEl.textContent = word;
        bannerCountEl.textContent = String(info.secondsLeft);
        bannerEl.classList.remove('hud-banner--hidden');
        phaseEl.classList.add('hud-phase--hidden');
      } else {
        phaseEl.textContent = `${short} ${info.secondsLeft}`;
        phaseEl.classList.remove('hud-phase--hidden');
        bannerEl.classList.add('hud-banner--hidden');
      }
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
    signalPlayerDeath(): void {
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
    setStats(data: { lifetime: StatCounts; run: StatCounts }): void {
      statsData = data;
      if (!statsView.classList.contains('hud-stats--hidden')) renderStatsTable();
      if (!runSummaryEl.classList.contains('hud-run-summary--hidden')) renderRunSummary();
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
        toastsEl.appendChild(t);
        const timer = setTimeout(() => {
          t.remove();
          toastTimers.delete(timer);
        }, TOAST_MS);
        toastTimers.add(timer);
      }
    },
    dispose(): void {
      disarmReset(); // a pending confirm timer must not outlive the HUD
      for (const t of toastTimers) clearTimeout(t);
      toastTimers.clear();
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
      achOpenBtn.removeEventListener('click', handleAchOpen);
      achOpenBtn.removeEventListener('click', blurIfPointer);
      achBackBtn.removeEventListener('click', handleAchBack);
      achBackBtn.removeEventListener('click', blurIfPointer);
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
