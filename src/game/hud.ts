import type { GameState } from './state';
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
    <div class="hud-panel hud-panel--hidden">
      <h1 class="hud-title"></h1>
      <p class="hud-subtitle"></p>
      <div class="hud-levels hud-levels--hidden"></div>
      <button class="hud-action" type="button"></button>
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
  const panelSettings = el.querySelector('.hud-panel-settings') as HTMLElement;
  const levelsRow = el.querySelector('.hud-levels') as HTMLElement;
  const panelMuteBtn = el.querySelector('.hud-panel-mute') as HTMLButtonElement;
  const panelVolumeEl = el.querySelector('.hud-panel-volume') as HTMLInputElement;

  const muteCbs: Array<() => void> = [];
  const volumeCbs: Array<(v: number) => void> = [];
  const startRestartCbs: Array<() => void> = [];
  const quitCbs: Array<() => void> = [];

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
    quitBtn.classList.toggle('hud-quit--hidden', s !== 'paused');
    panelSettings.classList.toggle('hud-panel-settings--hidden', s !== 'paused' && s !== 'title');
    levelsRow.classList.toggle('hud-levels--hidden', s !== 'title' || !levelChoice);
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
    dispose(): void {
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
