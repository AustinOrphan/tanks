import { describe, expect, it } from 'vitest';

/**
 * The seam's second half (issue #556). A pane's `Pick<PaneHost, ...>` is enforced by the compiler,
 * but a cast reaches past it at run time. So the key list each pane declares is pinned here from
 * source, where a reviewer reads a pane's shared-state cost as a line in a table. This also checks
 * that no pane module imports `hud.ts`, which would put the closure's types, and the file that
 * imports the pane, back within reach.
 *
 * Source is read with `import.meta.glob(..., '?raw')`, as `hud-ownership.test.ts` does, because
 * the question is what the file SAYS.
 */
const paneSources = import.meta.glob('./*-pane.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Every extracted pane, and the host members it may call. Adding a pane adds a row. */
const HOST_KEYS: Readonly<Record<string, readonly string[]>> = {
  './customize-pane.ts': ['back', 'closeSurface', 'enterSurface', 'isSurfaceOpen', 'open'],
  './controllers-pane.ts': ['back', 'closeSurface', 'enterSurface', 'isSurfaceOpen', 'open'],
};

const withoutComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** The keys of every `Pick<PaneHost, ...>` in a source, sorted; null when there is none. */
function hostKeys(src: string): string[] | null {
  const picks = [...withoutComments(src).matchAll(/Pick<\s*PaneHost\s*,([^>]*)>/g)];
  if (picks.length === 0) return null;
  return [...new Set(picks.flatMap((m) => [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((k) => k[1])))].sort();
}

/** Whether a source imports `hud.ts`, as a type or a value. */
function importsHud(src: string): boolean {
  return /\bfrom\s+['"]\.\/hud(?:\.ts)?['"]/.test(withoutComments(src));
}

describe('pane host seam (issue #556)', () => {
  it('finds every extracted pane module, and every one is in the table', () => {
    expect(Object.keys(paneSources).length, 'the glob found no pane: the checks below would be vacuous').toBeGreaterThan(0);
    expect(Object.keys(paneSources).sort()).toEqual(Object.keys(HOST_KEYS).sort());
  });

  it('pins the host members each pane declares', () => {
    for (const [file, src] of Object.entries(paneSources)) {
      expect(hostKeys(src), `${file}'s Pick<PaneHost, ...>`).toEqual(HOST_KEYS[file]);
    }
    // Negative control: a pane that widens its host is caught.
    const widened = "type H = Pick<PaneHost, 'back' | 'closeSurface' | 'enterSurface' | 'isSurfaceOpen' | 'open' | 'captureFocus'>;";
    expect(hostKeys(widened)).not.toEqual(HOST_KEYS['./customize-pane.ts']);
    expect(hostKeys('// type H = Pick<PaneHost, \'back\'>;\nconst x = 1;')).toBeNull();
  });

  it('keeps every pane module from importing hud.ts', () => {
    for (const [file, src] of Object.entries(paneSources)) {
      expect(importsHud(src), `${file} imports hud.ts`).toBe(false);
    }
    // Negative controls: a type import is caught, and a comment that names the file is not.
    expect(importsHud("import type { Hud } from './hud';")).toBe(true);
    expect(importsHud("import { createHud } from './hud.ts';")).toBe(true);
    expect(importsHud("// the host lives in './hud'\nimport type { PaneHost } from './pane-host';")).toBe(false);
  });
});
