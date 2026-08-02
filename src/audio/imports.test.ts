// A circular import between music-data.ts and chords.ts left a module-level
// const uninitialised, and the symptom was a ReferenceError AT IMPORT TIME --
// not a wrong note. It survived a run reporting "96 passed", because a file that
// fails to load contributes no tests to the count and the failure sits above the
// summary line.
//
// The first version of this test named the two guilty files. Review proved that
// worthless: a cycle of the SAME shape between a different pair (melody.ts and
// music-data.ts) passed all four checks, as did the original cycle written with
// double quotes or as a side-effect import. So this builds the actual graph and
// looks for any cycle at all.
import { describe, it, expect } from 'vitest';

// eager: true gives us every module's SOURCE without importing it, so a module
// that would throw on import can still be analysed.
const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

const MODULES = Object.keys(sources).filter((f) => !f.endsWith('.test.ts'));

/** Local imports of a module, however they are written. */
function localImports(src: string): string[] {
  const out: string[] = [];
  // `from './x'`, `from "./x"`, and bare side-effect `import './x'`.
  for (const re of [/from\s+['"]\.\/([\w./-]+)['"]/g, /import\s+['"]\.\/([\w./-]+)['"]/g]) {
    for (const m of src.matchAll(re)) out.push(m[1].replace(/\.ts$/, ''));
  }
  return out;
}

describe('the audio module graph stays acyclic', () => {
  it('read the sources at all', () => {
    // ?raw yields an empty string if the loader is not configured, which would
    // make every assertion below pass vacuously -- the trap hud.css.test.ts
    // documents. Also guards the glob silently matching nothing.
    expect(MODULES.length).toBeGreaterThan(5);
    for (const f of MODULES) expect(sources[f].length, f).toBeGreaterThan(100);
  });

  it('has no import cycle anywhere in src/audio', () => {
    const graph = new Map<string, string[]>();
    for (const f of MODULES) {
      const name = f.replace('./', '').replace('.ts', '');
      graph.set(
        name,
        localImports(sources[f]).filter((d) => graph.has(d) || MODULES.includes(`./${d}.ts`)),
      );
    }
    const cycles: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [];
    const walk = (node: string): void => {
      const at = stack.indexOf(node);
      if (at >= 0) {
        cycles.push([...stack.slice(at), node].join(' -> '));
        return;
      }
      if (seen.has(node)) return;
      seen.add(node);
      stack.push(node);
      for (const d of graph.get(node) ?? []) walk(d);
      stack.pop();
    };
    for (const n of graph.keys()) walk(n);
    expect(cycles).toEqual([]);
  });

  it('imports every audio module cleanly, in isolation', async () => {
    // The direct regression test: importing any one of these FIRST must not
    // throw. Vitest resets the module registry per file, so this exercises cold
    // import order rather than an already-warmed graph.
    for (const m of ['./notes', './chords', './melody', './music-data', './music', './synth']) {
      await expect(import(/* @vite-ignore */ m), m).resolves.toBeDefined();
    }
  });
});
