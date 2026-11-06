// End-to-end: the real overlay in headless Chromium against the fixture site.
import { WED_HOME, freshSite } from './helpers.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, buildOverlay } from '../src/server.js';
import { launch } from '../src/browser.js';
import { addRef, openRef, listRefs } from '../src/refs.js';

let srv, browser, page, errors;
const chromiumOk = !!(await launch({ headless: true }).then((b) => b && b.close().then(() => true)));
const skip = !chromiumOk && 'Chromium not available';

const api = async (method, p, body) => {
  const r = await fetch(srv.url + '/__wed' + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
};

before(async () => {
  if (skip) return;
  srv = await startServer({ folder: freshSite(), port: 0 });
  browser = await launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await srv?.close();
});

async function freshPage() {
  if (page) await page.context().close();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx.newPage();
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(srv.url + '/');
  await page.waitForSelector('wed-overlay', { state: 'attached' });
  return page;
}

test('overlay mounts without errors and does not move page content', { skip }, async () => {
  await freshPage();
  const withOverlay = await page.locator('h1.hero-title').boundingBox();
  const p2 = await page.context().newPage();
  await p2.goto(srv.url + '/?__wed_raw');
  const without = await p2.locator('h1.hero-title').boundingBox();
  await p2.close();
  assert.deepEqual(withOverlay, without);
  assert.equal(await page.locator('wed-overlay .bar').count(), 1);
  assert.deepEqual(errors, []);
});

test('selectors are unique for every element on the page', { skip }, async () => {
  await freshPage();
  const bad = await page.evaluate(() => {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('wed-overlay') || el.tagName === 'SCRIPT') continue;
      const sel = window.__wedDebug.buildSelector(el);
      const hits = document.querySelectorAll(sel);
      if (hits.length !== 1 || hits[0] !== el) out.push(sel);
    }
    return out;
  });
  assert.deepEqual(bad, []);
});

test('pick, describe, queue, send: Claude gets the exact source line and a screenshot', { skip }, async () => {
  await freshPage();
  await page.keyboard.press('p');
  await page.click('button.cta'); // in pick mode this must not trigger the site's onclick
  assert.equal(await page.evaluate(() => document.body.dataset.clicked || null), null);
  await page.keyboard.press('Escape');

  await page.click('h1.hero-title');
  const ta = page.locator('wed-overlay .pop textarea');
  await ta.waitFor();
  await ta.fill('make this 20% larger');
  await ta.press('Control+Enter');
  const item = await until(async () => (await api('GET', '/items')).items.find((i) => i.status === 'draft'));
  assert.equal(item.instruction, 'make this 20% larger');
  const expectedSrc = await page.getAttribute('h1.hero-title', 'data-wed-src');
  assert.equal(item.src, expectedSrc);
  assert.equal(item.selector, 'h1.hero-title');
  assert.equal(await page.locator('wed-overlay .pin').count(), 1);

  await page.locator('wed-overlay .bar button.primary').click();
  const claimed = await until(() => api('GET', '/next?timeout=1000'), 25000);
  assert.equal(claimed.items[0].src, expectedSrc);
  assert.ok(claimed.items[0].screenshot && fs.existsSync(claimed.items[0].screenshot), 'screenshot saved');
  assert.ok(fs.statSync(claimed.items[0].screenshot).size > 1000);
  await api('POST', '/done', { ids: [claimed.items[0].id], note: 'test' });
  assert.deepEqual(errors, []);
});

test('style nudge previews live and sends an exact before/after delta', { skip }, async () => {
  await freshPage();
  await page.keyboard.press('p');
  await page.click('.cards .card:nth-of-type(2)');
  await page.locator('wed-overlay .pop button', { hasText: 'Style' }).click();
  const range = page.locator('wed-overlay .nudge input[type=range]').first(); // font size
  await range.evaluate((el) => {
    el.value = '30';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.$eval('.cards .card:nth-of-type(2)', (el) => getComputedStyle(el).fontSize), '30px');
  await page.locator('wed-overlay .pop button.primary').click();
  const item = await until(async () => (await api('GET', '/items')).items.find((i) => i.status === 'draft' && i.styleDelta));
  assert.deepEqual(item.styleDelta['font-size'], { from: '16px', to: '30px' });
  assert.equal(item.kind, 'style');
  await api('DELETE', '/items/' + item.id);
});

test('double-click text, retype, Enter: the source file changes with no Claude turn', { skip }, async () => {
  await freshPage();
  await page.keyboard.press('p');
  await page.dblclick('p.lede');
  await page.waitForFunction(() => document.querySelector('p.lede').isContentEditable);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Catch failures early.');
  await page.keyboard.press('Enter');
  const file = path.join(srv.root, 'index.html');
  await until(() => fs.readFileSync(file, 'utf8').includes('<p class="lede">Catch failures early.</p>'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('Forecast failures'));
});

test('a reload from disk waits while a note is being typed', { skip }, async () => {
  await freshPage();
  await page.keyboard.press('p');
  await page.click('h1.hero-title');
  await page.locator('wed-overlay .pop textarea').fill('half-written');
  await page.evaluate(() => (window.__marker = 1));
  fs.appendFileSync(path.join(srv.root, 'css', 'style.css'), '\n/* touch */\n');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await page.evaluate(() => window.__marker), 1, 'page did not reload mid-note');
  const nav = page.waitForNavigation();
  await page.keyboard.press('Escape');
  await nav;
  assert.equal(await page.evaluate(() => window.__marker), undefined, 'page reloaded after the note closed');
});

test('inspiration: ref add extracts design tokens and a screenshot', { skip }, async () => {
  const r = await addRef(srv.url + '/?__wed_raw', 'fixture');
  assert.equal(r.tokens.fonts[0].value, 'Georgia');
  assert.ok(r.tokens.fontSizes.some((s) => s.value === '48px'));
  assert.ok(r.tokens.spacing.some((s) => s.value === '16px'));
  assert.ok(fs.existsSync(path.join(WED_HOME, 'refs', 'fixture', 'page.png')));
  assert.match(fs.readFileSync(path.join(WED_HOME, 'refs', 'fixture', 'tokens.md'), 'utf8'), /Georgia/);
});

test('inspiration: reference mode saves a clicked element with styles and a crop', { skip }, async () => {
  const saved = [];
  await openRef(srv.url + '/?__wed_raw', 'fixture-el', buildOverlay({ mode: 'ref', refMode: true }), (id) => saved.push(id), {
    headless: true,
    onPage: async (p) => {
      await p.waitForSelector('wed-overlay', { state: 'attached' });
      await p.click('.cards .card:nth-of-type(1)');
      const name = p.locator('wed-overlay .pop input[type=text]');
      await name.fill('soft-card');
      await p.locator('wed-overlay .pop textarea').fill('the soft shadow');
      await p.locator('wed-overlay .pop button.primary').click();
      await until(() => saved.length > 0);
      await p.close();
    },
  });
  assert.deepEqual(saved, ['fixture-el/soft-card']);
  const meta = JSON.parse(fs.readFileSync(path.join(WED_HOME, 'refs', 'fixture-el', 'elements', 'soft-card.json'), 'utf8'));
  assert.equal(meta.why, 'the soft shadow');
  assert.match(meta.fullStyles['box-shadow'], /rgba\(0, 0, 0, 0.08\)/);
  assert.ok(fs.existsSync(path.join(WED_HOME, 'refs', 'fixture-el', 'elements', 'soft-card.png')));
  assert.ok(listRefs().refs.find((r) => r.name === 'fixture-el').elements.includes('soft-card'));
});

test('double-click inside a heading with <mark> edits the whole heading and keeps the tag', { skip }, async () => {
  await freshPage();
  await page.keyboard.press('p');
  await page.dblclick('h2.tagline mark');
  await page.waitForFunction(() => document.querySelector('h2.tagline').isContentEditable);
  assert.equal(await page.evaluate(() => document.querySelector('[contenteditable]').tagName), 'H2');
  await page.keyboard.press('End');
  await page.keyboard.type(' Today.');
  await page.keyboard.press('Enter');
  const file = path.join(srv.root, 'index.html');
  await until(() => fs.readFileSync(file, 'utf8').includes('<h2 class="tagline">Every way to get rid of it. <mark>One place</mark> to sort it out. Today.</h2>'));
  assert.deepEqual(errors, []);
});

test('double-click never fails silently: hint outside pick mode, warning on layout blocks', { skip }, async () => {
  await freshPage();
  await page.dblclick('h1.hero-title');
  await page.locator('wed-overlay .toast', { hasText: 'press P' }).waitFor();
  assert.equal(await page.locator('[contenteditable]').count(), 0);

  await page.keyboard.press('p');
  const box = await page.locator('section.cards').boundingBox();
  await page.mouse.dblclick(box.x + 4, box.y + 4); // the section's own padding, not a card
  await page.locator('wed-overlay .toast', { hasText: 'cannot be retyped' }).waitFor();
  assert.equal(await page.locator('[contenteditable]').count(), 0);
});
