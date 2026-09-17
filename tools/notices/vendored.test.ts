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

// The vendored-source declaration (issue #771), checked against the tree it describes.
//
// The scanned population is every non-test `.ts`, `.mjs`, `.js` and `.cjs` file under `src/`
// and `tools/`. Two files are excluded because they quote the markers by design: the
// generated Legal page content, and the module that declares the markers.
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

/** Vendored files a licence document does not name in code spans. */
function unnamedIn(license: string, files: readonly string[]): string[] {
  return files.filter((f) => !license.includes(`\`${f}\``));
}

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

  it('renders every vendored source, its files and its notice into THIRD-PARTY-NOTICES.md', () => {
    const rendered = renderNotices();
    for (const source of VENDORED_SOURCES) {
      expect(rendered).toContain(`## ${source.name} (${source.license})`);
      for (const f of source.files) expect(rendered).toContain(`\`${f}\``);
      expect(rendered).toContain(noticeText(source));
    }
  });

  it('names every vendored file in CONTENT-LICENSE.md, which would otherwise class it as first-party code', () => {
    const license = readFileSync(join(ROOT, 'CONTENT-LICENSE.md'), 'utf8');
    expect(unnamedIn(license, vendoredFiles())).toEqual([]);
    // Negative control: the same document with hypot.ts's code span removed.
    const withoutHypot = license.replaceAll('`src/sim/math/hypot.ts`', 'hypot');
    expect(unnamedIn(withoutHypot, vendoredFiles())).toEqual(['src/sim/math/hypot.ts']);
  });
});
