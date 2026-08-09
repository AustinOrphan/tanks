/**
 * The portability checker guards a defect class that ships SILENTLY -- a blank game on
 * the deployed subpath, with a green suite and a green build. So the checker itself needs
 * its own negative controls, per CLAUDE.md: "A guard is worth what its own tests prove."
 *
 * The fixtures below are the shapes vite ACTUALLY emits, copied out of real builds rather
 * than imagined, because that is where the shell version this replaces went wrong: it
 * matched double-quoted paths, vite 8 emits backticks, and the guard silently stopped
 * catching anything when the toolchain moved.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- plain .mjs, deliberately dependency-free so the workflows can run it
import { portabilityFailures } from './check.mjs';

const RELATIVE_HTML = '<script type="module" crossorigin src="./assets/index-abc.js"></script>';
const ABSOLUTE_HTML = '<script type="module" crossorigin src="/assets/index-abc.js"></script>';

/** Verbatim from a `base: './'` build under vite 8.1.5. The base survives as a variable. */
const GOOD_BUNDLE = 'const yl=.6,ch=`./`,lh={sfx:{cannon:`${ch}audio/cannon.wav`}};';
/** Same build with `const BASE = '/'` in manifest.ts: only the bound value moves. */
const ABSOLUTE_BASE_BUNDLE = 'const yl=.6,ch=`/`,lh={sfx:{cannon:`${ch}audio/cannon.wav`}};';

const bundle = (source: string) => [{ name: 'assets/index-abc.js', source }];

describe('subpath portability checker', () => {
  it('passes the shape a real `base: "./"` build emits', () => {
    // Fails if any check gains a false positive on genuine output -- which would make the
    // deploy workflow unmergeable rather than merely unhelpful.
    expect(portabilityFailures(RELATIVE_HTML, bundle(GOOD_BUNDLE))).toEqual([]);
  });

  it('catches vite.config.ts losing `base: "./"`', () => {
    // Fails if the index.html check is deleted or its regex loosened.
    const failures = portabilityFailures(ABSOLUTE_HTML, bundle(GOOD_BUNDLE));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/does not reference assets relatively/);
  });

  it('catches manifest.ts losing `import.meta.env.BASE_URL`', () => {
    // The mutation the shell version could not see: index.html is untouched and no
    // absolute literal appears, so only the base-binding check can fire. Fails if that
    // check is deleted.
    const failures = portabilityFailures(RELATIVE_HTML, bundle(ABSOLUTE_BASE_BUNDLE));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/the audio base is not relative/);
    expect(failures[0]).toContain('"/"');
  });

  // The toolchain-dependence that killed the shell version: vite 5 emitted "…", vite 8
  // emits `…`. Each entry fails if the quote class is dropped from the regex.
  it.each([
    ['double quotes (vite 5 shape)', 'x={cannon:"/audio/cannon.wav"};'],
    ['backticks (vite 8 shape)', 'x={cannon:`/audio/cannon.wav`};'],
    ['single quotes', "x={cannon:'/audio/cannon.wav'};"],
  ])('catches a hand-written origin-absolute path in %s', (_label, source) => {
    const failures = portabilityFailures(RELATIVE_HTML, bundle(source));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/contains origin-absolute asset paths/);
  });

  it('fails when the build produced no JavaScript at all', () => {
    // The shell version PASSED here: `grep` exits 2 on a non-matching glob and `!` turns
    // that into success. Fails if the bundles.length guard is removed.
    const failures = portabilityFailures(RELATIVE_HTML, []);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no JS bundle found/);
  });

  it('fails when the probe is gone but the bundle still carries audio files', () => {
    // The rot case: a manifest RENAME would leave both asset checks looking at nothing
    // and reporting success -- the hud.css failure mode. Fails if the probeSeen guard
    // goes. The bundle here still ships an audio file, so the assets did not leave;
    // only the probe stopped matching them.
    const failures = portabilityFailures(RELATIVE_HTML, bundle('x={a:`${ch}audio/shot.wav`};'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no reference to audio\/cannon\.wav/);
    expect(failures[0]).toMatch(/probe has rotted/);
  });

  it('passes when there are no audio files at all -- the shipped, empty-manifest state', () => {
    // AUDIO_MANIFEST declares nothing, so `audioUrl` is tree-shaken and no audio URL
    // reaches the bundle. That is not the probe rotting, and failing on it would make
    // the gate red on every build for as long as no asset is committed.
    expect(portabilityFailures(RELATIVE_HTML, bundle('const ch=`./`;'))).toEqual([]);
  });

  it('does not mistake Howler MIME literals for audio files', () => {
    // Every bundle ships `audio/wav`, `audio/mpeg` and ten more as MIME strings. Read
    // as asset URLs they would pin the rot branch on permanently -- which they did, on
    // the first draft of this check.
    const mime = 'const t=["audio/wav","audio/mpeg","audio/x-caf;"];';
    expect(portabilityFailures(RELATIVE_HTML, bundle(mime))).toEqual([]);
  });

  it('reports every distinct absolute path, not just the first', () => {
    // Fails if the loop is replaced by a find/some that stops at the first hit -- the
    // message is what tells you how much of the manifest regressed.
    const failures = portabilityFailures(
      RELATIVE_HTML,
      bundle('x={a:`/audio/cannon.wav`,b:`/audio/ping.wav`};'),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('/audio/cannon.wav');
    expect(failures[0]).toContain('/audio/ping.wav');
  });

  it('is the single source of truth: both workflows call it, neither re-inlines it', () => {
    // The reason this lives in tools/ rather than pasted into two YAML files nothing
    // typechecks. Fails the moment someone pastes the grep back into either workflow.
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/pages.yml']) {
      const text = readFileSync(workflow, 'utf8');
      expect(text, `${workflow} should call the shared checker`).toContain(
        'npm run portability',
      );
      expect(text, `${workflow} has re-inlined the assertion`).not.toContain("grep -q 'src=");
    }
  });
});
