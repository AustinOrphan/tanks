import type { GameState } from './state';
import './hud.css';

export interface Hud {
  setLives(n: number): void;
  setEnemiesRemaining(n: number): void;
  setState(s: GameState): void;
  onMuteToggle(cb: () => void): void;
  onVolumeChange(cb: (v: number) => void): void;
  /** Extension: fired when the title/win/lose panel's start/restart button is clicked. */
  onStartRestart(cb: () => void): void;
  dispose(): void;
}

export function createHud(root: HTMLElement): Hud {
  const el = document.createElement('div');
  el.className = 'hud';
  el.innerHTML = `
    <div class="hud-topbar">
      <div class="hud-stat">Lives: <span class="hud-lives">3</span></div>
      <div class="hud-stat">Enemies: <span class="hud-enemies">3</span></div>
      <div class="hud-audio">
        <button class="hud-mute" type="button">Mute (M)</button>
        <input class="hud-volume" type="range" min="0" max="1" step="0.01" value="0.6" />
      </div>
    </div>
    <div class="hud-panel hud-panel--hidden">
      <h1 class="hud-title"></h1>
      <p class="hud-subtitle"></p>
      <button class="hud-action" type="button"></button>
    </div>
  `;
  root.appendChild(el);

  const livesEl = el.querySelector('.hud-lives') as HTMLElement;
  const enemiesEl = el.querySelector('.hud-enemies') as HTMLElement;
  const muteBtn = el.querySelector('.hud-mute') as HTMLButtonElement;
  const volumeEl = el.querySelector('.hud-volume') as HTMLInputElement;
  const panel = el.querySelector('.hud-panel') as HTMLElement;
  const titleEl = el.querySelector('.hud-title') as HTMLElement;
  const subtitleEl = el.querySelector('.hud-subtitle') as HTMLElement;
  const actionBtn = el.querySelector('.hud-action') as HTMLButtonElement;

  const muteCbs: Array<() => void> = [];
  const volumeCbs: Array<(v: number) => void> = [];
  const startRestartCbs: Array<() => void> = [];

  const handleMute = (): void => {
    for (const cb of muteCbs) cb();
  };
  const handleVolume = (): void => {
    const v = Number(volumeEl.value);
    for (const cb of volumeCbs) cb(v);
  };
  const handleAction = (): void => {
    for (const cb of startRestartCbs) cb();
  };

  muteBtn.addEventListener('click', handleMute);
  volumeEl.addEventListener('input', handleVolume);
  actionBtn.addEventListener('click', handleAction);

  function setState(s: GameState): void {
    if (s === 'playing') {
      panel.classList.add('hud-panel--hidden');
      return;
    }
    panel.classList.remove('hud-panel--hidden');
    if (s === 'title') {
      titleEl.textContent = 'TANKS!';
      subtitleEl.textContent = 'Clear the arena. One shot kills anything.';
      actionBtn.textContent = 'Start';
    } else if (s === 'win') {
      titleEl.textContent = 'You Win!';
      subtitleEl.textContent = 'Arena cleared.';
      actionBtn.textContent = 'Play Again';
    } else {
      titleEl.textContent = 'Game Over';
      subtitleEl.textContent = 'Out of lives.';
      actionBtn.textContent = 'Retry';
    }
  }

  setState('title');

  return {
    setLives(n: number): void {
      livesEl.textContent = String(n);
    },
    setEnemiesRemaining(n: number): void {
      enemiesEl.textContent = String(n);
    },
    setState,
    onMuteToggle(cb: () => void): void {
      muteCbs.push(cb);
    },
    onVolumeChange(cb: (v: number) => void): void {
      volumeCbs.push(cb);
    },
    onStartRestart(cb: () => void): void {
      startRestartCbs.push(cb);
    },
    dispose(): void {
      muteBtn.removeEventListener('click', handleMute);
      volumeEl.removeEventListener('input', handleVolume);
      actionBtn.removeEventListener('click', handleAction);
      el.remove();
    },
  };
}
