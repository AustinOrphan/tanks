// @vitest-environment jsdom
//
// The developer diagnostics CONTROLS (issue #247) -- the half `dev-diagnostics.test.ts` does
// not cover: whether the pane offers them at all, what they write, and what Pin is forbidden
// from doing. The formatting is tested against the pure module; this file is about wiring.
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud } from './hud';
import type { SessionDiagnostics } from './dev-diagnostics';

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
