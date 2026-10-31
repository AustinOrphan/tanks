import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIRST_PARTY_WITH_MARKERS,
  PROVENANCE_MARKERS,
  VENDORED_SOURCES,
  headerNotice,
  noticeText,
  vendoredFiles,
} from './vendored.mjs';
import { renderNotices } from './render.mjs';
import { parseLegalDocument } from '../legal/parse.mjs';

// The vendored-source declaration (issue #771), checked against the tree it describes.
//
// The scanned population is every non-test `.ts`, `.mjs`, `.js` and `.cjs` file under `src/`
// and `tools/`. Two files are excluded because they quote the markers by design: the
// generated Legal page content, and the module that declares the markers. The typefaces
// (issue #294's cutover audit) are not code, so their inventory reads `src/game/fonts/` itself.
const ROOT = new URL('../../', import.meta.url).pathname;
const QUOTES_THE_MARKERS = new Set(['src/game/legal-content.ts', 'tools/notices/vendored.mjs']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (name === 'node_modules') continue;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|mjs|js|cjs)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(rel);
  }
  return out;
}

/** Files carrying a provenance marker that neither declaration lists. */
function undeclared(
  files: readonly string[],
  vendored: readonly string[],
  firstParty: Record<string, string>,
): string[] {
  return files.filter((f) => {
    if (QUOTES_THE_MARKERS.has(f) || vendored.includes(f) || f in firstParty) return false;
    const text = readFileSync(join(ROOT, f), 'utf8');
    return PROVENANCE_MARKERS.some((m: RegExp) => m.test(text));
  });
}

/**
 * Vendored files a license text names neither by path nor under a `dir/**` glob, in code spans.
 * The glob is how CONTENT-LICENSE.md names the font directory (`src/game/fonts/**`).
 */
function unnamedIn(license: string, files: readonly string[]): string[] {
  const dirs = [...license.matchAll(/`([^`*]+)\/\*\*`/g)].map((m) => `${m[1]}/`);
  return files.filter((f) => !license.includes(`\`${f}\``) && !dirs.some((dir) => f.startsWith(dir)));
}

/**
 * CONTENT-LICENSE.md's vendored-source part: from its bold lead to the next one. A check over
 * the whole document would pass on its own, because the "Everything else is code" sentence
 * names `src/**`, a glob that covers every vendored file.
 */
function vendoredPart(license: string): string {
  const start = license.indexOf('**Third-party source vendored into `src/`**');
  const end = license.indexOf('**Then reserved content:**', start);
  if (start < 0 || end < 0) throw new Error('CONTENT-LICENSE.md has no vendored-source part');
  return license.slice(start, end);
}

/** The typefaces: the vendored sources whose files are all under `src/game/fonts/`. */
const FONT_SOURCES = VENDORED_SOURCES.filter((s: { files: readonly string[] }) =>
  s.files.every((f) => f.startsWith('src/game/fonts/')),
);

describe('vendored third-party source (issue #771)', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('tools')];

  it('declares every file carrying a third-party provenance marker, as vendored or as first-party with a reason', () => {
    expect(undeclared(files, vendoredFiles(), FIRST_PARTY_WITH_MARKERS)).toEqual([]);
    for (const [file, reason] of Object.entries(FIRST_PARTY_WITH_MARKERS)) {
      expect(files, `${file} is declared first-party but is not in the scan`).toContain(file);
      expect(reason.length, `${file} gives no reason`).toBeGreaterThan(20);
      // An exemption for a file no marker matches is stale, and hides a narrowed marker.
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(PROVENANCE_MARKERS.some((m: RegExp) => m.test(text)), `${file} matches no marker`).toBe(true);
    }
    // Negative control, which also shows the scan reads real files: without hypot.ts on the
    // vendored list, the scan names it.
    const withoutHypot = vendoredFiles().filter((f) => f !== 'src/sim/math/hypot.ts');
    expect(undeclared(files, withoutHypot, FIRST_PARTY_WITH_MARKERS)).toEqual([
      'src/sim/math/hypot.ts',
    ]);
  });

  it('accounts for every file under src/sim/math, so a new port cannot arrive unlisted', () => {
    const math = files.filter((f) => f.startsWith('src/sim/math/'));
    const listed = (f: string) => vendoredFiles().includes(f) || f in FIRST_PARTY_WITH_MARKERS;
    expect(math.filter((f) => !listed(f))).toEqual([]);
  });

  it('accounts for every font file under src/game/fonts, so a new face cannot ship without its notice', () => {
    // hud.css references every font file here, so the build emits each into dist/ whether a
    // page loads it or not, and each owes a notice. The directory is read directly: the scan
    // above takes code files only.
    const fonts = readdirSync(join(ROOT, 'src/game/fonts'))
      .filter((name) => /\.(woff2?|ttf|otf)$/.test(name))
      .map((name) => `src/game/fonts/${name}`);
    const unlisted = (declared: readonly string[]) => fonts.filter((f) => !declared.includes(f));
    expect(unlisted(vendoredFiles())).toEqual([]);
    // Negative control, which also shows the directory read finds real files: without Inter on
    // the vendored list, the inventory names it.
    const inter = 'src/game/fonts/inter-latin-wght-normal.woff2';
    expect(unlisted(vendoredFiles().filter((f) => f !== inter))).toEqual([inter]);
  });

  it('quotes the fdlibm notice from the source, identical in every fdlibm file', () => {
    const fdlibm = VENDORED_SOURCES.find((s: { name: string }) => s.name === 'fdlibm');
    const notice = noticeText(fdlibm);
    expect(notice).toMatch(/^Copyright \(C\) 1993 by Sun Microsystems, Inc\. All rights reserved\./);
    expect(notice).toMatch(/provided that this notice\nis preserved\.$/);
    for (const f of fdlibm.files) {
      expect(headerNotice(readFileSync(join(ROOT, f), 'utf8')), `${f}'s notice differs`).toBe(notice);
    }
    expect(() => headerNotice('/**\n * no notice here\n */')).toThrow(/no ===== notice block/);
  });

  it("stores V8's BSD licence whole, from its copyright line to its disclaimer", () => {
    const v8 = VENDORED_SOURCES.find((s: { name: string }) => s.name === 'V8');
    const text = noticeText(v8);
    expect(text.startsWith('Copyright 2014, the V8 project authors. All rights reserved.')).toBe(true);
    // The third clause is what makes it BSD-3-Clause rather than BSD-2-Clause.
    expect(text).toContain('Neither the name of Google Inc. nor the names of its');
    expect(text.endsWith('EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.')).toBe(true);
  });

  it("stores each typeface's SIL Open Font License whole, under that face's own copyright line", () => {
    // Spelled out per face from each package's own LICENSE file. A face pointed at another
    // face's license file still carries a whole OFL, so only the copyright line tells them
    // apart: IBM Plex Sans and IBM Plex Mono differ in the year alone.
    const copyright: Record<string, string> = {
      'IBM Plex Sans': 'Copyright 2019 IBM Corp. All rights reserved.',
      'IBM Plex Mono': 'Copyright 2017 IBM Corp. All rights reserved.',
      'Atkinson Hyperlegible': 'Copyright 2020 Braille Institute of America, Inc.',
      Inter: 'Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)',
    };
    expect(FONT_SOURCES.map((s: { name: string }) => s.name)).toEqual(Object.keys(copyright));
    const isWholeOfl = (text: string) =>
      text.includes('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007') &&
      text.endsWith('OTHER DEALINGS IN THE FONT SOFTWARE.');
    for (const source of FONT_SOURCES) {
      const text = noticeText(source);
      expect(text.startsWith(copyright[source.name]), `${source.name}'s copyright line`).toBe(true);
      expect(isWholeOfl(text), `${source.name}'s license is not a whole OFL 1.1`).toBe(true);
    }
    // Negative controls: V8's license is not an OFL, and an OFL cut short is not whole.
    const v8 = VENDORED_SOURCES.find((s: { name: string }) => s.name === 'V8');
    expect(isWholeOfl(noticeText(v8))).toBe(false);
    const plexSans = noticeText(FONT_SOURCES[0]);
    expect(isWholeOfl(plexSans.slice(0, plexSans.indexOf('TERMINATION')))).toBe(false);
  });

  it('gives each typeface the package and version src/game/fonts/README.md records for its files', () => {
    // The version is written twice, in the declaration and in the README's tables. An update
    // that refreshes one leaves the notices citing a package the files did not come from.
    const readme = readFileSync(join(ROOT, 'src/game/fonts/README.md'), 'utf8');
    const drifted = (doc: string): string[] => {
      const packageOf = new Map(
        [...doc.matchAll(/^\| `([^`]+\.woff2)` \|.*\| `(@[^`]+)` \|$/gm)].map((m) => [
          `src/game/fonts/${m[1]}`,
          m[2],
        ]),
      );
      return FONT_SOURCES.flatMap((s: { origin: string; files: readonly string[] }) =>
        s.files.filter((f) => !packageOf.has(f) || !s.origin.includes(packageOf.get(f) as string)),
      );
    };
    expect(drifted(readme)).toEqual([]);
    // Negative control: the README moves Inter to a new version and the declaration does not.
    const bumped = readme.replace('`@fontsource-variable/inter@5.3.0`', '`@fontsource-variable/inter@5.4.0`');
    expect(drifted(bumped)).toEqual(['src/game/fonts/inter-latin-wght-normal.woff2']);
  });

  it('renders every vendored source, its files and its notice into THIRD-PARTY-NOTICES.md', () => {
    const rendered = renderNotices();
    for (const source of VENDORED_SOURCES) {
      expect(rendered).toContain(`\n### ${source.name} (${source.license})\n`);
      for (const f of source.files) expect(rendered).toContain(`\`${f}\``);
      expect(rendered).toContain(noticeText(source));
    }
  });

  it('keeps the notices untitled, so the Legal page heads them with their own label', () => {
    // The Legal page takes a document's first H1 as its title. THIRD-PARTY-NOTICES.md has
    // none, so the pane shows its label; a vendored part rendered as an H1 retitled the whole
    // document "Vendored source".
    expect(parseLegalDocument(renderNotices(), 'THIRD-PARTY-NOTICES.md').title).toBeNull();
  });

  it('names every vendored file in CONTENT-LICENSE.md, which would otherwise class it as first-party code', () => {
    const license = readFileSync(join(ROOT, 'CONTENT-LICENSE.md'), 'utf8');
    const unnamed = (doc: string) => unnamedIn(vendoredPart(doc), vendoredFiles());
    expect(unnamed(license)).toEqual([]);
    // Negative control: the same document with hypot.ts's code span removed.
    expect(unnamed(license.replaceAll('`src/sim/math/hypot.ts`', 'hypot'))).toEqual(['src/sim/math/hypot.ts']);
    // Negative control: without the fonts' glob every font file is unnamed, although the
    // document's `src/**` still covers them outside the vendored part.
    expect(unnamed(license.replaceAll('`src/game/fonts/**`', 'src/game/fonts'))).toEqual([
      'src/game/fonts/atkinson-hyperlegible-latin-400-normal.woff2',
      'src/game/fonts/atkinson-hyperlegible-latin-700-normal.woff2',
      'src/game/fonts/ibm-plex-mono-latin-400-normal.woff2',
      'src/game/fonts/ibm-plex-mono-latin-600-normal.woff2',
      'src/game/fonts/ibm-plex-sans-latin-wght-normal.woff2',
      'src/game/fonts/inter-latin-wght-normal.woff2',
    ]);
  });
});
