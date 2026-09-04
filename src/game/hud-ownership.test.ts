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
 * So this pins the violations as an EXPLICIT, SHRINKING list. Every step of #324 deleted
 * entries from `SESSION_REACHES_ROUTE_UI`; nothing may add one. That made the migration's
 * progress a number a reviewer could read, and -- more importantly -- made a NEW violation
 * fail immediately rather than being absorbed into a boundary everyone already believed
 * was broken. The list is EMPTY as of step S7, which removed the last entry
 * (`setRelaunchTarget`, now pushed by the page when it hands a session the slot).
 *
 * An empty list is a claim that has to keep being earned, so two things guard it. The
 * scan below still runs, with a planted-violation control so `[]` cannot mean "the scanner
 * stopped scanning". And step S8 made the boundary STRUCTURAL rather than merely observed:
 * `loop.ts` no longer names the `Hud` type at all -- it holds `GameplaySlot.hud`, which is
 * `hud.ts`'s own ten-member `GameplayHud` -- so a route member is not something a session
 * is trusted not to call, it is something that does not compile. The last test in this
 * file is what keeps that true.
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
 * Each entry named the step of #324 that removed it, so the list read as a plan rather
 * than as a list of complaints. These were NOT acceptable: they were the debt, written
 * down. It is empty, and it stays empty -- an entry added here is a session reaching back
 * into the shell, and needs the argument for that in the diff rather than a line in a
 * table.
 */
const SESSION_REACHES_ROUTE_UI: Readonly<Record<string, string>> = {};

/**
 * The `hud.ts` types that carry APPLICATION-ROUTE reach, which `loop.ts` may not name.
 *
 * `Hud` is the whole 67-member interface and `RouteHud` is the route-owned `Pick` of it;
 * either one in the session's hands puts the Settings sliders, the Levels grid and the
 * Records tables back within reach. The gameplay vocabulary (`GameplayHud`,
 * `GameplayStatus`, `VersusStock`) and the frame's `HudSurface` are deliberately not
 * listed -- a session states its status and the page's surface projection is derived from
 * a route, and neither is a way into a route surface.
 *
 * `createHud` is not a type and is not a violation: it is the browser wiring
 * `createBrowserDeps` binds for `RouteHostDeps`, and since step S8 it is absent from the
 * `GameDeps` a session receives, so `startGameWith` cannot call it.
 */
const ROUTE_REACHING_HUD_TYPES = ['Hud', 'RouteHud'];

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
 * Does comment-stripped source name this type, as a whole identifier?
 *
 * Word-bounded on both sides, which is the whole subtlety: `createHud`, `GameplayHud`,
 * `HudSurface` and `BlockedFireHudCue` all contain the letters `Hud` and all of them stay
 * in `loop.ts` legitimately. Comments go first for the same reason `hudCallsIn` strips
 * them -- this codebase explains its boundaries in prose, and a guard that read the
 * explanation as a breach would be reporting on documentation.
 */
function namesType(source: string, name: string): boolean {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
  return new RegExp(`\\b${name}\\b`).test(code);
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

  /** Every route/frame member a source calls that the session is not entitled to. */
  function violationsIn(source: string): string[] {
    const route = keysOfUnion('RouteHudKey');
    const frame = keysOfUnion('HudFrameKey');
    return [...hudCallsIn(source)]
      .filter((m) => route.has(m) || (frame.has(m) && !FRAME_MEMBERS_THE_SESSION_MAY_CALL.includes(m)))
      .sort();
  }

  it('the gameplay session reaches ONLY gameplay members: the debt list is empty', () => {
    // The assertion that shrank to nothing. `loop.ts` is the session; every
    // application-route member it calls is a place a match can repaint the Main Menu.
    expect(violationsIn(loopSource)).toEqual(Object.keys(SESSION_REACHES_ROUTE_UI).sort());
    expect(Object.keys(SESSION_REACHES_ROUTE_UI), 'issue #324 finished the migration').toEqual([]);
  });

  it('would still report a violation: the empty list is measured, not assumed', () => {
    // The negative control the emptied list needs. `toEqual([])` is satisfied just as well
    // by a scanner that stopped finding calls -- a renamed local, a changed regex, an
    // import shape the strip mishandles -- as by a session that stopped making them. So
    // the same classifier runs over source that DOES violate the boundary, in each of the
    // two shapes it can: a route member and a non-lent frame member.
    //
    // Source strings rather than a mutated copy of loop.ts, because what is under test
    // here is the classifier, and a fixture that named a real line of production would
    // start failing for reasons that have nothing to do with it.
    expect(violationsIn('hud.setLevelSelect(3, 9);\n')).toEqual(['setLevelSelect']);
    expect(violationsIn('hud.setStatus(s);\nhud.setState("main-menu");\n')).toEqual(['setState']);
    // ...and the lent frame member is NOT a violation, which is what stops the control
    // above from being a test that simply flags everything.
    expect(violationsIn("hud.showToast('Gamepad connected');\n")).toEqual([]);
  });

  it('names no application-route HUD type at all (issue #324, step S8)', () => {
    // THE STRUCTURAL HALF, and the reason the debt list can stay empty without anyone
    // watching it. The call scan above reports what `loop.ts` does today; this reports
    // what it is ABLE to do. Since step S8 the session holds `GameplaySlot.hud` -- a
    // ten-member `GameplayHud` facade -- and `GameDeps` no longer carries the HUD factory,
    // so there is no expression in the file whose type is a whole `Hud`. Reaching a route
    // member is a compile error rather than a convention.
    //
    // Read off the source rather than the types because that is the question: `tsc` proves
    // today's code compiles, and cannot say that the NEXT edit will not simply import the
    // interface back and hold one.
    for (const type of ROUTE_REACHING_HUD_TYPES) {
      expect(
        namesType(loopSource, type),
        `loop.ts names the ${type} type; a gameplay session must not hold one`,
      ).toBe(false);
    }
    // NON-VACUITY: the scanner finds these types where they legitimately live, so a `false`
    // above means "loop.ts does not name it" rather than "the scanner never matches".
    expect(namesType(rawModules['./route-host.ts'], 'Hud')).toBe(true);
    // ...and it is not fooled by the names that merely CONTAIN one of them: `createHud`,
    // `GameplayHud`, `HudSurface` and `BlockedFireHudCue` are all still in loop.ts.
    expect(namesType('const x: GameplayHud = h; createHud(root); type S = HudSurface;', 'Hud')).toBe(
      false,
    );
    expect(namesType('let c: BlockedFireHudCue;', 'Hud')).toBe(false);
    // ...nor by prose, which discusses the interface by name throughout this codebase.
    expect(namesType('// the whole Hud is the page\'s\nconst x = 1;', 'Hud')).toBe(false);
    expect(namesType('/* a session must not hold a Hud */', 'Hud')).toBe(false);
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
