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

/** Source with `//` and block comments removed, so a mention is not a call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('src/audio is deterministic by construction', () => {
  it('calls Math.random NOWHERE -- every source of chance is a seeded rng', () => {
    // music.ts and synth.ts reject Math.random in their own comments, and
    // engine.ts seeds the director from the clock precisely so that "that join
    // sounded awful" can be reproduced. All three claims were COMMENTS: review
    // replaced engine.ts's seeded xorshift with Math.random at the call site
    // and the whole 1268-test suite stayed green, because the shuffle inside
    // playlist.ts (which IS pinned) was untouched. This scans the wiring.
    // Population: every non-test module in src/audio -- 11 files at this commit
    // (`ls src/audio/*.ts | grep -v '\.test\.ts' | wc -l`).
    const offenders = MODULES.filter((f) => /Math\s*\.\s*random/.test(stripComments(sources[f])));
    expect(offenders, `Math.random in: ${offenders.join(', ')}`).toEqual([]);
    // Not pinned to 11: adding a module must not fail this. The floor only
    // catches a glob that silently matched nothing, which would report a
    // clean sweep over zero files.
    expect(MODULES.length, 'the glob matched nothing -- a vacuous sweep').toBeGreaterThan(5);
  });

  it('...and the scan can actually tell a call from a mention', () => {
    // The negative controls. A guard is worth what its own tests prove: without
    // these, a stripComments that returned '' would report a clean sweep.
    const detect = (src: string): boolean => /Math\s*\.\s*random/.test(stripComments(src));
    expect(detect('const r = Math.random();'), 'missed a plain call').toBe(true);
    expect(detect('const r = Math . random ();'), 'missed a spaced call').toBe(true);
    expect(detect('// never use Math.random here'), 'flagged a line comment').toBe(false);
    expect(detect('/* seeded, not Math.random */'), 'flagged a block comment').toBe(false);
    expect(detect('/* a\n * Math.random mention\n */\nconst x = 1;'), 'flagged a multi-line comment').toBe(
      false,
    );
  });
});
