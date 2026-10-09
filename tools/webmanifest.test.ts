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
// @ts-expect-error -- plain .mjs, deliberately dependency-free so the workflows can run it
import { metaTags } from './portability/check.mjs';

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
  description: string;
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

  it('describes the game in one count-free sentence, shared with index.html', () => {
    // Three copies of one sentence, in two files: the page's meta description, its
    // og:description, and this manifest's description. All three still said "three enemy
    // personalities" after the roster grew to six (#772). A count in this sentence goes
    // stale whenever the roster changes, so the sentence states none.
    const meta = html.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1];
    const og = html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/)?.[1];
    expect(meta, 'index.html has no meta description').toBeTruthy();
    expect(og, 'og:description differs from the meta description').toBe(meta);
    expect(manifest.description, 'the manifest description differs from index.html').toBe(meta);
    expect(meta).not.toMatch(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
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
    // deletes every CacheStorage entry it does not own (docs/agent/commands-and-operations.md),
    // so a service worker here fights one this repo cannot edit. The manifest is exactly the
    // change that invites somebody to add one next, which is why the constraint gets an
    // assertion rather than another paragraph.
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

/**
 * THE LINK-CARD IMAGE (issue #973), checked at SOURCE: the tags agree with each other and
 * with the file they name. `tools/portability/check.mjs` checks the BUILT output carries it.
 *
 * A pure helper over the page's text and the PNG's facts, so the negative controls below are
 * one-field edits of the REAL index.html and the REAL file's facts. They are the named
 * controls this guard has, because the mutation harness cannot reach index.html: it relates a
 * test to a file only through import edges, and a readFileSync is not one.
 */
const SHARE_IMAGE_MAX_BYTES = 2_097_152;
const SHARE_IMAGE_SIZE = { width: 1200, height: 630 };

interface PngFacts {
  png: boolean;
  bytes: number;
  width: number;
  height: number;
}

/** What is wrong with the share-image tags and file, one message per rule broken. */
function shareImageFailures(page: string, factsFor: (publicPath: string) => PngFacts | null): string[] {
  const tags = metaTags(page) as Record<string, string>[];
  const og = (p: string): string | undefined => tags.find((t) => t.property === p)?.content;
  const tw = (n: string): string | undefined => tags.find((t) => t.name === n)?.content;
  const url = og('og:image');
  if (url === undefined) return ['index.html has no og:image'];
  const failures: string[] = [];
  const canonical = page.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/)?.[1] ?? '';
  const underCanonical = canonical !== '' && url.startsWith(canonical);
  const facts = underCanonical ? factsFor(url.slice(canonical.length)) : null;
  if (!underCanonical) {
    failures.push(`og:image ${url} does not start with the canonical href ${canonical || '(none)'}`);
  } else if (facts === null) {
    failures.push(`og:image names ${url.slice(canonical.length)}, which is not a file under public/`);
  }
  if (facts !== null) {
    if (!facts.png) failures.push('the share image is not a PNG');
    if (facts.bytes > SHARE_IMAGE_MAX_BYTES) {
      failures.push(`the share image is ${facts.bytes} bytes, over the ${SHARE_IMAGE_MAX_BYTES} ceiling`);
    }
    if (String(facts.width) !== og('og:image:width') || String(facts.height) !== og('og:image:height')) {
      failures.push(
        `the share image is ${facts.width}x${facts.height}, but og:image:width/height say ` +
          `${og('og:image:width')}x${og('og:image:height')}`,
      );
    }
    if (facts.width !== SHARE_IMAGE_SIZE.width || facts.height !== SHARE_IMAGE_SIZE.height) {
      failures.push(
        `the share image is ${facts.width}x${facts.height}, not ${SHARE_IMAGE_SIZE.width}x${SHARE_IMAGE_SIZE.height}`,
      );
    }
  }
  if (og('og:image:type') !== 'image/png') failures.push(`og:image:type is ${og('og:image:type')}, not image/png`);
  if (tw('twitter:card') !== 'summary_large_image') {
    failures.push(`twitter:card is ${tw('twitter:card')}, not summary_large_image`);
  }
  if (tw('twitter:image') !== url) failures.push('twitter:image differs from og:image');
  const alt = og('og:image:alt') ?? '';
  if (alt.trim() === '') failures.push('og:image:alt is empty');
  if (alt.length > 500) failures.push(`og:image:alt is ${alt.length} characters, over 500`);
  if (alt !== '' && alt === og('og:title')) failures.push('og:image:alt repeats og:title');
  if (alt !== '' && alt === og('og:description')) failures.push('og:image:alt repeats og:description');
  if (tw('twitter:image:alt') !== alt) failures.push('twitter:image:alt differs from og:image:alt');
  return failures;
}

/**
 * The real file's facts, read off its bytes and its IHDR chunk -- the header alone, not
 * `decodePng`, which decodes only the RGBA icons this file's other cases read and refuses an
 * RGB photo-like frame.
 */
function realFacts(publicPath: string): PngFacts | null {
  const file = repo(join('public', publicPath));
  try {
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  const bytes = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(signature)
    && bytes.subarray(12, 16).toString('latin1') === 'IHDR';
  return {
    png,
    bytes: bytes.length,
    width: png ? bytes.readUInt32BE(16) : 0,
    height: png ? bytes.readUInt32BE(20) : 0,
  };
}

describe('the link-card image (issue #973)', () => {
  const real = realFacts('share-image.png');
  const facts = (over: Partial<PngFacts>) => (): PngFacts => ({ ...(real as PngFacts), ...over });
  /** The real page with one tag's content replaced; every tag here is `<meta attr="key" content="...">`. */
  const withTag = (page: string, attr: 'property' | 'name', key: string, value: string): string => {
    const re = new RegExp(`(<meta\\s+${attr}="${key}"\\s+content=")[^"]*(")`);
    expect(re.test(page), `${key} is not in index.html in the expected shape`).toBe(true);
    return page.replace(re, `$1${value}$2`);
  };
  /** Both alt texts at once, so a rule on the alt is tested without tripping the "they agree" rule. */
  const withAlt = (value: string): string =>
    withTag(withTag(html, 'property', 'og:image:alt', value), 'name', 'twitter:image:alt', value);
  /** og:image and twitter:image together, for the same reason. */
  const withImage = (value: string): string =>
    withTag(withTag(html, 'property', 'og:image', value), 'name', 'twitter:image', value);
  const content = (key: string): string =>
    html.match(new RegExp(`<meta\\s+property="${key}"\\s+content="([^"]*)"`))?.[1] ?? '';

  it('holds on the real page and the real file', () => {
    expect(real, 'public/share-image.png is missing').not.toBeNull();
    expect(shareImageFailures(html, realFacts)).toEqual([]);
  });

  // The negative controls: each changes ONE field of the real page or of the real file's facts
  // (a field written in two tags changes in both), and each must fail with exactly the one
  // message that names it.
  it.each([
    ['og:image is missing',
      () => shareImageFailures(html.replace(/<meta\s+property="og:image"\s+content="[^"]*"\s*\/>/, ''), realFacts),
      /has no og:image/],
    ['og:image is not under the canonical href',
      () => shareImageFailures(withImage('https://example.com/tanks/share-image.png'), realFacts),
      /does not start with the canonical href/],
    ['og:image names no file under public/',
      () => shareImageFailures(withImage('https://austinorphan.com/tanks/missing.png'), realFacts),
      /not a file under public/],
    ['the file is not a PNG',
      () => shareImageFailures(html, facts({ png: false })),
      /not a PNG/],
    ['the file is over the byte ceiling',
      () => shareImageFailures(html, facts({ bytes: SHARE_IMAGE_MAX_BYTES + 1 })),
      /over the 2097152 ceiling/],
    ['og:image:width disagrees with the header',
      () => shareImageFailures(withTag(html, 'property', 'og:image:width', '1201'), realFacts),
      /og:image:width\/height say 1201x630/],
    ['og:image:height disagrees with the header',
      () => shareImageFailures(withTag(html, 'property', 'og:image:height', '631'), realFacts),
      /og:image:width\/height say 1200x631/],
    ['the header is not 1200x630, though the tags agree with it',
      () => shareImageFailures(
        withTag(withTag(html, 'property', 'og:image:width', '1000'), 'property', 'og:image:height', '525'),
        facts({ width: 1000, height: 525 }),
      ),
      /is 1000x525, not 1200x630/],
    ['og:image:type is not image/png',
      () => shareImageFailures(withTag(html, 'property', 'og:image:type', 'image/jpeg'), realFacts),
      /og:image:type is image\/jpeg/],
    ['twitter:card is not summary_large_image',
      () => shareImageFailures(withTag(html, 'name', 'twitter:card', 'summary'), realFacts),
      /twitter:card is summary,/],
    ['twitter:image differs from og:image',
      () => shareImageFailures(withTag(html, 'name', 'twitter:image', 'https://austinorphan.com/tanks/other.png'), realFacts),
      /twitter:image differs/],
    ['og:image:alt is empty',
      () => shareImageFailures(withAlt(''), realFacts),
      /og:image:alt is empty/],
    ['og:image:alt is over 500 characters',
      () => shareImageFailures(withAlt('a'.repeat(501)), realFacts),
      /501 characters, over 500/],
    ['og:image:alt repeats og:title',
      () => shareImageFailures(withAlt(content('og:title')), realFacts),
      /repeats og:title/],
    ['og:image:alt repeats og:description',
      () => shareImageFailures(withAlt(content('og:description')), realFacts),
      /repeats og:description/],
    ['twitter:image:alt differs from og:image:alt',
      () => shareImageFailures(withTag(html, 'name', 'twitter:image:alt', 'Something else.'), realFacts),
      /twitter:image:alt differs/],
  ] as const)('fails when %s', (_label, run, message) => {
    const failures = run();
    expect(failures, JSON.stringify(failures)).toHaveLength(1);
    expect(failures[0]).toMatch(message);
  });
});
