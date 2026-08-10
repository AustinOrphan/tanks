/**
 * The subpath-portability gate, in one place because BOTH ci.yml and pages.yml run it.
 *
 * It used to be a shell block pasted into both files. That is the `devflags.ts`
 * divergence in a new costume -- two copies of one rule, in the two files nothing
 * typechecks and no test reads -- and the copies were already weaker than they looked.
 * Measured, on the real bundle:
 *
 *   - `! grep -qE '"/(audio|assets)/' dist/assets/*.js` PASSED on a dist/ with no
 *     JavaScript at all: grep exits 2 for a non-matching glob and `!` turns that into 0.
 *   - It also passed the mutation it was written for. Reverting manifest.ts to
 *     `const BASE = '/'` ships ten origin-absolute audio URLs, and the grep does not
 *     fire, because the minifier keeps the base as a VARIABLE -- the emitted form is
 *     `${ch}audio/cannon.wav` with `ch="/"`, never a matchable string literal.
 *     (Reproduced under both vite 5.4.21 and vite 8.1.5.)
 *
 * Three failure modes, each with a live mutation that kills exactly one check:
 *
 *   1. `base` in vite.config.ts stops being './'  ->  index.html asks for /assets/...,
 *      and the project page is blank on any host that is not a domain root.
 *   2. Source writes a bare '/audio/x.wav' instead of `${BASE}audio/x.wav`. `base` does
 *      NOT fix that: a plain string in public/ is opaque to the bundler (see the comment
 *      in src/audio/manifest.ts), so it survives into the bundle as an absolute path.
 *   3. The manifest's BASE stops being `import.meta.env.BASE_URL`. Nothing about
 *      index.html changes, and no absolute literal appears -- only the value bound to
 *      the template's base variable moves. This is the one the greps could not see.
 *
 * None of the three is visible to the unit suite: under Vitest `import.meta.env.BASE_URL`
 * is '/' even though vitest.config reads the same `base: './'`. Only an assertion against
 * the BUILT output can observe the real base, which is why this runs in CI and not in
 * `npm test`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The asset family whose URLs must never be origin-absolute. */
const ASSET_DIRS = 'audio|assets';
/**
 * A file the audio manifest would request, used to locate the runtime base.
 *
 * Nothing requests it TODAY: `AUDIO_MANIFEST` deliberately declares no files, because
 * none has ever been committed, so `audioUrl` is tree-shaken out of the bundle
 * entirely. Check (3) below therefore has nothing to probe -- which this file treats
 * as a state to ASSERT rather than a reason to go quiet, since a guard that silently
 * finds nothing is the exact failure the hud.css lesson is about.
 */
const PROBE_ASSET = 'audio/cannon.wav';

/**
 * @param {string} indexHtml
 * @param {{name: string, source: string}[]} bundles
 * @returns {string[]} one message per failure; empty means portable
 */
export function portabilityFailures(indexHtml, bundles) {
  const failures = [];

  // (1) index.html must reach its assets relatively.
  if (!/src="\.\/assets\//.test(indexHtml)) {
    const tags = indexHtml.match(/<script[^>]*>/g) ?? [];
    failures.push(`index.html does not reference assets relatively:\n  ${tags.join('\n  ')}`);
  }

  // The guard that makes the rest non-vacuous. The shell version passed on an empty
  // dist/; a build that emitted no JavaScript must be a failure, not a silent success.
  if (bundles.length === 0) {
    failures.push('no JS bundle found under assets/ -- the build produced nothing to check');
    return failures;
  }

  let probeSeen = false;
  for (const { name, source } of bundles) {
    // (2) No origin-absolute asset literal anywhere in the bundle -- in ANY quote style.
    // The shell version this replaces matched double quotes only, which is what vite 5
    // emitted. vite 8 minifies the same source to a BACKTICK template
    // (`` `/audio/cannon.wav` ``), so the old grep stopped firing when the toolchain
    // moved and nothing said so.
    const absolute = [
      ...new Set(source.match(new RegExp(`["'\`]/(${ASSET_DIRS})/[^"'\`]*["'\`]`, 'g')) ?? []),
    ];
    if (absolute.length) {
      failures.push(`${name} contains origin-absolute asset paths:\n  ${absolute.join('\n  ')}`);
    }

    // (3) The runtime base the manifest interpolates must itself be relative. The
    // minified form is `${id}audio/cannon.wav`; find `id`, then the literal bound to it.
    const templated = source.match(
      new RegExp(`\\$\\{([A-Za-z_$][\\w$]*)\\}${PROBE_ASSET.replace('.', '\\.')}`),
    );
    if (templated) {
      probeSeen = true;
      const id = templated[1].replace(/\$/g, '\\$');
      const bound = source.match(new RegExp(`[,;{(]\\s*${id}\\s*=\\s*("[^"]*"|\`[^\`]*\`)`));
      const base = bound ? bound[1].slice(1, -1) : null;
      if (base === null) {
        failures.push(`${name}: found \${${templated[1]}}${PROBE_ASSET} but could not read the value bound to ${templated[1]}`);
      } else if (!base.startsWith('./')) {
        failures.push(
          `${name}: the audio base is not relative -- \${${templated[1]}} = ${JSON.stringify(base)}, ` +
            `so every asset URL resolves against the origin root instead of the deploy subpath. ` +
            `Check that src/audio/manifest.ts still reads import.meta.env.BASE_URL.`,
        );
      }
    } else if (new RegExp(`["'\`][^"'\`]*${PROBE_ASSET.replace('.', '\\.')}`).test(source)) {
      // Folded to a literal by some future minifier: check (2) above already judged it.
      probeSeen = true;
    }
  }

  // The hud.css lesson: a guard that finds nothing to check must say so rather than
  // report success. If the probe asset vanishes, check (3) stops meaning anything.
  //
  // But "vanished" has two causes, and only one is a bug. The manifest ships EMPTY on
  // purpose, so no audio URL reaches the bundle at all and there is genuinely nothing
  // to interpolate. That state is checkable in its own right: assert the absence is
  // TOTAL. If any asset-family URL is present while the probe is not, the probe has
  // rotted against a bundle that does still carry assets, and it must be updated.
  if (!probeSeen) {
    // An audio FILE reference, which needs three qualifications to be meaningful here:
    // not the full ASSET_DIRS (`assets/` matches vite's own chunk names, always
    // present), and a filename with an extension (a bare `audio/wav` is one of Howler's
    // dozen MIME-type literals, which ship in every bundle and would pin this branch on
    // forever).
    // Every Howler-supported extension, case-insensitive, PLUS the computed form
    // `${id}audio/${k}.wav` -- a key-driven loop over the manifest is the natural next
    // edit here, and review measured that shape walking straight through the first
    // draft. `audio/aac` and friends are MIME literals in every bundle, which is why a
    // filename (a dot and an extension) is required rather than a bare `audio/`.
    const AUDIO_FILE =
      /audio\/(?:\$\{[^}]*\}|[\w-]+)\.(?:wav|mp3|ogg|oga|m4a|m4b|mp4|aac|caf|weba|webm|dolby|flac|opus)\b/i;
    const anyAudioUrl = bundles.some(({ source }) => AUDIO_FILE.test(source));
    if (anyAudioUrl) {
      failures.push(
        `no reference to ${PROBE_ASSET} in any bundle, but the bundle DOES carry other ` +
          `audio/ URLs -- so the probe has rotted rather than the audio having gone. ` +
          `Update PROBE_ASSET to one the manifest still requests.`,
      );
    }
    // Otherwise: no asset URLs at all, which is the empty-manifest state. Check (2)
    // still ran over every bundle and found no origin-absolute path -- vacuously, and
    // that is the honest reading. Re-arms by itself the moment an asset is declared.
  }

  return failures;
}

/**
 * The same rule, one layer out: the PWA shell.
 *
 * A web app manifest carries two more URLs that resolve against an origin, and both are
 * silent when wrong. `start_url: "/"` installs a shortcut that opens the origin ROOT --
 * austinorphan.com's portfolio, not /tanks/ -- and `scope: "/"` claims every other
 * project page on the domain. Neither shows up in the browser, in the bundle, or in any
 * unit test: the game plays fine and only the INSTALLED copy is wrong.
 *
 * Presence is asserted, not merely shape. `hud.css.test.ts`'s lesson is that a guard
 * which finds nothing must say so rather than report success -- so removing the manifest
 * fails here, deliberately, and removing it on purpose means deleting this check too.
 *
 * @param {string} indexHtml
 * @param {{files: string[], texts: Record<string, string>}} dist  every file in the
 *   built tree (posix-relative), and the text of the ones worth reading
 * @returns {string[]}
 */
export function manifestFailures(indexHtml, dist) {
  const failures = [];
  /** `./icons/x.png` -> `icons/x.png`; anything not relative is reported by the caller. */
  const toPath = (href) => href.replace(/^\.\//, '');
  const link = (rel) =>
    indexHtml.match(new RegExp(`<link[^>]*rel="${rel}"[^>]*href="([^"]+)"`)) ??
    indexHtml.match(new RegExp(`<link[^>]*href="([^"]+)"[^>]*rel="${rel}"`));

  const manifestLink = link('manifest');
  if (!manifestLink) {
    failures.push(
      'index.html links no web app manifest -- Add to Home Screen is silently unavailable. ' +
        'If that is deliberate, delete this check with it.',
    );
    return failures;
  }
  const href = manifestLink[1];
  if (!href.startsWith('./')) {
    failures.push(
      `index.html links the manifest as ${JSON.stringify(href)}, which resolves against the ` +
        `origin root rather than the deploy subpath.`,
    );
  }
  const manifestPath = toPath(href);
  const text = dist.texts[manifestPath];
  if (text === undefined) {
    failures.push(`${manifestPath} is linked by index.html but is not in the built output`);
    return failures;
  }

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    failures.push(`${manifestPath} is not valid JSON: ${e.message}`);
    return failures;
  }

  for (const field of ['start_url', 'scope']) {
    const value = manifest[field];
    if (typeof value !== 'string' || !value.startsWith('./')) {
      failures.push(
        `${manifestPath}: ${field} is ${JSON.stringify(value)} -- it resolves against the ` +
          `manifest's URL, so anything not relative launches the origin root instead of the game.`,
      );
    }
  }

  // Icons, and the iOS tile, which is a link rather than a manifest entry.
  const referenced = [
    ...(Array.isArray(manifest.icons) ? manifest.icons.map((i) => i && i.src) : []),
    link('apple-touch-icon')?.[1],
  ];
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    failures.push(`${manifestPath} declares no icons, so nothing is installable`);
  }
  if (!link('apple-touch-icon')) {
    failures.push('index.html links no apple-touch-icon -- iOS reads no other icon source');
  }
  for (const src of referenced) {
    if (typeof src !== 'string') continue;
    if (!src.startsWith('./')) {
      failures.push(`${manifestPath}: icon ${JSON.stringify(src)} is not relative`);
      continue;
    }
    if (!dist.files.includes(toPath(src))) {
      failures.push(`${src} is referenced but missing from the built output`);
    }
  }
  return failures;
}

/** Every file under `dir`, as posix-relative paths. */
function walk(dir, prefix = '') {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name), `${prefix}${e.name}/`)
      : [`${prefix}${e.name}`],
  );
}

/** Read a built dist/ into the shape the two checkers take. */
export function readDist(dir) {
  const files = walk(dir);
  const texts = {};
  for (const f of files) {
    if (f.endsWith('.webmanifest') || f.endsWith('.json')) {
      texts[f] = readFileSync(join(dir, f), 'utf8');
    }
  }
  return {
    indexHtml: readFileSync(join(dir, 'index.html'), 'utf8'),
    bundles: files
      .filter((f) => f.startsWith('assets/') && f.endsWith('.js'))
      .map((f) => ({ name: f, source: readFileSync(join(dir, f), 'utf8') })),
    dist: { files, texts },
  };
}

// CLI only when invoked directly, so the test can import the pure functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? 'dist';
  const { indexHtml, bundles, dist } = readDist(dir);
  const failures = [
    ...portabilityFailures(indexHtml, bundles),
    ...manifestFailures(indexHtml, dist),
  ];
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(
    `subpath-portable: ${dir}/index.html + ${bundles.length} bundle(s) + the PWA shell checked`,
  );
}
