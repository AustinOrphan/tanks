import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [url, out, label] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const SLOW = 30000;
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await p.goto(url, { waitUntil: 'load' });
await p.waitForSelector('.hud-splash', { state: 'attached' });
await p.waitForTimeout(800);
await p.keyboard.press('Space');
await p.waitForTimeout(1200);
// The SAME injection on both refs; main's close does not read it because it never runs
// a transition on close at all.
await p.addStyleTag({ content: `:root { --ui-transition-duration: ${SLOW}ms; }` });
await p.click('.hud-stats-open');
// Let the OPEN settle completely, so what follows is the CLOSE and nothing else.
await p.waitForTimeout(32000);
const probe = () => p.evaluate(() => {
  const g = (s) => {
    const el = document.querySelector(s);
    const cs = getComputedStyle(el);
    return { op: Number(cs.opacity).toFixed(3), display: cs.display, anim: cs.animationName };
  };
  return { stats: g('.hud-stats'), panel: g('.hud-panel') };
});
await p.click('.hud-stats-back');          // the CLOSE, the subject
const rec = [];
for (const name of ['a', 'b', 'c']) {
  const before = await probe();
  await p.screenshot({ path: join(out, `close-${name}-${label}.png`) });
  rec.push({ name, before, after: await probe() });
}
writeFileSync(join(out, `close-probe-${label}.json`), JSON.stringify(rec, null, 2) + '\n');
for (const r of rec) console.log(`${label} ${r.name}: stats op ${r.before.stats.op}->${r.after.stats.op} (${r.before.stats.display}, anim=${r.before.stats.anim}) | panel op ${r.before.panel.op}->${r.after.panel.op}`);
await b.close();
