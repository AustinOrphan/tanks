// @vitest-environment jsdom
//
// The developer diagnostics CONTROLS (issue #247) -- the half `dev-diagnostics.test.ts` does
// not cover: whether the pane offers them at all, what they write, and what Pin is forbidden
// from doing. The formatting is tested against the pure module; this file is about wiring.
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud } from './hud';
import type { SessionDiagnostics } from './dev-diagnostics';
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
  it('reports the live seed, and the field is only shown once there is something in it', () => {
    const root = mountDev({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    expect(shown(out(root))).toBe(false);
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(shown(out(root))).toBe(true);
    expect(out(root).value).toContain('- Seed: 4242424242');
    expect(out(root).value).toContain('- Build: abc1234');
    expect(out(root).value).toContain('- URL: /tanks/?dev=1');
  });

  it('READS THE SOURCE AT PRESS TIME, not when it was registered', () => {
    // The load-bearing one. `loop.ts` rebuilds the world on every level change and every
    // restart, and the seed changes with it -- so a HUD that had snapshotted the source's
    // value at registration would report the session's FIRST world for the rest of its life,
    // which is the one number this whole feature exists to get right.
    const root = mountDev({ developerPage: PAGE });
    let live: SessionDiagnostics = SESSION;
    hud!.setDiagnosticsSource(() => live);
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).value).toContain('- Seed: 4242424242');
    live = { ...SESSION, seed: 99 };
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).value).toContain('- Seed: 99');
  });

  it('says there is no session when nothing is live, rather than reporting a seed', () => {
    // `route-host.ts` returns `null` from the trampoline whenever no session holds the slot,
    // which is the state the developer pane is usually opened in -- from the main menu.
    const root = mountDev({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => null);
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).value).toContain('none simulating');
    expect(out(root).value).not.toContain('- Seed:');
  });

  it('selects the text it wrote, so the keyboard copy path works without a clipboard', () => {
    // The async Clipboard API is origin- and permission-gated and absent on a file:// page.
    // Selecting is the path that always works, and the self-test's Copy already relies on it.
    const root = mountDev({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    q<HTMLButtonElement>(root, '.hud-diag-copy').click();
    expect(out(root).selectionStart).toBe(0);
    expect(out(root).selectionEnd).toBe(out(root).value.length);
  });
});

describe('Pin Current Seed offers a URL and changes nothing', () => {
  it('writes a URL carrying the live seed', () => {
    const root = mountDev({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => SESSION);
    q<HTMLButtonElement>(root, '.hud-diag-pin').click();
    expect(out(root).value).toBe('/tanks/?dev=1&seed=4242424242');
  });

  it('DOES NOT NAVIGATE, and does not ask the page to apply anything', () => {
    // "Seed pinning does not change the current world before the user applies/reloads" is
    // this issue's sharpest criterion, and this is the assertion that can fail for it: the
    // HUD is given the very seam that WOULD navigate -- the configuration menu's
    // `applyDeveloperConfig` -- and pressing Pin must not reach for it. A handler that
    // "helpfully" applied the pinned URL would reload the page and destroy the world whose
    // seed was being pinned, which is the opposite of the point.
    const applied: string[] = [];
    const root = mountDev({ developerPage: PAGE, applyDeveloperConfig: (s) => applied.push(s) });
    hud!.setDiagnosticsSource(() => SESSION);
    q<HTMLButtonElement>(root, '.hud-diag-pin').click();
    expect(applied).toEqual([]);
  });

  it('does not disturb the snapshot the session handed it', () => {
    // The same guarantee one layer up from `dev-diagnostics.test.ts`'s own version: the
    // record the getter returned is byte-identical after the press, so a future handler that
    // started writing back through the snapshot fails here.
    const root = mountDev({ developerPage: PAGE });
    const session = { ...SESSION };
    const before = JSON.stringify(session);
    hud!.setDiagnosticsSource(() => session);
    q<HTMLButtonElement>(root, '.hud-diag-pin').click();
    expect(JSON.stringify(session)).toBe(before);
  });

  it('says why there is nothing to pin when no session is live', () => {
    const root = mountDev({ developerPage: PAGE });
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

  it('offers all three, labelled from the catalogue', () => {
    const root = mountDev({ developerPage: PAGE });
    hud!.setDevActionPort(() => fakePort().port);
    expect(Array.from(root.querySelectorAll('.hud-devact'), (b) => b.textContent)).toEqual([
      'Restart with Same Seed',
      'Reroll Seed',
      'Restart Current Round',
    ]);
  });

  it('re-asks whether a round exists every time the pane opens, not only at registration', () => {
    // THE LOAD-BEARING ONE. `route-host.ts` registers the port once, at construction, when
    // the session is still at its own title screen -- so a set-once availability would leave
    // all three controls hidden for the entire life of the page. Whether a round exists
    // changes underneath a pane that is shut.
    const root = mountDev({ developerPage: PAGE });
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

  it('hides all three with no session, and shows them once one is live', () => {
    // Distinct from the `developerPage` gate: the pane exists either way, but there is no
    // round to restart from the main menu. A control the session cannot serve is not
    // rendered, the rule Exit and both diagnostics buttons already follow.
    const root = mountDev({ developerPage: PAGE });
    expect(act(root, 'reroll-seed').hidden).toBe(true);
    hud!.setDevActionPort(() => null);
    expect(act(root, 'reroll-seed').hidden).toBe(true);
    hud!.setDevActionPort(() => fakePort({ hasRound: false }).port);
    expect(act(root, 'reroll-seed').hidden).toBe(true);
    hud!.setDevActionPort(() => fakePort().port);
    expect(act(root, 'reroll-seed').hidden).toBe(false);
  });

  it('ARMS before it fires, and the first press rebuilds nothing', () => {
    // "Cancelled confirmations make no change." The first press only changes the label; the
    // port is untouched, so a handler that fired on one press fails here rather than in a
    // playtest with a lost round.
    const root = mountDev({ developerPage: PAGE });
    const f = fakePort();
    hud!.setDevActionPort(() => f.port);
    act(root, 'reroll-seed').click();
    expect(f.calls).toEqual([]);
    expect(act(root, 'reroll-seed').textContent).toBe('Reroll, losing this round?');
    act(root, 'reroll-seed').click();
    expect(f.calls).toEqual([{ seed: null, keepLives: false }]);
  });

  it('arming one action DISARMS another, so a stray second press cannot fire the wrong one', () => {
    // The mechanism is single-slot (`armedReset`), which is what makes this true -- and the
    // label restoration is what makes it visible. Before issue #252 that restoration was a
    // two-way ternary over the two reset buttons; an armed developer action would have been
    // relabelled "Reset progress".
    const root = mountDev({ developerPage: PAGE });
    const f = fakePort();
    hud!.setDevActionPort(() => f.port);
    act(root, 'reroll-seed').click();
    act(root, 'restart-round').click();
    expect(act(root, 'reroll-seed').textContent).toBe('Reroll Seed');
    expect(act(root, 'restart-round').textContent).toBe('Restart this round?');
    expect(f.calls).toEqual([]);
  });

  it('asks for the CURRENT seed on a same-seed restart, and reports what came back', () => {
    const root = mountDev({ developerPage: PAGE });
    const f = fakePort({ seed: 4242, resolved: 4242 });
    hud!.setDevActionPort(() => f.port);
    act(root, 'restart-same-seed').click();
    act(root, 'restart-same-seed').click();
    expect(f.calls).toEqual([{ seed: 4242, keepLives: false }]);
    expect(out(root).value).toContain('now running seed 4242');
  });

  it('puts a REPRODUCTION URL beside a rerolled seed, not just the number', () => {
    // "Reroll reports an exact seed that can immediately be copied into a reproduction URL."
    // A bare number leaves the developer to build the URL; this is the same `pinnedSeedUrl`
    // Pin Current Seed uses, so the two cannot produce different URLs for one session.
    const root = mountDev({ developerPage: PAGE });
    hud!.setDiagnosticsSource(() => ({ ...SESSION, seed: 8888 }));
    hud!.setDevActionPort(() => fakePort({ resolved: 8888 }).port);
    act(root, 'reroll-seed').click();
    act(root, 'reroll-seed').click();
    expect(out(root).value).toContain('now running seed 8888');
    expect(out(root).value).toContain('/tanks/?dev=1&seed=8888');
  });

  it('says so rather than appearing to work when the port refuses', () => {
    const root = mountDev({ developerPage: PAGE });
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
  it('is cleared and re-hidden when Developer Tools closes', () => {
    // A URL or a report left in the field is a statement about a session that may since have
    // been restarted, and the next opener would read it as current. The self-test's report
    // field is cleared on close for the same reason.
    const root = mountDev({ developerPage: PAGE });
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
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
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

  it('Download Screenshot saves nothing with no session, and says so', () => {
    const d = downloads();
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDevExportPort(() => null);
    shotBtn(root).click();
    expect(d.canvases).toEqual([]);
    expect(out(root).value).toBe(NO_SESSION_SCREENSHOT_NOTE);
  });

  it('Download Screenshot reports a capture that throws, and saves nothing', () => {
    const d = downloads();
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
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
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
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

  it('Download Diagnostics saves one JSON file of the live session and round, and says so', () => {
    const d = downloads();
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
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

  it('reads the round at press time, not when the port was registered', () => {
    const d = downloads();
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDiagnosticsSource(() => SESSION);
    let tick = 10;
    hud!.setDevExportPort(() => port({ round: () => ({ ...ROUND, tick }) }));
    diagBtn(root).click();
    tick = 99;
    diagBtn(root).click();
    expect(d.saved.map((s) => JSON.parse(s.text).round.tick)).toEqual([10, 99]);
  });

  it('saves a no-session file without a round when nothing is live', () => {
    const d = downloads();
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDiagnosticsSource(() => null);
    hud!.setDevExportPort(() => null);
    diagBtn(root).click();
    expect(d.saved.map((s) => s.fileName)).toEqual(['tanks-diagnostics-no-session.json']);
    expect(JSON.parse(d.saved[0].text).round).toBeNull();
  });

  it('Download Replay saves NOTHING when recording is off, and says how to turn it on', () => {
    const d = downloads();
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDevExportPort(() => port({ replay: () => null }));
    replayBtn(root).click();
    expect(d.saved).toEqual([]);
    expect(out(root).value).toContain('replay=1');
  });

  it('Download Replay saves nothing with no session, and says so', () => {
    const d = downloads();
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
    hud!.setDevExportPort(() => null);
    replayBtn(root).click();
    expect(d.saved).toEqual([]);
    expect(out(root).value).toBe(NO_SESSION_REPLAY_NOTE);
  });

  it('Download Replay saves the recorded trace as it is', () => {
    const d = downloads();
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
    const world = createWorldFor(arenaById('arena-01'), 5, { lives: 3 });
    const rec = createRecordingInput(
      { sample: () => [{ move: { x: 1, y: 0 }, aim: { x: 0, y: 1 }, fire: true, mine: false }] },
      replayMetaFor(world, 'arena-01'),
    );
    for (let i = 0; i < 3; i++) rec.sample();
    hud!.setDevExportPort(() => port({ replay: () => rec.trace() }));
    replayBtn(root).click();
    expect(d.saved).toHaveLength(1);
    expect(JSON.parse(d.saved[0].text)).toEqual(rec.trace());
    expect(out(root).value).toContain('3 ticks');
  });

  it('REPORTS a failure in the field instead of throwing, and saves nothing', () => {
    // Issue #254: "export failures are reported without mutating game or persistence state".
    // The port has no writer to call; what this pins is that the failure reaches the field and
    // the click handler does not throw out of the pane.
    const d = downloads();
    const root = mountDev({ developerPage: PAGE, developerDownloads: d.seam });
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

  it('reports a download that throws, too', () => {
    const root = mountDev({
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
});
