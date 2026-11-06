// Element screenshots for each queued edit.
//
// The page is re-rendered headlessly at the viewport the user had, the target element
// gets a red outline, and a crop with 48 px of surrounding context is saved as PNG.
// Claude can open the PNG with its Read tool to see exactly what was pointed at.

import path from 'node:path';
import fs from 'node:fs';
import { sharedBrowser } from './browser.js';

const PAD = 48;

export async function captureItems(baseUrl, items, outDir) {
  const browser = await sharedBrowser();
  if (!browser) return {};
  fs.mkdirSync(outDir, { recursive: true });
  const result = {};
  for (const it of items) {
    if (!it.url || !it.selector) continue;
    const vp = it.viewport || { w: 1440, h: 900 };
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    try {
      const u = new URL(it.url, baseUrl);
      const target = new URL(u.pathname + u.search, baseUrl);
      target.searchParams.set('__wed_shot', '1');
      await page.goto(target.href, { waitUntil: 'load', timeout: 15000 });
      const sel = it.src ? `[data-wed-src="${it.src.replace(/"/g, '\\"')}"]` : it.selector;
      const loc = page.locator(sel).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      await loc.evaluate((el) => {
        el.style.outline = '3px solid #ff3b30';
        el.style.outlineOffset = '2px';
      });
      const box = await loc.boundingBox();
      if (!box) continue;
      const vpSize = page.viewportSize();
      const x = Math.max(0, box.x - PAD);
      const y = Math.max(0, box.y - PAD);
      // boundingBox is relative to the viewport after scrolling, so the clip stays inside it.
      const clip = {
        x,
        y,
        width: Math.min(vpSize.width - x, box.x - x + box.width + PAD),
        height: Math.min(vpSize.height - y, box.y - y + box.height + PAD),
      };
      if (clip.width < 4 || clip.height < 4) continue;
      const file = path.join(outDir, `${it.id}.png`);
      await page.screenshot({ path: file, clip });
      result[it.id] = file;
    } catch {
      // A missing screenshot never blocks the batch; the text context is still there.
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  return result;
}
