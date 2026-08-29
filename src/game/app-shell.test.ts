// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createAppShell, type AppShell } from './app-shell';
import { createAppSettings, type AppSettings } from './app-settings';
import { createMemoryStorage, createStores } from './storage';
import { createCapabilitySource, createStaticReducedMotionSource, NO_CAPABILITIES } from './capabilities';
import { createBrowserDeps } from './loop';
import type { AudioEngine } from '../audio/engine';

function realSettings(): AppSettings {
  const storage = createMemoryStorage();
  return createAppSettings({
    storage,
    namespace: 'production',
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

function build(): { shell: AppShell; audio: string[]; settingsDisposals: () => number } {
  const { engine, calls } = recordingAudio();
  let settingsDisposals = 0;
  const settings = realSettings();
  const wrapped = {
    ...settings,
    dispose: () => {
      settingsDisposals += 1;
      settings.dispose();
    },
  } as AppSettings;
  return {
    shell: createAppShell({ settings: wrapped, audio: engine }),
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
