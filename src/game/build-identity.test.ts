import { describe, it, expect } from 'vitest';
import { readBuildIdentity } from './build-identity';

// Moved here with the function it covers (issue #946). It used to live in
// `dev-diagnostics.test.ts`, which is the right home for the report formatter and the wrong one
// for the build identity: `readBuildIdentity` is called on ordinary paths by `loop.ts` and
// `route-host.ts`, and keeping its test in the developer module's file was the same conflation
// the module split fixes.

describe('readBuildIdentity says unknown rather than inventing a version', () => {
  it('reports a supplied commit as known', () => {
    expect(readBuildIdentity({ VITE_BUILD_SHA: 'abc1234' })).toEqual({ commit: 'abc1234', known: true });
  });

  it('reports an absent variable as unknown, not as an empty commit', () => {
    // `known: false` is the answer a local build, a dev server and any tree that never went
    // through the deploy workflow genuinely has. The acceptance criterion is that copied
    // diagnostics "identify local/unknown builds honestly", so the flag is what a reader
    // branches on rather than the emptiness of a string.
    expect(readBuildIdentity({})).toEqual({ commit: '', known: false });
  });

  it('treats an empty or whitespace value as absent', () => {
    // An unset variable in a shell substitution arrives as `''`, and a CI step that
    // interpolated a missing SHA would produce whitespace. Either way the build does not
    // know its commit, and a report printing "Build: " would be claiming that it did.
    for (const raw of ['', '   ', '\n']) {
      expect(readBuildIdentity({ VITE_BUILD_SHA: raw }), JSON.stringify(raw)).toEqual({
        commit: '',
        known: false,
      });
    }
  });

  it('does NOT reach import.meta -- the environment is injected (issue #946)', () => {
    // The reason this module can be tested without a browser at all, and the property that let
    // it move out of `dev-diagnostics.ts` without dragging that module's purity note along.
    // A build that read `import.meta.env` directly would make this file impossible.
    const src = readBuildIdentity.toString();
    expect(src).not.toContain('import.meta');
    expect(src).toContain('VITE_BUILD_SHA');
  });
});
