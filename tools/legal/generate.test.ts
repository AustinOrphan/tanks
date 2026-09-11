// src/game/legal-content.ts is generated from the repository's own legal documents --
// see tools/legal/parse.mjs and render.mjs. Same regenerate-and-diff idiom as
// tools/notices/generate.test.ts, tools/devflags/doc.test.ts and tools/tanks/doc.test.ts,
// applied to a TypeScript module instead of a markdown page: regenerate in memory, compare
// against what's committed, fail if they differ. The fix for a red run here is
// `npm run legal`, never hand-editing this test or the generated module.
//
// The production mistakes this guards against, named so a reader can check each negative
// control without re-deriving it:
//  1. Edit PRIVACY.md (or any of the five) without running `npm run legal` -- the
//     byte-identical comparison fails, because the committed module still carries the old
//     text. This is the whole point: issue #117's "no legal content is duplicated into a
//     hand-maintained list that can drift from repository sources" is enforced HERE, at the
//     one place a copy can go stale.
//  2. Hand-edit src/game/legal-content.ts (reword a sentence, delete a clause) -- same
//     comparison, same failure.
//  3. Add a runtime dependency without running `npm run notices` FIRST -- the notices
//     document is itself generated, so the chain is package.json -> THIRD-PARTY-NOTICES.md
//     -> legal-content.ts, and the "every document's text is present" case below fails on
//     the missing package name.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderLegalModule } from './render.mjs';
import { LEGAL_SOURCES, inlineText, parseLegalDocument, legalLinks } from './parse.mjs';

const OUT = fileURLToPath(new URL('../../src/game/legal-content.ts', import.meta.url));
const repoFile = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8');

describe('src/game/legal-content.ts is generated, not hand-edited', () => {
  it('matches what renderLegalModule() produces right now -- run `npm run legal` to fix', () => {
    const generated = renderLegalModule();
    // Vacuity guard: an empty generated string would make the equality below pass trivially
    // against an accidentally-emptied module, the same trap tools/notices/generate.test.ts
    // and tools/devflags/doc.test.ts each document. 20 KB is well under the ~25 KB the five
    // documents produce today and well over anything a broken generator would emit.
    expect(generated.length).toBeGreaterThan(20_000);
    expect(readFileSync(OUT, 'utf8')).toBe(generated);
  });

  it('self-describes as generated', () => {
    const committed = readFileSync(OUT, 'utf8');
    expect(committed).toContain('GENERATED');
    expect(committed).toContain('npm run legal');
  });

  it('carries every source document, and names each one in the module it generates', () => {
    const committed = readFileSync(OUT, 'utf8');
    // Derived from LEGAL_SOURCES rather than a literal list, so adding a sixth document
    // needs `npm run legal` and nothing else.
    expect(LEGAL_SOURCES.length).toBeGreaterThan(0);
    for (const entry of LEGAL_SOURCES) {
      expect(committed).toContain(`source: '${entry.source}'`);
      expect(committed).toContain(`id: '${entry.id}'`);
    }
  });

  it('carries text that is only in each document, so no document is silently empty', () => {
    // One distinctive sentence per file, spelled through `inlineText` because that is what
    // the generator stores. A document whose blocks came out empty -- the failure a
    // parser change is most likely to cause, and the one the byte comparison above cannot
    // distinguish from a deliberate edit -- fails here with the file named.
    const committed = readFileSync(OUT, 'utf8');
    const witnesses: ReadonlyArray<readonly [string, string]> = [
      ['PRIVACY.md', 'The game collects **no data**.'],
      ['CREDITS.md', '**No AI-generated audio.**'],
      ['THIRD-PARTY-NOTICES.md', 'Permission is hereby granted, free of charge'],
      ['LICENSE', 'PolyForm Shield License 1.0.0'],
      ['CONTENT-LICENSE.md', '**Copyright Austin Orphan. All rights reserved.**'],
    ];
    for (const [file, raw] of witnesses) {
      // The witness has to be present in the SOURCE too, or this case pins a sentence that
      // has already been reworded away and silently stops measuring the document.
      expect(repoFile(file), `${file} no longer contains its witness sentence`).toContain(raw);
      const escaped = inlineText(raw).split("'").join("\\'");
      expect(committed, `${file}'s text is missing from the generated module`).toContain(escaped);
    }
  });

  it('reads both outbound URLs out of the documents that state them', () => {
    // Not "the links are non-empty" -- that passes on a regex that silently matched the
    // wrong line. Each URL is compared against the file it is read from.
    const links = legalLinks();
    expect(links.map((l) => l.id)).toEqual(['site', 'contact']);
    for (const link of links) {
      expect(link.url).toMatch(/^https:\/\//);
    }
    expect(repoFile('README.md')).toContain(`[Play it](${links[0].url})`);
    expect(repoFile('PRIVACY.md')).toContain(`](${links[1].url})`);
  });

  it('refuses a construct it would otherwise drop on the floor', () => {
    // The negative control for `assertSupported`. Each of these renders as something WRONG
    // rather than as nothing if the guard is removed -- an ordered list becomes one run-on
    // paragraph with the numbers inline -- so a parser that quietly accepted them would keep
    // this suite green while the pane misrepresented a licence.
    const unsupported: ReadonlyArray<readonly [string, RegExp]> = [
      ['1. First obligation\n', /ordered list/],
      ['- top\n  - nested\n', /nested list/],
      ['<div>markup</div>\n', /inline HTML/],
      ['Heading\n=======\n', /setext heading/],
    ];
    for (const [source, message] of unsupported) {
      expect(() => parseLegalDocument(source, 'fixture.md'), source).toThrow(message);
    }
    // And the control on the control: the supported shapes next to them must still parse.
    // Without this, tightening `assertSupported` until it rejected everything would pass.
    const clean = parseLegalDocument(
      '# Title\n\n## Section\n\n- one\n- two\n\n> quoted\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nText.\n',
      'fixture.md',
    );
    expect(clean.title).toBe('Title');
    expect(clean.blocks.map((b: { kind: string }) => b.kind)).toEqual([
      'heading',
      'list',
      'note',
      'table',
      'paragraph',
    ]);
  });

  it('flattens inline markdown to plain text, keeping only the URLs that leave the repository', () => {
    // The renderer sets `textContent`, so anything left un-flattened is shown as literal
    // syntax. Each case here is a construct one of the five documents actually uses.
    expect(inlineText('**bold** and `code` and _italic_')).toBe('bold and code and italic');
    expect(inlineText('see [`LICENSE`](LICENSE) for terms')).toBe('see LICENSE for terms');
    expect(inlineText('[Play it](https://example.com/x)')).toBe('Play it (https://example.com/x)');
    expect(inlineText('<https://example.com/x>')).toBe('https://example.com/x');
    expect(inlineText('a &mdash; b &amp; c')).toBe('a — b & c');
    // ***bold italic*** is LICENSE's warranty disclaimer, and the two passes have to
    // compose or that clause ships with stray asterisks around it.
    expect(inlineText('***as is***')).toBe('as is');
    // A snake_case identifier is not an italic run. Nothing in the five documents uses one
    // today, which is exactly why this is pinned: the naive `_..._` rule eats them.
    expect(inlineText('tanks_settings_v1')).toBe('tanks_settings_v1');
  });

  it('names every table, because an unnamed table heads nothing', () => {
    // #629's stats-table finding, applied to generated content: a `<caption>` is the only
    // thing that says what a column of figures is about once it is out of its document.
    for (const entry of LEGAL_SOURCES) {
      const { blocks } = parseLegalDocument(repoFile(entry.source), entry.source);
      for (const block of blocks as ReadonlyArray<{ kind: string; caption?: string }>) {
        if (block.kind !== 'table') continue;
        expect(block.caption, `a table in ${entry.source} has no caption`).not.toBe('');
      }
    }
    // Non-vacuity: two of the five documents contain tables today (PRIVACY.md's storage-key
    // table and CREDITS.md's two attribution tables; CONTENT-LICENSE.md's two make five
    // tables across three files). A loop over zero tables would pass while measuring nothing.
    const tables = LEGAL_SOURCES.flatMap((entry) =>
      (parseLegalDocument(repoFile(entry.source), entry.source).blocks as { kind: string }[]).filter(
        (b) => b.kind === 'table',
      ),
    );
    expect(tables.length).toBe(5);
  });
});
