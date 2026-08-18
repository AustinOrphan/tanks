import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Playwright's `waitForFunction(pageFunction, arg, options)` takes the options object
 * THIRD. Passing `{ timeout: N }` second silently serialises it as `arg` — the page
 * function ignores it, options stays undefined, and the call runs at Playwright's 30s
 * default instead of the timeout that was written down.
 *
 * All three call sites in `tools/` had this, and it went unnoticed for the reason
 * CLAUDE.md names: `tools/` is read by no test and largely typechecked by nothing, so a
 * silent argument-position error has nothing to fail against. `tools/gl/run.mjs` was the
 * one that bit — its 90s liveness ceiling was raised deliberately, with a comment citing
 * measured timings, and the raise never took effect. It surfaced as a bare `TimeoutError`
 * at a flat 30s, which reads as a broken harness rather than a mis-set option.
 *
 * This guard is a source scan, not a behavioural test, because the failure is invisible at
 * runtime: the wrong call still resolves whenever the page is fast enough. It fails on the
 * exact shape that caused the bug — a `timeout:`-bearing object in the `arg` slot — rather
 * than on formatting.
 */

const TOOLS_DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(mjs|js|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Argument lists of every `name(` call in `src`, extracted by balanced parens. */
function callArgLists(src: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const start = src.indexOf(needle, from);
    if (start === -1) return out;
    let depth = 0;
    let i = start + needle.length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(start + needle.length, i));
    from = i + 1;
  }
}

/** Split on commas that sit at nesting depth 0, so nested calls/objects stay whole. */
function topLevelArgs(argList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of argList) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current);
  return out;
}

describe('Playwright option objects sit in the options position, not the arg position', () => {
  const files = sourceFiles(TOOLS_DIR);

  it('finds the tools sources to scan at all (a guard that reads nothing passes vacuously)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('every waitForFunction call passing a timeout puts it in the THIRD argument', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of files) {
      for (const argList of callArgLists(readFileSync(file, 'utf8'), 'waitForFunction')) {
        const args = topLevelArgs(argList);
        const timeoutIndex = args.findIndex((a) => /\btimeout\s*:/.test(a));
        if (timeoutIndex === -1) continue;
        checked++;
        if (timeoutIndex !== 2) {
          offenders.push(
            `${file.replace(TOOLS_DIR, 'tools')}: timeout object is argument ${timeoutIndex + 1} of ${args.length}, must be 3`,
          );
        }
      }
    }
    // Denominator, so a refactor that deletes every call site cannot read as a pass.
    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
