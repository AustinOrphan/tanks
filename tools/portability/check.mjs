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
/** A file the audio manifest is known to request, used to locate the runtime base. */
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
  // report success. If the probe asset vanishes, checks (2) and (3) stop meaning anything.
  if (!probeSeen) {
    failures.push(
      `no reference to ${PROBE_ASSET} in any bundle -- the audio manifest changed shape, ` +
        `so this check no longer proves anything. Update PROBE_ASSET.`,
    );
  }

  return failures;
}

/** Read a built dist/ into the shape `portabilityFailures` takes. */
export function readDist(dir) {
  const assetDir = join(dir, 'assets');
  let entries = [];
  try {
    entries = readdirSync(assetDir);
  } catch {
    entries = [];
  }
  return {
    indexHtml: readFileSync(join(dir, 'index.html'), 'utf8'),
    bundles: entries
      .filter((f) => f.endsWith('.js'))
      .map((f) => ({ name: `assets/${f}`, source: readFileSync(join(assetDir, f), 'utf8') })),
  };
}

// CLI only when invoked directly, so the test can import the pure functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? 'dist';
  const { indexHtml, bundles } = readDist(dir);
  const failures = portabilityFailures(indexHtml, bundles);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`subpath-portable: ${dir}/index.html + ${bundles.length} bundle(s) checked`);
}
