import { DT } from '../sim/constants';
import { step, type World } from '../sim/world';
import { CURRENT_ARENA, arenaBounds, createArenaWorld } from '../sim/arena';
import type { SimEvent } from '../sim/events';
import { createInputController } from '../input/input';
import { createRenderer } from '../render/renderer';
import { createAudioEngine } from '../audio/engine';
import { AUDIO_MANIFEST } from '../audio/manifest';
import { createAudioDirector } from '../audio/director';
import { createGameStateMachine } from './state';
import { createHud } from './hud';

function countEnemies(world: World): number {
  let n = 0;
  for (const t of world.tanks) {
    if (t.kind !== 'player' && t.alive) n += 1;
  }
  return n;
}

export function startGame(
  canvas: HTMLCanvasElement,
  uiRoot: HTMLElement,
): { dispose(): void } {
  // A fresh seed per world. Date.now() is illegal inside sim/ (it would break
  // replay determinism) but correct here at the boundary: the sim stays a pure
  // function of the seed it is handed, and only the game layer decides what
  // that seed is.
  const newSeed = (): number => (Date.now() ^ (Date.now() >>> 9)) >>> 0 || 1;

  let curr: World = createArenaWorld(newSeed());
  let prev: World = curr;

  const { width, height } = arenaBounds(CURRENT_ARENA);

  const renderer = createRenderer(canvas, width, height, CURRENT_ARENA.cellSize);
  const input = createInputController(canvas, (x, y) => renderer.screenToGround(x, y));
  const audio = createAudioEngine(AUDIO_MANIFEST);
  const director = createAudioDirector(audio, curr.tanks.find((t) => t.kind === 'player')!.id);
  const sm = createGameStateMachine();
  const hud = createHud(uiRoot);

  function updateHudStats(): void {
    hud.setLives(curr.lives);
    hud.setEnemiesRemaining(countEnemies(curr));
  }

  function resetWorld(): void {
    curr = createArenaWorld(newSeed());
    prev = curr;
    acc = 0;
    updateHudStats();
  }

  // --- HUD wiring -----------------------------------------------------------
  hud.onMuteToggle(() => {
    hud.setMuted(audio.toggleMute());
  });
  hud.onVolumeChange((v) => {
    audio.setVolume(v);
  });
  hud.onStartRestart(() => {
    // This click is the only guaranteed user gesture in the game, and Safari
    // will not open an AudioContext resumed from anywhere else. Sounds are
    // emitted from the rAF loop below, which never qualifies.
    audio.unlock();
    if (sm.state === 'title') {
      sm.startPlaying();
    } else {
      // win or lose -> rebuild a fresh arena and re-enter playing
      resetWorld();
      sm.restart();
    }
  });

  sm.onChange((s) => {
    hud.setState(s);
    if (s === 'playing') audio.startMusic();
  });

  hud.setState(sm.state); // initial title panel
  updateHudStats();

  // --- global mute hotkey (M) ----------------------------------------------
  const onKey = (e: KeyboardEvent): void => {
    // Auto-repeat guard, as in input.ts: holding M fires ~30 keydowns a second,
    // so mute would toggle ~30 times and land on whichever state the repeat
    // count's parity picked. Also ignore keys aimed at a focused control.
    if (e.repeat) return;
    if (e.target instanceof HTMLElement && e.target.closest('input,button,select,textarea')) return;
    if (e.key === 'm' || e.key === 'M') hud.setMuted(audio.toggleMute());
  };
  window.addEventListener('keydown', onKey);

  // --- resize ---------------------------------------------------------------
  const onResize = (): void => {
    renderer.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);
  onResize();

  // --- fixed-timestep accumulator ------------------------------------------
  let acc = 0;
  let last = performance.now();
  let raf = 0;
  let running = true;

  const frame = (now: number): void => {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    let dtReal = (now - last) / 1000;
    last = now;
    if (dtReal > 0.25) dtReal = 0.25; // clamp to avoid a spiral of death after a stall

    const frameEvents: SimEvent[] = [];

    if (sm.state === 'playing') {
      acc += dtReal;
      while (acc >= DT) {
        prev = curr;
        const result = step(curr, input.sample());
        curr = result.world;
        acc -= DT;
        for (const ev of result.events) frameEvents.push(ev);
      }
      if (frameEvents.length > 0) {
        director.handle(frameEvents);
        sm.onEvents(frameEvents);
      }
      updateHudStats();
    } else {
      // Not simulating: keep prev == curr so the scene renders a static pose.
      acc = 0;
      prev = curr;
    }

    const alpha = sm.state === 'playing' ? acc / DT : 1;
    renderer.render(prev, curr, alpha, frameEvents, dtReal);
  };

  raf = requestAnimationFrame(frame);

  return {
    dispose(): void {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      input.dispose();
      renderer.dispose();
      audio.dispose();
      hud.dispose();
    },
  };
}
