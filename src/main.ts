import { bootCanvas } from './render/canvas';
import { startGameWith, versusAwareDeps } from './game/loop';
import { boot } from './boot';

// Wiring only. Everything this file used to do -- the WebGL error page, the
// teardown registration -- lives in boot.ts, which can be called with fakes.
// This file runs at module scope against a real document, so importing it
// starts the game and no test can ever reach it. Keep it free of logic:
// anything added here is unpinned again.
boot({
  root: document.getElementById('app')!,
  bootCanvas,
  // The one wrapper line the versus reboot seam needs: builds this session's real
  // GameDeps (versusAwareDeps, game/loop.ts) from whatever boot.ts is rebooting
  // with, and threads the reboot callback boot.ts hands back on every call. No
  // branching here -- that logic lives in versusAwareDeps/applyVersusToDeps, which
  // a test can reach directly.
  startGame: (canvas, uiRoot, versus, requestVersusSession) =>
    startGameWith(canvas, uiRoot, versusAwareDeps(versus, requestVersusSession)),
  host: window,
  reportError: (err) => console.error('Tanks! failed to start:', err),
});
