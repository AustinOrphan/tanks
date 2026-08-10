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
};

/**
 * Parses `--browser chromium,firefox` / `--port 5178`.
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
    } else {
      throw new Error(`unknown argument "${a}"`);
    }
  }
  return out;
}
