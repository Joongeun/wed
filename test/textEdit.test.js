import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshSite, lineOf } from './helpers.js';
import { applyTextEdit, replaceTextInHtml } from '../src/textEdit.js';

const at = (html, needle) => {
  const line = lineOf(html, needle);
  return [line, html.split('\n')[line - 1].indexOf(needle) + 1];
};

test('replaces plain text at the tagged element and nothing else', () => {
  const dir = freshSite();
  const file = path.join(dir, 'index.html');
  const before = fs.readFileSync(file, 'utf8');
  const [line, col] = at(before, '<h1 class="hero-title">');
  const r = applyTextEdit(dir, `index.html:${line}:${col}`, 'Build robots that recover', 'Robots that fix themselves');
  assert.equal(r.ok, true, r.reason);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, before.replace('Build robots that recover', 'Robots that fix themselves'));
});

test('keeps entities valid and escapes new markup characters', () => {
  const html = '<body>\n<p class="x">Fast &amp; cheap</p>\n</body>';
  const r = replaceTextInHtml(html, 2, 1, 'Fast & cheap', 'Fast <and> cheap & good');
  assert.equal(r.ok, true);
  assert.match(r.html, /<p class="x">Fast &lt;and&gt; cheap &amp; good<\/p>/);
});

test('refuses an element that mixes text with tags', () => {
  const dir = freshSite();
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const [line, col] = at(html, '<p>For <strong>');
  const r = applyTextEdit(dir, `index.html:${line}:${col}`, 'For teams that ship.', 'For everyone.');
  assert.equal(r.ok, false);
  assert.match(r.reason, /mixes text/);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), html);
});

test('refuses when the page text no longer matches the file', () => {
  const html = '<body>\n<h1>Hello</h1>\n</body>';
  const r = replaceTextInHtml(html, 2, 1, 'Goodbye', 'New');
  assert.equal(r.ok, false);
});

test('refuses template syntax and paths outside the root', () => {
  assert.equal(replaceTextInHtml('<body>\n<h1>{{ page.title }}</h1>', 2, 1, '{{ page.title }}', 'x').ok, false);
  const dir = freshSite();
  assert.equal(applyTextEdit(dir, '../../etc/passwd:1:1', 'a', 'b').ok, false);
});
