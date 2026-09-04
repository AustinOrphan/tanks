import { describe, it, expect } from 'vitest';

/**
 * The boundary issue #324 draws, measured against the tree rather than asserted in prose.
 *
 * `hud.ts` classifies all 67 `Hud` members into `HudFrameKey` / `RouteHudKey` /
 * `GameplayHudKey`, and a type-level guard there already fails the build if a member is
 * added without an owner. That guard cannot see CALL SITES, though, and call sites are
 * where the actual violation lives: `loop.ts` -- the gameplay session -- reached straight
 * into Settings sliders, the Records table and the Main Menu's level list.
 *
 * So this pins the violations as an EXPLICIT, SHRINKING list. Every remaining step of
 * #324 deletes entries from `SESSION_REACHES_ROUTE_UI`; nothing may add one. That makes
 * the migration's progress a number a reviewer can read, and -- more importantly -- makes
 * a NEW violation fail immediately rather than being absorbed into a boundary everyone
 * already believes is broken. One entry is left, and it belongs to step S7.
 *
 * Source is read with the same `import.meta.glob(..., '?raw')` scan
 * `dependency-direction.test.ts` uses, for the same reason: the question is what the file
 * SAYS, which importing it cannot answer.
 */
const rawModules = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const loopSource = rawModules['./loop.ts'];
const hudSource = rawModules['./hud.ts'];

/**
 * Members `loop.ts` calls that the classification says belong to an application route or
 * to the page frame.
 *
 * Each entry names the step of #324 that removes it, so the list reads as a plan rather
 * than as a list of complaints. These are NOT acceptable: they are the debt, written down.
 */
const SESSION_REACHES_ROUTE_UI: Readonly<Record<string, string>> = {
  // S7 -- the host pushes this when it hands a session the slot.
  setRelaunchTarget: 'S7',
};

/**
 * The one frame member a session legitimately holds. The frame owns the toast STACK; a
 * session is lent the writer for the gamepad connect/disconnect edges, which are neither
 * route changes nor gameplay events but do happen mid-match.
 *
 * `dispose` is deliberately absent: issue #468 already moved HUD teardown to the page, and
 * `loop.ts` only mentions it in a comment explaining that it used to do so.
 */
const FRAME_MEMBERS_THE_SESSION_MAY_CALL = ['showToast'];

/**
 * Every `hud.<member>(` a file actually CALLS, with comments removed first.
 *
 * Both comment forms, and both are load-bearing rather than defensive. `loop.ts` quotes
 * `hud.setState('playing')` in a line comment while never calling it, and its teardown
 * block comment says the session "used to be ... `hud.dispose()`" -- a scanner that read
 * either would report a frame member being called from the session and force a spurious
 * entry into the debt list below, which is exactly the kind of noise that makes a
 * boundary test stop being believed.
 */
function hudCallsIn(source: string): Set<string> {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
  return new Set([...code.matchAll(/\bhud\.([a-zA-Z][a-zA-Z0-9]*)\(/g)].map((m) => m[1]));
}

/**
 * The member names inside one exported key union in hud.ts's source.
 *
 * Comments are stripped BEFORE the terminating `;` is looked for, and that is not
 * fussiness: these unions are documented inline, and prose contains semicolons. Slicing
 * to the first raw `;` truncated `HudFrameKey` at the word "showing;" and returned an
 * EMPTY set -- which every assertion below then passed vacuously. A parser that silently
 * returns nothing is worse here than one that throws, so the caller checks the size.
 */
function keysOfUnion(name: string): Set<string> {
  const start = hudSource.indexOf(`export type ${name} =`);
  expect(start, `${name} is declared in hud.ts`).toBeGreaterThan(-1);
  const code = hudSource
    .slice(start)
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
  const body = code.slice(0, code.indexOf(';'));
  const keys = new Set([...body.matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map((m) => m[1]));
  expect(keys.size, `${name} parsed to at least one member`).toBeGreaterThan(0);
  return keys;
}

describe('HUD ownership boundary (issue #324)', () => {
  it('classifies every member exactly once, into three roles that cover the interface', () => {
    // The type-level guard in hud.ts proves EXHAUSTIVENESS at compile time. This proves
    // the other half, which a `Pick` cannot: that the roles do not quietly overlap. One
    // deliberate exception is asserted by name below rather than tolerated by a loose
    // comparison, so a second shared member has to be argued for in a diff.
    const frame = keysOfUnion('HudFrameKey');
    const route = keysOfUnion('RouteHudKey');
    const gameplay = keysOfUnion('GameplayHudKey');
    const overlaps = [...gameplay].filter((k) => frame.has(k) || route.has(k));
    expect(overlaps, 'showToast is the ONE member deliberately in two roles').toEqual([
      'showToast',
    ]);
    expect([...route].filter((k) => frame.has(k))).toEqual([]);
    // Counts stated beside the population they came from: 67 members, of which showToast
    // is counted twice, so the roles sum to 68. Four FEWER than the 72 that stood before
    // issue #324's step S6, and the arithmetic is the whole of that step: five per-kind
    // status members (`setLives`, `setEnemiesRemaining`, `setLevel`, `setSessionKind`,
    // `setVersusStocks`) left, one discriminated `setStatus` arrived, and every one of
    // those five was gameplay-owned, so the drop lands entirely on `gameplay`.
    //
    // Growth here is not automatically a regression and neither is a fall: what these
    // numbers guard is that a member arrived or left through a diff someone read. The
    // assertion below is what pins that a session still cannot reach a route member.
    expect(frame.size + route.size + gameplay.size).toBe(68);
    expect(gameplay.size, 'what a live match may write').toBe(10);
  });

  it('the gameplay session reaches ONLY gameplay members, plus the pinned debt', () => {
    // The assertion that shrinks. `loop.ts` is the session; every application-route
    // member it calls is a place a match can repaint the Main Menu.
    const route = keysOfUnion('RouteHudKey');
    const frame = keysOfUnion('HudFrameKey');
    const called = hudCallsIn(loopSource);
    const violations = [...called]
      .filter((m) => route.has(m) || (frame.has(m) && !FRAME_MEMBERS_THE_SESSION_MAY_CALL.includes(m)))
      .sort();
    expect(violations).toEqual(Object.keys(SESSION_REACHES_ROUTE_UI).sort());
  });

  it('the debt list is live, not decorative', () => {
    // A negative control for the test above: every pinned entry must still be a real call
    // in loop.ts. Without this, an entry left behind after its step landed would sit in
    // the list forever, making the debt look larger than it is and letting a genuine
    // regression hide in the slack.
    const called = hudCallsIn(loopSource);
    for (const member of Object.keys(SESSION_REACHES_ROUTE_UI)) {
      expect(called.has(member), `${member} is pinned as debt but loop.ts no longer calls it`).toBe(
        true,
      );
    }
  });

  it('does not count a call that only appears in a comment', () => {
    // The scanner's own guard. loop.ts discusses `hud.setState('playing')` in prose at
    // its round-phase comment while never calling it -- and setState is frame-owned, so a
    // scanner that counted comments would report a violation that does not exist and
    // force a spurious entry into the debt list above.
    expect(loopSource).toContain("`hud.setState('playing')` always runs before");
    expect(hudCallsIn(loopSource).has('setState')).toBe(false);
    // ...and the block-comment half: loop.ts's teardown says it "used to be
    // `hud.dispose()`", which is the page's job since #468 and must not read as a call.
    expect(loopSource).toContain('`hud.dispose()`');
    expect(hudCallsIn(loopSource).has('dispose')).toBe(false);
    expect(hudCallsIn("hud.setStatus(s); // hud.setStats(x)\n")).toEqual(new Set(['setStatus']));
    expect(hudCallsIn('/* hud.setSkin(a) */ hud.setStatus(s);')).toEqual(new Set(['setStatus']));
  });
});
