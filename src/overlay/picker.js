// Pick mode, the note popover, and inline text editing.
// In pick mode the overlay swallows clicks in the capture phase, so links and buttons
// on the site do not fire while you are choosing an element.

let hoverEl = null;
let pop = null;
let nudge = null;
let refChoices = [];

function targetFromEvent(e) {
  const path = e.composedPath ? e.composedPath() : [e.target];
  const el = path.find((n) => n && n.nodeType === 1);
  if (!el || el === host || el === document.documentElement) return null;
  return el;
}

function setPickMode(on) {
  W.pickMode = on;
  ss.set('pick', on);
  document.documentElement.style.cursor = on ? 'crosshair' : '';
  if (!on && !W.pinned) showHighlight(null);
  W.renderBar && W.renderBar();
}

function swallow(e) {
  if (!W.pickMode || isOverlayEvent(e)) return false;
  // Let clicks inside the text being edited place the caret normally.
  if (W.editingEl && e.composedPath && e.composedPath().includes(W.editingEl)) return false;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  return true;
}

document.addEventListener('mousemove', (e) => {
  if (!W.pickMode || W.pinned || isOverlayEvent(e)) return;
  const el = targetFromEvent(e);
  if (el !== hoverEl) {
    hoverEl = el;
    showHighlight(el, false);
  }
}, true);

for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'submit']) {
  document.addEventListener(type, swallow, true);
}

document.addEventListener('click', (e) => {
  if (!swallow(e)) return;
  const el = targetFromEvent(e);
  if (!el) return;
  if (W.pinned && W.pinned !== el && pop && popHasInput()) {
    // A half-written note is not thrown away by a stray click.
    toast('Finish or cancel the open note first (Esc cancels)', 'warn', [], 2500);
    return;
  }
  openPopover(el);
}, true);

document.addEventListener('dblclick', (e) => {
  if (REF_MODE || isOverlayEvent(e) || W.editingEl) return;
  const el = targetFromEvent(e);
  if (!W.pickMode) {
    // Outside pick mode a double-click keeps its normal meaning (select a word),
    // but say once how to edit, so it never looks broken.
    if (el && editTarget(el) && !ss.get('dblHint', false)) {
      ss.set('dblHint', true);
      toast('To edit text: press P, then double-click it', '', [], 3500);
    }
    return;
  }
  swallow(e);
  if (!el) return;
  const target = editTarget(el);
  if (!target) {
    toast('This element holds other blocks, so it cannot be retyped in place. Describe the change in the note instead.', 'warn', [], 4500);
    return;
  }
  closePopover();
  startTextEdit(target);
}, true);

function popHasInput() {
  const ta = pop && pop.querySelector('textarea');
  return !!(ta && ta.value.trim()) || (nudge && nudge.hasChanges());
}

// ---- popover ------------------------------------------------------------------

function positionPopover() {
  if (!pop || !W.pinned) return;
  const r = W.pinned.getBoundingClientRect();
  const pw = pop.offsetWidth || 360;
  const ph = pop.offsetHeight || 200;
  let top = r.bottom + 10;
  if (top + ph > innerHeight - 70) top = r.top - ph - 10;
  if (top < 8) top = Math.min(innerHeight - ph - 70, Math.max(8, r.top + 10));
  const left = Math.min(Math.max(8, r.left), innerWidth - pw - 8);
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
}
W.positionPopover = positionPopover;

function closePopover(keepStyles) {
  if (nudge && !keepStyles) nudge.reset();
  nudge = null;
  refChoices = [];
  if (pop) pop.remove();
  pop = null;
  W.pinned = null;
  W.busy = false;
  showHighlight(null);
  if (W.pendingReload) W.reloadNow();
}

async function loadRefs() {
  if (REF_MODE) return [];
  if (!W.refs) {
    try {
      W.refs = (await api('GET', '/refs')).refs || [];
    } catch {
      W.refs = [];
    }
  }
  return W.refs;
}

function openPopover(el) {
  closePopover();
  W.pinned = el;
  W.busy = true;
  showHighlight(el, true);
  if (REF_MODE) return openRefPopover(el);

  const src = srcOf(el);
  const ta = h('textarea', { placeholder: 'What should change? e.g. "make this 20% larger and bolder"' });
  const chips = h('div.row');
  const refSelect = h('select', { title: 'Attach a saved inspiration reference' }, h('option', { value: '' }, 'Inspiration…'));
  loadRefs().then((refs) => {
    if (!refs.length) {
      refSelect.append(h('option', { value: '', disabled: true }, 'No refs yet: wed ref add <url>'));
      return;
    }
    for (const r of refs) {
      refSelect.append(h('option', { value: r.name }, `${r.name} (whole page)`));
      for (const e of r.elements) refSelect.append(h('option', { value: `${r.name}/${e}` }, `  ${r.name} / ${e}`));
    }
  });
  refSelect.addEventListener('change', () => {
    const v = refSelect.value;
    refSelect.value = '';
    if (!v || refChoices.includes(v)) return;
    refChoices.push(v);
    renderChips();
  });
  const renderChips = () => {
    chips.replaceChildren(...refChoices.map((r) => h('span.chip', null, '✦ ' + r, h('button', { onclick: () => { refChoices = refChoices.filter((x) => x !== r); renderChips(); } }, '×'))));
    chips.style.display = refChoices.length ? 'flex' : 'none';
    positionPopover();
  };
  renderChips();

  const nudgeSlot = h('div');
  const styleBtn = h('button.small', {
    onclick: () => {
      if (nudge) {
        nudgeSlot.replaceChildren();
        nudge.reset();
        nudge = null;
        styleBtn.classList.remove('on');
      } else {
        nudge = createNudge(el, () => showHighlight(el, true));
        nudgeSlot.replaceChildren(nudge.node);
        styleBtn.classList.add('on');
      }
      positionPopover();
    },
  }, 'Style ▾');
  const editable = editTarget(el);
  const textBtn = h('button.small', {
    disabled: !editable,
    title: editable ? 'Edit the words in place (or double-click the text)' : 'This element holds other blocks; describe the change instead',
    onclick: () => {
      closePopover();
      startTextEdit(editable);
    },
  }, 'Edit text');
  const parentBtn = h('button.small.ghost', {
    title: 'Select the parent element (↑)',
    disabled: !el.parentElement || el.parentElement === document.body.parentElement,
    onclick: () => openPopover(el.parentElement),
  }, '↑ parent');

  const add = async () => {
    const note = ta.value.trim();
    const delta = nudge ? nudge.delta() : null;
    if (!note && !(delta && Object.keys(delta).length) && !refChoices.length) {
      ta.focus();
      toast('Write a note, nudge a style, or attach a ref first', 'warn', [], 2000);
      return;
    }
    const payload = {
      ...describe(el),
      kind: delta && Object.keys(delta).length ? (note ? 'note+style' : 'style') : 'note',
      instruction: note || (delta ? 'Apply the style changes below.' : 'Make this look like the attached reference.'),
      styleDelta: delta && Object.keys(delta).length ? delta : undefined,
      refs: refChoices.length ? refChoices.slice() : undefined,
    };
    try {
      await api('POST', '/items', payload);
      closePopover(true); // keep the live style preview until Claude's edit reloads the page
      toast('Added to queue. Pick the next element, or press Send.', 'ok', [], 2200);
    } catch (err) {
      toast('Could not save: ' + err.message, 'warn');
    }
  };

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      add().then(() => W.send());
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      add();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePopover();
    }
  });

  pop = h('div.pop', { onkeydown: (e) => e.stopPropagation() },
    h('div.head', null, h('code', null, labelOf(el)), h('span.src', null, shortSrc(src) || 'proxy: no line info'), h('span.grow'), parentBtn),
    ta,
    chips,
    h('div.row', null, styleBtn, textBtn, refSelect),
    nudgeSlot,
    h('div.row', null, h('span.hint', null, '⌘↵ add · ⌘⇧↵ add + send'), h('span.grow'), h('button.ghost', { onclick: () => closePopover() }, 'Cancel'), h('button.primary', { onclick: add }, 'Add')),
  );
  layer.append(pop);
  positionPopover();
  setTimeout(() => ta.focus(), 0);
}

// ---- reference mode popover ---------------------------------------------------

function openRefPopover(el) {
  const guess = (Array.from(el.classList)[0] || el.tagName.toLowerCase()).replace(/[^a-z0-9-]/gi, '-').slice(0, 30);
  const name = h('input', { type: 'text', value: guess, placeholder: 'name, e.g. pricing-card' });
  const why = h('textarea', { placeholder: 'What do you like about it? e.g. "the soft shadow and tight type"' });
  const save = async () => {
    const payload = { ...describe(el), name: name.value.trim() || guess, why: why.value.trim(), pageUrl: location.href, fullStyles: fullStyles(el) };
    const r = el.getBoundingClientRect();
    payload.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    closePopover();
    try {
      const res = await window.__wedSaveRef(payload);
      toast('Saved as inspiration: ' + res.id, 'ok');
    } catch (err) {
      toast('Could not save: ' + err.message, 'warn');
    }
  };
  pop = h('div.pop', { onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Escape') closePopover(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); } },
    h('div.head', null, h('code', null, labelOf(el)), h('span.grow'), h('button.small.ghost', { onclick: () => openPopover(el.parentElement) }, '↑ parent')),
    name,
    h('div', { style: { height: '6px' } }),
    why,
    h('div.row', null, h('span.hint', null, 'Saved to ~/.wed/refs'), h('span.grow'), h('button.ghost', { onclick: () => closePopover() }, 'Cancel'), h('button.primary', { onclick: save }, 'Save ref')),
  );
  layer.append(pop);
  positionPopover();
  setTimeout(() => name.select(), 0);
}

function fullStyles(el) {
  const cs = getComputedStyle(el);
  const props = KEY_STYLES.concat(['font-style', 'text-transform', 'border-top', 'border-bottom', 'outline', 'transition', 'transform', 'backdrop-filter', 'filter', 'min-height', 'aspect-ratio', 'object-fit']);
  const out = {};
  for (const p of props) out[p] = cs.getPropertyValue(p);
  return out;
}

// ---- inline text editing ------------------------------------------------------

/** innerHTML as it should be written to disk: wed's own attributes removed. */
function cleanInnerHtml(el) {
  const c = el.cloneNode(true);
  for (const d of c.querySelectorAll('[data-wed-src],[contenteditable]')) {
    d.removeAttribute('data-wed-src');
    d.removeAttribute('contenteditable');
  }
  return c.innerHTML;
}

function startTextEdit(el) {
  const before = el.textContent;
  const rich = !isLeafText(el); // holds inline tags such as <mark>, which must survive the edit
  const beforeHtml = el.innerHTML;
  const beforeClean = rich ? cleanInnerHtml(el) : null;
  const src = srcOf(el);
  W.busy = true;
  W.editingEl = el;
  showHighlight(el, true);
  if (rich) {
    el.setAttribute('contenteditable', 'true');
  } else {
    el.setAttribute('contenteditable', 'plaintext-only');
    if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
  }
  // Pasting rich content would drag in foreign markup; paste plain text only.
  const onPaste = (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
  };
  el.addEventListener('paste', onPaste, true);
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  toast('Editing text: Enter saves, Esc cancels, Shift+Enter for a line break', '', [], 3000);

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    el.removeEventListener('keydown', onKey, true);
    el.removeEventListener('blur', onBlur, true);
    el.removeEventListener('paste', onPaste, true);
    el.removeAttribute('contenteditable');
    W.editingEl = null;
    showHighlight(null);
    const after = el.textContent;
    let afterHtml = rich ? cleanInnerHtml(el) : null;
    // Editable regions turn typed spaces at edges into &nbsp;. Keep them only if the source had them.
    if (rich && !beforeClean.includes('&nbsp;')) afterHtml = afterHtml.replace(/&nbsp;/g, ' ');
    const unchanged = rich ? afterHtml === beforeClean : after.trim() === before.trim();
    if (!save || unchanged) {
      if (rich) el.innerHTML = beforeHtml;
      else el.textContent = before;
      W.busy = false;
      if (W.pendingReload) W.reloadNow();
      return;
    }
    let result = { ok: false, reason: 'proxy mode: no source lines' };
    if (src && W.state.mode === 'static') {
      try {
        result = await api('POST', '/text', { src, oldText: before, newText: after, newHtml: afterHtml, tag: el.tagName.toLowerCase(), selector: buildSelector(el) });
      } catch (err) {
        result = { ok: false, reason: err.message };
      }
    }
    if (result.ok) {
      toast(`Saved to ${result.file}:${result.line}`, 'ok', [], 2500);
    } else {
      // Fall back to a note so the change is never lost.
      const editedHtml = el.innerHTML;
      if (rich) el.innerHTML = beforeHtml;
      else el.textContent = before;
      await api('POST', '/items', {
        ...describe(el),
        kind: 'text',
        instruction: rich
          ? `Change this element's contents to (keep the inline tags as shown):\n${afterHtml}`
          : `Change this text from:\n"${before.trim()}"\nto:\n"${after.trim()}"`,
        textChange: { from: before.trim(), to: after.trim() },
      }).catch(() => {});
      el.innerHTML = editedHtml;
      toast(`Queued for Claude (${result.reason})`, 'warn', [], 4000);
    }
    W.busy = false;
    if (W.pendingReload) W.reloadNow();
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && e.shiftKey && rich) {
      // A rich editor would insert a <div> here; a <br> is what a heading needs.
      e.preventDefault();
      document.execCommand('insertLineBreak');
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  el.addEventListener('keydown', onKey, true);
  el.addEventListener('blur', onBlur, true);
}

W.setPickMode = setPickMode;
W.openPopover = openPopover;
W.closePopover = closePopover;
W.startTextEdit = startTextEdit;
