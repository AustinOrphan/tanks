import type { GameState } from './state';
import type { StatCounts } from './stats';
import { PALETTE, type HullColorId } from './customization';
import type { RoundPhase } from '../sim/round';
import { DEFAULT_VOLUME } from '../audio/manifest';
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
   * Only reached when the roundPhaseHud dev flag is on -- see devflags.ts.
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
  dispose(): void;
}

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
    <div class="hud-customize hud-customize--hidden">
      <h1>Customize</h1>
      <p>Hull colour — repaints the tank behind this menu.</p>
      <div class="hud-swatches"></div>
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
    <div class="hud-panel hud-panel--hidden">
      <h1 class="hud-title"></h1>
      <p class="hud-subtitle"></p>
      <div class="hud-levels hud-levels--hidden"></div>
      <p class="hud-run-summary hud-run-summary--hidden"></p>
      <button class="hud-action" type="button"></button>
      <button class="hud-stats-open hud-stats-open--hidden" type="button">Stats</button>
      <button class="hud-customize-open hud-customize-open--hidden" type="button">Customize</button>
      <button class="hud-quit hud-quit--hidden" type="button">Quit to Title</button>
      <!-- The panel settings row, shown on the main menu AND the pause panel: the
           seed of the settings pane. Mirrors the topbar audio pair (same engine, same
           callbacks) rather than moving it, so audio stays adjustable mid-game too.
           autocomplete="off" for the same Firefox bfcache reason as the topbar slider. -->
      <div class="hud-panel-settings hud-panel-settings--hidden">
        <button class="hud-panel-mute" type="button">Mute (M)</button>
        <input class="hud-panel-volume" type="range" min="0" max="1" step="0.01" value="${DEFAULT_VOLUME}" autocomplete="off" />
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
  const swatchesRow = el.querySelector('.hud-swatches') as HTMLElement;
  const customizeBackBtn = el.querySelector('.hud-customize-back') as HTMLButtonElement;
  const runSummaryEl = el.querySelector('.hud-run-summary') as HTMLElement;
  const panelSettings = el.querySelector('.hud-panel-settings') as HTMLElement;
  const levelsRow = el.querySelector('.hud-levels') as HTMLElement;
  const panelMuteBtn = el.querySelector('.hud-panel-mute') as HTMLButtonElement;
  const panelVolumeEl = el.querySelector('.hud-panel-volume') as HTMLInputElement;

  const muteCbs: Array<() => void> = [];
  const volumeCbs: Array<(v: number) => void> = [];
  const startRestartCbs: Array<() => void> = [];
  const quitCbs: Array<() => void> = [];
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

  function showCustomize(show: boolean): void {
    customizeView.classList.toggle('hud-customize--hidden', !show);
    panel.classList.toggle('hud-panel--hidden', show);
    if (show) renderSwatchSelection();
  }

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

  // Where the session stands in the level sequence, for the win panel's copy. Null
  // until the loop calls setLevel, and a HUD never told about levels keeps its
  // original single-arena wording.
  let levelPos: { current: number; total: number } | null = null;
  // Whether level select has anything to offer (more than one level). Gates the row's
  // visibility together with the title state.
  let levelChoice = false;
  // What setState last showed: setLevelSelect may re-render while ANOTHER panel is
  // up (unlocks are recorded at the win event), and must not splash the row onto it.
  let shownState: GameState = 'title';
  const levelSelectCbs: Array<(level: number) => void> = [];

  function setState(s: GameState): void {
    // Any state change closes the stats and customize pages FIRST -- including the
    // playing early-return below, or an overlay opened on the title screen would
    // sit over the live game. They are title-screen affairs.
    statsView.classList.add('hud-stats--hidden');
    customizeView.classList.add('hud-customize--hidden');
    disarmReset();
    if (s === 'playing') {
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

  setState('title');

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
    dispose(): void {
      disarmReset(); // a pending confirm timer must not outlive the HUD
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
