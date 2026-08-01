// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud } from './hud';
import { DEFAULT_VOLUME } from '../audio/manifest';

let hud: Hud | null = null;

function mount(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root);
  return { hud, root };
}

afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

const volumeSlider = (root: HTMLElement): HTMLInputElement =>
  root.querySelector('.hud-volume') as HTMLInputElement;

describe('createHud volume control', () => {
  it('shows the volume the audio engine actually boots at', () => {
    const { root } = mount();

    // Not a literal: the slider and the engine must read the same constant, or
    // the displayed level is a guess that happens to be wrong.
    expect(Number(volumeSlider(root).value)).toBe(DEFAULT_VOLUME);
  });

  it('keeps DEFAULT_VOLUME on the step grid the browser will snap to', () => {
    // Real browsers sanitize <input type="range"> onto the `step` grid; jsdom
    // does not. A DEFAULT_VOLUME of, say, 1/3 would leave the test above green
    // while the real HUD displayed 0.33 and the engine ran at 0.3333... --
    // the same lie, just below this test's resolution.
    const { root } = mount();
    const step = Number(volumeSlider(root).step);

    // Tolerance, not equality: 0.6 / 0.01 is 59.999999999999993 in binary
    // floating point, so an exact `toBe(Math.round(...))` would fail on a
    // value that is perfectly on-grid.
    const steps = DEFAULT_VOLUME / step;
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
  });

  it('opts out of Firefox form-value restoration', () => {
    const { root } = mount();
    expect(volumeSlider(root).getAttribute('autocomplete')).toBe('off');
  });

  it('reports slider movement to subscribers', () => {
    const { hud: h, root } = mount();
    const seen: number[] = [];
    h.onVolumeChange((v) => seen.push(v));

    const slider = volumeSlider(root);
    slider.value = '0.3';
    slider.dispatchEvent(new Event('input'));

    expect(seen).toEqual([0.3]);
  });
});

describe('createHud stats', () => {
  it('renders lives and enemies remaining', () => {
    const { hud: h, root } = mount();

    h.setLives(2);
    h.setEnemiesRemaining(1);

    expect((root.querySelector('.hud-lives') as HTMLElement).textContent).toBe('2');
    expect((root.querySelector('.hud-enemies') as HTMLElement).textContent).toBe('1');
  });

  it('does not rewrite the text node when the value is unchanged', () => {
    // loop.ts calls these every frame. textContent's setter replaces the text
    // node even for an identical string, invalidating layout at 60 Hz for
    // values that change a handful of times per round.
    const { hud: h, root } = mount();
    h.setLives(3);
    const node = (root.querySelector('.hud-lives') as HTMLElement).firstChild;

    h.setLives(3);

    expect((root.querySelector('.hud-lives') as HTMLElement).firstChild).toBe(node);
  });
});

describe('createHud mute button', () => {
  const muteBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-mute') as HTMLButtonElement;

  it('starts unmuted and says so', () => {
    const { root } = mount();
    expect(muteBtn(root).getAttribute('aria-pressed')).toBe('false');
    expect(muteBtn(root).textContent).toBe('Mute (M)');
  });

  it('reflects mute state, so a muted game is distinguishable from a broken one', () => {
    const { hud: h, root } = mount();

    h.setMuted(true);
    expect(muteBtn(root).getAttribute('aria-pressed')).toBe('true');
    expect(muteBtn(root).textContent).toBe('Muted (M)');

    h.setMuted(false);
    expect(muteBtn(root).getAttribute('aria-pressed')).toBe('false');
    expect(muteBtn(root).textContent).toBe('Mute (M)');
  });

  it('notifies subscribers when clicked', () => {
    const { hud: h, root } = mount();
    let clicks = 0;
    h.onMuteToggle(() => clicks++);

    muteBtn(root).dispatchEvent(new MouseEvent('click'));

    expect(clicks).toBe(1);
  });
});

describe('createHud panel', () => {
  const panel = (root: HTMLElement): HTMLElement => root.querySelector('.hud-panel') as HTMLElement;
  const title = (root: HTMLElement): string =>
    (root.querySelector('.hud-title') as HTMLElement).textContent ?? '';
  const action = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-action') as HTMLButtonElement;

  it('shows the title panel on mount', () => {
    const { root } = mount();
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(false);
    expect(title(root)).toBe('TANKS!');
    expect(action(root).textContent).toBe('Start');
  });

  it('hides the panel while playing and restores it on win and lose', () => {
    const { hud: h, root } = mount();

    h.setState('playing');
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(true);

    h.setState('win');
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(false);
    expect(title(root)).toBe('You Win!');
    expect(action(root).textContent).toBe('Play Again');

    h.setState('lose');
    expect(title(root)).toBe('Game Over');
    expect(action(root).textContent).toBe('Retry');
  });

  it('notifies start/restart subscribers — the only gesture that can unlock audio', () => {
    const { hud: h, root } = mount();
    let starts = 0;
    h.onStartRestart(() => starts++);

    action(root).dispatchEvent(new MouseEvent('click'));

    expect(starts).toBe(1);
  });

  it('detaches listeners and removes itself on dispose', () => {
    const { hud: h, root } = mount();
    let events = 0;
    h.onMuteToggle(() => events++);
    h.onStartRestart(() => events++);
    const btn = muteBtnOf(root);
    const act = action(root);

    h.dispose();
    hud = null; // already disposed; stop afterEach double-disposing

    btn.dispatchEvent(new MouseEvent('click'));
    act.dispatchEvent(new MouseEvent('click'));

    expect(events).toBe(0);
    expect(root.querySelector('.hud')).toBeNull();
  });

  function muteBtnOf(root: HTMLElement): HTMLButtonElement {
    return root.querySelector('.hud-mute') as HTMLButtonElement;
  }
});

describe('createHud does not keep keyboard focus after a pointer interaction', () => {
  it('drops focus from the mute button when it is clicked with the mouse', () => {
    // A focused HUD control legitimately claims Space/Enter/arrows, so a mouse player who
    // clicks Mute would silently lose arrow-key driving and the Space mine-drop until they
    // clicked elsewhere. Keyboard activation reports detail 0 and must KEEP focus, so
    // anyone tabbing through the HUD still has it work.
    const { root } = mount();
    const btn = root.querySelector('.hud-mute') as HTMLButtonElement;

    btn.focus();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(document.activeElement).not.toBe(btn);
  });

  it('keeps focus when the mute button is activated from the keyboard', () => {
    const { root } = mount();
    const btn = root.querySelector('.hud-mute') as HTMLButtonElement;

    btn.focus();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(document.activeElement).toBe(btn);
  });

  it('drops focus from the volume slider when the drag ends', () => {
    const { root } = mount();
    const slider = volumeSlider(root);

    slider.focus();
    slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(document.activeElement).not.toBe(slider);
  });
});

describe('hud: losing a life', () => {
  function mount(): { root: HTMLElement; hud: ReturnType<typeof createHud> } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return { root, hud: createHud(root) };
  }

  it('shows nothing until a life is actually lost', () => {
    const { root, hud } = mount();
    expect(root.querySelector('.hud-damage')?.className).not.toContain('hud-damage--hit');
    hud.dispose();
  });

  it('flashes the screen and pulses the counter', () => {
    const { root, hud } = mount();
    hud.signalPlayerDeath();
    expect(root.querySelector('.hud-damage')?.className).toContain('hud-damage--hit');
    expect(root.querySelector('.hud-lives')?.className).toContain('hud-lives--hit');
    hud.dispose();
  });

  it('replays for a second death, so two deaths read as two', () => {
    // Re-adding a class the element already has does NOT restart a CSS
    // animation. Without the remove-and-reflow, a second death inside the
    // animation window would be invisible -- the case where the player most
    // needs telling. MutationObserver delivers on a microtask, so drain it
    // synchronously with takeRecords rather than waiting.
    const { root, hud } = mount();
    hud.signalPlayerDeath();
    const damage = root.querySelector('.hud-damage') as HTMLElement;
    const obs = new MutationObserver(() => {});
    obs.observe(damage, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    hud.signalPlayerDeath();
    const records = obs.takeRecords();
    obs.disconnect();
    const sawRemoval = records.some(
      (r) => r.oldValue?.includes('hud-damage--hit') && !r.oldValue.endsWith('--hit '),
    );
    expect(records.length).toBeGreaterThanOrEqual(2); // removed, then re-added
    expect(sawRemoval).toBe(true);
    expect(damage.className).toContain('hud-damage--hit');
    hud.dispose();
  });

  it('the flash cannot swallow the pointer', () => {
    // It covers the whole board, and the player is aiming through it the
    // instant they respawn.
    const { root, hud } = mount();
    hud.signalPlayerDeath();
    const damage = root.querySelector('.hud-damage') as HTMLElement;
    expect(damage.getAttribute('aria-hidden')).toBe('true');
    hud.dispose();
  });
});

describe('hud: dev shell count', () => {
  function mount(): { root: HTMLElement; hud: ReturnType<typeof createHud> } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return { root, hud: createHud(root) };
  }

  it('is hidden until asked for, since it is off by default', () => {
    const { root, hud } = mount();
    expect(root.querySelector('.hud-shells')?.className).toContain('hud-shells--hidden');
    hud.dispose();
  });

  it('shows shells against the cap', () => {
    const { root, hud } = mount();
    hud.setShellCount({ inFlight: 2, cap: 5 });
    const el = root.querySelector('.hud-shells') as HTMLElement;
    expect(el.textContent).toBe('shells 2/5');
    expect(el.className).not.toContain('hud-shells--hidden');
    hud.dispose();
  });

  it('marks the state where the cannon goes silent', () => {
    // At the cap firing stops with no other cue. That is the state this
    // readout exists for, so it must be distinguishable at a glance.
    const { root, hud } = mount();
    hud.setShellCount({ inFlight: 5, cap: 5 });
    expect((root.querySelector('.hud-shells') as HTMLElement).className).toContain('hud-shells--full');
    hud.setShellCount({ inFlight: 4, cap: 5 });
    expect((root.querySelector('.hud-shells') as HTMLElement).className).not.toContain('hud-shells--full');
    hud.dispose();
  });

  it('hides again on null', () => {
    const { root, hud } = mount();
    hud.setShellCount({ inFlight: 1, cap: 5 });
    hud.setShellCount(null);
    expect(root.querySelector('.hud-shells')?.className).toContain('hud-shells--hidden');
    hud.dispose();
  });
});

describe('hud: round-start phase feedback', () => {
  function mount(): { root: HTMLElement; hud: ReturnType<typeof createHud> } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return { root, hud: createHud(root) };
  }

  it('shows nothing until it is told to', () => {
    const { root, hud } = mount();
    expect(root.querySelector('.hud-banner')?.className).toContain('hud-banner--hidden');
    expect(root.querySelector('.hud-phase')?.className).toContain('hud-phase--hidden');
    hud.dispose();
  });

  it('shows the teaching banner when prominent', () => {
    const { root, hud } = mount();
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3, prominent: true });
    const banner = root.querySelector('.hud-banner') as HTMLElement;
    expect(banner.className).not.toContain('hud-banner--hidden');
    expect(root.querySelector('.hud-banner-word')?.textContent).toBe('TAKE AIM');
    expect(root.querySelector('.hud-banner-count')?.textContent).toBe('3');
    // and not both at once
    expect(root.querySelector('.hud-phase')?.className).toContain('hud-phase--hidden');
    hud.dispose();
  });

  it('shows the quiet chip when not prominent', () => {
    const { root, hud } = mount();
    hud.setRoundPhase({ phase: 'grace', secondsLeft: 2, prominent: false });
    expect(root.querySelector('.hud-phase')?.textContent).toBe('MOVE 2');
    expect(root.querySelector('.hud-phase')?.className).not.toContain('hud-phase--hidden');
    expect(root.querySelector('.hud-banner')?.className).toContain('hud-banner--hidden');
    hud.dispose();
  });

  it('uses the phase word, not a generic countdown', () => {
    const { root, hud } = mount();
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 1, prominent: false });
    expect(root.querySelector('.hud-phase')?.textContent).toBe('AIM 1');
    hud.setRoundPhase({ phase: 'grace', secondsLeft: 1, prominent: false });
    expect(root.querySelector('.hud-phase')?.textContent).toBe('MOVE 1');
    hud.dispose();
  });

  it('hides on null and on live', () => {
    const { root, hud } = mount();
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3, prominent: true });
    hud.setRoundPhase(null);
    expect(root.querySelector('.hud-banner')?.className).toContain('hud-banner--hidden');
    hud.setRoundPhase({ phase: 'countdown', secondsLeft: 3, prominent: false });
    hud.setRoundPhase({ phase: 'live', secondsLeft: 0, prominent: false });
    expect(root.querySelector('.hud-phase')?.className).toContain('hud-phase--hidden');
    hud.dispose();
  });

});

describe('hud: level progression', () => {
  it('shows the level position once told, and only in a multi-level sequence', () => {
    const { hud: h, root } = mount();
    const chip = (): HTMLElement => root.querySelector('.hud-level') as HTMLElement;
    expect(chip().className).toContain('hud-level--hidden'); // nothing until setLevel

    h.setLevel(1, 2);
    expect(chip().className).not.toContain('hud-level--hidden');
    expect(chip().textContent).toContain('1/2');

    // A one-level sequence (the sandbox) shows no chip: "Level 1/1" is noise.
    h.setLevel(1, 1);
    expect(chip().className).toContain('hud-level--hidden');
  });

  it('offers Next Level on an intermediate win, Play Again on the final one', () => {
    const { hud: h, root } = mount();
    const title = (): string => (root.querySelector('.hud-title') as HTMLElement).textContent ?? '';
    const button = (): string => (root.querySelector('.hud-action') as HTMLElement).textContent ?? '';

    h.setLevel(1, 2);
    h.setState('win');
    expect(title()).toContain('cleared');
    expect(button()).toBe('Next Level');

    h.setLevel(2, 2);
    h.setState('win'); // re-renders unconditionally; the equal-state guard lives in state.ts, not here
    expect(title()).toBe('You Win!');
    expect(button()).toBe('Play Again');
  });

  it('never says cleared before setLevel has been called at all', () => {
    // A HUD that has not been told about levels behaves exactly as it always did.
    const { hud: h, root } = mount();
    h.setState('win');
    expect((root.querySelector('.hud-title') as HTMLElement).textContent).toBe('You Win!');
  });
});

describe('hud: pause panel', () => {
  const panel = (root: HTMLElement): HTMLElement => root.querySelector('.hud-panel') as HTMLElement;
  const quit = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-quit') as HTMLButtonElement;
  const settings = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-panel-settings') as HTMLElement;

  it('shows the frozen-scene panel with Resume, Quit and the audio pair', () => {
    const { hud: h, root } = mount();
    h.setState('paused');
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(false);
    expect((root.querySelector('.hud-title') as HTMLElement).textContent).toBe('Paused');
    expect((root.querySelector('.hud-action') as HTMLElement).textContent).toBe('Resume');
    expect(quit(root).classList.contains('hud-quit--hidden')).toBe(false);
    expect(settings(root).classList.contains('hud-panel-settings--hidden')).toBe(false);
  });

  it('keeps Quit out of every other panel state, and settings off the END screens', () => {
    // Population: all four non-paused states. A quit button on the win panel would
    // be a second untested path out of a finished game. The settings row serves the
    // TITLE (the main menu) and pause; win/lose panels stay verdict-only.
    const { hud: h, root } = mount();
    for (const s of ['title', 'win', 'lose'] as const) {
      h.setState(s);
      expect(quit(root).classList.contains('hud-quit--hidden'), s).toBe(true);
    }
    for (const s of ['win', 'lose'] as const) {
      h.setState(s);
      expect(settings(root).classList.contains('hud-panel-settings--hidden'), s).toBe(true);
    }
    h.setState('title');
    expect(settings(root).classList.contains('hud-panel-settings--hidden')).toBe(false);
    h.setState('playing'); // panel hidden entirely
    expect(panel(root).classList.contains('hud-panel--hidden')).toBe(true);
  });

  it('does NOT render a Game Over corpse screen for paused', () => {
    // setState's final else renders "Game Over"; a forgotten branch for a new state
    // lands exactly there. This is the pin that keeps 'paused' out of it.
    const { hud: h, root } = mount();
    h.setState('paused');
    expect((root.querySelector('.hud-title') as HTMLElement).textContent).not.toBe('Game Over');
  });

  it('notifies quit subscribers, separately from start/restart', () => {
    const { hud: h, root } = mount();
    let quits = 0;
    let starts = 0;
    h.onQuitToTitle(() => quits++);
    h.onStartRestart(() => starts++);
    h.setState('paused');
    quit(root).dispatchEvent(new MouseEvent('click'));
    expect(quits).toBe(1);
    expect(starts).toBe(0);
  });

  it('mirrors mute state onto the panel button too', () => {
    const { hud: h, root } = mount();
    h.setMuted(true);
    expect((root.querySelector('.hud-panel-mute') as HTMLElement).textContent).toBe('Muted (M)');
    expect((root.querySelector('.hud-mute') as HTMLElement).textContent).toBe('Muted (M)');
  });

  it('panel volume slider reports changes and keeps the topbar slider in step', () => {
    const { hud: h, root } = mount();
    const seen: number[] = [];
    h.onVolumeChange((v) => seen.push(v));
    const panelSlider = root.querySelector('.hud-panel-volume') as HTMLInputElement;
    panelSlider.value = '0.2';
    panelSlider.dispatchEvent(new Event('input'));
    expect(seen).toEqual([0.2]);
    expect((root.querySelector('.hud-volume') as HTMLInputElement).value).toBe('0.2');
  });

  it('topbar slider keeps the panel slider in step, so reopening pause never lies', () => {
    const { hud: h, root } = mount();
    void h;
    const topbar = root.querySelector('.hud-volume') as HTMLInputElement;
    topbar.value = '0.7';
    topbar.dispatchEvent(new Event('input'));
    expect((root.querySelector('.hud-panel-volume') as HTMLInputElement).value).toBe('0.7');
  });
});

describe('hud: level select on the main menu', () => {
  const row = (root: HTMLElement): HTMLElement => root.querySelector('.hud-levels') as HTMLElement;
  const buttons = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('.hud-level-btn'));

  it('renders one button per level, locking those past the unlock line', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 3); // cleared nothing beyond level 1's unlock
    const btns = buttons(root);
    expect(btns.map((b) => b.textContent)).toEqual(['1', '2', '3']);
    // Population: all 3 buttons. Level 1 open; 2 and 3 locked and DISABLED --
    // a locked level must be unclickable, not merely grey.
    expect(btns.map((b) => b.disabled)).toEqual([false, true, true]);
    expect(btns.map((b) => b.classList.contains('hud-level-btn--locked')))
      .toEqual([false, true, true]);
  });

  it('reports a click on an unlocked level, 0-based, and nothing for a locked one', () => {
    const { hud: h, root } = mount();
    const picks: number[] = [];
    h.onLevelSelect((i) => picks.push(i));
    h.setLevelSelect(2, 3);
    h.setState('title');
    buttons(root)[1].dispatchEvent(new MouseEvent('click'));
    buttons(root)[2].dispatchEvent(new MouseEvent('click')); // locked: disabled anyway
    expect(picks).toEqual([1]);
  });

  it('shows the row on the title panel only', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 2);
    h.setState('title');
    expect(row(root).classList.contains('hud-levels--hidden')).toBe(false);
    for (const s of ['paused', 'win', 'lose'] as const) {
      h.setState(s);
      expect(row(root).classList.contains('hud-levels--hidden'), s).toBe(true);
    }
  });

  it('hides the row entirely for a one-level sequence (the sandbox)', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 1);
    h.setState('title');
    expect(row(root).classList.contains('hud-levels--hidden')).toBe(true);
  });

  it('a re-render while another panel is up must not splash the row onto it', () => {
    // The natural call order: the loop records an unlock AT the win event and
    // refreshes the select -- while the WIN panel is showing.
    const { hud: h, root } = mount();
    h.setState('win');
    h.setLevelSelect(2, 2);
    expect(row(root).classList.contains('hud-levels--hidden')).toBe(true);
    h.setState('title');
    expect(row(root).classList.contains('hud-levels--hidden')).toBe(false);
  });

  it('re-rendering after an unlock replaces the buttons rather than appending', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(1, 2);
    h.setLevelSelect(2, 2); // level 1 cleared -> level 2 unlocks
    expect(buttons(root)).toHaveLength(2);
    expect(buttons(root)[1].disabled).toBe(false);
  });
});

describe('hud: the stats page', () => {
  const statsView = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-stats') as HTMLElement;
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-stats-open') as HTMLButtonElement;
  const cell = (root: HTMLElement, row: string, col: 0 | 1): string => {
    const tr = Array.from(root.querySelectorAll('.hud-stats-table tr')).find(
      (r) => r.querySelector('th')?.textContent === row,
    );
    return tr?.querySelectorAll('td')[col]?.textContent ?? '(no row)';
  };
  const SOME = {
    shotsFired: 10, shellKills: 4, mineKills: 1, deaths: 2, selfKills: 1,
    friendlyFireKills: 3, minesLaid: 2, wallsDestroyed: 5, ricochets: 7,
  };
  const NONE = {
    shotsFired: 0, shellKills: 0, mineKills: 0, deaths: 0, selfKills: 0,
    friendlyFireKills: 0, minesLaid: 0, wallsDestroyed: 0, ricochets: 0,
  };

  it('opens from the title, shows both columns, and Back returns to the menu', () => {
    const { hud: h, root } = mount();
    h.setStats({ lifetime: SOME, run: NONE });
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(statsView(root).classList.contains('hud-stats--hidden')).toBe(false);
    expect(cell(root, 'Shell kills', 0)).toBe('4'); // lifetime column
    expect(cell(root, 'Shell kills', 1)).toBe('0'); // run column
    (root.querySelector('.hud-stats-back') as HTMLButtonElement).dispatchEvent(new MouseEvent('click'));
    expect(statsView(root).classList.contains('hud-stats--hidden')).toBe(true);
  });

  it('derives both accuracies, and shows -- when the denominator is zero', () => {
    const { hud: h, root } = mount();
    h.setStats({ lifetime: SOME, run: NONE });
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(cell(root, 'Accuracy', 0)).toBe('40%'); // 4 shell kills / 10 shots
    expect(cell(root, 'Mine accuracy', 0)).toBe('50%'); // 1 mine kill / 2 laid
    expect(cell(root, 'Accuracy', 1)).toBe('--'); // 0 shots this run
  });

  it('the Stats button lives on the title panel only', () => {
    const { hud: h, root } = mount();
    for (const s of ['paused', 'win', 'lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-stats-open--hidden'), s).toBe(true);
    }
    h.setState('title');
    expect(openBtn(root).classList.contains('hud-stats-open--hidden')).toBe(false);
  });

  it('both resets are two-click: the first arms, the second fires', () => {
    const { hud: h, root } = mount();
    let statResets = 0;
    let progResets = 0;
    h.onResetStats(() => statResets++);
    h.onResetProgress(() => progResets++);
    h.setStats({ lifetime: SOME, run: NONE });
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));

    const reset = root.querySelector('.hud-reset-stats') as HTMLButtonElement;
    reset.dispatchEvent(new MouseEvent('click'));
    expect(statResets).toBe(0); // armed, not fired
    expect(reset.textContent).toBe('Really reset?');
    reset.dispatchEvent(new MouseEvent('click'));
    expect(statResets).toBe(1);
    expect(reset.textContent).toBe('Reset stats'); // disarmed after firing

    const prog = root.querySelector('.hud-reset-progress') as HTMLButtonElement;
    prog.dispatchEvent(new MouseEvent('click'));
    prog.dispatchEvent(new MouseEvent('click'));
    expect(progResets).toBe(1);
  });

  it('arming one reset does not arm the other, and leaving the page disarms', () => {
    const { hud: h, root } = mount();
    h.setStats({ lifetime: SOME, run: NONE });
    h.setState('title');
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    const reset = root.querySelector('.hud-reset-stats') as HTMLButtonElement;
    const prog = root.querySelector('.hud-reset-progress') as HTMLButtonElement;
    reset.dispatchEvent(new MouseEvent('click'));
    expect(prog.textContent).toBe('Reset progress'); // untouched
    (root.querySelector('.hud-stats-back') as HTMLButtonElement).dispatchEvent(new MouseEvent('click'));
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(reset.textContent).toBe('Reset stats'); // disarmed by leaving
  });

  it('win panel carries the run summary line', () => {
    const { hud: h, root } = mount();
    h.setStats({ lifetime: SOME, run: { ...NONE, shellKills: 3, shotsFired: 6, deaths: 1 } });
    h.setState('win');
    const line = (root.querySelector('.hud-run-summary') as HTMLElement).textContent ?? '';
    expect(line).toContain('3 kills');
    expect(line).toContain('50%');
    // And updates if the final batch lands after the panel opened -- the winning
    // kill is recorded a beat after the state flips.
    h.setStats({ lifetime: SOME, run: { ...NONE, shellKills: 4, shotsFired: 6, deaths: 1 } });
    expect((root.querySelector('.hud-run-summary') as HTMLElement).textContent).toContain('4 kills');
  });
});
