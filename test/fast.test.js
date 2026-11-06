import { ROOT, freshSite } from './helpers.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { isMechanical, parseReply } from '../src/fast.js';
import { readTaste } from '../src/store.js';

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const servers = [];
after(async () => {
  for (const s of servers) await s.close();
});

const j = async (s, method, p, body) => {
  const r = await fetch(s.url + '/__wed' + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : null };
};
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};
async function boot(env = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wed-fake-')), 'call.json');
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CLAUDE_MODE = env.mode || 'ok';
  const s = await startServer({ folder: freshSite(), port: 0, shots: false, claudeBin: FAKE, fastModel: 'sonnet' });
  servers.push(s);
  return { s, log };
}
const STYLE = { kind: 'style', instruction: 'Apply the style changes below.', selector: '.card', src: 'index.html:21:7', tag: 'div',
  styleDelta: { 'font-size': { from: '16px', to: '30px' } } };

test('only exact text and exact slider edits count as mechanical', () => {
  assert.equal(isMechanical({ kind: 'text', textChange: { from: 'a', to: 'b' } }), true);
  assert.equal(isMechanical(STYLE), true);
  assert.equal(isMechanical({ kind: 'note', instruction: 'make it calmer' }), false);
  assert.equal(isMechanical({ kind: 'note+style', instruction: 'bigger', styleDelta: STYLE.styleDelta }), false);
  assert.equal(isMechanical({ ...STYLE, refs: ['linear'] }), false);
});

test('reply parser reads one line per item and ignores everything else', () => {
  const r = parseReply('Done.\n- e-1a2b | done | h1 text updated\n`e-3c4d` | FAILED | text not found\ne-ffff | done | not in batch', ['e-1a2b', 'e-3c4d']);
  assert.deepEqual(r, { 'e-1a2b': { status: 'done', note: 'h1 text updated' }, 'e-3c4d': { status: 'failed', note: 'text not found' } });
});

test('a mechanical batch runs on sonnet with edit-only tools, and never reaches the main session', async () => {
  const { s, log } = await boot();
  const item = (await j(s, 'POST', '/items', STYLE)).data;
  const sent = (await j(s, 'POST', '/send')).data;
  assert.equal(sent.route, 'sonnet');
  const done = await until(async () => (await j(s, 'GET', '/items')).data.items.find((i) => i.id === item.id && i.status === 'done'));
  assert.equal(done.resultNote, 'font-size 16px -> 30px in style.css (sonnet)');

  const call = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(call.args.slice(0, 3), ['-p', '--model', 'sonnet']);
  assert.ok(call.args.includes('acceptEdits'));
  const disallowed = call.args.slice(call.args.indexOf('--disallowedTools') + 1);
  assert.ok(disallowed.includes('Bash'), 'the fast model cannot run commands');
  assert.equal(fs.realpathSync(call.cwd), s.root);
  assert.match(call.prompt, /font-size: 16px -> 30px/);
  assert.match(fs.readFileSync(path.join(s.root, 'css', 'style.css'), 'utf8'), /\.card \{ font-size: 30px; \}/);

  assert.equal((await j(s, 'GET', '/next?timeout=50')).status, 204, 'main session gets nothing');
  const batch = (await j(s, 'GET', '/items')).data.batches.at(-1);
  assert.equal(batch.route, 'sonnet');
  assert.deepEqual(batch.changed, ['css/style.css']);
  assert.equal(readTaste().find((e) => e.itemId === item.id).model, 'sonnet');
});

test('a batch with a free-form note goes to the main session, not the fast model', async () => {
  const { s, log } = await boot();
  await j(s, 'POST', '/items', STYLE);
  await j(s, 'POST', '/items', { instruction: 'make the hero feel calmer', selector: 'section.hero', src: 'index.html:13:5', tag: 'section' });
  assert.equal((await j(s, 'POST', '/send')).data.route, 'main');
  const claimed = await until(async () => (await j(s, 'GET', '/next?timeout=200')).data);
  assert.equal(claimed.items.length, 2);
  assert.equal(fs.existsSync(log), false, 'fast model was never started');
});

test('if the fast model cannot start, the batch falls back to the main session', async () => {
  const { s } = await boot({ mode: 'fail' });
  const item = (await j(s, 'POST', '/items', STYLE)).data;
  assert.equal((await j(s, 'POST', '/send')).data.route, 'sonnet');
  const claimed = await until(async () => (await j(s, 'GET', '/next?timeout=200')).data);
  assert.equal(claimed.items[0].id, item.id);
});
