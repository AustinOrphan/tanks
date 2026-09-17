import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  LAYOUTS,
  capturePaths,
  classifyPair,
  compareExitCode,
  compareManifests,
  mediaSignature,
  select,
  sweepManifest,
  viewportQueries,
} from './sweep-plan.mjs';
import { SCREEN_STATES } from './states.mjs';

const HUD_CSS = readFileSync(resolve(__dirname, '../../src/game/hud.css'), 'utf8');

describe('screen sweep layout matrix (issue #766)', () => {
  it('reads the viewport queries hud.css actually uses, and skips commented-out ones', () => {
    const queries = viewportQueries(HUD_CSS);
    expect(queries.length, 'no viewport query found: the signature check would be vacuous').toBeGreaterThan(0);
    // Every one is a query the stylesheet declares outside a comment.
    for (const q of queries) expect(HUD_CSS.replace(/\s+/g, '')).toContain(`@media(${q})`);
    expect(viewportQueries('/* @media (max-width: 999px) { } */ @media (orientation: landscape) {}')).toEqual([
      'orientation:landscape',
    ]);
  });

  it('gives every layout a unique name, a real size and the risk it protects', () => {
    expect(new Set(LAYOUTS.map((l) => l.name)).size).toBe(LAYOUTS.length);
    for (const l of LAYOUTS) {
      expect(l.width > 0 && l.height > 0 && l.dpr > 0, l.name).toBe(true);
      expect(l.risk.length, `${l.name} names no risk`).toBeGreaterThan(20);
    }
  });

  it('keeps no two layouts hud.css cannot tell apart, unless one says why in sameQueriesAs', () => {
    const queries = viewportQueries(HUD_CSS);
    const bySignature = new Map<string, string[]>();
    for (const l of LAYOUTS) {
      const sig = mediaSignature(l, queries);
      bySignature.set(sig, [...(bySignature.get(sig) ?? []), l.name]);
    }
    for (const names of bySignature.values()) {
      if (names.length === 1) continue;
      const declared = names.map((name) => LAYOUTS.find((l) => l.name === name)?.sameQueriesAs);
      // Exactly one layout of the group is the reference; each other one names a layout in the group.
      expect(declared.filter((d) => d === undefined), `${names.join(', ')} meet the same queries`).toHaveLength(1);
      for (const [i, d] of declared.entries()) {
        if (d !== undefined) expect(names, `${names[i]} names ${d}, which meets different queries`).toContain(d);
      }
    }
    // Negative control: a duplicate of the first layout under a new name is caught.
    const duplicate = { ...LAYOUTS[0], name: 'copy' };
    expect(mediaSignature(duplicate, queries)).toBe(mediaSignature(LAYOUTS[0], queries));
  });

  it('decides a width query by CSS pixels and orientation by the longer side', () => {
    const queries = ['max-width:760px', 'max-width:340px', 'orientation:landscape'];
    expect(mediaSignature({ width: 320, height: 568 }, queries)).toBe('max-width:760px=1 max-width:340px=1 orientation:landscape=0');
    expect(mediaSignature({ width: 844, height: 390 }, queries)).toBe('max-width:760px=0 max-width:340px=0 orientation:landscape=1');
    expect(mediaSignature({ width: 760, height: 760 }, queries)).toBe('max-width:760px=1 max-width:340px=0 orientation:landscape=0');
  });
});

describe('screen sweep selection and output (issue #766)', () => {
  it('selects everything by default, a named subset in catalogue order, and refuses an unknown id', () => {
    expect(select(SCREEN_STATES, undefined, (s) => s.id, 'state')).toHaveLength(SCREEN_STATES.length);
    const ids = select(SCREEN_STATES, 'screen.customize, screen.main-menu', (s) => s.id, 'state').map((s) => s.id);
    expect(ids).toEqual(['screen.main-menu', 'screen.customize']);
    expect(() => select(LAYOUTS, '320x568,4k', (l) => l.name, 'layout')).toThrow('unknown layout: 4k');
  });

  it('writes each capture under its state, named by its layout, with the report beside it', () => {
    expect(capturePaths('/tmp/s', 'screen.customize', '320x568')).toEqual({
      png: join('/tmp/s', 'screen.customize', '320x568.png'),
      report: join('/tmp/s', 'screen.customize', '320x568.json'),
    });
  });

  it('records the build, the request and every result in the manifest, failures counted', () => {
    const manifest = sweepManifest({
      dist: '/d',
      source: 'abc',
      options: { hideGame: true },
      complete: false,
      states: [{ id: 'screen.a' }],
      layouts: [{ name: '320x568', width: 320, height: 568, dpr: 2, risk: 'r' } as never],
      results: [
        { state: 'screen.a', layout: '320x568', ok: true, sha256: 'x', pageErrors: 0 },
        { state: 'screen.a', layout: '320x568', ok: false, error: 'boom' },
      ],
    });
    expect(manifest).toMatchObject({ dist: '/d', source: 'abc', options: { hideGame: true }, complete: false, states: ['screen.a'], captures: 2, failed: 1 });
    expect(manifest.layouts).toEqual([{ name: '320x568', width: 320, height: 568, dpr: 2 }]);
  });
});

describe('screen sweep comparison (issue #766)', () => {
  it('classifies a pair missing on either side as missing, never identical', () => {
    expect(classifyPair({ base: null, head: 'a' })).toBe('missing');
    expect(classifyPair({ base: 'a', head: null })).toBe('missing');
    expect(classifyPair({ base: null, head: null })).toBe('missing');
  });

  it('calls a pair unstable when a control of the same build differs, before judging the change', () => {
    expect(classifyPair({ base: 'a', head: 'b', baseControl: 'c' })).toBe('unstable');
    expect(classifyPair({ base: 'a', head: 'a', headControl: 'z' })).toBe('unstable');
    expect(classifyPair({ base: 'a', head: 'a', baseControl: null })).toBe('unstable');
    expect(classifyPair({ base: 'a', head: 'b', baseControl: 'a', headControl: 'b' })).toBe('different');
    expect(classifyPair({ base: 'a', head: 'a', baseControl: 'a' })).toBe('identical');
    expect(classifyPair({ base: 'a', head: 'a' })).toBe('identical');
  });

  it('compares every pair either sweep names, and exits 0 only when all are identical', () => {
    const sweep = (results: Array<[string, string, string | null]>) => ({
      complete: true,
      results: results.map(([state, layout, sha]) => (sha === null
        ? { state, layout, ok: false }
        : { state, layout, ok: true, sha256: sha, measurementsSha256: 'm' })),
    });
    const base = sweep([['s1', 'l1', 'a'], ['s1', 'l2', 'b'], ['s2', 'l1', 'c'], ['s3', 'l1', null]]);
    const head = sweep([['s1', 'l1', 'a'], ['s1', 'l2', 'x'], ['s3', 'l1', 'd'], ['s4', 'l1', 'e']]);
    const result = compareManifests({ base, head });
    expect(result.pairs.map((p) => [p.state, p.layout, p.outcome])).toEqual([
      ['s1', 'l1', 'identical'],
      ['s1', 'l2', 'different'],
      ['s2', 'l1', 'missing'],
      ['s3', 'l1', 'missing'],
      ['s4', 'l1', 'missing'],
    ]);
    expect(result.totals).toEqual({ pairs: 5, identical: 1, different: 1, missing: 3, unstable: 0, measurementsIdentical: 2 });
    expect(compareExitCode(result)).toBe(1);

    const same = compareManifests({ base: sweep([['s1', 'l1', 'a']]), head: sweep([['s1', 'l1', 'a']]) });
    expect(compareExitCode(same)).toBe(0);
    // Two empty sweeps compared nothing, and that is not a pass.
    expect(compareExitCode(compareManifests({ base: sweep([]), head: sweep([]) }))).toBe(1);

    const withControl = compareManifests({ base: sweep([['s1', 'l1', 'a']]), head: sweep([['s1', 'l1', 'b']]), baseControl: sweep([['s1', 'l1', 'q']]) });
    expect(withControl.pairs[0].outcome).toBe('unstable');
    expect(withControl.controls).toEqual({ base: true, head: false });
  });

  it('says whether the measurements agree, without letting them turn a pixel difference identical', () => {
    const one = (sha: string, m?: string) => ({ complete: true, results: [{ state: 's', layout: 'l', ok: true, sha256: sha, measurementsSha256: m }] });
    const unstableButSameLayout = compareManifests({ base: one('a', 'm1'), head: one('a', 'm1'), baseControl: one('b', 'm1') });
    expect(unstableButSameLayout.pairs[0]).toMatchObject({ outcome: 'unstable', measurements: 'identical' });
    expect(compareExitCode(unstableButSameLayout)).toBe(1);
    expect(compareManifests({ base: one('a', 'm1'), head: one('b', 'm2') }).pairs[0].measurements).toBe('different');
    expect(compareManifests({ base: one('a'), head: one('a', 'm1') }).pairs[0].measurements).toBe('missing');
  });

  it('refuses to compare sweeps taken with different options', () => {
    const shown = { complete: true, options: { hideGame: false }, results: [] };
    const hidden = { complete: true, options: { hideGame: true }, results: [] };
    expect(() => compareManifests({ base: shown, head: hidden })).toThrow(/head sweep was taken with/);
    expect(() => compareManifests({ base: hidden, head: hidden, baseControl: shown })).toThrow(/base control sweep/);
    expect(compareManifests({ base: hidden, head: hidden }).options).toEqual({ hideGame: true });
  });

  it('refuses a sweep that did not finish, naming which one', () => {
    const done = { complete: true, results: [{ state: 's', layout: 'l', ok: true, sha256: 'a' }] };
    const stopped = { complete: false, results: [{ state: 's', layout: 'l', ok: true, sha256: 'a' }] };
    expect(() => compareManifests({ base: done, head: stopped })).toThrow(/head sweep did not finish/);
    expect(() => compareManifests({ base: { results: [] }, head: done })).toThrow(/base sweep did not finish/);
    expect(compareManifests({ base: done, head: done }).totals.identical).toBe(1);
  });
});
