import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  attribute,
  collectOwners,
  isWriteTarget,
  paneReport,
  placeEntries,
  programForFile,
  programForSource,
  strictFailures,
} from './closure.mjs';
import { CORRECTIONS, PANES } from './attribution.mjs';
import { readManifest } from '../mutate/run.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;

/**
 * A closure small enough to state every answer by hand. Two panes, one shared helper, one write
 * across a pane boundary, one shadowed local and one statement that references both panes.
 */
const FIXTURE = `
export function createHud(root: { q(s: string): unknown }) {
  const el = root;
  let openCount = 0;
  let theme = 'dark';
  const customizeView = el.q('.customize');
  const customizeSettingsRow = el.q('.row');
  function showCustomize(show: boolean): number {
    openCount += 1;
    return show ? 1 : 0;
  }
  const settingsView = el.q('.settings');
  function showSettings(): void {
    const swap = (x: unknown): void => { void x; };
    swap(settingsView);
    theme = 'light';
  }
  function swap(x: unknown): void { void x; }
  const PANELS = [customizeView, settingsView];
  swap(customizeView);
  swap([showCustomize, showSettings]);
  // a leading comment a manifest find can start in
  void PANELS;
  return {
    onCustomizeOpen(): number { return showCustomize(true); },
    setVolume(v: number): void { void v; void theme; },
    settingsView,
  };
}
`;

const FIXTURE_PANES = [
  { pane: 'Customize', nouns: ['customize'] },
  { pane: 'Settings', nouns: ['settings', 'volume'] },
];

function analyseFixture(corrections = [{ pane: 'Settings', names: ['theme'] }]) {
  const program = programForSource(ts, '/fixture.ts', FIXTURE);
  const collected = collectOwners(ts, program, '/fixture.ts', 'createHud');
  const attributed = attribute(collected.owners, { panes: FIXTURE_PANES, corrections });
  return { collected, ...attributed };
}

const row = (report: ReturnType<typeof paneReport>, pane: string) => {
  const found = report.rows.find((r) => r.pane === pane);
  if (!found) throw new Error(`no row for ${pane}`);
  return found;
};

describe('hud closure analysis (issue #767)', () => {
  it('makes one owner of every direct statement and every returned member', () => {
    const { collected } = analyseFixture();
    const report = paneReport(collected, ['Customize', 'Settings']);
    expect(report.owners).toBe(16);
    expect(report.kinds).toEqual({ const: 5, let: 2, function: 3, member: 3, statement: 3, type: 0 });
  });

  it('puts a name in the FIRST pane whose noun it contains, and a correction wins over nouns', () => {
    const { collected } = analyseFixture();
    const paneOf = (name: string) => collected.owners.find((o) => o.names.includes(name))?.pane;
    // `customizeSettingsRow` contains both nouns: Customize is listed first.
    expect(paneOf('customizeSettingsRow')).toBe('Customize');
    // `theme` contains no noun; only the correction puts it in Settings.
    expect(paneOf('theme')).toBe('Settings');
    expect(paneOf('swap')).toBe('shared');
  });

  it('gives a nameless statement to the one pane it references, and shares one that references two', () => {
    const { collected, crossPaneStatements } = analyseFixture();
    const customize = collected.owners.filter((o) => o.pane === 'Customize').map((o) => o.names[0] ?? `statement@${o.start}`);
    expect(customize).toEqual(['customizeView', 'customizeSettingsRow', 'showCustomize', 'statement@20', 'onCustomizeOpen']);
    expect(crossPaneStatements.map((o) => o.start)).toEqual([21]);
  });

  it('does not count a shadowed local as a reference to the closure name it shadows', () => {
    const { collected } = analyseFixture();
    const report = paneReport(collected, ['Customize', 'Settings']);
    // `showSettings` declares its own `swap` and calls it. Only `settingsView`'s initialiser
    // reaches outside the pane, through `el`.
    expect(row(report, 'Settings').outsideValues).toEqual(['el']);
    expect(row(report, 'Customize').outsideValues).toEqual(['el', 'openCount', 'swap']);
  });

  it('reports a write to a binding outside the pane, and not a write inside it', () => {
    const { collected } = analyseFixture();
    const report = paneReport(collected, ['Customize', 'Settings']);
    expect(row(report, 'Customize').writesAcross).toEqual([
      { binding: 'openCount', kind: 'let', pane: 'shared', writers: ['showCustomize'] },
    ]);
    // `showSettings` writes `theme`, which the correction put in Settings: not across.
    expect(row(report, 'Settings').writesAcross).toEqual([]);
    expect(row(report, 'Customize').inbound).toEqual(['PANELS', 'statement@21']);
  });

  it('fails --strict on a write across a boundary and on a correction that names nothing, per pane', () => {
    const stale = analyseFixture([{ pane: 'Settings', names: ['theme'] }, { pane: 'shared', names: ['nosuchname'] }]);
    const report = paneReport(stale.collected, ['Customize', 'Settings']);
    expect(stale.staleCorrections).toEqual([{ name: 'nosuchname', pane: 'shared', source: undefined }]);
    expect(strictFailures(report, stale.staleCorrections)).toEqual([
      'Customize writes openCount (let, shared) from showCustomize',
      'correction names nosuchname (shared), which is not in the closure',
    ]);
    const clean = analyseFixture();
    const cleanReport = paneReport(clean.collected, ['Customize', 'Settings']);
    expect(strictFailures(cleanReport, clean.staleCorrections, 'Settings')).toEqual([]);
    expect(strictFailures(cleanReport, clean.staleCorrections, 'Customize')).toHaveLength(1);
    expect(strictFailures(cleanReport, clean.staleCorrections, 'Nowhere')).toEqual(['no pane named Nowhere']);
  });

  it('places a manifest entry by where its find starts, counting a leading comment as its statement', () => {
    const { collected } = analyseFixture();
    const entries = [
      { id: 'in-a-pane', find: 'openCount += 1' },
      { id: 'in-a-leading-comment', find: '// a leading comment' },
      { id: 'before-the-body', find: 'export function createHud' },
      { id: 'third-swap-call', find: 'swap(', occurrence: 3 },
      { id: 'absent', find: 'nowhere at all' },
    ];
    const placed = placeEntries(collected.owners, collected.span, collected.text, entries)
      .map((p) => [p.entry.id, p.where, p.pane]);
    expect(placed).toEqual([
      ['in-a-pane', 'owner', 'Customize'],
      ['in-a-leading-comment', 'owner', 'shared'],
      ['before-the-body', 'outside', null],
      ['third-swap-call', 'owner', 'Customize'],
      ['absent', 'not-found', null],
    ]);
  });

  it('sums recorded scope costs per pane and leaves an unrecorded scope out rather than as zero', () => {
    const { collected } = analyseFixture();
    const entries = [
      { id: 'a', find: 'openCount += 1', tests: ['a.test.ts'] },
      { id: 'b', find: 'return show ? 1 : 0;', tests: ['b.test.ts'] },
    ];
    const costOf = (tests: readonly string[]) => (tests[0] === 'a.test.ts' ? 2.5 : null);
    const customize = row(paneReport(collected, ['Customize', 'Settings'], { entries, costOf }), 'Customize');
    expect([customize.manifestEntries, customize.costedEntries, customize.serialSeconds]).toEqual([2, 1, 2.5]);
  });
});

describe('isWriteTarget (issue #767)', () => {
  const targets = (code: string) => {
    const sf = ts.createSourceFile('/w.ts', code, ts.ScriptTarget.ES2022, true);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'x') found.push(isWriteTarget(ts, n) ? 'write' : 'read');
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  };

  it('reads assignments, updates, destructuring and loop variables as writes', () => {
    expect(targets('x = 1;')).toEqual(['write']);
    expect(targets('x += 1;')).toEqual(['write']);
    expect(targets('x++; --x;')).toEqual(['write', 'write']);
    expect(targets('[x, y] = z;')).toEqual(['write']);
    expect(targets('({ a: x } = z);')).toEqual(['write']);
    expect(targets('for (x of z) {}')).toEqual(['write']);
  });

  it('reads every other use as a read', () => {
    expect(targets('y = x;')).toEqual(['read']);
    expect(targets('f(x);')).toEqual(['read']);
    expect(targets('y = [x];')).toEqual(['read']);
    expect(targets('x.count = 1;')).toEqual(['read']);
  });
});

describe('hud closure analysis on the real hud.ts (issue #767)', () => {
  const file = join(ROOT, 'src/game/hud.ts');
  const collected = collectOwners(ts, programForFile(ts, ROOT, file), file, 'createHud');
  attribute(collected.owners, { panes: PANES, corrections: CORRECTIONS });

  it('finds every Surface constant createHud declares, as an owner', () => {
    const declaredInSource = [...readFileSync(file, 'utf8').matchAll(/^ {2}const ([A-Z_]+_SURFACE): Surface = /gm)].map((m) => m[1]);
    expect(declaredInSource.length, 'the source scan found almost nothing').toBeGreaterThan(10);
    const ownerNames = new Set(collected.owners.flatMap((o) => o.names));
    expect(declaredInSource.filter((name) => !ownerNames.has(name))).toEqual([]);
  });

  it('places every manifest entry that names hud.ts, and finds each one', () => {
    const entries = readManifest(join(ROOT, 'tools/mutate/manifests')).filter((e) => e.file === 'src/game/hud.ts');
    const report = paneReport(collected, PANES.map((p) => p.pane), { entries });
    expect(entries.length, 'no entry names hud.ts: this would pass vacuously').toBeGreaterThan(0);
    expect(report.manifest.total).toBe(entries.length);
    expect(report.manifest.notFound).toEqual([]);
    const placedInRows = report.rows.reduce((sum, r) => sum + r.manifestEntries, 0);
    expect(placedInRows + report.manifest.outsideFunction + report.manifest.betweenOwners).toBe(entries.length);
  });
});
