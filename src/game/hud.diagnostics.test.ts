// @vitest-environment jsdom
//
// The developer diagnostics CONTROLS (issue #247) -- the half `dev-diagnostics.test.ts` does
// not cover: whether the pane offers them at all, what they write, and what Pin is forbidden
// from doing. The formatting is tested against the pure module; this file is about wiring.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud } from './hud';
import type { SessionDiagnostics } from './dev-diagnostics';
import { DEV_ACTIONS, type DevActionPort } from './dev-actions';
import {
  NO_SESSION_REPLAY_NOTE,
  NO_SESSION_SCREENSHOT_NOTE,
  type DevExportPort,
  type RoundDiagnostics,
} from './dev-exports';
import { createRecordingInput, replayMetaFor } from './replay';
import { arenaById, createWorldFor } from '../sim/arena';

let hud: Hud | null = null;
afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

const SESSION: SessionDiagnostics = {
  seed: 4242424242,
  arenaId: 'arena-02',
  mode: 'campaign',
  humanPlayers: 1,
  bots: 0,
  quality: 'medium',
};

const PAGE = { path: '/tanks/', hash: '', build: { commit: 'abc1234', known: true } } as const;

function mountDev(opts: Parameters<typeof createHud>[1] = {}): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root, { developerMode: true, developerSearch: '?dev=1', ...opts });
  hud.setState('main-menu');
  return root;
}

const q = <T extends HTMLElement>(root: HTMLElement, sel: string): T =>
  root.querySelector<T>(sel) as T;

/**
 * Every dynamic import in flight has landed, plus a macrotask, so the HUD's `.then` has run:
 * an assertion of ABSENCE after this is not merely early. `hud.selftest.test.ts`'s helper.
 */
async function settled(): Promise<void> {
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Everything that escaped while `run` ran and every import settled: a throw from a click
 * listener, which jsdom reports as a window `error` rather than from `click()` -- so
 * `expect(click).not.toThrow()` cannot see it -- and an unhandled rejection, which `boot.ts`
 * treats as the match failing.
 */
async function escapedDuring(run: () => void | Promise<void>): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const onError = (e: ErrorEvent): void => {
    escaped.push(e.error);
    e.preventDefault();
  };
  const onRejection = (reason: unknown): void => void escaped.push(reason);
  window.addEventListener('error', onError);
  process.on('unhandledRejection', onRejection);
  try {
    await run();
    await settled();
  } finally {
    window.removeEventListener('error', onError);
    process.off('unhandledRejection', onRejection);
  }
  return escaped;
}

/** A port with a round running, recording every rebuild it is asked for. */
function livePort(rebuilt: Array<number | null> = []): DevActionPort {
  return {
    currentSeed: () => 1,
    hasRound: () => true,
    rebuild: (seed) => {
      rebuilt.push(seed);
      return 1;
    },
  };
}

/**
 * `mountDev`, with the pane's modules loaded the way the page loads them (issue #1014):
 * Developer Tools is opened, the REAL imports are awaited, and the pane is closed again, so a
 * case starts where it always has -- at the main menu -- and every press in it is answered in
 * its own task, which its assertions read straight after the press. An open that loaded
 * nothing fails those assertions rather than this helper.
 */
async function mountDevLoaded(opts: Parameters<typeof createHud>[1] = {}): Promise<HTMLElement> {
  const root = mountDev(opts);
  q<HTMLButtonElement>(root, '.hud-devtools-open').click();
  await settled();
  q<HTMLButtonElement>(root, '.hud-devtools-back').click();
  return root;
}
const out = (root: HTMLElement): HTMLTextAreaElement => q(root, '.hud-diag-out');
const shown = (el: HTMLElement): boolean => getComputedStyle(el).display !== 'none';

describe('the diagnostics controls are offered only when the page half is wired', () => {
  it('hides both buttons when no developerPage is supplied', () => {
    // The rule `exitDeveloperMode` and Apply already follow: a control whose seam is absent
    // is not rendered, rather than rendered and inert. ~230 injected HUDs in this suite have
    // no `developerPage`, and none of them should grow two buttons that would report a page
    // the test does not have.
    const root = mountDev();
    expect(q(root, '.hud-diag-copy').hidden).toBe(true);
    expect(q(root, '.hud-diag-pin').hidden).toBe(true);
  });

  it('shows both when it is', () => {
    const root = mountDev({ developerPage: PAGE });
    expect(q(root, '.hud-diag-copy').hidden).toBe(false);
    expect(q(root, '.hud-diag-pin').hidden).toBe(false);
  });

  it('does nothing at all when Copy is pressed without one', () => {
    // Not merely hidden: the HANDLER refuses too. A hidden button is still clickable through
    // the DOM, and a handler that ran anyway would have to invent a path and a build.
    const root = mountDev();
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).value).toBe('');
    expect(shown(out(root))).toBe(false);
  });
});

describe('Copy Diagnostics writes the session it was given', () => {
  it('reports the live seed, and the field is only shown once there is something in it', async () => {
    const root = await mountDevLoaded({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    expect(shown(out(root))).toBe(false);
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(shown(out(root))).toBe(true);
    expect(out(root).value).toContain('- Seed: 4242424242');
    expect(out(root).value).toContain('- Build: abc1234');
    expect(out(root).value).toContain('- URL: /tanks/?dev=1');
  });

  it('READS THE SOURCE AT PRESS TIME, not when it was registered', async () => {
    // The load-bearing one. `loop.ts` rebuilds the world on every level change and every
    // restart, and the seed changes with it -- so a HUD that had snapshotted the source's
    // value at registration would report the session's FIRST world for the rest of its life,
    // which is the one number this whole feature exists to get right.
    const root = await mountDevLoaded({ developerPage: PAGE });
    let live: SessionDiagnostics = SESSION;
    hud!.setDiagnosticsSource(() => live);
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).value).toContain('- Seed: 4242424242');
    live = { ...SESSION, seed: 99 };
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).value).toContain('- Seed: 99');
  });

  it('says there is no session when nothing is live, rather than reporting a seed', async () => {
    // `route-host.ts` returns `null` from the trampoline whenever no session holds the slot,
    // which is the state the developer pane is usually opened in -- from the main menu.
    const root = await mountDevLoaded({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => null);
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).value).toContain('none simulating');
    expect(out(root).value).not.toContain('- Seed:');
  });

  it('selects the text it wrote, so the keyboard copy path works without a clipboard', async () => {
    // The async Clipboard API is origin- and permission-gated and absent on a file:// page.
    // Selecting is the path that always works, and the self-test's Copy already relies on it.
    const root = await mountDevLoaded({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).selectionStart).toBe(0);
    expect(out(root).selectionEnd).toBe(out(root).value.length);
  });
});

describe('Pin Current Seed offers a URL and changes nothing', () => {
  it('writes a URL carrying the live seed', async () => {
    const root = await mountDevLoaded({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    q<HTMLButtonElement>(root, '.hud-diag-pin').click();
    expect(out(root).value).toBe('/tanks/?dev=1&seed=4242424242');
  });

  it('DOES NOT NAVIGATE, and does not ask the page to apply anything', async () => {
    // "Seed pinning does not change the current world before the user applies/reloads" is
    // this issue's sharpest criterion, and this is the assertion that can fail for it: the
    // HUD is given the very seam that WOULD navigate -- the configuration menu's
    // `applyDeveloperConfig` -- and pressing Pin must not reach for it. A handler that
    // "helpfully" applied the pinned URL would reload the page and destroy the world whose
    // seed was being pinned, which is the opposite of the point.
    const applied: string[] = [];
    const root = await mountDevLoaded({ developerPage: PAGE, applyDeveloperConfig: (s) => applied.push(s) });
    hud!.setDiagnosticsSource(() => SESSION);
    q<HTMLButtonElement>(root, '.hud-diag-pin').click();
    expect(applied).toEqual([]);
  });

  it('does not disturb the snapshot the session handed it', async () => {
    // The same guarantee one layer up from `dev-diagnostics.test.ts`'s own version: the
    // record the getter returned is byte-identical after the press, so a future handler that
    // started writing back through the snapshot fails here.
    const root = await mountDevLoaded({ developerPage: PAGE });
    const session = { ...SESSION };
    const before = JSON.stringify(session);
    hud!.setDiagnosticsSource(() => session);
    q<HTMLButtonElement>(root, '.hud-diag-pin').click();
    expect(JSON.stringify(session)).toBe(before);
  });

  it('says why there is nothing to pin when no session is live', async () => {
    const root = await mountDevLoaded({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => null);
    q<HTMLButtonElement>(root, '.hud-diag-pin').click();
    expect(out(root).value).toContain('no resolved seed to pin');
    expect(out(root).value).not.toContain('/tanks/?');
  });
});

describe('the three developer actions (issue #252)', () => {
  /** A port that records what it was asked and answers with a seed of its own. */
  function fakePort(overrides: Partial<{ hasRound: boolean; seed: number; resolved: number }> = {}) {
    const calls: Array<{ seed: number | null; keepLives: boolean }> = [];
    return {
      calls,
      port: {
        currentSeed: () => overrides.seed ?? 55,
        hasRound: () => overrides.hasRound ?? true,
        rebuild: (seed: number | null, keepLives: boolean) => {
          calls.push({ seed, keepLives });
          return overrides.resolved ?? 8888;
        },
      },
    };
  }

  const act = (root: HTMLElement, id: string): HTMLButtonElement =>
    q<HTMLButtonElement>(root, `.hud-devact[data-action="${id}"]`);

  it('offers all three, labelled from the catalogue', async () => {
    const root = await mountDevLoaded({ developerPage: PAGE });
    hud!.setDevActionPort(() => fakePort().port);
    expect(Array.from(root.querySelectorAll('.hud-devact'), (b) => b.textContent)).toEqual([
      'Restart with Same Seed',
      'Reroll Seed',
      'Restart Current Round',
    ]);
  });

  it('re-asks whether a round exists every time the pane opens, not only at registration', async () => {
    // THE LOAD-BEARING ONE. `route-host.ts` registers the port once, at construction, when
    // the session is still at its own title screen -- so a set-once availability would leave
    // all three controls hidden for the entire life of the page. Whether a round exists
    // changes underneath a pane that is shut.
    const root = await mountDevLoaded({ developerPage: PAGE });
    let roundStarted = false;
    hud!.setDevActionPort(() => ({
      currentSeed: () => 1,
      hasRound: () => roundStarted,
      rebuild: () => 1,
    }));
    expect(act(root, 'reroll-seed').hidden).toBe(true);
    roundStarted = true;
    q<HTMLButtonElement>(root, '.hud-devtools-open').click();
    expect(act(root, 'reroll-seed').hidden).toBe(false);
  });

  it('hides all three with no session, and shows them once one is live', async () => {
    // Distinct from the `developerPage` gate: the pane exists either way, but there is no
    // round to restart from the main menu. A control the session cannot serve is not
    // rendered, the rule Exit and both diagnostics buttons already follow.
    const root = await mountDevLoaded({ developerPage: PAGE });
    expect(act(root, 'reroll-seed').hidden).toBe(true);
    hud!.setDevActionPort(() => null);
    expect(act(root, 'reroll-seed').hidden).toBe(true);
    hud!.setDevActionPort(() => fakePort({ hasRound: false }).port);
    expect(act(root, 'reroll-seed').hidden).toBe(true);
    hud!.setDevActionPort(() => fakePort().port);
    expect(act(root, 'reroll-seed').hidden).toBe(false);
  });

  it('ARMS before it fires, and the first press rebuilds nothing', async () => {
    // "Cancelled confirmations make no change." The first press only changes the label; the
    // port is untouched, so a handler that fired on one press fails here rather than in a
    // playtest with a lost round.
    const root = await mountDevLoaded({ developerPage: PAGE });
    const f = fakePort();
    hud!.setDevActionPort(() => f.port);
    act(root, 'reroll-seed').click();
    expect(f.calls).toEqual([]);
    expect(act(root, 'reroll-seed').textContent).toBe('Reroll, losing this round?');
    act(root, 'reroll-seed').click();
    expect(f.calls).toEqual([{ seed: null, keepLives: false }]);
  });

  it('arming one action DISARMS another, so a stray second press cannot fire the wrong one', async () => {
    // The mechanism is single-slot (`armedReset`), which is what makes this true -- and the
    // label restoration is what makes it visible. Before issue #252 that restoration was a
    // two-way ternary over the two reset buttons; an armed developer action would have been
    // relabelled "Reset progress".
    const root = await mountDevLoaded({ developerPage: PAGE });
    const f = fakePort();
    hud!.setDevActionPort(() => f.port);
    act(root, 'reroll-seed').click();
    act(root, 'restart-round').click();
    expect(act(root, 'reroll-seed').textContent).toBe('Reroll Seed');
    expect(act(root, 'restart-round').textContent).toBe('Restart this round?');
    expect(f.calls).toEqual([]);
  });

  it('asks for the CURRENT seed on a same-seed restart, and reports what came back', async () => {
    const root = await mountDevLoaded({ developerPage: PAGE });
    const f = fakePort({ seed: 4242, resolved: 4242 });
    hud!.setDevActionPort(() => f.port);
    act(root, 'restart-same-seed').click();
    act(root, 'restart-same-seed').click();
    expect(f.calls).toEqual([{ seed: 4242, keepLives: false }]);
    expect(out(root).value).toContain('now running seed 4242');
  });

  it('puts a REPRODUCTION URL beside a rerolled seed, not just the number', async () => {
    // "Reroll reports an exact seed that can immediately be copied into a reproduction URL."
    // A bare number leaves the developer to build the URL; this is the same `pinnedSeedUrl`
    // Pin Current Seed uses, so the two cannot produce different URLs for one session.
    const root = await mountDevLoaded({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => ({ ...SESSION, seed: 8888 }));
    hud!.setDevActionPort(() => fakePort({ resolved: 8888 }).port);
    act(root, 'reroll-seed').click();
    act(root, 'reroll-seed').click();
    expect(out(root).value).toContain('now running seed 8888');
    expect(out(root).value).toContain('/tanks/?dev=1&seed=8888');
  });

  it('says so rather than appearing to work when the port refuses', async () => {
    const root = await mountDevLoaded({ developerPage: PAGE });
    // Available at arm time, gone by the time the second press lands -- the session detached
    // while the control sat armed, which a 4-second window makes reachable.
    let live = true;
    hud!.setDevActionPort(() => (live ? fakePort({ hasRound: false }).port : null));
    live = true;
    act(root, 'restart-round').click();
    act(root, 'restart-round').click();
    expect(out(root).value).toContain('nothing to restart');
  });
});

describe('the field does not outlive the pane', () => {
  it('is cleared and re-hidden when Developer Tools closes', async () => {
    // A URL or a report left in the field is a statement about a session that may since have
    // been restarted, and the next opener would read it as current. The self-test's report
    // field is cleared on close for the same reason.
    const root = await mountDevLoaded({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    // OPENED FIRST, through the badge the player uses. The clearing hangs off the pane's
    // close, so a test that only clicked Back on a pane that was never open would assert
    // against a path that did not run -- and would pass just as well with the clearing
    // deleted.
    q<HTMLButtonElement>(root, '.hud-devtools-open').click();
    q<HTMLButtonElement>(root, '.hud-diag-pin').click();
    expect(out(root).value).not.toBe('');
    q<HTMLButtonElement>(root, '.hud-devtools-back').click();
    expect(out(root).value).toBe('');
    expect(shown(out(root))).toBe(false);
  });
});

describe('the persistence controls (issue #249)', () => {
  const q2 = <T extends HTMLElement>(root: HTMLElement, sel: string): T =>
    root.querySelector<T>(sel) as T;

  it('states the namespace continuously, and WARNS only on the production keys', () => {
    // Criterion 4: "namespace status remains obvious while production data is active in a dev
    // session". Both directions in one case, because a line that read the same either way
    // would satisfy "states the namespace" and none of what it is for.
    const dev = mountDev({ developerPage: PAGE, storageNamespace: 'developer' });
    expect(q2(dev, '.hud-devns').textContent).toContain('developer keys');
    expect(q2(dev, '.hud-devns').classList.contains('hud-devns--warning')).toBe(false);
    hud?.dispose();
    document.body.innerHTML = '';
    const prod = mountDev({ developerPage: PAGE, storageNamespace: 'production' });
    expect(q2(prod, '.hud-devns').textContent).toContain('PRODUCTION');
    expect(q2(prod, '.hud-devns').classList.contains('hud-devns--warning')).toBe(true);
  });

  it('ARMS Reset Developer Data, and a cancelled confirmation changes nothing', () => {
    // Criterion 6 names cancellation first. The first press only relabels; arming a DIFFERENT
    // control disarms this one, which is the cancel path a developer actually takes.
    const cleared: number[] = [];
    const root = mountDev({
      developerPage: PAGE,
      storageNamespace: 'developer',
      resetDeveloperData: () => cleared.push(1),
      applyDeveloperConfig: () => {},
    });
    q2<HTMLButtonElement>(root, '.hud-devreset').click();
    expect(cleared).toEqual([]);
    expect(q2(root, '.hud-devreset').textContent).toBe('Erase all developer data?');
    // Arming ANOTHER danger control is the cancel a developer actually performs: the
    // mechanism holds one armed button at a time, and arming a second disarms the first.
    // (`.hud-diag-copy` would not do it -- it is not a danger control and never disarms
    // anything, which a first draft of this case got wrong and the assertion caught.)
    q2<HTMLButtonElement>(root, '.hud-prodsave').click();
    expect(q2(root, '.hud-devreset').textContent).toBe('Reset Developer Data');
    expect(cleared).toEqual([]);
  });

  it('clears developer data on the second press, and says the real save was spared', () => {
    const cleared: number[] = [];
    const root = mountDev({
      developerPage: PAGE,
      storageNamespace: 'developer',
      resetDeveloperData: () => cleared.push(1),
    });
    q2<HTMLButtonElement>(root, '.hud-devreset').click();
    q2<HTMLButtonElement>(root, '.hud-devreset').click();
    expect(cleared).toEqual([1]);
    expect(out(root).value).toContain('production save was not touched');
  });

  it('navigates to the production save ONLY on the second press', () => {
    // "Enabling it requires a warning and deliberate confirmation immediately before reload."
    // The second press IS the reload, so there is no window between confirming and applying.
    const applied: string[] = [];
    const root = mountDev({
      developerPage: PAGE,
      storageNamespace: 'developer',
      applyDeveloperConfig: (s) => applied.push(s),
    });
    q2<HTMLButtonElement>(root, '.hud-prodsave').click();
    expect(applied).toEqual([]);
    q2<HTMLButtonElement>(root, '.hud-prodsave').click();
    expect(applied).toHaveLength(1);
    // The URL carries the gate AND the flag, canonicalised -- `selectStorageNamespace` needs
    // both, and a URL with the flag alone would be inert.
    expect(applied[0]).toContain('dev=1');
    expect(applied[0]).toContain('prodSave=1');
  });

  it('does not offer Use Production Save on a session already on the production keys', () => {
    // It would reload onto where it already is. `Reset Developer Data` stays offered, because
    // the developer keys still exist and are still resettable from a prodSave session.
    const root = mountDev({
      developerPage: PAGE,
      storageNamespace: 'production',
      applyDeveloperConfig: () => {},
      resetDeveloperData: () => {},
    });
    expect(q2(root, '.hud-prodsave').hidden).toBe(true);
    expect(q2(root, '.hud-devreset').hidden).toBe(false);
  });

  it('hides both when their seams are absent, which is every injected HUD in this suite', () => {
    const root = mountDev({ developerPage: PAGE, storageNamespace: 'developer' });
    expect(q2(root, '.hud-prodsave').hidden).toBe(true);
    expect(q2(root, '.hud-devreset').hidden).toBe(true);
  });
});

describe('the exports (issue #254)', () => {
  interface Saved {
    text: string;
    fileName: string;
    type: string;
  }
  interface SavedCanvas {
    image: HTMLCanvasElement;
    fileName: string;
  }
  function downloads(encode: () => Promise<void> = () => Promise.resolve()): {
    saved: Saved[];
    canvases: SavedCanvas[];
    seam: {
      saveText(text: string, fileName: string, type: string): void;
      saveCanvas(image: HTMLCanvasElement, fileName: string): Promise<void>;
    };
  } {
    const saved: Saved[] = [];
    const canvases: SavedCanvas[] = [];
    return {
      saved,
      canvases,
      seam: {
        saveText: (text, fileName, type) => void saved.push({ text, fileName, type }),
        saveCanvas: (image, fileName) => {
          canvases.push({ image, fileName });
          return encode();
        },
      },
    };
  }
  const ROUND: RoundDiagnostics = { tick: 480, roundStartTick: 1, surface: 'gameplay/playing' };
  const CAPTURE = { image: document.createElement('canvas'), width: 1280, height: 800, pixelRatio: 2 };
  const port = (over: Partial<DevExportPort> = {}): DevExportPort => ({
    round: () => ROUND,
    replay: () => null,
    captureFrame: () => CAPTURE,
    ...over,
  });
  const shotBtn = (root: HTMLElement): HTMLButtonElement => q(root, '.hud-export-screenshot');
  const diagBtn = (root: HTMLElement): HTMLButtonElement => q(root, '.hud-export-diagnostics');
  const replayBtn = (root: HTMLElement): HTMLButtonElement => q(root, '.hud-export-replay');
  // TypeScript 6's DOM types widen `hidden` to `boolean | 'until-found'` (5.x had `boolean`), and
  // these buttons are hidden through that property, so what is read back carries the wider type.
  const hiddenOf = (root: HTMLElement): (boolean | 'until-found')[] =>
    [shotBtn(root).hidden, diagBtn(root).hidden, replayBtn(root).hidden];
  /** Lets a resolved or rejected save settle before asserting on the field. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('hides all three unless the page supplies its facts AND a way to save', () => {
    const { seam } = downloads();
    const neither = mountDev();
    expect(hiddenOf(neither)).toEqual([true, true, true]);
    hud?.dispose();
    const pageOnly = mountDev({ developerPage: PAGE });
    expect(hiddenOf(pageOnly)).toEqual([true, true, true]);
    hud?.dispose();
    const saveOnly = mountDev({ developerDownloads: seam });
    expect(hiddenOf(saveOnly)).toEqual([true, true, true]);
    hud?.dispose();
    const both = mountDev({ developerPage: PAGE, developerDownloads: seam });
    expect(hiddenOf(both)).toEqual([false, false, false]);
  });

  it('Download Screenshot saves the frame the session copied, and says what it is', async () => {
    const d = downloads();
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDiagnosticsSource(() => SESSION);
    hud!.setDevExportPort(() => port());
    shotBtn(root).click();
    expect(d.canvases).toHaveLength(1);
    expect(d.canvases[0].image).toBe(CAPTURE.image);
    expect(d.canvases[0].fileName).toBe('tanks-canvas-seed4242424242-tick480-1280x800-dpr2.png');
    await settle();
    expect(out(root).value).toContain('1280x800 pixels at pixel ratio 2');
    expect(out(root).value).toContain('The HUD is not in it');
  });

  it('Download Screenshot saves nothing with no session, and says so', async () => {
    const d = downloads();
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDevExportPort(() => null);
    shotBtn(root).click();
    expect(d.canvases).toEqual([]);
    expect(out(root).value).toBe(NO_SESSION_SCREENSHOT_NOTE);
  });

  it('Download Screenshot reports a capture that throws, and saves nothing', async () => {
    const d = downloads();
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDevExportPort(() =>
      port({
        captureFrame: () => {
          throw new Error('context lost');
        },
      }),
    );
    expect(() => shotBtn(root).click()).not.toThrow();
    expect(d.canvases).toEqual([]);
    expect(out(root).value).toBe('Download Screenshot failed, so no file was saved: context lost');
  });

  it('Download Screenshot reports an encoding that fails AFTER the click returned', async () => {
    // The PNG is encoded asynchronously, so this failure arrives in a later task. A handler that
    // only caught synchronous throws would leave the field empty, looking like it had worked.
    const d = downloads(() => Promise.reject(new Error('encode refused')));
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDevExportPort(() => port());
    shotBtn(root).click();
    await settle();
    expect(out(root).value).toBe('Download Screenshot failed, so no file was saved: encode refused');
  });

  it('lives inside Developer Tools, which production UI never opens', () => {
    // Issue #254: "ordinary production UI exposes none of these actions". The pane's entry is
    // hidden without developer mode (`hud-devtools-open--hidden`), and these sit inside it.
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, { developerPage: PAGE, developerDownloads: downloads().seam });
    expect(diagBtn(root).closest('.hud-devtools')).not.toBeNull();
    expect(replayBtn(root).closest('.hud-devtools')).not.toBeNull();
    expect(q(root, '.hud-devtools-open').classList.contains('hud-devtools-open--hidden')).toBe(true);
  });

  it('Download Diagnostics saves one JSON file of the live session and round, and says so', async () => {
    const d = downloads();
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDiagnosticsSource(() => SESSION);
    hud!.setDevExportPort(() => port());
    diagBtn(root).click();
    expect(d.saved).toHaveLength(1);
    expect(d.saved[0].fileName).toBe('tanks-diagnostics-seed4242424242-tick480.json');
    expect(d.saved[0].type).toBe('application/json');
    const file = JSON.parse(d.saved[0].text);
    expect(file.session).toEqual(SESSION);
    expect(file.round).toEqual(ROUND);
    expect(file.build).toEqual(PAGE.build);
    expect(out(root).value).toContain(`Saved ${d.saved[0].fileName}`);
  });

  it('reads the round at press time, not when the port was registered', async () => {
    const d = downloads();
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDiagnosticsSource(() => SESSION);
    let tick = 10;
    hud!.setDevExportPort(() => port({ round: () => ({ ...ROUND, tick }) }));
    diagBtn(root).click();
    tick = 99;
    diagBtn(root).click();
    expect(d.saved.map((s) => JSON.parse(s.text).round.tick)).toEqual([10, 99]);
  });

  it('saves a no-session file without a round when nothing is live', async () => {
    const d = downloads();
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDiagnosticsSource(() => null);
    hud!.setDevExportPort(() => null);
    diagBtn(root).click();
    expect(d.saved.map((s) => s.fileName)).toEqual(['tanks-diagnostics-no-session.json']);
    expect(JSON.parse(d.saved[0].text).round).toBeNull();
  });

  it('Download Replay saves NOTHING when recording is off, and says how to turn it on', async () => {
    const d = downloads();
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDevExportPort(() => port({ replay: () => null }));
    replayBtn(root).click();
    expect(d.saved).toEqual([]);
    expect(out(root).value).toContain('replay=1');
  });

  it('Download Replay saves nothing with no session, and says so', async () => {
    const d = downloads();
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDevExportPort(() => null);
    replayBtn(root).click();
    expect(d.saved).toEqual([]);
    expect(out(root).value).toBe(NO_SESSION_REPLAY_NOTE);
  });

  it('Download Replay saves the recorded trace as it is', async () => {
    const d = downloads();
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    const world = createWorldFor(arenaById('arena-01'), 5, { lives: 3 });
    const rec = createRecordingInput(
      { sample: () => [{ move: { x: 1, y: 0 }, aim: { x: 0, y: 1 }, fire: true, mine: false }] },
      replayMetaFor(world, 'arena-01', false),
    );
    for (let i = 0; i < 3; i++) rec.sample();
    hud!.setDevExportPort(() => port({ replay: () => rec.trace() }));
    replayBtn(root).click();
    expect(d.saved).toHaveLength(1);
    expect(JSON.parse(d.saved[0].text)).toEqual(rec.trace());
    expect(out(root).value).toContain('3 ticks');
  });

  it('REPORTS a failure in the field instead of throwing, and saves nothing', async () => {
    // Issue #254: "export failures are reported without mutating game or persistence state".
    // The port has no writer to call; what this pins is that the failure reaches the field and
    // the click handler does not throw out of the pane.
    const d = downloads();
    const root = await mountDevLoaded({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDiagnosticsSource(() => SESSION);
    hud!.setDevExportPort(() =>
      port({
        round: () => {
          throw new Error('round unreadable');
        },
      }),
    );
    expect(() => diagBtn(root).click()).not.toThrow();
    expect(d.saved).toEqual([]);
    expect(out(root).value).toContain('Download Diagnostics failed, so no file was saved: round unreadable');
  });

  it('reports a download that throws, too', async () => {
    const root = await mountDevLoaded({
      developerPage: PAGE,
      developerDownloads: {
        saveText: () => {
          throw new Error('blocked');
        },
        saveCanvas: () => Promise.resolve(),
      },
    });
    hud!.setDiagnosticsSource(() => SESSION);
    hud!.setDevExportPort(() => port());
    expect(() => diagBtn(root).click()).not.toThrow();
    expect(out(root).value).toContain('failed, so no file was saved: blocked');
  });

  describe('pressed before the developer modules have loaded (issue #1014)', () => {
    // The pane's modules load when it opens, so a press can land before them. It reads the
    // session at the press and saves once they are there; what changes in between must not
    // reach the file. Each case opens the pane and presses in the same task, so the press
    // really is before the load -- asserted, not assumed.

    it('Download Diagnostics saves the session and round as they were at the press', async () => {
      // Negative controls: the diagnostics input, and the round, read once the load lands.
      const d = downloads();
      const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
      let live: SessionDiagnostics = SESSION;
      let tick = 10;
      hud!.setDiagnosticsSource(() => live);
      hud!.setDevExportPort(() => port({ round: () => ({ ...ROUND, tick }) }));
      const escaped = await escapedDuring(() => {
        q<HTMLButtonElement>(root, '.hud-devtools-open').click();
        diagBtn(root).click();
        expect(d.saved, 'saved before the load').toEqual([]);
        live = { ...SESSION, seed: 99 };
        tick = 99;
      });
      expect(escaped).toEqual([]);
      expect(d.saved).toHaveLength(1);
      const file = JSON.parse(d.saved[0].text);
      expect(file.session.seed).toBe(4242424242);
      expect(file.round.tick).toBe(10);
      expect(out(root).value).toContain(`Saved ${d.saved[0].fileName}`);
    });

    it('Download Screenshot saves the frame captured at the press, named from the round then', async () => {
      // A frame captured once the modules had loaded would be a later one than the developer
      // saw. Negative controls: the frame captured, and the round read, once the load lands.
      const d = downloads();
      const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
      hud!.setDiagnosticsSource(() => SESSION);
      const atPress = { ...CAPTURE, image: document.createElement('canvas') };
      const later = { ...CAPTURE, image: document.createElement('canvas') };
      let frame = atPress;
      let tick = 480;
      const captured: HTMLCanvasElement[] = [];
      hud!.setDevExportPort(() =>
        port({
          round: () => ({ ...ROUND, tick }),
          captureFrame: () => {
            captured.push(frame.image);
            return frame;
          },
        }),
      );
      const escaped = await escapedDuring(() => {
        q<HTMLButtonElement>(root, '.hud-devtools-open').click();
        shotBtn(root).click();
        expect(captured, 'the frame is captured at the press').toHaveLength(1);
        expect(d.canvases, 'saved before the load').toEqual([]);
        frame = later;
        tick = 999;
      });
      expect(escaped).toEqual([]);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toBe(atPress.image);
      expect(d.canvases).toHaveLength(1);
      expect(d.canvases[0].image).toBe(atPress.image);
      expect(d.canvases[0].fileName).toBe('tanks-canvas-seed4242424242-tick480-1280x800-dpr2.png');
      expect(out(root).value).toContain('1280x800 pixels at pixel ratio 2');
    });

    it('Download Replay saves the trace as it was at the press', async () => {
      // Negative control: the trace read once the load lands, which carries the tick recorded
      // in between.
      const d = downloads();
      const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
      const world = createWorldFor(arenaById('arena-01'), 5, { lives: 3 });
      const rec = createRecordingInput(
        { sample: () => [{ move: { x: 1, y: 0 }, aim: { x: 0, y: 1 }, fire: true, mine: false }] },
        replayMetaFor(world, 'arena-01', false),
      );
      for (let i = 0; i < 3; i++) rec.sample();
      const atPress = rec.trace();
      hud!.setDevExportPort(() => port({ replay: () => rec.trace() }));
      const escaped = await escapedDuring(() => {
        q<HTMLButtonElement>(root, '.hud-devtools-open').click();
        replayBtn(root).click();
        expect(d.saved, 'saved before the load').toEqual([]);
        rec.sample();
      });
      expect(escaped).toEqual([]);
      expect(d.saved).toHaveLength(1);
      expect(JSON.parse(d.saved[0].text)).toEqual(atPress);
      expect(out(root).value).toContain('3 ticks');
    });
  });
});

describe('the developer modules load when the pane opens (issue #1014)', () => {
  // `dev-actions`, `dev-diagnostics` and `dev-exports` are loaded by dynamic imports when
  // Developer Tools opens, so an ordinary page never downloads them. Every case above starts
  // with them loaded (`mountDevLoaded`); these pin the window before they land and what it
  // must not change.

  it('nothing loads them before the pane opens: a press after every import has settled still waits', async () => {
    // Negative control: loading them at construction, which answers this press in its own
    // task. The press then loads them itself and is answered, so the absence is not because
    // nothing ever could be.
    const root = mountDev({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    await settled();
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).value, 'answered before any load').toBe('');
    await settled();
    expect(out(root).value).toContain('- Seed: 4242424242');
  });

  it('THE CONTROL: opening the pane loads them, so a press once that has settled is answered at once', async () => {
    // Without this the case above could pass because nothing loads them at all. Negative
    // control: an open that does not start the load.
    const root = mountDev({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    q<HTMLButtonElement>(root, '.hud-devtools-open').click();
    await settled();
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).value).toContain('- Seed: 4242424242');
  });

  it('the markup names each action exactly as the catalogue does, one button per entry', () => {
    // The catalogue is the single source of the wording. The markup carries the labels so a
    // button has an accessible name before the catalogue has loaded, and this is what keeps the
    // two from drifting -- a renamed action leaving a stale word on a button that dispatches
    // the new id. Read off the HUD as constructed, before any load. Negative controls: a stale
    // word in the markup, and an action renamed in the catalogue alone.
    const root = mountDev();
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-devact'));
    expect(buttons.map((b) => b.dataset.action).sort()).toEqual(Object.keys(DEV_ACTIONS).sort());
    for (const b of buttons) {
      const id = b.dataset.action as keyof typeof DEV_ACTIONS;
      expect(b.textContent, id).toBe(DEV_ACTIONS[id].label);
    }
  });

  it('arms each action with its own catalogue confirm label, and restores its own label on disarm', async () => {
    // Each in turn: arming the next disarms the one before, through `restingLabel`. The case
    // above `arming one action DISARMS another` restores only the one action whose label a
    // wrong lookup would happen to produce. Negative controls: the confirm label, and the
    // resting label, read from one catalogue entry for every button.
    const root = await mountDevLoaded({ developerPage: PAGE });
    const rebuilt: Array<number | null> = [];
    hud!.setDevActionPort(() => livePort(rebuilt));
    const btn = (id: string): HTMLButtonElement => q(root, `.hud-devact[data-action="${id}"]`);
    let previous: keyof typeof DEV_ACTIONS | null = null;
    for (const id of ['restart-same-seed', 'reroll-seed', 'restart-round', 'restart-same-seed'] as const) {
      btn(id).click();
      expect(btn(id).textContent, `${id} armed`).toBe(DEV_ACTIONS[id].confirmLabel);
      if (previous !== null) {
        expect(btn(previous).textContent, `${previous} disarmed`).toBe(DEV_ACTIONS[previous].label);
      }
      previous = id;
    }
    expect(rebuilt).toEqual([]);
  });

  it('Copy pressed before the load reports the session as it was at the press', async () => {
    // Negative control: the diagnostics input read once the load lands.
    const root = mountDev({ developerPage: PAGE });
    let live: SessionDiagnostics = SESSION;
    hud!.setDiagnosticsSource(() => live);
    const escaped = await escapedDuring(() => {
      q<HTMLButtonElement>(root, '.hud-devtools-open').click();
      q<HTMLButtonElement>(root, '.hud-diag-copy').click();
      expect(out(root).value, 'answered before the load').toBe('');
      live = { ...SESSION, seed: 99 };
    });
    expect(escaped).toEqual([]);
    expect(out(root).value).toContain('- Seed: 4242424242');
  });

  it('Pin pressed before the load offers the seed that was running at the press', async () => {
    // Negative control: the diagnostics input read once the load lands.
    const root = mountDev({ developerPage: PAGE });
    let live: SessionDiagnostics = SESSION;
    hud!.setDiagnosticsSource(() => live);
    const escaped = await escapedDuring(() => {
      q<HTMLButtonElement>(root, '.hud-devtools-open').click();
      q<HTMLButtonElement>(root, '.hud-diag-pin').click();
      expect(out(root).value, 'answered before the load').toBe('');
      live = { ...SESSION, seed: 99 };
    });
    expect(escaped).toEqual([]);
    expect(out(root).value).toBe('/tanks/?dev=1&seed=4242424242');
  });

  describe('Copy, when the clipboard refuses', () => {
    // An answer that waited on the load can outlive the press's user activation, and a browser
    // then refuses the clipboard. jsdom has no clipboard, so one that refuses is installed.
    let before: PropertyDescriptor | undefined;
    afterEach(() => {
      if (before === undefined) delete (navigator as { clipboard?: unknown }).clipboard;
      else Object.defineProperty(navigator, 'clipboard', before);
    });
    /**
     * Installs a clipboard whose every write is refused, and returns the writes it was asked for.
     * A plain function, not `vi.fn`: a mock attaches its own handlers to a promise it returns
     * (to record how it settled), which would mark the refusal handled and hide the leak.
     */
    function refuseClipboard(): string[] {
      before = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      const asked: string[] = [];
      const writeText = (text: string): Promise<void> => {
        asked.push(text);
        return Promise.reject(new DOMException('No user activation', 'NotAllowedError'));
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      return asked;
    }

    it('pressed before the load still selects its report when it lands, and the refusal escapes nowhere', async () => {
      // Negative controls: a selection made only once the clipboard accepts, and a refusal left
      // unhandled.
      const asked = refuseClipboard();
      const root = mountDev({ developerPage: PAGE });
      hud!.setDiagnosticsSource(() => SESSION);
      const escaped = await escapedDuring(() => {
        q<HTMLButtonElement>(root, '.hud-devtools-open').click();
        q<HTMLButtonElement>(root, '.hud-diag-copy').click();
        expect(out(root).value, 'answered before the load').toBe('');
      });
      expect(escaped).toEqual([]);
      const field = out(root);
      expect(asked, 'the clipboard was tried, with the report').toEqual([field.value]);
      expect(field.value).toContain('- Seed: 4242424242');
      expect(document.activeElement).toBe(field);
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe(field.value.length);
    });
  });

  it('a press answered after the pane closed writes nothing into the field the close cleared', async () => {
    // Negative controls: a close that spends no generation, and an answer that ignores it.
    const root = mountDev({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    q<HTMLButtonElement>(root, '.hud-devtools-open').click();
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    q<HTMLButtonElement>(root, '.hud-devtools-back').click();
    await settled();
    expect(out(root).value).toBe('');
    expect(shown(out(root))).toBe(false);
  });

  it('a teardown during the load writes nothing into the discarded field', async () => {
    // `dispose` never runs the pane's close. Negative control: a teardown that spends no
    // generation.
    const root = mountDev({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    q<HTMLButtonElement>(root, '.hud-devtools-open').click();
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    const field = out(root);
    hud!.dispose();
    hud = null;
    await settled();
    expect(field.value).toBe('');
  });

  it('offers the actions only once their catalogue has loaded, even with a round running', async () => {
    // Until then there is no confirm label to arm one with. Negative control: availability that
    // ignores the load, which offers them before it.
    const root = mountDev({ developerPage: PAGE });
    hud!.setDevActionPort(() => livePort());
    const reroll = q<HTMLButtonElement>(root, '.hud-devact[data-action="reroll-seed"]');
    expect(reroll.hidden, 'offered before the pane opened').toBe(true);
    q<HTMLButtonElement>(root, '.hud-devtools-open').click();
    expect(reroll.hidden, 'offered before the load landed').toBe(true);
    await settled();
    expect(reroll.hidden, 'still not offered once it landed').toBe(false);
  });

  it('an action clicked before its catalogue loads throws nothing, arms nothing and rebuilds nothing', async () => {
    // It is hidden until then, so only a programmatic click can arrive. Negative control: the
    // click handler with no guard, which reads a catalogue that is not there.
    const root = mountDev({ developerPage: PAGE });
    const rebuilt: Array<number | null> = [];
    hud!.setDevActionPort(() => livePort(rebuilt));
    const reroll = q<HTMLButtonElement>(root, '.hud-devact[data-action="reroll-seed"]');
    const escaped = await escapedDuring(() => {
      reroll.click();
      reroll.click();
    });
    expect(escaped).toEqual([]);
    expect(reroll.textContent).toBe(DEV_ACTIONS['reroll-seed'].label);
    expect(reroll.classList.contains('hud-danger--armed')).toBe(false);
    expect(rebuilt).toEqual([]);
  });

  it('a Use Production Save armed while the load is in flight is still armed when it lands', async () => {
    // The load landing reveals the actions; it is not a lapse. Negative control: the landing
    // re-running the whole availability refresh, which disarms whenever no round exists.
    const root = mountDev({
      developerPage: PAGE,
      storageNamespace: 'developer',
      applyDeveloperConfig: () => {},
    });
    q<HTMLButtonElement>(root, '.hud-devtools-open').click();
    q<HTMLButtonElement>(root, '.hud-prodsave').click();
    expect(q(root, '.hud-prodsave').textContent).toBe('Reload onto the REAL save?');
    await settled();
    expect(q(root, '.hud-prodsave').textContent).toBe('Reload onto the REAL save?');
  });

  it('an armed action lapses after 4 seconds, back to its catalogue label, and the next press arms again', async () => {
    // Negative control: an arm that never lapses.
    const root = await mountDevLoaded({ developerPage: PAGE });
    const rebuilt: Array<number | null> = [];
    hud!.setDevActionPort(() => livePort(rebuilt));
    const reroll = q<HTMLButtonElement>(root, '.hud-devact[data-action="reroll-seed"]');
    vi.useFakeTimers();
    try {
      reroll.click();
      vi.advanceTimersByTime(3999);
      expect(reroll.textContent).toBe(DEV_ACTIONS['reroll-seed'].confirmLabel);
      vi.advanceTimersByTime(1);
      expect(reroll.textContent).toBe(DEV_ACTIONS['reroll-seed'].label);
      reroll.click();
      expect(rebuilt).toEqual([]);
      expect(reroll.textContent).toBe(DEV_ACTIONS['reroll-seed'].confirmLabel);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an armed action lapses when another pane opens over it, so the press on return arms again', async () => {
    // Read the moment Configuration opens: every Back re-enters its origin through `setState`,
    // which disarms on its own, so after one the layer's own disarm could not be told apart.
    // Negative control: opening a layer that keeps the arm.
    const root = await mountDevLoaded({ developerPage: PAGE });
    const rebuilt: Array<number | null> = [];
    hud!.setDevActionPort(() => livePort(rebuilt));
    const reroll = q<HTMLButtonElement>(root, '.hud-devact[data-action="reroll-seed"]');
    q<HTMLButtonElement>(root, '.hud-devtools-open').click();
    reroll.click();
    expect(reroll.textContent).toBe(DEV_ACTIONS['reroll-seed'].confirmLabel);
    q<HTMLButtonElement>(root, '.hud-devcfg-open').click();
    expect(reroll.textContent).toBe(DEV_ACTIONS['reroll-seed'].label);
    q<HTMLButtonElement>(root, '.hud-devcfg-back').click();
    reroll.click();
    expect(rebuilt).toEqual([]);
  });

  describe('a load that fails', () => {
    // `dev-exports` made to fail as a stale chunk name or a dropped connection would, mocked
    // per case and restored after, so no other case loads a failing module. Both the mock and
    // its removal are flushed by an import of their own before the pane opens: Vitest resolves
    // a queued `doMock` on the next import, and the pane's three imports start together, so
    // only the first would wait for it.
    afterEach(async () => {
      vi.doUnmock('./dev-exports');
      vi.resetModules();
      await import('./dev-exports');
    });
    async function failLoads(): Promise<void> {
      vi.doMock('./dev-exports', () => {
        throw new Error('offline');
      });
      vi.resetModules();
      await import('./dev-exports').catch(() => {});
    }
    async function restoreLoads(): Promise<void> {
      vi.doUnmock('./dev-exports');
      vi.resetModules();
      await import('./dev-exports');
    }

    it('is reported in the output field when the pane opens, and the next open loads them', async () => {
      // Negative controls: no rejection handler (an unhandled rejection, and a field that says
      // nothing), and a failed load kept, so the next open fails again without trying.
      const root = mountDev({ developerPage: PAGE });
      hud!.setDiagnosticsSource(() => SESSION);
      await failLoads();
      const escaped = await escapedDuring(() => q<HTMLButtonElement>(root, '.hud-devtools-open').click());
      expect(escaped).toEqual([]);
      expect(shown(out(root))).toBe(true);
      expect(out(root).value).toMatch(/^The developer tools could not be loaded \(.*\)\. Reload the page to try again\.$/);
      await restoreLoads();
      q<HTMLButtonElement>(root, '.hud-devtools-back').click();
      q<HTMLButtonElement>(root, '.hud-devtools-open').click();
      await settled();
      q<HTMLButtonElement>(root, '.hud-diag-copy').click();
      expect(out(root).value).toContain('- Seed: 4242424242');
    });

    it('after the pane closed reports nothing into it', async () => {
      // Negative control: the failure path ignoring the generation.
      const root = mountDev({ developerPage: PAGE });
      await failLoads();
      q<HTMLButtonElement>(root, '.hud-devtools-open').click();
      q<HTMLButtonElement>(root, '.hud-devtools-back').click();
      await settled();
      expect(out(root).value).toBe('');
      expect(shown(out(root))).toBe(false);
    });
  });
});
