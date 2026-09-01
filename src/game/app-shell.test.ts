// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createAppShell, createBrowserAppShell, type AppShell } from './app-shell';
import { createAppSettings, type AppSettings } from './app-settings';
import { createMemoryStorage, createStores } from './storage';
import { createCapabilitySource, createStaticReducedMotionSource, NO_CAPABILITIES } from './capabilities';
import {
  probeRenderCapability,
  RENDER_CAPABILITY_SUPPORTED,
  type RenderCapability,
} from './render-capability';
import { createBrowserDeps } from './loop';
import type { AudioEngine } from '../audio/engine';

function realSettings(namespace: 'production' | 'developer' = 'production'): AppSettings {
  const storage = createMemoryStorage();
  return createAppSettings({
    storage,
    namespace,
    stores: createStores(storage, 'persistent'),
    capabilities: createCapabilitySource(() => NO_CAPABILITIES),
    motion: createStaticReducedMotionSource(false),
  });
}

/** Records which lifecycle calls it received, in order. */
function recordingAudio(): { engine: AudioEngine; calls: string[] } {
  const calls: string[] = [];
  const engine = {
    stopMusic: () => calls.push('stopMusic'),
    dispose: () => calls.push('dispose'),
  } as unknown as AudioEngine;
  return { engine, calls };
}

function build(
  namespace: 'production' | 'developer' = 'production',
  render: RenderCapability = RENDER_CAPABILITY_SUPPORTED,
): { shell: AppShell; audio: string[]; settingsDisposals: () => number } {
  const { engine, calls } = recordingAudio();
  let settingsDisposals = 0;
  const settings = realSettings(namespace);
  const wrapped = {
    ...settings,
    dispose: () => {
      settingsDisposals += 1;
      settings.dispose();
    },
  } as AppSettings;
  return {
    shell: createAppShell({ settings: wrapped, audio: engine, render }),
    audio: calls,
    settingsDisposals: () => settingsDisposals,
  };
}

describe('createAppShell: the Launch gate (issue #317)', () => {
  it('starts undismissed, so the first session of a document load opens on the splash', () => {
    expect(build().shell.launchDismissed()).toBe(false);
  });

  it('latches once dismissed, and stays latched -- "per document load" is the whole point', () => {
    const { shell } = build();
    shell.dismissLaunch();
    expect(shell.launchDismissed()).toBe(true);
    // Idempotent: both gesture handlers in loop.ts can reach it, and a pointerdown that
    // followed a keydown must not reopen the gate.
    shell.dismissLaunch();
    expect(shell.launchDismissed()).toBe(true);
  });

  it('is per SHELL, not module state -- two pages do not share a dismissal', () => {
    // A module-level latch is the obvious shape and would make the second page in a test
    // run (and, in a browser, a soft navigation) skip a splash it never showed.
    const a = build();
    const b = build();
    a.shell.dismissLaunch();
    expect(b.shell.launchDismissed(), 'the gate leaked across shells').toBe(false);
  });
});

describe('createAppShell: disposal', () => {
  it('releases the audio engine AND the settings owner', () => {
    const { shell, audio, settingsDisposals } = build();
    shell.dispose();
    expect(audio, 'the page teardown left the audio engine alive').toEqual(['dispose']);
    expect(settingsDisposals(), 'the page teardown left the settings owner alive').toBe(1);
  });
});

describe('createBrowserDeps: the page-owned audio wiring (issue #317)', () => {
  it('hands every session the SAME engine, and releases it by STOPPING rather than disposing', () => {
    // This is the wiring `main.ts` ships and no other test enters. Getting either half
    // wrong is silent: a fresh engine per session reintroduces the ordering gap the
    // splash used to cover, and a releasing `dispose()` latches the engine shut
    // (engine.ts) so every session after the first is silent with nothing thrown.
    const { shell, audio } = build();
    const first = createBrowserDeps(shell);
    const second = createBrowserDeps(shell);
    expect(first.createAudio(), 'a session got its own engine').toBe(shell.audio);
    expect(second.createAudio(), 'the second session got a different engine').toBe(shell.audio);

    first.releaseAudio(first.createAudio());
    expect(audio, 'releasing a session disposed the PAGE engine').toEqual(['stopMusic']);
  });

  it('reads and writes the shell\'s Launch gate, both directions', () => {
    const { shell } = build();
    const deps = createBrowserDeps(shell);
    expect(deps.launchGate.dismissed()).toBe(false);

    deps.launchGate.dismiss();

    expect(shell.launchDismissed(), 'the session dismissed a gate the shell cannot see').toBe(true);
    // The READ side is separately wrong if it is wired to a snapshot taken at deps
    // construction, which is why this asks the SAME deps object again rather than a new one.
    expect(deps.launchGate.dismissed(), 'the gate read a stale snapshot').toBe(true);
  });
});

describe('createBrowserDeps: the storage namespace reaches the save API (issue #250)', () => {
  it('carries the namespace the settings owner resolved, both values', () => {
    // The wiring `main.ts` ships and nothing else enters. A hard-coded 'production' here
    // would label every developer export as production -- silently, since the blob's KEYS
    // are the store-facing names in either namespace and so look identical. That is the
    // exact defect issue #250 closes, reintroduced one line lower down.
    expect(createBrowserDeps(build('production').shell).storageNamespace).toBe('production');
    expect(createBrowserDeps(build('developer').shell).storageNamespace).toBe('developer');
  });

  it('is the SAME namespace the storage adapter is applying, not a second answer', () => {
    // `storage` and `storageNamespace` are a pair; read from one object so they cannot
    // disagree about which keys this session is on.
    const { shell } = build('developer');
    const deps = createBrowserDeps(shell);
    expect(deps.storageNamespace).toBe(shell.settings.namespace);
    expect(deps.storage).toBe(shell.settings.storage);
  });
});

/**
 * The retained capability answer (issue #470).
 *
 * The shell RETAINS what the probe said; it does not take the reading itself. That split
 * is what lets `boot.ts` decide before a session exists, and lets a test drive both sides
 * without a GPU -- and it is why `createBrowserAppShell` is the one place the real probe
 * runs.
 */
describe('createAppShell: the retained render capability (issue #470)', () => {
  it('exposes exactly what it was handed, unchanged', () => {
    expect(build().shell.render).toBe(RENDER_CAPABILITY_SUPPORTED);

    const answer: RenderCapability = { webgl2: false, failure: 'no-webgl2' };
    expect(build('production', answer).shell.render).toBe(answer);
  });

  /**
   * A FIELD, not a live source: unlike a gamepad, WebGL 2 support does not arrive mid
   * document, and a shell that re-probed would take a fresh reading per read.
   *
   * Would fail if `render` became a getter over a fresh probe -- two reads would still be
   * `toEqual`, but no longer the same object.
   */
  it('answers with the same object every time it is asked', () => {
    const { shell } = build();
    expect(shell.render).toBe(shell.render);
  });

  /**
   * Survives the whole shell lifecycle for the same reason settings and audio do: the page
   * keeps it while sessions come and go.
   */
  it('is still readable after the page teardown, so a late error screen can name the cause', () => {
    const answer: RenderCapability = { webgl2: false, failure: 'probe-failed' };
    const { shell } = build('production', answer);
    shell.dispose();
    expect(shell.render).toBe(answer);
  });
});

/**
 * The one line in this module that runs the REAL probe (issue #470).
 *
 * Everything above injects the answer, which is what makes those cases readable without a
 * GPU -- and is exactly why none of them can see whether `createBrowserAppShell` ever asks.
 * `createBrowserAppShell` is production-only wiring: `main.ts` names it and
 * `createBrowserDeps` defaults to it, and no other test in this repo constructs it, so
 * before this case a shell that assumed support shipped with the whole suite green. That
 * is the same class as `devflags-developer-mode-gate-always-off` -- a gate that goes
 * permanently one way for the real browser while nothing fails.
 */
describe('createBrowserAppShell: the one real probe on the page (issue #470)', () => {
  /**
   * jsdom genuinely has no WebGL -- render-capability.test.ts's 'runs against a real
   * document and reports this environment unsupported' establishes that against the same
   * environment -- so a shell that really probed cannot report support here.
   *
   * Would fail if the wiring hardcoded an answer instead of calling the probe: a literal
   * `{ webgl2: true, failure: null }` on that line reads as SUPPORTED in an environment
   * that demonstrably is not, which in a real unsupported browser would sail past
   * `boot.ts`'s gate and put the player back on the pre-#470 path -- a canvas, a session
   * and a world built before `THREE.WebGLRenderer` throws.
   */
  it('takes a real reading rather than assuming the browser can render', () => {
    const shell = createBrowserAppShell();
    try {
      expect(shell.render).toEqual(probeRenderCapability());
      expect(shell.render.webgl2).toBe(false);
      expect(shell.render.failure).toBe('no-webgl2');
    } finally {
      shell.dispose();
    }
  });
});
