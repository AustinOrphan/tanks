/**
 * `public/manifest.webmanifest` and `public/icons/` are copied verbatim into `dist/` by
 * vite and are read by NOTHING in the bundle -- the same hole `index-html.test.ts` and
 * `hud.css.test.ts` exist to close one file over. A manifest that fails to parse, or
 * that names an icon nobody committed, or whose declared `sizes` disagree with the PNG's
 * real header, is not an error anywhere: the page loads, the game plays, and Add to Home
 * Screen is silently unavailable or installs a blank tile.
 *
 * Split of duties with `tools/portability/check.mjs`: that runs in CI against the BUILT
 * output and asserts the deploy-subpath properties (relative hrefs surviving the build);
 * this runs in `npm test` against the SOURCE and asserts the content is coherent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
// @ts-expect-error -- plain .mjs, deliberately dependency-free (it is also the CLI that
// writes these files); `render.test.ts` is its own guard.
import { decodePng } from './icons/render.mjs';

const repo = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));

const manifestText = readFileSync(repo('public/manifest.webmanifest'), 'utf8');
const html = readFileSync(repo('index.html'), 'utf8');

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}
interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: Icon[];
}

describe('the web app manifest', () => {
  it('is valid JSON at all', () => {
    // The vacuity guard: every assertion below runs against the parse, so a file that
    // does not parse must fail HERE with a readable message rather than as nine
    // confusing failures. A trailing comma is the way this file will break.
    expect(() => JSON.parse(manifestText) as Manifest).not.toThrow();
    expect(manifestText.length).toBeGreaterThan(200);
  });

  const manifest = JSON.parse(manifestText) as Manifest;

  it('starts and scopes RELATIVELY, so the installed app opens the game', () => {
    // Both resolve against the manifest's own URL. `"/"` would resolve to
    // austinorphan.com's root -- the portfolio -- so the installed icon would launch
    // somebody else's page, and `scope: "/"` would additionally claim every project
    // page on the origin. This is the same `base: './'` rule the whole build turns on,
    // one file further out, and nothing else in `npm test` covers this file.
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    for (const icon of manifest.icons) expect(icon.src.startsWith('./')).toBe(true);
  });

  it('installs as an APP, not as a browser tab, and is installable at all', () => {
    // Both of these were unpinned, and both were proved so before this case was
    // written: `"display": "standalone"` -> `"browser"` passed all 30 tests across
    // this file and `tools/portability/check.test.ts`, and `"name": "Tanks!"` -> `""`
    // passed all 6 here.
    //
    // `display` is the single field that decides whether the installed icon opens a
    // chromeless app or a browser tab -- which is the whole of issue #107 -- and
    // `name`/`short_name` are Chrome's installability floor: an empty `name` makes the
    // manifest silently uninstallable, with the page still loading and playing
    // perfectly, which is exactly the failure mode this file exists to catch.
    //
    // `standalone` is a DECISION, recorded in the PR and in the backlog: both platforms
    // honour it predictably, where iOS's handling of `fullscreen` was not verified. So
    // this is pinned as the literal rather than as "one of the app-like values" -- a
    // change to `fullscreen` should be deliberate and should land with the verification
    // that is currently missing.
    expect(manifest.display).toBe('standalone');
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeGreaterThan(0);
    // Chrome truncates `short_name` on a home screen at around a dozen characters; the
    // bound is generous rather than exact, and its job is to catch a name pasted in from
    // the description field, not to pick a length.
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  it('agrees with index.html on the colours the launch screen is painted in', () => {
    // `background_color` is what the platform paints while the bundle boots, before a
    // single frame is drawn. If it disagrees with the page's own background the launch
    // flashes a different colour and then settles -- which reads as a bug and is
    // invisible to every other test, because the two values live in two files that
    // nothing checks against each other.
    expect(html).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
    expect(html).toContain(`background: ${manifest.background_color};`);
  });

  it('declares icons that exist, at the size they claim', () => {
    // A declared-but-missing icon is a 404 during install and nothing else; a size that
    // disagrees with the file is worse, because Chrome picks by the DECLARED size and
    // then scales whatever it gets. Both are read straight off the PNG header here.
    const seen: string[] = [];
    for (const icon of manifest.icons) {
      const file = repo(join('public', icon.src));
      expect(statSync(file).isFile(), `${icon.src} is declared but not committed`).toBe(true);
      const png = decodePng(readFileSync(file)) as { width: number; height: number };
      expect(`${png.width}x${png.height}`, `${icon.src} lies about its size`).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
      seen.push(icon.src);
    }
    // Population: every icon the manifest declares -- 3 today, and the count is not
    // pinned, because adding one is not a regression.
    expect(seen.length).toBe(manifest.icons.length);
    expect(seen.length).toBeGreaterThan(0);

    // Chrome's installability floor is one icon of at least 192px; Android crops any
    // non-maskable icon into a white circle, which is why the maskable one is not
    // optional if the result is to look drawn rather than pasted.
    const any = manifest.icons.filter((i) => i.purpose === 'any');
    expect(any.some((i) => parseInt(i.sizes, 10) >= 192)).toBe(true);
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('gives iOS an opaque square icon, which is the only one it will read', () => {
    // iOS reads neither the manifest's icons nor an SVG favicon for Add to Home Screen.
    // It also applies its OWN corner mask and composites transparency onto a solid
    // background, so pointing this link at `icon-192.png` -- rounded, and therefore
    // transparent outside the radius -- would give a tile with four pale notches. That
    // mutation is what this assertion kills: it is not a restatement of the generator.
    const href = html.match(/<link[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/)?.[1];
    expect(href, 'index.html links no apple-touch-icon').toBeTruthy();
    const png = decodePng(readFileSync(repo(join('public', href as string)))) as {
      width: number;
      height: number;
      rgba: Uint8Array;
    };
    expect(png.width).toBe(png.height);
    expect(png.width).toBeGreaterThanOrEqual(180);
    let transparent = 0;
    for (let i = 3; i < png.rgba.length; i += 4) if (png.rgba[i] !== 255) transparent++;
    expect(transparent, 'the iOS tile has transparent pixels to composite').toBe(0);
  });

  it('registers no service worker anywhere the bundle can reach', () => {
    // Not a preference: the portfolio's root-scoped /sw.js already controls /tanks/ and
    // deletes every CacheStorage entry it does not own (CLAUDE.md), so a service worker
    // here fights one this repo cannot edit. The manifest is exactly the change that
    // invites somebody to add one next, which is why the constraint gets an assertion
    // rather than another paragraph.
    //
    // Population: every non-test .ts file under src/ (the code that ships), plus
    // index.html. NOT swept: tools/, docs/, and *.test.ts -- a registration there does
    // not reach a player.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
            ? [join(dir, e.name)]
            : [],
      );
    const files = [...walk(repo('src')), repo('index.html')];
    expect(files.length).toBeGreaterThan(50);
    // Case-SENSITIVE: `serviceWorker` is the API's spelling, and matching it
    // case-insensitively would also fire on the prose "service worker" in index.html's
    // comment explaining why there is none.
    const offenders = files.filter((f) => /serviceWorker|workbox/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(repo(''), ''))).toEqual([]);
  });
});
