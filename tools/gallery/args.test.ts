// The gallery is a dev tool, but its argument handling has already broken twice in ways
// that cost a full re-render: labels silently dropped by ffmpeg, and ANSI escapes landing
// in the image as literal text. Those are cheap to pin and expensive to rediscover.
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs, deliberately dependency-free so the runner can use it
import { parseArgs, safeLabel, gridShape, DEFAULTS } from './args.mjs';

const ESC = String.fromCharCode(27);

describe('gallery args', () => {
  it('defaults to a still of a lone mine from the game camera', () => {
    const a = parseArgs([]);
    expect(a.elements).toBe('mine');
    expect(a.view).toBe('game');
    expect(a.anim).toBe(false);
    expect(a.sweep).toBeNull();
  });

  it('reads values, booleans and numbers', () => {
    const a = parseArgs(['--elements', 'blast,tank', '--view', 'top', '--anim', '--fps', '24']);
    expect(a.elements).toBe('blast,tank');
    expect(a.view).toBe('top');
    expect(a.anim).toBe(true);
    expect(a.fps).toBe(24);
    expect(typeof a.fps).toBe('number'); // not the string '24', which ffmpeg would reject
  });

  it('rejects a flag with no value instead of swallowing the next flag', () => {
    // `--elements --anim` used to set elements to "--anim" and silently render the default.
    expect(() => parseArgs(['--elements', '--anim'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--fps'])).toThrow(/needs a value/);
  });

  it('rejects unknown flags and non-numeric numbers', () => {
    expect(() => parseArgs(['--elemants', 'mine'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--fps', 'fast'])).toThrow(/must be a number/);
  });

  it('requires sweep and values together, since either alone renders nothing useful', () => {
    expect(() => parseArgs(['--sweep', 'MINE_DOME_H'])).toThrow(/needs --values/);
    expect(() => parseArgs(['--values', '1,2'])).toThrow(/needs --sweep/);
    // One constant, plain commas: each variant is a one-element tuple.
    const ok = parseArgs(['--sweep', 'MINE_DOME_H', '--values', '0.04, 0.08 ,0.12']);
    expect(ok.sweep).toEqual(['MINE_DOME_H']);
    expect(ok.values).toEqual([['0.04'], ['0.08'], ['0.12']]); // trimmed, empties dropped
  });

  it('confines slowmo and burst to the game scene, where the live clock is', () => {
    const a = parseArgs(['--scene', 'game', '--slowmo', '0.05', '--burst', '150']);
    expect(a.slowmo).toBe(0.05);
    expect(a.burst).toBe(150);
    // The gallery scene steps poses explicitly; a silent no-op knob is how a 48-sample
    // comparison turns out to be one sample 48 times.
    expect(() => parseArgs(['--slowmo', '0.5'])).toThrow(/--scene game/);
    expect(() => parseArgs(['--burst', '10'])).toThrow(/--scene game/);
  });

  it('rejects slowmo outside (0,1] and non-integer bursts', () => {
    expect(() => parseArgs(['--scene', 'game', '--slowmo', '0'])).toThrow(/slowmo/);
    expect(() => parseArgs(['--scene', 'game', '--slowmo', '2'])).toThrow(/slowmo/);
    expect(() => parseArgs(['--scene', 'game', '--burst', '2.5'])).toThrow(/burst/);
    expect(() => parseArgs(['--scene', 'game', '--burst', '0'])).toThrow(/burst/);
  });

  it('refuses burst with sweep: a grid of timelines serves neither purpose', () => {
    expect(() =>
      parseArgs(['--scene', 'game', '--burst', '5', '--sweep', 'MINE_DOME_H', '--values', '1,2']),
    ).toThrow(/--sweep/);
  });

  it('refuses a .png target for animated output, where the gif encoder would fill it', () => {
    // Found in review: --burst 30 --out clip.png ran palettegen/paletteuse into a file
    // named .png. The same hole existed for --anim since the gif path shipped.
    expect(() => parseArgs(['--scene', 'game', '--burst', '5', '--out', 'clip.png'])).toThrow(/\.gif/);
    expect(() => parseArgs(['--anim', '--out', 'clip.png'])).toThrow(/\.gif/);
    expect(parseArgs(['--scene', 'game', '--burst', '5', '--out', 'clip.gif']).burst).toBe(5);
  });

  it('refuses --crop on animated output instead of silently ignoring it', () => {
    // The animated branch never crops; accepting the flag was a dead knob -- the
    // 48-samples-that-were-one-sample failure mode, one layer up.
    expect(() =>
      parseArgs(['--scene', 'game', '--burst', '5', '--crop', '10x10+0+0', '--out', 'x.gif']),
    ).toThrow(/--crop/);
    expect(() => parseArgs(['--anim', '--crop', '10x10+0+0', '--out', 'x.gif'])).toThrow(/--crop/);
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

  it('pairs constants within a variant, so two can be swept together', () => {
    const a = parseArgs([
      '--sweep', 'MINE_Y,MINE_BASE_H',
      '--values', '0.06|(MINE_Y*2)/4; 0.09|(MINE_Y*2)/3',
    ]);
    expect(a.sweep).toEqual(['MINE_Y', 'MINE_BASE_H']);
    expect(a.values).toEqual([['0.06', '(MINE_Y*2)/4'], ['0.09', '(MINE_Y*2)/3']]);
  });

  it('refuses a variant that does not supply every swept constant', () => {
    // Padding here would silently leave one constant at whatever the PREVIOUS variant
    // set it to, which on screen looks like a variant that failed to change.
    expect(() => parseArgs(['--sweep', 'A,B', '--values', '1|2; 3'])).toThrow(/supplies 1/);
    expect(() => parseArgs(['--sweep', 'A', '--values', '1|2'])).toThrow(/supplies 2/);
  });

  it('refuses a label list that does not match the variants', () => {
    expect(() => parseArgs(['--sweep', 'A', '--values', '1,2,3', '--labels', 'one;two']))
      .toThrow(/2 entries for 3 variants/);
  });

  it('validates the game-scene options rather than failing halfway through a run', () => {
    // Each of these costs a browser launch per variant to discover at runtime.
    expect(() => parseArgs(['--scene', 'arena'])).toThrow(/must be 'gallery' or 'game'/);
    expect(() => parseArgs(['--crop', 'nonsense'])).toThrow(/640x480\+100\+50/);
    // The game owns its own clock, so there is no pose to step. Allowing --anim here
    // would silently produce N identical frames.
    expect(() => parseArgs(['--scene', 'game', '--anim'])).toThrow(/not supported with --scene game/);
    const ok = parseArgs(['--scene', 'game', '--crop', '470x350+505+470', '--settle', '4200', '--query', 'dev=1&seed=7']);
    expect(ok.scene).toBe('game');
    expect(ok.settle).toBe(4200);
    expect(typeof ok.settle).toBe('number');
    expect(ok.query).toBe('dev=1&seed=7');
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
