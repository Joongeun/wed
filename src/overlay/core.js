// Shared state and helpers. Every overlay file is concatenated into one IIFE, and
// CONFIG is defined just above this file by the server.

const params = new URLSearchParams(location.search);
if (params.has('__wed_shot')) return; // headless screenshot render: no overlay
const REF_MODE = !!CONFIG.refMode;
if (REF_MODE && window.top !== window) return; // reference mode only runs in the top frame

const W = {
  state: { items: [], batches: [], claudeListening: false, mode: CONFIG.mode },
  pickMode: false,
  pinned: null, // element currently open in the popover
  busy: false, // true while the user is typing; reloads wait for it
  pendingReload: false,
  refs: null,
};

const ss = {
  get(k, d) {
    try {
      const v = sessionStorage.getItem('wed:' + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem('wed:' + k, JSON.stringify(v));
    } catch {}
  },
};

async function api(method, p, body) {
  const r = await fetch('/__wed' + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) throw Object.assign(new Error((data && (data.error || data.reason)) || r.statusText), { data, status: r.status });
  return data;
}

/** Tiny element builder: h('button.primary', {onclick}, 'Send') */
function h(spec, props, ...kids) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

const isTyping = (e) => {
  const t = e.composedPath ? e.composedPath()[0] : e.target;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
};

const srcOf = (el) => (el && el.getAttribute && el.getAttribute('data-wed-src')) || null;
const shortSrc = (src) => (src ? src.replace(/:(\d+):\d+$/, ':$1') : '');

function labelOf(el) {
  if (!el || !el.tagName) return '';
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const cls = Array.from(el.classList).slice(0, 2);
  if (cls.length) s += '.' + cls.join('.');
  return s;
}

/** True when the element holds only text, so it can be edited in place. */
function isLeafText(el) {
  if (!el || !el.childNodes.length) return false;
  return Array.from(el.childNodes).every((n) => n.nodeType === 3 || n.nodeType === 8) && el.textContent.trim().length > 0;
}

const KEY_STYLES = ['display', 'position', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'color', 'background-color', 'background-image', 'padding', 'margin', 'gap', 'border', 'border-radius', 'box-shadow',
  'width', 'height', 'max-width', 'text-align', 'flex-direction', 'justify-content', 'align-items', 'grid-template-columns', 'opacity'];
const BORING = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'static', 'start', '1', '0px none rgb(0, 0, 0)']);

function keyStyles(el) {
  const cs = getComputedStyle(el);
  const out = {};
  for (const p of KEY_STYLES) {
    let v = cs.getPropertyValue(p);
    if (!v || BORING.has(v)) continue;
    if (v.length > 160) v = v.slice(0, 160) + '…';
    out[p] = v;
  }
  return out;
}

function trimmedOuterHTML(el) {
  let s = el.outerHTML.replace(/ data-wed-src="[^"]*"/g, '');
  if (s.length > 2000) s = s.slice(0, 1600) + '\n…[truncated ' + (s.length - 1600) + ' chars]';
  return s;
}

function viewportInfo() {
  const w = innerWidth;
  return { w, h: innerHeight, device: w <= 480 ? 'phone' : w <= 900 ? 'tablet' : 'desktop' };
}

/** Everything Claude needs to find and understand one element. */
function describe(el) {
  const r = el.getBoundingClientRect();
  return {
    url: location.pathname + location.search,
    viewport: viewportInfo(),
    selector: buildSelector(el),
    src: srcOf(el),
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
    outerHTML: trimmedOuterHTML(el),
    styles: keyStyles(el),
    rect: { x: Math.round(r.x), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
  };
}

function findItemElement(item) {
  try {
    if (item.src) {
      const el = document.querySelector(`[data-wed-src="${CSS.escape(item.src)}"]`);
      if (el) return el;
    }
    return item.selector ? document.querySelector(item.selector) : null;
  } catch {
    return null;
  }
}
