// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createGameSessionHost, type GameSessionHost } from './session-host';
import { defaultSlots } from './versus-setup';
import type { GameHandle } from './loop';
import type { VersusConfig } from './versus-config';
import type { AppShell } from './app-shell';

function config(arenaId: string): VersusConfig {
  return { mode: 'ffa', players: 2, arenaId, stock: 3, friendlyFire: false, slots: defaultSlots(2) };
}

type StartArgs = [
  HTMLCanvasElement,
  HTMLElement,
  { config: VersusConfig } | null,
  (c: VersusConfig) => void,
  () => void,
  AppShell,
];

function harness(): {
  host: GameSessionHost;
  root: HTMLElement;
  shell: AppShell;
  startArgs: StartArgs[];
  canvases: HTMLCanvasElement[];
  /**
   * Which session (by construction order, 0-based) each `dispose()` belongs to.
   *
   * A bare count cannot tell a stale capture apart from correct behaviour: a host that
   * captured the FIRST handle and disposed it twice reports the same `2` a host that
   * disposed each session once does. See the stale-capture controls below.
   */
  disposedIds: number[];
  shellDisposals: number;
} {
  const root = document.createElement('div');
  const startArgs: StartArgs[] = [];
  const canvases: HTMLCanvasElement[] = [];
  const disposedIds: number[] = [];
  const box = { shellDisposals: 0 };
  let nextId = 0;
  const shell = {
    dispose(): void {
      box.shellDisposals += 1;
    },
  } as unknown as AppShell;

  const host = createGameSessionHost({
    root,
    // Mirrors render/canvas.ts's real bootCanvas: APPENDED into the root, not just
    // handed back, so "the dead canvas was removed" has a real DOM relationship to read.
    bootCanvas: (r) => {
      const canvas = document.createElement('canvas');
      r.appendChild(canvas);
      canvases.push(canvas);
      return canvas;
    },
    startGame: (canvas, uiRoot, versus, reqVersus, reqCampaign, s): GameHandle => {
      startArgs.push([canvas, uiRoot, versus, reqVersus, reqCampaign, s]);
      const id = nextId++;
      return {
        dispose(): void {
          disposedIds.push(id);
        },
      };
    },
    shell,
  });

  return {
    host,
    root,
    shell,
    startArgs,
    canvases,
    disposedIds,
    get shellDisposals(): number {
      return box.shellDisposals;
    },
  };
}

describe('createGameSessionHost: start', () => {
  it('builds a canvas in the root and starts ONE campaign session on it', () => {
    const h = harness();
    h.host.start();
    expect(h.startArgs).toHaveLength(1);
    const [canvas, uiRoot, versus] = h.startArgs[0];
    expect(canvas).toBe(h.canvases[0]);
    expect(canvas.parentElement, 'the session was started on a canvas outside the root').toBe(h.root);
    expect(uiRoot).toBe(h.root);
    // `null`, not a config: the page opens on campaign. A host that started the first
    // session from a retained versus config would put a returning player straight into
    // a match they did not ask for.
    expect(versus).toBeNull();
  });

  it('a SECOND start() replaces the first session rather than orphaning it', () => {
    // Not a call boot.ts makes, and that is the point: `start()` bypassing the replace
    // path is the shape this had first, and it left the first session's frame loop,
    // renderer and GL context running with nothing holding its handle.
    const h = harness();
    h.host.start();
    h.host.start();
    expect(h.disposedIds, 'the first session was orphaned').toEqual([0]);
    expect(h.root.querySelectorAll('canvas')).toHaveLength(1);
  });

  it('start() after dispose() starts nothing -- the latch covers the first session too', () => {
    const h = harness();
    h.host.dispose();
    h.host.start();
    expect(h.startArgs, 'a session started on a page that had already gone').toEqual([]);
  });

  it('does not touch the canvas or the game before start() is called', () => {
    // The constructor has to be side-effect-free for boot.ts's try/catch to be where the
    // no-WebGL throw lands: a renderer built at construction would throw from a line
    // boot.ts does not guard.
    const h = harness();
    expect(h.startArgs).toEqual([]);
    expect(h.canvases).toEqual([]);
  });
});

describe('createGameSessionHost: the reboot seams', () => {
  it('hands every session the SAME two callbacks and the SAME shell', () => {
    // Identity, not equality. A fresh pair per session would hand the OUTGOING session's
    // closure to the incoming one; a fresh shell would reintroduce the resetting-mute
    // (#320) and replaying-splash (#317) defects with every unit test still green.
    const h = harness();
    h.host.start();
    h.startArgs[0][3](config('arena-02'));
    h.startArgs[1][4]();
    expect(h.startArgs).toHaveLength(3);
    for (const [, , , reqVersus, reqCampaign, shell] of h.startArgs) {
      expect(reqVersus).toBe(h.startArgs[0][3]);
      expect(reqCampaign).toBe(h.startArgs[0][4]);
      expect(shell).toBe(h.shell);
    }
  });

  it('exposes the same two callbacks it threads into sessions', () => {
    // boot.ts never reads these, but a caller that wired `host.requestVersusSession` to
    // its own UI must get the one the sessions hold, not a second entry point.
    const h = harness();
    h.host.start();
    expect(h.startArgs[0][3]).toBe(h.host.requestVersusSession);
    expect(h.startArgs[0][4]).toBe(h.host.requestCampaignSession);
  });

  it('a versus request disposes the running session exactly once and starts one carrying the config', () => {
    const h = harness();
    h.host.start();
    const vs = config('vs-duel-01');
    h.host.requestVersusSession(vs);
    expect(h.disposedIds, 'the outgoing session was left running').toEqual([0]);
    expect(h.startArgs).toHaveLength(2);
    expect(h.startArgs[1][2]).toEqual({ config: vs });
  });

  it('a campaign request from a versus session starts with versus: null', () => {
    const h = harness();
    h.host.start();
    h.host.requestVersusSession(config('arena-02'));
    h.host.requestCampaignSession();
    expect(h.disposedIds).toEqual([0, 1]);
    expect(h.startArgs[2][2], 'the campaign reboot carried the versus config forward').toBeNull();
  });

  it('a versus request AFTER a campaign detour carries its OWN config', () => {
    // The retained-config pin. `lastVersusConfig` is written one line before it is read,
    // so a host that replayed a STALE retained config would put the player on the wrong
    // board -- and with one config in the fixture nothing would notice.
    const h = harness();
    h.host.start();
    h.host.requestVersusSession(config('arena-02'));
    h.host.requestCampaignSession();
    h.host.requestVersusSession(config('vs-duel-01'));
    expect(h.startArgs[3][2]).toEqual({ config: config('vs-duel-01') });
  });

  it('a SECOND replacement disposes the SECOND session, not the first -- the stale-capture control', () => {
    // A `const` capture of the first handle disposes id 0 twice and leaves the live
    // session's loop, listeners and GL context all running. `disposedIds` is what tells
    // that apart from correct behaviour; a count of 2 cannot.
    const h = harness();
    h.host.start();
    h.host.requestVersusSession(config('arena-02'));
    h.host.requestVersusSession(config('vs-duel-01'));
    expect(h.disposedIds).toEqual([0, 1]);
  });

  it('builds a FRESH canvas per replacement and removes the dead one from the DOM', () => {
    // startGameWith's teardown calls renderer.forceContextLoss(), which a WebGL context
    // does not come back from -- so a second renderer on the SAME element renders nothing
    // forever in a real browser, invisibly to every fake here. The removal is what stops
    // repeated switches stacking disconnected canvases behind the live one.
    const h = harness();
    h.host.start();
    h.host.requestVersusSession(config('arena-02'));
    expect(h.canvases).toHaveLength(2);
    expect(h.startArgs[1][0], 'the replacement reused the dead canvas').toBe(h.canvases[1]);
    expect(h.canvases[0].isConnected, 'the dead canvas was left in the DOM').toBe(false);
    expect(h.root.querySelectorAll('canvas')).toHaveLength(1);
  });

  it('leaves exactly one canvas in the root after repeated switches', () => {
    const h = harness();
    h.host.start();
    for (let i = 0; i < 4; i += 1) {
      h.host.requestVersusSession(config('arena-02'));
      h.host.requestCampaignSession();
    }
    expect(h.startArgs).toHaveLength(9);
    expect(h.root.querySelectorAll('canvas')).toHaveLength(1);
    expect(h.root.querySelector('canvas')).toBe(h.startArgs[8][0]);
  });
});

describe('createGameSessionHost: stop and dispose', () => {
  it('stop() disposes the running session and LEAVES its canvas in the DOM', () => {
    // The asymmetry with `replace`, and it is deliberate: stop() is what the page
    // teardown calls, and there is nothing to draw afterwards. Removing the canvas here
    // would make the last frame vanish before the document does.
    const h = harness();
    h.host.start();
    h.host.stop();
    expect(h.disposedIds).toEqual([0]);
    expect(h.root.querySelectorAll('canvas'), 'stop() removed the canvas').toHaveLength(1);
  });

  it('stop() is idempotent -- a second call disposes nothing again', () => {
    // A host that kept the handle after disposing it would call a session's dispose()
    // twice, which double-releases the audio engine and unregisters listeners the NEXT
    // session may already own.
    const h = harness();
    h.host.start();
    h.host.stop();
    h.host.stop();
    expect(h.disposedIds).toEqual([0]);
  });

  it('stop() before start() disposes nothing rather than throwing', () => {
    const h = harness();
    expect(() => h.host.stop()).not.toThrow();
    expect(h.disposedIds).toEqual([]);
  });

  it('dispose() disposes the CURRENT session after a replacement, not the original', () => {
    const h = harness();
    h.host.start();
    h.host.requestVersusSession(config('arena-02'));
    h.host.dispose();
    expect(h.disposedIds).toEqual([0, 1]);
  });

  it('dispose() latches: a late reboot request starts no session on a dying page', () => {
    // Both seams are already in a HUD click handler's hands when pagehide fires. Without
    // the latch a click in the same task builds a whole session -- canvas, renderer,
    // frame loop -- onto a document on its way out, holding a GL context nothing will
    // ever dispose.
    const h = harness();
    h.host.start();
    h.host.dispose();
    const startsBefore = h.startArgs.length;
    const canvasesBefore = h.canvases.length;

    h.host.requestVersusSession(config('arena-02'));
    h.host.requestCampaignSession();

    expect(h.startArgs.length, 'a session started after the page teardown').toBe(startsBefore);
    expect(h.canvases.length, 'a canvas was built after the page teardown').toBe(canvasesBefore);
    expect(h.disposedIds, 'the latched host disposed something twice').toEqual([0]);
  });

  it('never disposes the shell it borrowed -- that is the page teardown', () => {
    // AppShell.dispose() takes the audio engine and the OS reduced-motion listener with
    // it, and the engine LATCHES (audio/engine.ts): a host that disposed it on a switch
    // would leave every later session silent with nothing thrown.
    const h = harness();
    h.host.start();
    h.host.requestVersusSession(config('arena-02'));
    h.host.requestCampaignSession();
    h.host.stop();
    h.host.dispose();
    expect(h.shellDisposals).toBe(0);
  });
});
