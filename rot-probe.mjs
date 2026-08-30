import { chromium } from 'playwright';
const URL = 'http://127.0.0.1:8531/';
const SIZES = [44];
const WIDTHS = [{ w: 280, h: 640, name: 'icon' }];
const ICONS = [22, 26, 28];
const b = await chromium.launch();
const rows = [];
for (const { w, h, name } of WIDTHS) {
  for (const size of SIZES) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.mouse.click(Math.floor(w / 2), Math.floor(h / 2));
    await p.waitForTimeout(700);
    const cz = p.getByRole('button', { name: 'Customize' }).first();
    if (!(await cz.isVisible().catch(() => false))) { console.log(`${name}/${size}: NO CUSTOMIZE BUTTON`); await p.close(); continue; }
    await cz.click();
    await p.waitForTimeout(600);
    for (const ic of ICONS) {
      await p.addStyleTag({ content: `.hud-rotate-btn{width:${size}px!important;height:${size}px!important}.hud-rotate-icon{width:${ic}px!important;height:${ic}px!important}` });
      await p.waitForTimeout(200);
      await p.screenshot({ path: `/tmp/352-shots/icon-44px-glyph${ic}.png` });
      console.log(`icon ${ic}px on a 44px box -> fill ${(ic/44*100).toFixed(0)}%`);
    }
    const m = await p.evaluate(() => {
      const pane = document.querySelector('.hud-preview');
      const cluster = document.querySelector('.hud-preview-rotate');
      const btns = [...document.querySelectorAll('.hud-rotate-btn')];
      if (!cluster || !btns.length) return null;
      const cb = cluster.getBoundingClientRect();
      const boxes = btns.map((e) => e.getBoundingClientRect());
      const host = cluster.parentElement;
      const hb = host.getBoundingClientRect();
      return {
        clusterW: +cb.width.toFixed(1),
        btn: +boxes[0].width.toFixed(1),
        rows: new Set(boxes.map((r) => Math.round(r.top))).size,
        paneW: pane ? +pane.getBoundingClientRect().width.toFixed(1) : null,
        hostW: +hb.width.toFixed(1),
        overflowsHost: +(cb.right - hb.right).toFixed(1),
        offViewportRight: +(cb.right - document.documentElement.clientWidth).toFixed(1),
        docScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    console.log(`${name}/${size}px ${JSON.stringify(m)}`);
    rows.push({ name, size, ...m });
    await p.screenshot({ path: `/tmp/352-shots/${name}-${size}px.png` });
    await p.close();
  }
}
await b.close();
