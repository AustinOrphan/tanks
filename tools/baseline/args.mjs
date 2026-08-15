/**
 * Argument handling for tools/baseline/run.mjs, kept in its own dependency-free module so
 * it can be tested (args.test.ts) without importing the runner -- importing the runner
 * would launch a vite server and a browser. Same split as tools/gallery/args.mjs.
 */

/** The engines Playwright ships. webkit is JavaScriptCore, but NOT shipped Safari. */
export const BROWSERS = ['chromium', 'firefox', 'webkit'];

export const DEFAULTS = {
  browsers: ['chromium'],
  port: 5178,
  // ---- beacon mode (--beacon) only; unused on the Playwright path below ----
  beacon: false,
  // false: vite binds localhost only (the supported path -- see run.mjs's beacon
  // instructions for why LAN needs a caveat crypto.subtle does not forgive).
  host: false,
  // The beacon collector's OWN http server, deliberately not 5178 (vite) or 5177
  // (tools/gl/run.mjs): a third port so all three can run at once without colliding.
  beaconPort: 5179,
  // Generous: a human has to physically open a simulator or type a URL on a device.
  timeout: 300_000,
};

/**
 * Parses `--browser chromium,firefox` / `--port 5178` / `--beacon` / `--host [addr]` /
 * `--beacon-port 5179` / `--timeout 60000`.
 *
 * Throws on anything it does not understand rather than ignoring it. A typo'd engine name
 * that silently fell back to chromium would report "3 engines agree" from one engine --
 * the precise false result this tool exists to avoid.
 */
export function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--browser' || a === '--browsers') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value (one or more of ${BROWSERS.join(', ')})`);
      const names = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length === 0) throw new Error(`${a} needs a value (one or more of ${BROWSERS.join(', ')})`);
      for (const n of names) {
        if (!BROWSERS.includes(n)) {
          throw new Error(`unknown browser "${n}" -- expected one of ${BROWSERS.join(', ')}`);
        }
      }
      // De-duplicated, order preserved: running chromium twice would print two identical
      // hashes and read as cross-engine agreement.
      out.browsers = [...new Set(names)];
    } else if (a === '--browser=all' || a === '--all') {
      out.browsers = [...BROWSERS];
    } else if (a === '--port') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v <= 0 || v > 65535) throw new Error(`--port needs a port number, got "${argv[i]}"`);
      out.port = v;
    } else if (a === '--beacon') {
      out.beacon = true;
    } else if (a === '--host') {
      // Value is OPTIONAL (vite's own `--host` works the same way): `--host` alone binds
      // every interface, `--host 192.168.1.5` binds that one. Only consume the next token
      // as a value if it does not itself look like a flag.
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) {
        out.host = v;
        i++;
      } else {
        out.host = true;
      }
    } else if (a === '--beacon-port') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v <= 0 || v > 65535) throw new Error(`--beacon-port needs a port number, got "${argv[i]}"`);
      out.beaconPort = v;
    } else if (a === '--timeout') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v <= 0) throw new Error(`--timeout needs a positive number of milliseconds, got "${argv[i]}"`);
      out.timeout = v;
    } else {
      throw new Error(`unknown argument "${a}"`);
    }
  }
  return out;
}
