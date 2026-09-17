/**
 * CSS syntax integrity for the stylesheets the game ships (issue #763).
 *
 * TWO CHECKS, because a spec-conforming parser alone accepts the break this repository has
 * actually shipped. CSS Syntax says the end of the file closes every open block, and CSS
 * Nesting makes a rule inside a rule legal, so a rule that lost its closing brace parses
 * cleanly: the rules after it become its children and stop matching (hud.css.test.ts's
 * header records two such breaks). An unterminated comment is the same: it silently eats the
 * rest of the file. So:
 *
 *   1. `tokenProblems` walks the text (comments, strings, escapes, url()) and reports a block
 *      still open at the end, a `}` with nothing to close, and an unterminated comment or string --
 *      the corruptions a parser repairs without saying so.
 *   2. lightningcss -- a Vite 8 dependency and its default production CSS minifier -- parses the
 *      text with error recovery off, and every error it raises is reported: malformed
 *      declarations, selectors, at-rules and media queries, unbalanced functions.
 *
 * Nothing here is style policy. It asks only whether the text parses as the author wrote it.
 * hud.css.test.ts keeps its own, stricter structural checks and every semantic contract.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The shipped stylesheets: every `.css` file under src/ and public/, and every `<style>`
 * block in an `.html` file there or at the repository root (index.html). Found by walking
 * the tree rather than listed, so a new stylesheet is checked the day it is added.
 */
export function discoverSources(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(css|html)$/.test(name)) files.push(relative(root, path));
    }
  };
  for (const dir of ['src', 'public']) walk(join(root, dir));
  for (const name of readdirSync(root)) if (name.endsWith('.html')) files.push(name);
  return files.sort();
}

/**
 * The CSS in one file, as units to check. A `.css` file is one unit. An `.html` file gives one
 * unit per `<style>` element, with the line and column its text starts at, so a problem is
 * reported at its line in the HTML file. HTML comments are blanked first (newlines kept), so
 * a comment that mentions `<style>` is not mistaken for one.
 */
export function cssUnits(file, text) {
  if (file.endsWith('.css')) return [{ label: file, css: text, line: 1, column: 1 }];
  const blanked = text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const units = [];
  let index = 0;
  for (const m of blanked.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const start = m.index + m[0].indexOf('>') + 1;
    const before = text.slice(0, start);
    const line = before.split('\n').length;
    const column = start - before.lastIndexOf('\n');
    index += 1;
    units.push({ label: `${file} <style> #${index}`, css: text.slice(start, start + m[1].length), line, column });
  }
  return units;
}

/** A position in a unit's text, as a 1-based line and column of the FILE the unit came from. */
function position(unit, offset) {
  const before = unit.css.slice(0, offset);
  const lineInUnit = before.split('\n').length - 1;
  const columnInLine = offset - (before.lastIndexOf('\n') + 1);
  return {
    line: unit.line + lineInUnit,
    column: (lineInUnit === 0 ? unit.column : 1) + columnInLine,
  };
}

/**
 * Check 1: what a parser silently repairs. Returns problems with file positions. Follows the
 * CSS tokenizer closely enough for this: comments, single- and double-quoted strings with
 * backslash escapes (a raw newline ends a string, as it does in CSS), escapes outside strings,
 * and unquoted url() bodies, none of which may contribute a brace.
 */
export function tokenProblems(unit) {
  const { css } = unit;
  const problems = [];
  const open = [];
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) {
        problems.push({ ...position(unit, i), message: 'comment is never closed, so everything after it is ignored' });
        break;
      }
      i = end + 2;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      if (j >= css.length) {
        problems.push({ ...position(unit, i), message: 'string is never closed' });
        break;
      }
      i = j + 1;
    } else if (ch === '\\') {
      i += 2;
    } else if (/^url\(\s*[^'"\s]/i.test(css.slice(i, i + 64)) && !/[\w-]/.test(css[i - 1] ?? '')) {
      const end = css.indexOf(')', i);
      i = end < 0 ? css.length : end + 1;
    } else if (ch === '{') {
      open.push(i);
      i += 1;
    } else if (ch === '}') {
      if (open.length === 0) problems.push({ ...position(unit, i), message: '`}` closes nothing' });
      else open.pop();
      i += 1;
    } else {
      i += 1;
    }
  }
  // The innermost block still open is the one whose brace went missing: every block opened
  // after it was closed.
  if (open.length > 0) {
    problems.push({
      ...position(unit, open[open.length - 1]),
      message: `block opened here is never closed (${open.length} open at the end of the stylesheet)`,
    });
  }
  return problems;
}

/**
 * Check 2: a strict parse. `transform` is lightningcss's, passed in so this module stays free
 * of a native import and the fixture tests can run it directly.
 */
export function parseProblems(unit, transform) {
  try {
    transform({ filename: unit.label, code: Buffer.from(unit.css), errorRecovery: false, minify: false });
    return [];
  } catch (error) {
    // lightningcss reports a 1-based line and column within the text it was given.
    const loc = error.loc ?? { line: 1, column: 1 };
    const lineInUnit = loc.line - 1;
    return [{
      line: unit.line + lineInUnit,
      column: lineInUnit === 0 ? unit.column + loc.column - 1 : loc.column,
      message: String(error.message),
    }];
  }
}

/** Every problem in every unit of every source, as `file:line:column: message` lines. */
export function checkSources(root, files, transform) {
  const reports = [];
  let units = 0;
  for (const file of files) {
    for (const unit of cssUnits(file, readFileSync(join(root, file), 'utf8'))) {
      units += 1;
      for (const p of [...tokenProblems(unit), ...parseProblems(unit, transform)]) {
        reports.push(`${file}:${p.line}:${p.column}: ${p.message} (${unit.label})`);
      }
    }
  }
  return { units, reports };
}
