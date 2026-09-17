/**
 * Screen-state capture (issue #561): boot the BUILT page into a named application state
 * and photograph it, deterministically.
 *
 *   node tools/screens/run.mjs --state screen.records.stats --dist dist \
 *     --out tmp/frame.png --report tmp/producer.json --w 1280 --h 800 --dpr 2
 *
 * `--report` may be omitted, and then lands beside `--out`; both default under `tmp/`
 * rather than the repository root (issue #637, tools/screens/paths.mjs).
 *
 * A standalone CLI writing one frame and one report, which is the shape
 * `tools/capture/gallery-adapter.mjs` already established for the `moment` producer -- the
 * adapter shells out, reads `producer.json` back, and validates it. Playwright arrives
 * through `PLAYWRIGHT_MODULE`, checked once by the capture framework's prerequisites, and is
 * loaded here through the tools family's shared loader (`tools/shared/playwright.mjs`).
 *
 * WHY EVERY SHOT IS ALSO MEASURED. A screenshot named `records.stats` proves the page did
 * not crash and nothing else; two states that render identically produce two files a
 * reviewer has to eyeball. So each capture also records the bounding box and key computed
 * properties of the elements the state names. That half is deterministic in a way pixels
 * are not, and it is the half that has actually caught things: the campaign-complete
 * screen's two tally lines sat 24px apart where 8px was intended, and the number is what
 * said so -- the picture just looked slightly loose.
 *
 * NOT A GATE, and that is argued rather than assumed. See tools/screens/README.md.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findScreenState, SCREEN_STATE_IDS } from './states.mjs';
import { screenCapturePaths } from './paths.mjs';
import { captureState, launchBrowser, serve } from './capture.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const stateId = arg('state');
  const state = stateId ? findScreenState(stateId) : null;
  if (state === null) {
    throw new Error(`--state must name a screen state (${SCREEN_STATE_IDS.join(', ')})`);
  }
  const dist = resolve(arg('dist', 'dist'));
  // Both artifacts through one resolver (issue #637): a bare default used to resolve
  // against the working directory, dropping `screen.png` and `producer.json` into the
  // repository root where neither is ignored. See tools/screens/paths.mjs.
  const { out, report: reportPath } = screenCapturePaths({ out: arg('out'), report: arg('report') });
  const width = Number(arg('w', 1280));
  const height = Number(arg('h', 800));
  const dpr = Number(arg('dpr', 2));
  const timeout = Number(arg('timeout', 20000));
  if (!existsSync(resolve(dist, 'index.html'))) throw new Error(`no index.html under ${dist}`);

  // The browser and the server live for this one capture; `sweep.mjs` keeps them for many.
  const browser = await launchBrowser();
  const server = await serve(dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    const { png, report } = await captureState(browser, base, state, { width, height, dpr, timeout });
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, png);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const { measurements, pageErrors } = report.producer;
    console.log(`${state.id}: ${measurements.filter((m) => m.visible).length}/${measurements.length} measured element(s) visible, ${pageErrors.length} page error(s)`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
