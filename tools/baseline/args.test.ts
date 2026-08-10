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
    expect(parseArgs([])).toEqual({ browsers: ['chromium'], port: DEFAULTS.port });
    // Not 5177: that is tools/gl/run.mjs's port, and each runner refuses to start while
    // anything answers on its own. Sharing one would make them mutually exclusive.
    expect(DEFAULTS.port).not.toBe(5177);
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
