// run.mjs launches a vite server and a browser at import time, so its argument handling
// lives in args.mjs and is pinned here. The failure this guards against is specific and
// silent: an engine name that is not understood must never fall back to the default,
// because "chromium, chromium, chromium agree" printed under three names is exactly the
// false cross-engine result the tool is built to produce evidence against.
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs, deliberately dependency-free so the runner can use it
import { parseArgs, BROWSERS, DEFAULTS } from './args.mjs';

describe('baseline runner args', () => {
  it('defaults to one chromium run on a port of its own', () => {
    // LITERAL, not `DEFAULTS.port`. Writing the constant on both sides made this a
    // tautology against the fixture: measured, `DEFAULTS.port` 5178 -> 5173 (vite's own
    // default, the collision that matters most) passed this file untouched. The port is a
    // contract with two things outside this module -- tools/gl/run.mjs's 5177, and
    // whatever else is listening on the box -- so it is pinned as the number it is.
    expect(parseArgs([])).toEqual({
      browsers: ['chromium'],
      port: 5178,
      beacon: false,
      host: false,
      beaconPort: 5179,
      timeout: 300_000,
    });
    // Not 5177: that is tools/gl/run.mjs's port, and each runner refuses to start while
    // anything answers on its own. Sharing one would make them mutually exclusive. Kept
    // beside the literal because it names WHY the literal is not free to move.
    expect(DEFAULTS.port).not.toBe(5177);
    // beaconPort is a THIRD port, distinct from both -- run.mjs's vite server and the
    // beacon collector's own http server run at once in --beacon mode.
    expect(DEFAULTS.beaconPort).not.toBe(5177);
    expect(DEFAULTS.beaconPort).not.toBe(DEFAULTS.port);
  });

  it('reads --beacon, --beacon-port and --timeout', () => {
    expect(parseArgs(['--beacon']).beacon).toBe(true);
    expect(parseArgs(['--beacon-port', '9000']).beaconPort).toBe(9000);
    expect(parseArgs(['--timeout', '60000']).timeout).toBe(60_000);
    expect(() => parseArgs(['--beacon-port', 'nope'])).toThrow(/needs a port number/);
    expect(() => parseArgs(['--timeout', '-1'])).toThrow(/needs a positive number/);
    expect(() => parseArgs(['--timeout', '0'])).toThrow(/needs a positive number/);
  });

  it('--host takes an optional value: bare binds every interface, a value binds one', () => {
    expect(parseArgs(['--host']).host).toBe(true);
    expect(parseArgs(['--host', '192.168.1.5']).host).toBe('192.168.1.5');
    // A bare --host followed by another flag must NOT swallow that flag as its value.
    expect(parseArgs(['--host', '--beacon'])).toMatchObject({ host: true, beacon: true });
  });

  it('reads a comma list of engines, in order', () => {
    expect(parseArgs(['--browser', 'firefox,chromium']).browsers).toEqual(['firefox', 'chromium']);
    expect(parseArgs(['--browsers', ' webkit , firefox ']).browsers).toEqual(['webkit', 'firefox']);
  });

  it('de-duplicates, so one engine cannot be reported as several', () => {
    expect(parseArgs(['--browser', 'chromium,chromium,firefox']).browsers)
      .toEqual(['chromium', 'firefox']);
  });

  it('--all is every engine playwright ships', () => {
    expect(parseArgs(['--all']).browsers).toEqual(BROWSERS);
    expect(BROWSERS).toEqual(['chromium', 'firefox', 'webkit']);
  });

  it('REFUSES an unknown engine rather than falling back', () => {
    expect(() => parseArgs(['--browser', 'safari'])).toThrow(/unknown browser "safari"/);
    expect(() => parseArgs(['--browser', 'chromium,sarafi'])).toThrow(/unknown browser "sarafi"/);
  });

  it('refuses a missing or empty value', () => {
    expect(() => parseArgs(['--browser'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--browser', ','])).toThrow(/needs a value/);
  });

  it('reads --port and refuses a non-port', () => {
    expect(parseArgs(['--port', '5199']).port).toBe(5199);
    expect(() => parseArgs(['--port', 'nope'])).toThrow(/needs a port number/);
    expect(() => parseArgs(['--port', '0'])).toThrow(/needs a port number/);
    expect(() => parseArgs(['--port', '70000'])).toThrow(/needs a port number/);
    expect(() => parseArgs(['--port', '5199.5'])).toThrow(/needs a port number/);
  });

  it('refuses an argument it does not understand', () => {
    // A tool whose whole output is one hash must not silently ignore a flag: a typo'd
    // --brower would print a chromium hash under a firefox intention.
    expect(() => parseArgs(['--brower', 'firefox'])).toThrow(/unknown argument "--brower"/);
    expect(() => parseArgs(['firefox'])).toThrow(/unknown argument "firefox"/);
  });
});
