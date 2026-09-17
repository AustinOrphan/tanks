// CSS syntax integrity (issue #763). The first test IS the required-CI gate: it runs the same
// check as `npm run lint:css` over every shipped stylesheet. The rest prove the check fails on
// each kind of corruption it claims, reports it at the right line, and passes valid CSS that
// looks like corruption to a naive scan.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'lightningcss';
import { checkSources, cssUnits, discoverSources, parseProblems, tokenProblems } from './check.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Every problem both checks report for one stylesheet's text, as `line:column message`. */
function problems(css: string): string[] {
  const unit = { label: 'fixture.css', css, line: 1, column: 1 };
  return [...tokenProblems(unit), ...parseProblems(unit, transform)].map((p) => `${p.line}:${p.column} ${p.message}`);
}

describe('css integrity: the shipped stylesheets', () => {
  it('every shipped stylesheet parses as written', () => {
    const files = discoverSources(ROOT);
    const { units, reports } = checkSources(ROOT, files, transform);
    expect(reports).toEqual([]);
    // Non-vacuity: the three files that carry CSS today, and their four stylesheets
    // (hud.css; index.html's head and <noscript> blocks; privacy.html's one block).
    expect(files).toEqual(expect.arrayContaining(['index.html', 'public/privacy.html', 'src/game/hud.css']));
    expect(units).toBe(4);
  });

  it('finds a stylesheet added anywhere under src/ or public/, or as a root page, without a list to update', () => {
    const root = mkdtempSync(join(tmpdir(), 'css-integrity-'));
    try {
      for (const dir of ['src/game/panes', 'public/legal']) mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, 'src/game/panes/new.css'), '.a { color: red; }');
      writeFileSync(join(root, 'public/legal/terms.html'), '<style>.b { color: blue; }</style>');
      writeFileSync(join(root, 'landing.html'), '<p>no style</p>');
      writeFileSync(join(root, 'src/game/panes/new.ts'), 'export {};');
      expect(discoverSources(root)).toEqual(['landing.html', 'public/legal/terms.html', 'src/game/panes/new.css']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('css integrity: what it rejects', () => {
  it('a rule that lost its closing brace, at the brace that went missing', () => {
    const css = '.a { color: red; }\n.b { color: blue;\n.c { color: green; }\n.d { color: black; }\n';
    expect(problems(css)).toEqual(['2:4 block opened here is never closed (1 open at the end of the stylesheet)']);
    // Why the token check exists: the strict parser alone accepts this (the end of the file
    // closes the block, and .c and .d parse as nested rules of .b).
    expect(parseProblems({ label: 'fixture.css', css, line: 1, column: 1 }, transform)).toEqual([]);
  });

  it('a comment that is never closed, which would swallow the rest of the file', () => {
    const css = '.a { color: red; }\n/* note\n.b { color: blue; }\n';
    expect(problems(css)).toEqual(['2:1 comment is never closed, so everything after it is ignored']);
  });

  it('a stray closing brace', () => {
    expect(problems('.a { color: red; }\n}\n.b { color: blue; }\n')).toEqual([
      '2:1 `}` closes nothing',
      '2:1 Invalid empty selector',
    ]);
  });

  it('a malformed declaration, at-rule, function and string', () => {
    expect(problems('.a { color red; }\n')).toEqual(['1:11 Unexpected token Ident("red")']);
    expect(problems('.a { color: red; }\n@media (min-width: { .b { color: blue; } }\n')).toEqual([
      '2:18 Invalid media query',
    ]);
    expect(problems('.a { width: calc(1px + 2px; }\n')).toEqual(['1:29 Unexpected token CloseCurlyBracket']);
    const unterminated = problems('.a { content: "abc; }\n');
    expect(unterminated.some((p) => p.startsWith('1:') && p.includes('BadString'))).toBe(true);
  });
});

describe('css integrity: what it accepts', () => {
  it('braces inside strings, escapes, url() and comments, and nested at-rules', () => {
    // Each case is its own stylesheet, and each lone brace is unpaired within it. Checked
    // together, the `{` in one string and the `}` in another cancel out, and a scan that
    // counted braces inside strings passed (measured: mutation entry
    // css-integrity-counts-braces-inside-strings survived the combined fixture).
    const cases = [
      '.a::before { content: "{"; }',
      ".b::after { content: '}'; }",
      '.c::before { content: "\\"{"; }',
      '.d\\{ { color: red; }',
      '.e { background: url(data:image/svg+xml;utf8,<svg>{</svg>); }',
      '/* { an open brace in a comment */ .f { color: red; }',
      '@media (min-width: 40rem) { @supports (display: grid) { .g { display: grid; } } }',
      '@keyframes spin { from { rotate: 0deg; } to { rotate: 360deg; } }',
      '.h { color: color-mix(in srgb, red 50%, blue); }',
    ];
    expect(cases.map((css) => [css, problems(css)]).filter(([, found]) => found.length > 0)).toEqual([]);
  });
});

describe('css integrity: HTML <style> blocks', () => {
  it('reports a problem at its line and column in the HTML file, skipping a comment that mentions <style>', () => {
    const html = [
      '<!doctype html>',
      '<!-- a <style> mentioned in a comment is not a stylesheet -->',
      '<head>',
      '  <style>.ok { color: red; }',
      '    .bad { color blue; }',
      '  </style>',
      '</head>',
    ].join('\n');
    const units = cssUnits('page.html', html);
    expect(units.map((u: { label: string; line: number; column: number }) => [u.label, u.line, u.column])).toEqual([
      ['page.html <style> #1', 4, 10],
    ]);
    const found = units.flatMap((u: Parameters<typeof tokenProblems>[0]) => parseProblems(u, transform));
    // lightningcss points at the whitespace where the missing `:` belonged: column 17 of line 5.
    expect(found.map((p: { line: number; column: number }) => [p.line, p.column])).toEqual([[5, 17]]);
    // The first line of a block keeps the <style> tag's column offset.
    const firstLine = cssUnits('page.html', '<style>.a { color red; }</style>');
    expect(parseProblems(firstLine[0], transform).map((p: { line: number; column: number }) => [p.line, p.column]))
      .toEqual([[1, 18]]);
  });
});
