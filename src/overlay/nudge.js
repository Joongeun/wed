// Style nudge panel.
// Sliders and color pickers preview changes live on the pinned element as inline
// !important styles. The panel records each property's before and after value, and
// that delta is what Claude receives. Claude writes it into the stylesheet; the inline
// preview disappears on the next reload.

const NUDGE_PROPS = [
  { key: 'font-size', label: 'Font size', min: 8, max: (c) => Math.max(96, c * 2), step: 1 },
  { key: 'font-weight', label: 'Weight', min: 100, max: () => 900, step: 100, unit: '' },
  { key: 'line-height', label: 'Line height', min: 0, max: (c) => Math.max(80, c * 2), step: 1 },
  { key: 'letter-spacing', label: 'Letter spacing', min: -5, max: () => 12, step: 0.1 },
  { key: 'padding-block', label: 'Padding Y', min: 0, max: (c) => Math.max(120, c * 3), step: 1, read: 'padding-top' },
  { key: 'padding-inline', label: 'Padding X', min: 0, max: (c) => Math.max(120, c * 3), step: 1, read: 'padding-left' },
  { key: 'margin-top', label: 'Margin top', min: -40, max: (c) => Math.max(160, c * 3), step: 1 },
  { key: 'margin-bottom', label: 'Margin bottom', min: -40, max: (c) => Math.max(160, c * 3), step: 1 },
  { key: 'gap', label: 'Gap', min: 0, max: (c) => Math.max(96, c * 3), step: 1, when: (cs) => /flex|grid/.test(cs.display), read: 'row-gap' },
  { key: 'border-radius', label: 'Radius', min: 0, max: (c) => Math.max(48, c * 2), step: 1, read: 'border-top-left-radius' },
  { key: 'max-width', label: 'Max width', min: 120, max: () => 1600, step: 10, when: (cs) => cs.display !== 'inline' },
  { key: 'opacity', label: 'Opacity', min: 0, max: () => 1, step: 0.05, unit: '' },
];
const NUDGE_COLORS = [
  { key: 'color', label: 'Text color' },
  { key: 'background-color', label: 'Background' },
  { key: 'border-color', label: 'Border color', read: 'border-top-color' },
];

function rgbToHex(rgb) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
  if (!m) return '#000000';
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

function numeric(v, prop) {
  if (prop === 'letter-spacing' && v === 'normal') return 0;
  if (prop === 'line-height' && v === 'normal') return null;
  if (prop === 'max-width' && v === 'none') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the nudge UI for an element. Returns { node, delta(), reset(), commit() }.
 * reset() restores the element's original inline style attribute.
 */
function createNudge(el, onChange) {
  const originalStyle = el.getAttribute('style');
  const cs = getComputedStyle(el);
  const delta = {};
  const grid = h('div.nudge');

  for (const p of NUDGE_PROPS) {
    if (p.when && !p.when(cs)) continue;
    const before = cs.getPropertyValue(p.read || p.key);
    let cur = numeric(before, p.key);
    if (cur === null && p.key === 'line-height') cur = Math.round(parseFloat(cs.fontSize) * 1.2);
    if (cur === null && p.key === 'max-width') cur = Math.round(el.getBoundingClientRect().width);
    if (cur === null) continue;
    const unit = p.unit ?? 'px';
    const max = Math.ceil(p.max(cur));
    const val = h('span.val', null, before);
    const range = h('input', {
      type: 'range', min: String(Math.min(p.min, cur)), max: String(Math.max(max, cur)), step: String(p.step), value: String(cur),
      oninput: () => {
        const v = range.value + unit;
        el.style.setProperty(p.key, v, 'important');
        val.textContent = v;
        val.classList.add('changed');
        delta[p.key] = { from: before, to: v };
        onChange && onChange();
      },
    });
    grid.append(h('label', null, p.label), range, val);
  }
  for (const c of NUDGE_COLORS) {
    const before = cs.getPropertyValue(c.read || c.key);
    const val = h('span.val', null, rgbToHex(before));
    const input = h('input', {
      type: 'color', value: rgbToHex(before),
      oninput: () => {
        el.style.setProperty(c.key, input.value, 'important');
        if (c.key === 'border-color' && cs.borderTopStyle === 'none') {
          el.style.setProperty('border', `1px solid ${input.value}`, 'important');
          delta['border'] = { from: 'none', to: `1px solid ${input.value}` };
        }
        val.textContent = input.value;
        val.classList.add('changed');
        delta[c.key] = { from: before, to: input.value };
        onChange && onChange();
      },
    });
    grid.append(h('label', null, c.label), input, val);
  }

  return {
    node: grid,
    delta: () => ({ ...delta }),
    hasChanges: () => Object.keys(delta).length > 0,
    reset() {
      if (originalStyle === null) el.removeAttribute('style');
      else el.setAttribute('style', originalStyle);
      for (const k of Object.keys(delta)) delete delta[k];
    },
  };
}
