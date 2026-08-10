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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain .mjs, deliberately dependency-free so the workflows can run it
import { portabilityFailures, manifestFailures } from './check.mjs';

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

  it('detects a rotted probe across every audio form, not just .wav', () => {
    // Review measured four shapes walking silently through the first draft of this
    // branch: .opus and .aac assets, an UPPERCASE filename, and the computed
    // `${id}audio/${key}.wav` form -- which matters most, because a key-driven loop
    // over the manifest is the natural next edit to make here.
    for (const src of [
      'x={a:`${ch}audio/theme.opus`};',
      'x={a:`${ch}audio/hit.aac`};',
      'x={a:`${ch}audio/Cannon.WAV`};',
      'x=`${ch}audio/${k}.wav`;',
    ]) {
      const failures = portabilityFailures(RELATIVE_HTML, bundle(src));
      expect(failures, src).toHaveLength(1);
      expect(failures[0], src).toMatch(/probe has rotted/);
    }
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

/**
 * The PWA shell's own negative controls. Every failure below is silent in the browser:
 * the game loads and plays, and only the INSTALLED copy is broken -- which is why none
 * of them can be left to review.
 */
describe('web app manifest portability', () => {
  const HTML =
    '<link rel="manifest" href="./manifest.webmanifest" />' +
    '<link rel="apple-touch-icon" href="./icons/apple-touch-icon-180.png" />';
  const GOOD = {
    start_url: './',
    scope: './',
    icons: [{ src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
  };
  /** A dist/ shaped like the real one: the files that exist, and the manifest's text. */
  const dist = (manifest: unknown, files = ['icons/icon-192.png', 'icons/apple-touch-icon-180.png']) => ({
    files: [...files, 'manifest.webmanifest', 'index.html'],
    texts: { 'manifest.webmanifest': JSON.stringify(manifest) },
  });

  it('passes the shape this repo actually ships', () => {
    // Fails if any check below gains a false positive on real output, which would make
    // the deploy workflow unmergeable rather than merely unhelpful.
    expect(manifestFailures(HTML, dist(GOOD))).toEqual([]);
  });

  it('catches an origin-absolute start_url, which opens the portfolio instead', () => {
    const failures = manifestFailures(HTML, dist({ ...GOOD, start_url: '/' }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/start_url is "\/"/);
  });

  it('catches an origin-absolute scope, which claims every page on the domain', () => {
    const failures = manifestFailures(HTML, dist({ ...GOOD, scope: '/tanks/' }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/scope is "\/tanks\/"/);
  });

  it('catches an origin-absolute manifest href', () => {
    const html = HTML.replace('./manifest.webmanifest', '/manifest.webmanifest');
    // Two failures, and both are the point: the href is wrong AND the file it names is
    // not where it looked, so a reader is told the cause and the symptom.
    const failures = manifestFailures(html, dist(GOOD));
    expect(failures.some((f: string) => /resolves against the origin root/.test(f))).toBe(true);
  });

  it('catches an icon the build did not emit', () => {
    // The realistic version of this: an icon renamed in the manifest and not on disk.
    // vite copies public/ verbatim, so nothing else notices.
    const failures = manifestFailures(HTML, dist(GOOD, ['icons/apple-touch-icon-180.png']));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/icon-192\.png is referenced but missing/);
  });

  it('catches the iOS tile going missing while the manifest stays', () => {
    // iOS reads neither the manifest's icons nor an SVG favicon, so losing this link
    // loses the home-screen icon on one whole platform and nothing else changes.
    const failures = manifestFailures(HTML.split('<link rel="apple-touch-icon"')[0], dist(GOOD));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/links no apple-touch-icon/);
  });

  it('refuses to go quiet when there is no manifest at all', () => {
    // The hud.css lesson, applied: a guard that finds nothing must say so. Deleting the
    // manifest must be a deliberate act that also deletes this check.
    const failures = manifestFailures('<title>Tanks!</title>', dist(GOOD));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/links no web app manifest/);
  });

  it('catches a manifest that is linked but never built', () => {
    const failures = manifestFailures(HTML, { files: ['index.html'], texts: {} });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/is not in the built output/);
  });

  it('catches a manifest that does not parse', () => {
    const failures = manifestFailures(HTML, {
      files: ['manifest.webmanifest'],
      texts: { 'manifest.webmanifest': '{ "start_url": "./", }' },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/is not valid JSON/);
  });
});

describe('the CLI runs both checkers over a real directory', () => {
  // Composition blindness, one layer up from the unit cases above: every assertion in
  // this file so far calls the pure functions directly, so DELETING the manifestFailures
  // call from the CLI -- or the whole `readDist` change that feeds it -- leaves all of
  // them green while `npm run portability` checks nothing. Measured, with the call
  // removed from the CLI's `failures` array: 23 of the 24 cases in this file still pass,
  // including every unit case for `manifestFailures` itself. The one that fails is the
  // second case below.
  const CHECK = fileURLToPath(new URL('./check.mjs', import.meta.url));
  const write = (manifest: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'portability-'));
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, 'icons'));
    writeFileSync(
      join(dir, 'index.html'),
      '<script type="module" crossorigin src="./assets/index-abc.js"></script>' +
        '<link rel="manifest" href="./manifest.webmanifest" />' +
        '<link rel="apple-touch-icon" href="./icons/apple-touch-icon-180.png" />',
    );
    writeFileSync(join(dir, 'assets/index-abc.js'), 'const ch=`./`;');
    writeFileSync(join(dir, 'manifest.webmanifest'), manifest);
    writeFileSync(join(dir, 'icons/icon-192.png'), '');
    writeFileSync(join(dir, 'icons/apple-touch-icon-180.png'), '');
    return dir;
  };
  const run = (dir: string): { status: number; output: string } => {
    try {
      // stdio pipes stderr too: left at the default it is inherited, and the failing
      // case below would print its (expected) complaint into the test run's output.
      return {
        status: 0,
        output: execFileSync('node', [CHECK, dir], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      };
    } catch (e) {
      const err = e as { status: number; stderr: string; stdout: string };
      return { status: err.status, output: `${err.stdout}${err.stderr}` };
    }
  };
  const ICONS = [
    { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
  ];

  it('exits 0 on a well-formed tree, and says what it checked', () => {
    const dir = write(JSON.stringify({ start_url: './', scope: './', icons: ICONS }));
    const { status, output } = run(dir);
    expect(output).toContain('the PWA shell checked');
    expect(status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits non-zero when only the MANIFEST is wrong', () => {
    // The discriminating case: everything the original checker looks at is fine here,
    // so a CLI that forgot the new call would exit 0 and CI would stay green.
    const dir = write(JSON.stringify({ start_url: '/', scope: './', icons: ICONS }));
    const { status, output } = run(dir);
    expect(output).toMatch(/start_url is "\/"/);
    expect(status).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
