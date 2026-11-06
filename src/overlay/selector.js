// Stable, unique CSS selectors.
// Order of preference: a unique id, a data-testid, then the shortest ancestor path of
// tag.class segments (with :nth-of-type only where siblings would be ambiguous) that
// matches exactly one element.

function cssSegment(el) {
  const tag = el.tagName.toLowerCase();
  let s = tag;
  const cls = Array.from(el.classList)
    .filter((c) => /^[a-zA-Z_][\w-]*$/.test(c) && !/^(is-|has-|active|hover|focus|open)/.test(c))
    .slice(0, 2);
  if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
  const parent = el.parentElement;
  if (parent) {
    const matching = Array.from(parent.children).filter((c) => c.matches(s));
    if (matching.length > 1) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      s += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
  }
  return s;
}

function uniqueId(el) {
  if (!el.id || !/^[a-zA-Z][\w-]*$/.test(el.id)) return null;
  const sel = '#' + CSS.escape(el.id);
  return document.querySelectorAll(sel).length === 1 ? sel : null;
}

function buildSelector(el) {
  if (!el || el.nodeType !== 1) return '';
  const id = uniqueId(el);
  if (id) return id;
  const tid = el.getAttribute('data-testid');
  if (tid && document.querySelectorAll(`[data-testid="${CSS.escape(tid)}"]`).length === 1) return `[data-testid="${CSS.escape(tid)}"]`;
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
    const anchor = cur !== el && uniqueId(cur);
    if (anchor) {
      parts.unshift(anchor);
      break;
    }
    parts.unshift(cssSegment(cur));
    const sel = parts.join(' > ');
    try {
      if (document.querySelectorAll(sel).length === 1 && document.querySelector(sel) === el) return sel;
    } catch {}
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

W.buildSelector = buildSelector;
// Read-only hook for the end-to-end tests.
window.__wedDebug = { buildSelector };
