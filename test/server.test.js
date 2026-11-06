import { WED_HOME, ROOT, freshSite } from './helpers.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.js';
import { injectOverlay } from '../src/inject.js';
import { readTaste } from '../src/store.js';

const servers = [];
after(async () => {
  for (const s of servers) await s.close();
});

async function boot(opts) {
  const s = await startServer({ port: 0, shots: false, ...opts });
  servers.push(s);
  return s;
}

const j = async (s, method, p, body) => {
  const r = await fetch(s.url + '/__wed' + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : null };
};

test('injection: before </body>, appended when missing, never twice', () => {
  assert.match(injectOverlay('<html><body><p>x</p></BODY></html>'), /<p>x<\/p><script src="\/__wed\/overlay.js"[^>]*><\/script><\/BODY>/);
  assert.match(injectOverlay('<p>fragment</p>'), /<p>fragment<\/p>\n<script src="\/__wed\/overlay.js"/);
  const once = injectOverlay('<body></body>');
  assert.equal(injectOverlay(once), once);
});

test('static mode serves tagged HTML with the overlay, assets untouched, no traversal', async () => {
  const s = await boot({ folder: freshSite() });
  const html = await (await fetch(s.url + '/')).text();
  assert.match(html, /data-wed-src="index.html:\d+:\d+"/);
  assert.match(html, /__wed\/overlay.js/);
  const css = await (await fetch(s.url + '/css/style.css')).text();
  assert.equal(css, fs.readFileSync(path.join(s.root, 'css/style.css'), 'utf8'));
  const js = await (await fetch(s.url + '/__wed/overlay.js')).text();
  assert.doesNotThrow(() => new Function(js));
  const traversal = await new Promise((resolve) => {
    http.get(s.url + '/../../../etc/passwd', (r) => resolve(r.statusCode));
  });
  assert.notEqual(traversal, 200);
  assert.equal((await fetch(s.url + '/.wed/queue.json')).status, 404);
});

test('proxy mode injects into gzip and chunked HTML and strips CSP', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/gz') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-security-policy': "script-src 'none'" });
      return res.end(zlib.gzipSync('<html><body><h1>Zipped</h1></body></html>'));
    }
    if (req.url === '/chunked') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<html><body><h1>Chun');
      setTimeout(() => res.end('ked</h1></body></html>'), 20);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('h1{color:red}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  try {
    const s = await boot({ upstream: `http://127.0.0.1:${upstream.address().port}`, root: freshSite() });
    const gz = await fetch(s.url + '/gz');
    const gzBody = await gz.text();
    assert.match(gzBody, /<h1>Zipped<\/h1><script src="\/__wed\/overlay.js"/);
    assert.equal(gz.headers.get('content-security-policy'), null);
    assert.match(await (await fetch(s.url + '/chunked')).text(), /<h1>Chunked<\/h1><script/);
    assert.equal(await (await fetch(s.url + '/x.css')).text(), 'h1{color:red}');
  } finally {
    upstream.close();
  }
});

test('full loop: draft, send, wait CLI prints batch, done logs taste, revert restores bytes', async () => {
  const s = await boot({ folder: freshSite() });
  const file = path.join(s.root, 'css', 'style.css');
  const original = fs.readFileSync(file);

  const waiter = spawn(process.execPath, [path.join(ROOT, 'bin', 'wed.js'), 'wait'], { cwd: s.root, env: { ...process.env, WED_HOME } });
  let out = '';
  waiter.stdout.on('data', (d) => (out += d));
  const exited = new Promise((r) => waiter.on('exit', r));

  // The waiter announces itself, so the page can show "Claude is listening".
  for (let i = 0; i < 50 && !(await j(s, 'GET', '/items')).data.claudeListening; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await j(s, 'GET', '/items')).data.claudeListening, true);

  const item = (await j(s, 'POST', '/items', {
    instruction: 'make this 20% larger', selector: 'h1.hero-title', src: 'index.html:15:7', tag: 'h1', text: 'Build robots that recover',
    url: '/', viewport: { w: 375, h: 812, device: 'phone' }, styleDelta: { 'font-size': { from: '48px', to: '58px' } }, refs: ['nosuch'],
  })).data;
  assert.equal(item.status, 'draft');
  const sent = (await j(s, 'POST', '/send')).data;
  assert.equal(sent.count, 1);

  const code = await exited;
  assert.equal(code, 0);
  assert.match(out, /WED BATCH b-[0-9a-f]+: 1 edit/);
  assert.match(out, /source: index.html:15:7/);
  assert.match(out, /font-size: 48px -> 58px/);
  assert.match(out, /scope CSS changes to this breakpoint/);
  assert.match(out, new RegExp(`id=${item.id}`));

  // Claude edits the file, then reports done.
  fs.writeFileSync(file, original.toString() + '\n.hero-title { font-size: 58px; }\n');
  const done = (await j(s, 'POST', '/done', { ids: [item.id], note: 'font-size 48px -> 58px in style.css' })).data;
  assert.equal(done.results[0].batchComplete, true);
  assert.deepEqual(done.results[0].changed, ['css/style.css']);
  const taste = readTaste();
  assert.equal(taste.at(-1).instruction, 'make this 20% larger');
  assert.equal(taste.at(-1).outcome, 'kept');

  const batchId = (await j(s, 'GET', '/items')).data.batches.at(-1).id;
  const rv = (await j(s, 'POST', '/revert', { batch: batchId })).data;
  assert.deepEqual(rv.restored, ['css/style.css']);
  assert.ok(fs.readFileSync(file).equals(original), 'file bytes restored exactly');
  assert.equal(readTaste().at(-1).outcome, 'reverted');
});

test('editing the same element again within 2 minutes marks the first edit re-edited', async () => {
  const s = await boot({ folder: freshSite() });
  const a = (await j(s, 'POST', '/items', { instruction: 'bluer', selector: 'p.lede', src: 'index.html:16:7', tag: 'p' })).data;
  await j(s, 'POST', '/send');
  for (let i = 0; i < 20 && !(await j(s, 'GET', '/next?timeout=50')).data; i++);
  await j(s, 'POST', '/done', { ids: [a.id], note: 'color -> blue' });
  await j(s, 'POST', '/items', { instruction: 'less blue', selector: 'p.lede', src: 'index.html:16:7', tag: 'p' });
  const e = readTaste().find((x) => x.itemId === a.id);
  assert.equal(e.outcome, 're-edited');
});

test('direct text edit endpoint writes the file and refuses mixed content', async () => {
  const s = await boot({ folder: freshSite() });
  const html = fs.readFileSync(path.join(s.root, 'index.html'), 'utf8');
  const tagged = await (await fetch(s.url + '/')).text();
  const src = /<h1 class="hero-title" data-wed-src="([^"]+)"/.exec(tagged)[1];
  const ok = (await j(s, 'POST', '/text', { src, oldText: 'Build robots that recover', newText: 'Recover faster' })).data;
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(path.join(s.root, 'index.html'), 'utf8'), html.replace('Build robots that recover', 'Recover faster'));
  const strongSrc = /<p data-wed-src="([^"]+)">For <strong/.exec(tagged)[1];
  const no = (await j(s, 'POST', '/text', { src: strongSrc, oldText: 'For teams that ship.', newText: 'x' })).data;
  assert.equal(no.ok, false);
});
