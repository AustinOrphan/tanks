import { bootCanvas } from './render/canvas';
import { createBrowserDeps, startGameWith, versusAwareDeps } from './game/loop';
import { boot } from './boot';
import { createBrowserAppShell } from './game/app-shell';
import { createRouteHost } from './game/route-host';
import { readNavigatorGamepads } from './input/gamepad';

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
  startGame: (canvas, intent, requestVersusSession, requestCampaignSession, shell, routeHost) =>
    startGameWith(
      canvas,
      // The versus half of the intent, in the shape `applyVersusToDeps` has always taken:
      // a config swaps in the versus level system and the Versus identity, and every other
      // intent is a campaign-level-system session that `startGameWith` then lands on the
      // board the intent names. No branching here beyond that translation -- issue #428's
      // start policy lives in `startGameWith`'s own START BOUNDARY block, which a test can
      // reach directly.
      versusAwareDeps(
        intent.kind === 'versus' ? { config: intent.config } : null,
        requestVersusSession,
        requestCampaignSession,
        shell,
      ),
      routeHost,
      intent,
    ),
  host: window,
  reportError: (err) => console.error('Tanks! failed to start:', err),
  // The failure screen's recovery action (issue #325). `location.reload()` rather than
  // re-running `boot()`: whatever failed did so with the module graph already evaluated,
  // and a fresh document is the only retry that does not inherit whatever state the
  // failure left behind.
  reload: () => location.reload(),
  // The page's one shell (issues #320, #317): settings/persistence, the audio engine, the
  // Launch gate and the WebGL capability reading (#470). boot.ts calls this exactly once
  // and hands the result to every session, which is what keeps mute, volume, the resumed
  // audio context and the already-dismissed splash alive across a campaign/versus reboot.
  createAppShell: createBrowserAppShell,
  // The page's one application-route UI (issue #468): the HUD element tree, the state
  // machine and the route controller, built once and outliving every session. The deps it
  // reads are the SAME `createBrowserDeps` a session gets -- which matters, because the
  // stores behind them (`shell.settings.stores`) are the page's, so the Main Menu and a
  // running match are reading one set of preferences and one campaign run, not two.
  createRouteHost: (root, shell, requests) =>
    createRouteHost(
      root,
      {
        ...createBrowserDeps(shell),
        // The page's menu poller (issue #494): the real pads and the real frame loop.
        menuGamepads: readNavigatorGamepads,
        requestFrame: (cb) => {
          const id = requestAnimationFrame(cb);
          return () => cancelAnimationFrame(id);
        },
        // Monotonic, unlike Date.now: the modality threshold measures a span, and a
        // clock the system can step backwards would make a switch arrive early or never.
        now: () => performance.now(),
      },
      requests,
    ),
});
