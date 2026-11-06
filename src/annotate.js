// Source-line tagging for static mode.
//
// wed serves a copy of each HTML file in which every element inside <body> carries
// data-wed-src="<file>:<line>:<col>". The attribute points at the element's start tag
// in the file on disk, so a click in the browser resolves to an exact source location.
// The file on disk is never modified by this step.

import { parse } from 'parse5';

const SKIP = new Set(['html', 'head', 'script', 'style', 'template', 'noscript', 'title', 'meta', 'link', 'base']);

/** Walk a parse5 tree depth-first and call fn on every element node. */
export function walk(node, fn) {
  if (node.tagName) fn(node);
  const kids = node.tagName === 'template' && node.content ? node.content.childNodes : node.childNodes;
  if (kids) for (const k of kids) walk(k, fn);
}

export function parseWithLocations(html) {
  return parse(html, { sourceCodeLocationInfo: true });
}

/**
 * Insert data-wed-src attributes into the original HTML string.
 * Insertions are made by offset from last to first, so earlier offsets stay valid
 * and the rest of the document is byte-for-byte unchanged.
 */
export function annotateHtml(html, relPath) {
  const doc = parseWithLocations(html);
  const inserts = [];
  let inBody = false;
  walk(doc, (el) => {
    if (el.tagName === 'body') inBody = true;
    if (!inBody && el.tagName !== 'body') return;
    if (SKIP.has(el.tagName)) return;
    const loc = el.sourceCodeLocation && el.sourceCodeLocation.startTag;
    if (!loc) return; // element implied by the parser, not present in source
    // Find where the start tag closes. endOffset points just past '>'.
    let at = loc.endOffset - 1;
    if (html[at] !== '>') return;
    if (html[at - 1] === '/') at -= 1; // self-closing form <br/>
    if (el.attrs.some((a) => a.name === 'data-wed-src')) return;
    const value = `${relPath}:${loc.startLine}:${loc.startCol}`;
    inserts.push([at, ` data-wed-src="${escapeAttr(value)}"`]);
  });
  inserts.sort((a, b) => b[0] - a[0]);
  let out = html;
  for (const [at, text] of inserts) out = out.slice(0, at) + text + out.slice(at);
  return out;
}

/** Find the element whose start tag begins at line:col. */
export function findElementAt(doc, line, col) {
  let found = null;
  walk(doc, (el) => {
    const loc = el.sourceCodeLocation && el.sourceCodeLocation.startTag;
    if (!found && loc && loc.startLine === line && loc.startCol === col) found = el;
  });
  return found;
}

export function parseSrc(src) {
  const m = /^(.*):(\d+):(\d+)$/.exec(src || '');
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), col: Number(m[3]) };
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
