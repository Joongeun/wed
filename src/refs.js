// Inspiration board.
//
// `wed ref add <url>` renders a site you like, saves a full-page screenshot, and
// extracts its design tokens: fonts, type scale, colors, spacing, radii and shadows.
// `wed ref open <url>` opens the site in a visible Chromium with the overlay in
// reference mode, so clicking an element saves that element's styles and a crop.
// Everything lives in ~/.wed/refs/<name>/ and is shared by all projects.

import fs from 'node:fs';
import path from 'node:path';
import { WED_HOME, writeJsonAtomic, readJson } from './store.js';
import { launch } from './browser.js';

export const REFS_DIR = () => path.join(WED_HOME, 'refs');

export function slug(s) {
  return String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ref';
}

export function listRefs() {
  const dir = REFS_DIR();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
  } catch {
    return { refs: [] };
  }
  const refs = names.map((name) => {
    const meta = readJson(path.join(dir, name, 'meta.json'), {});
    const elDir = path.join(dir, name, 'elements');
    let elements = [];
    try {
      elements = fs.readdirSync(elDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    } catch {}
    return { name, url: meta.url || '', addedAt: meta.addedAt || 0, hasTokens: fs.existsSync(path.join(dir, name, 'tokens.md')), elements };
  });
  refs.sort((a, b) => b.addedAt - a.addedAt);
  return { refs, dir };
}

/** Paths Claude should read for a ref id like "stripe" or "stripe/pricing-card". */
export function refPaths(id) {
  const [name, el] = String(id).split('/');
  const base = path.join(REFS_DIR(), name);
  if (el) {
    return [path.join(base, 'elements', `${el}.json`), path.join(base, 'elements', `${el}.png`)].filter((p) => fs.existsSync(p));
  }
  return [path.join(base, 'tokens.md'), path.join(base, 'page.png')].filter((p) => fs.existsSync(p));
}

// Runs inside the page. Must be self-contained.
export function extractTokensInPage() {
  const count = (map, key, w = 1) => {
    if (!key) return;
    map[key] = (map[key] || 0) + w;
  };
  const fonts = {}, sizes = {}, colors = {}, bgs = {}, spacing = {}, radii = {}, shadows = {}, weights = {}, lineHeights = {};
  const els = Array.from(document.querySelectorAll('body *')).slice(0, 4000);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    const area = Math.min(r.width * r.height, 200000);
    if (hasText) {
      const len = el.textContent.trim().length;
      count(fonts, cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), len);
      count(sizes, cs.fontSize, len);
      count(weights, cs.fontWeight, len);
      count(lineHeights, `${cs.fontSize} / ${cs.lineHeight}`, len);
      count(colors, cs.color, len);
    }
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') count(bgs, cs.backgroundColor, area);
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'rowGap', 'columnGap']) {
      const v = cs[p];
      if (v && v !== '0px' && v !== 'normal' && v !== 'auto') count(spacing, v);
    }
    if (cs.borderTopLeftRadius !== '0px') count(radii, cs.borderTopLeftRadius);
    if (cs.boxShadow !== 'none') count(shadows, cs.boxShadow);
  }
  const top = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ value: k, weight: Math.round(v) }));
  const bodyCs = getComputedStyle(document.body);
  return {
    title: document.title,
    pageBackground: bodyCs.backgroundColor,
    fonts: top(fonts, 6),
    fontSizes: top(sizes, 12).sort((a, b) => parseFloat(b.value) - parseFloat(a.value)),
    fontWeights: top(weights, 5),
    lineHeights: top(lineHeights, 8),
    textColors: top(colors, 8),
    backgrounds: top(bgs, 8),
    spacing: top(spacing, 14).sort((a, b) => parseFloat(a.value) - parseFloat(b.value)),
    radii: top(radii, 6),
    shadows: top(shadows, 4),
    maxContentWidth: Math.max(...Array.from(document.querySelectorAll('main, section, .container, [class*="container"], [class*="wrapper"]')).slice(0, 50).map((e) => {
      const mw = getComputedStyle(e).maxWidth;
      return mw.endsWith('px') ? parseFloat(mw) : 0;
    }), 0),
  };
}

export function tokensToMarkdown(name, url, t) {
  const list = (arr, f = (x) => x.value) => arr.map((x) => `\`${f(x)}\``).join(', ') || '(none)';
  return `# Inspiration: ${name}

Source: ${url}
Title: ${t.title}
Captured: ${new Date().toISOString().slice(0, 10)}
Screenshot: page.png (1440 px wide, top 6000 px)

These are the most used values on the page, weighted by how much text or area uses them.
Borrow the system, not the brand: the scale ratios, spacing rhythm and contrast choices.

- **Fonts:** ${list(t.fonts)}
- **Font sizes, largest first:** ${list(t.fontSizes)}
- **Weights:** ${list(t.fontWeights)}
- **Size / line height pairs:** ${list(t.lineHeights)}
- **Text colors:** ${list(t.textColors)}
- **Page background:** \`${t.pageBackground}\`
- **Surface backgrounds:** ${list(t.backgrounds)}
- **Spacing values, smallest first:** ${list(t.spacing)}
- **Corner radii:** ${list(t.radii)}
- **Shadows:** ${list(t.shadows)}
- **Widest max-width container:** ${t.maxContentWidth ? t.maxContentWidth + 'px' : 'not set'}
`;
}

export async function addRef(url, name) {
  name = slug(name || new URL(url).hostname);
  const dir = path.join(REFS_DIR(), name);
  fs.mkdirSync(dir, { recursive: true });
  const browser = await launch({ headless: true });
  if (!browser) throw new Error('Chromium is not available. Run: npx playwright-core install chromium');
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    // Scroll once through the page so lazy-loaded sections render before the screenshot.
    await page.evaluate(async () => {
      for (let y = 0; y < Math.min(document.body.scrollHeight, 6000); y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 80));
      }
      window.scrollTo(0, 0);
    });
    const tokens = await page.evaluate(extractTokensInPage);
    const height = await page.evaluate(() => Math.min(document.documentElement.scrollHeight, 6000));
    await page.screenshot({ path: path.join(dir, 'page.png'), clip: { x: 0, y: 0, width: 1440, height }, fullPage: true, timeout: 20000 });
    writeJsonAtomic(path.join(dir, 'tokens.json'), tokens);
    fs.writeFileSync(path.join(dir, 'tokens.md'), tokensToMarkdown(name, url, tokens));
    writeJsonAtomic(path.join(dir, 'meta.json'), { url, name, addedAt: Date.now() });
    return { name, dir, tokens };
  } finally {
    await browser.close();
  }
}

/**
 * Open a reference site in a visible browser with the overlay in reference mode.
 * Clicking an element there calls back into Node, which saves styles and a crop.
 * Resolves when the browser window is closed.
 */
export async function openRef(url, name, overlaySource, onSaved = () => {}, { headless = false, onPage } = {}) {
  name = slug(name || new URL(url).hostname);
  const dir = path.join(REFS_DIR(), name);
  fs.mkdirSync(path.join(dir, 'elements'), { recursive: true });
  if (!fs.existsSync(path.join(dir, 'meta.json'))) writeJsonAtomic(path.join(dir, 'meta.json'), { url, name, addedAt: Date.now() });
  const browser = await launch({ headless });
  if (!browser) throw new Error('Chromium is not available. Run: npx playwright-core install chromium');
  // bypassCSP lets the overlay run on sites whose Content-Security-Policy would block it.
  const ctx = await browser.newContext({ viewport: headless ? { width: 1280, height: 800 } : null, bypassCSP: true });
  await ctx.exposeBinding('__wedSaveRef', async ({ page }, payload) => {
    const elName = slug(payload.name || payload.tag || 'element');
    const base = path.join(dir, 'elements', elName);
    writeJsonAtomic(`${base}.json`, { ...payload, name: elName, ref: name, savedAt: Date.now() });
    const r = payload.rect;
    if (r && r.width > 2 && r.height > 2) {
      const vp = page.viewportSize() || (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
      const x = Math.max(0, r.x - 24);
      const y = Math.max(0, r.y - 24);
      await page
        .screenshot({ path: `${base}.png`, clip: { x, y, width: Math.min(vp.width - x, r.width + 48), height: Math.min(vp.height - y, r.height + 48) } })
        .catch(() => {});
    }
    onSaved(`${name}/${elName}`);
    return { id: `${name}/${elName}` };
  });
  await ctx.addInitScript({ content: overlaySource });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (onPage) await onPage(page); // tests drive the page here, then close it
  await new Promise((resolve) => {
    if (browser.isConnected() === false || page.isClosed()) return resolve();
    browser.on('disconnected', resolve);
    ctx.on('close', resolve);
    page.on('close', () => {
      if (ctx.pages().length === 0) resolve();
    });
  });
  await browser.close().catch(() => {});
  return { name, dir };
}
