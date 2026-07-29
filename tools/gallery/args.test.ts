// The gallery is a dev tool, but its argument handling has already broken twice in ways
// that cost a full re-render: labels silently dropped by ffmpeg, and ANSI escapes landing
// in the image as literal text. Those are cheap to pin and expensive to rediscover.
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs, deliberately dependency-free so the runner can use it
import { parseArgs, safeLabel, gridShape, DEFAULTS } from './args.mjs';

const ESC = String.fromCharCode(27);

describe('gallery args', () => {
  it('defaults to a still of the mine from the game camera', () => {
    const a = parseArgs([]);
    expect(a.subject).toBe('mine');
    expect(a.view).toBe('game');
    expect(a.anim).toBe(false);
    expect(a.sweep).toBeNull();
  });

  it('reads values, booleans and numbers', () => {
    const a = parseArgs(['--subject', 'blast', '--view', 'top', '--anim', '--fps', '24']);
    expect(a.subject).toBe('blast');
    expect(a.view).toBe('top');
    expect(a.anim).toBe(true);
    expect(a.fps).toBe(24);
    expect(typeof a.fps).toBe('number'); // not the string '24', which ffmpeg would reject
  });

  it('rejects a flag with no value instead of swallowing the next flag', () => {
    // `--subject --anim` used to set subject to "--anim" and silently render the default.
    expect(() => parseArgs(['--subject', '--anim'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--fps'])).toThrow(/needs a value/);
  });

  it('rejects unknown flags and non-numeric numbers', () => {
    expect(() => parseArgs(['--subjekt', 'mine'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--fps', 'fast'])).toThrow(/must be a number/);
  });

  it('requires sweep and values together, since either alone renders nothing useful', () => {
    expect(() => parseArgs(['--sweep', 'MINE_DOME_H'])).toThrow(/needs --values/);
    expect(() => parseArgs(['--values', '1,2'])).toThrow(/needs --sweep/);
    const ok = parseArgs(['--sweep', 'MINE_DOME_H', '--values', '0.04, 0.08 ,0.12']);
    expect(ok.values).toEqual(['0.04', '0.08', '0.12']); // trimmed, empties dropped
  });

  it('strips what ffmpeg drawtext silently chokes on', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. A label containing = or % is not escaped by
    // ffmpeg -- it is dropped, and the grid comes back unlabelled with no error at all.
    const label = safeLabel('h=0.12 cyl 33%');
    expect(label).not.toContain('=');
    expect(label).not.toContain('%');
    expect(label).toContain('0.12');
    expect(label).toContain('33');
  });

  it('strips ANSI colour codes, which node emits into command substitution here', () => {
    // `node -e "console.log(25)"` produced "\x1b[33m25\x1b[39m", and those escapes were
    // drawn into the image as literal "[33m25[39m".
    expect(safeLabel(`${ESC}[33m25${ESC}[39m`)).toBe('25');
    expect(safeLabel(`${ESC}[1mMINE_DOME_H${ESC}[0m 0.08`)).toBe('MINE_DOME_H 0.08');
  });

  it('lays cells out in a grid that can hold them all', () => {
    for (const n of [1, 2, 3, 4, 6, 8, 9, 12]) {
      const { cols, rows } = gridShape(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n); // never drops a variant
      expect(Math.abs(cols - rows)).toBeLessThanOrEqual(1); // and stays near-square
    }
    expect(gridShape(0)).toEqual({ cols: 0, rows: 0 });
  });

  it('keeps DEFAULTS immutable across parses', () => {
    // parseArgs spreads DEFAULTS; a shared `values` array would accumulate between calls.
    parseArgs(['--sweep', 'X', '--values', 'a,b']);
    expect(DEFAULTS.values).toEqual([]);
    expect(parseArgs([]).values).toEqual([]);
  });
});
