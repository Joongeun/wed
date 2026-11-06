import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE, lineOf } from './helpers.js';
import { annotateHtml, parseSrc } from '../src/annotate.js';

const html = fs.readFileSync(path.join(FIXTURE, 'index.html'), 'utf8');

test('tags body elements with their exact start-tag line and column', () => {
  const out = annotateHtml(html, 'index.html');
  const line = lineOf(html, '<h1 class="hero-title">');
  const col = html.split('\n')[line - 1].indexOf('<h1') + 1;
  assert.match(out, new RegExp(`<h1 class="hero-title" data-wed-src="index.html:${line}:${col}">`));
});

test('leaves the head, scripts and everything outside tags byte-identical', () => {
  const out = annotateHtml(html, 'index.html');
  assert.equal(out.replace(/ data-wed-src="[^"]*"/g, ''), html);
  assert.ok(!/<(head|meta|link|title)\b[^>]*data-wed-src/.test(out));
});

test('handles self-closing and void elements', () => {
  const out = annotateHtml(html, 'index.html');
  assert.match(out, /<img src="[^"]*" alt="" data-wed-src="index.html:\d+:\d+"\/>/);
  assert.match(out, /<br data-wed-src="index.html:\d+:\d+">/);
});

test('every tag points at a line that really starts that element', () => {
  const out = annotateHtml(html, 'index.html');
  const lines = html.split('\n');
  for (const m of out.matchAll(/<([a-z0-9]+)[^>]*data-wed-src="([^"]+)"/g)) {
    const { line, col } = parseSrc(m[2]);
    assert.equal(lines[line - 1].slice(col - 1, col + m[1].length).toLowerCase(), '<' + m[1], m[0]);
  }
});

// Optional: set WED_REAL_SITE to a real single-file site's index.html to check it too.
const REAL = process.env.WED_REAL_SITE || '';
test('real single-file site: all tags resolve to the right source line', { skip: !(REAL && fs.existsSync(REAL)) && 'set WED_REAL_SITE to run' }, () => {
  const src = fs.readFileSync(REAL, 'utf8');
  const out = annotateHtml(src, 'index.html');
  const lines = src.split('\n');
  let n = 0;
  for (const m of out.matchAll(/<([a-zA-Z0-9-]+)[^>]*?data-wed-src="([^"]+)"/g)) {
    const { line, col } = parseSrc(m[2]);
    assert.equal(lines[line - 1].slice(col - 1, col + m[1].length).toLowerCase(), '<' + m[1].toLowerCase());
    n++;
  }
  assert.ok(n > 50, `expected many tagged elements, got ${n}`);
  assert.equal(out.replace(/ data-wed-src="[^"]*"/g, ''), src);
});
