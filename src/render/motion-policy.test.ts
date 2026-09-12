import { describe, it, expect } from 'vitest';
import rendererSource from './renderer.ts?raw';
// A REAL import beside the raw one, and it is load-bearing rather than decorative:
// `?raw` is not a module edge, so vitest's dependency graph does not relate this file to
// renderer.ts through it -- and `tools/mutate`'s reachability check refuses an entry whose
// declared tests cannot reach the file it mutates, which is exactly right and would have
// let this guard sit next to a mutation it could never be credited with killing. Asserted
// below rather than left unused, so nothing can treeshake the edge away.
import { createRenderer } from './renderer';

/**
 * THE FAN-OUT NOTHING WATCHED (issue #651).
 *
 * `renderer.setReducedMotion` routes the resolved policy to every render system that has an
 * answer to it. Until this file, a system dropped from that list -- or added and never
 * wired into it -- changed nothing any test could see: `createRenderer` builds a real
 * `WebGLRenderer`, which jsdom cannot provide, so there is no unit test that constructs one
 * and no spy to hang on the call. `renderer-builds-the-smoke-system-low-dropped` records
 * the same hole from the other side, as a DISCLOSED survivor.
 *
 * So this reads the SOURCE, the way `hud.css.test.ts` reads the stylesheet and
 * `arena.test.ts` reads its own module: the question is "is this wired", which is a property
 * of the text, and a guard that needed a GPU would not run in `verify:quick` at all.
 *
 * It is a POPULATION sweep, not a list. The expected set is derived from the modules that
 * declare the member, so a system added tomorrow is covered the day it declares it rather
 * than the day someone remembers to extend a fixture.
 */

/** Every `src/render` module's own text, for the declaration scan below. */
const sources = import.meta.glob('./*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The member as it appears in a system's own interface. */
const DECLARES = 'setReducedMotion(on: boolean): void;';

/**
 * `renderer.ts` declares it too, and is the ROUTER rather than a consumer -- routing the
 * call to itself is not a thing that could be forgotten. Named here rather than filtered by
 * a cleverer pattern so the exception is visible in the diff if it ever grows.
 */
const NOT_A_CONSUMER = ['./renderer.ts'];

function declaringModules(): string[] {
  return Object.keys(sources)
    .filter((p) => !NOT_A_CONSUMER.includes(p))
    .filter((p) => sources[p].includes(DECLARES))
    .sort();
}

/** The body of `renderer.ts`'s `setReducedMotion:` property, and nothing either side of it. */
function fanOutBlock(): string {
  const start = rendererSource.indexOf('setReducedMotion: (on: boolean) => {');
  expect(start, 'renderer.ts no longer has a setReducedMotion fan-out to check').toBeGreaterThan(-1);
  const end = rendererSource.indexOf('\n    },', start);
  expect(end, 'the fan-out block is unterminated').toBeGreaterThan(start);
  return rendererSource.slice(start, end);
}

/** `import { createFoo, ... } from './foo'` -> the factory renderer.ts uses for that module. */
function factoryFor(modulePath: string): string {
  const spec = modulePath.replace(/^\.\//, './').replace(/\.ts$/, '');
  const importLine = new RegExp(`import \\{([^}]*)\\} from '${spec}';`).exec(rendererSource);
  expect(importLine, `renderer.ts does not import ${modulePath} at all`).not.toBeNull();
  const factory = /\bcreate[A-Za-z]+\b/.exec((importLine as RegExpExecArray)[1]);
  expect(factory, `renderer.ts imports no factory from ${modulePath}`).not.toBeNull();
  return (factory as RegExpExecArray)[0];
}

/** `const ident: T | null = cond ? createFoo(...)` -> `ident`. Survives the ternary forms. */
function bindingFor(factory: string): string {
  const m = new RegExp(`const\\s+(\\w+)[^=;]*=\\s*[^;]*?\\b${factory}\\s*\\(`, 's').exec(
    rendererSource,
  );
  expect(m, `renderer.ts never binds the result of ${factory}`).not.toBeNull();
  return (m as RegExpExecArray)[1];
}

describe('the reduced-motion fan-out (issue #651)', () => {
  it('is related to renderer.ts by a real module edge, not only by reading its text', () => {
    // The edge the mutation harness needs. Without it `renderer-drops-a-system-from-the-
    // motion-fanout` is refused before it runs -- "declared tests do not reach the file they
    // mutate" -- and a guard nothing can credit is a guard nobody will keep.
    expect(typeof createRenderer).toBe('function');
  });

  it('finds the population it is about', () => {
    // Non-vacuity, and it is the denominator. A glob that matched nothing, or a declaration
    // string that no longer appears, would make every assertion below pass while measuring
    // nothing -- which is the exact shape the reduced-motion CSS guard was written to avoid.
    expect(Object.keys(sources).length, 'the module glob matched nothing').toBeGreaterThan(10);
    expect(declaringModules().length, 'no render system declares the member').toBeGreaterThan(3);
    expect(rendererSource).toContain(DECLARES);
  });

  it('routes the policy to EVERY render system that declares an answer to it', () => {
    // The assertion the issue asks for: "no test asserts the fan-out at all. A mutation that
    // drops a module from renderer.ts's list survives today." Derived from the declarations
    // rather than from a list, so a system added tomorrow is covered when it declares the
    // member, not when someone remembers this file.
    // The CALL, not the identifier. An earlier draft asked whether the binding's name
    // appeared anywhere in the block, and a mutation replacing `entities.setReducedMotion(on)`
    // with `void entities;` survived it: the name was still there and the policy was not
    // handed over. Found by running that mutation, not by reading.
    const block = fanOutBlock();
    const handed = (binding: string): boolean =>
      new RegExp(`\\b${binding}\\??\\.setReducedMotion\\(`).test(block);
    const missing = declaringModules().filter((p) => !handed(bindingFor(factoryFor(p))));
    expect(missing, 'declares setReducedMotion and is never handed the policy').toEqual([]);
  });

  it('routes nothing it did not construct, so a stale identifier cannot hide in the block', () => {
    // The other direction. A call on an identifier renderer.ts no longer builds would be
    // dead text that still reads as coverage; this fails on it.
    const called = [...fanOutBlock().matchAll(/(\w+)\??\.setReducedMotion\(/g)].map((m) => m[1]);
    expect(called.length, 'the block makes no calls at all').toBeGreaterThan(3);
    const built = new Set(declaringModules().map((p) => bindingFor(factoryFor(p))));
    expect(called.filter((id) => !built.has(id)), 'called but not built here').toEqual([]);
    // One call per system, not two: a duplicated line would let a swap go unnoticed.
    expect(new Set(called).size, 'a system is handed the policy twice').toBe(called.length);
  });

  it('the lookups are capable of failing, which is what makes the sweep a measurement', () => {
    // The control on the control. Without this, a `factoryFor`/`bindingFor` that silently
    // returned something for anything would make the sweep above pass whatever renderer.ts
    // said -- the trap `hud.css.test.ts` records for its own rule lookup.
    expect(() => factoryFor('./no-such-module.ts')).toThrow();
    expect(() => bindingFor('createNoSuchSystem')).toThrow();
    expect(declaringModules()).not.toContain('./renderer.ts');
  });
});
