import { bootCanvas } from './render/canvas';
import { startGame } from './game/loop';
import { boot } from './boot';

// Wiring only. Everything this file used to do -- the WebGL error page, the
// teardown registration -- lives in boot.ts, which can be called with fakes.
// This file runs at module scope against a real document, so importing it
// starts the game and no test can ever reach it. Keep it free of logic:
// anything added here is unpinned again.
boot({
  root: document.getElementById('app')!,
  bootCanvas,
  startGame,
  host: window,
  reportError: (err) => console.error('Tanks! failed to start:', err),
});
