// Toolbar, queue panel, device menu, Send and Revert.

const bar = h('div.bar');
let panel = null;
let menu = null;
layer.append(bar);

const openItems = () => W.state.items.filter((i) => !i.direct && ['draft', 'queued', 'capturing', 'applying'].includes(i.status));
const drafts = () => W.state.items.filter((i) => i.status === 'draft' && !i.direct);

function renderBar() {
  if (REF_MODE) {
    bar.replaceChildren(
      h('span.dot.live'),
      h('span', { style: { padding: '0 6px' } }, 'Reference mode: click any element to save it as inspiration'),
      h('button', { className: W.pickMode ? 'on' : '', onclick: () => setPickMode(!W.pickMode) }, W.pickMode ? 'Picking' : 'Pick'),
    );
    return;
  }
  const nDraft = drafts().length;
  const nOpen = openItems().length;
  const live = W.state.claudeListening;
  bar.replaceChildren(
    h('span.dot' + (live ? '.live' : ''), { title: live ? 'Claude is listening (wed wait is running)' : 'Claude is not listening. In Claude Code, run /live-edit' }),
    h('button', { className: W.pickMode ? 'on' : '', title: 'Toggle pick mode (P)', onclick: () => setPickMode(!W.pickMode) }, W.pickMode ? '◎ Picking' : '◎ Pick'),
    h('button', { className: panel ? 'on' : '', title: 'Show the queue', onclick: () => togglePanel() }, 'Queue', h('span.count', null, String(nOpen))),
    h('button.primary', { disabled: nDraft === 0, title: 'Send all drafts to Claude (⌘⇧↵)', onclick: () => send() }, nDraft ? `Send ${nDraft}` : 'Send'),
    h('span.sep'),
    h('button', { title: 'Preview at another screen width', onclick: () => toggleMenu() }, 'Width ▾'),
  );
}

function togglePanel(force) {
  const show = force ?? !panel;
  if (panel) panel.remove();
  panel = null;
  if (show) {
    closeMenu();
    panel = h('div.panel');
    layer.append(panel);
    renderPanel();
  }
  ss.set('panel', !!panel);
  renderBar();
}

function itemRow(it, n) {
  const where = it.src ? shortSrc(it.src) : it.selector;
  const del = it.status === 'draft'
    ? h('button.small.ghost', { title: 'Remove this draft', onclick: async () => { await api('DELETE', '/items/' + it.id).catch(() => {}); } }, '×')
    : null;
  const extras = [];
  if (it.styleDelta) extras.push(Object.entries(it.styleDelta).map(([k, v]) => `${k}: ${v.from} → ${v.to}`).join('; '));
  if (it.refs) extras.push('✦ ' + it.refs.join(', '));
  return h('div.item', null,
    h('span.n.' + it.status, { title: it.status }, it.status === 'done' ? '✓' : it.status === 'failed' ? '!' : it.status === 'reverted' ? '↺' : String(n)),
    h('div.body', {
      onclick: () => {
        const el = findItemElement(it);
        if (!el) return toast('That element is not on this page', 'warn', [], 2000);
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => { showHighlight(el, true); setTimeout(() => !W.pinned && showHighlight(null), 1400); }, 350);
      },
    },
      h('div.what', null, it.instruction || '(style change)'),
      extras.length ? h('div.where', null, extras.join(' · ')) : null,
      h('div.where', null, `${labelOf({ tagName: it.tag || 'el', classList: [], id: '' })} · ${where || ''}`),
      it.resultNote ? h('div.result', null, '↳ ' + it.resultNote) : null,
    ),
    del,
  );
}

function renderPanel() {
  if (!panel) return;
  const items = W.state.items.filter((i) => !i.direct);
  const open = openItems();
  const sections = [];
  if (open.length) {
    sections.push(h('h3', null, 'Open'));
    open.forEach((it, i) => sections.push(itemRow(it, i + 1)));
  }
  const finished = W.state.batches.filter((b) => ['done', 'reverted'].includes(b.status)).slice(-6).reverse();
  for (const b of finished) {
    const its = b.itemIds.map((id) => items.find((i) => i.id === id)).filter(Boolean);
    if (!its.length) continue;
    const when = new Date(b.finishedAt || b.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    sections.push(h('div.batch', null,
      h('span.grow', null, `${b.status === 'reverted' ? 'Reverted' : 'Applied'} ${when}${b.route && b.route !== 'main' ? ' by ' + b.route : ''}${b.changed && b.changed.length ? ' · ' + b.changed.join(', ') : ''}`),
      b.status === 'done' ? h('button.small.danger', { title: 'Restore files to before this batch', onclick: () => revert(b.id) }, 'Revert') : null,
    ));
    its.forEach((it) => sections.push(itemRow(it, 0)));
  }
  if (!sections.length) {
    sections.push(h('div.empty', null,
      h('div', null, '1. Press P (or ◎ Pick) and click any element.'),
      h('div', null, '2. Describe the change, nudge styles, or double-click text to retype it.'),
      h('div', null, '3. Queue as many as you like, then press Send.'),
      h('div', { style: { marginTop: '8px' } }, W.state.claudeListening ? 'Claude is listening.' : 'Claude is not listening yet: run /live-edit in Claude Code.'),
    ));
  }
  panel.replaceChildren(...sections);
}

function toggleMenu() {
  if (menu) return closeMenu();
  if (panel) togglePanel(false);
  const go = (w) => {
    const path = location.pathname + location.search;
    const inShell = window.top !== window && (() => { try { return window.top.location.pathname === '/__wed/device'; } catch { return false; } })();
    const dest = w ? `/__wed/device?w=${w}&path=${encodeURIComponent(path)}` : path;
    (inShell ? window.top : window).location.href = dest;
  };
  menu = h('div.menu', null,
    h('button', { onclick: () => go(375) }, 'Phone · 375 px'),
    h('button', { onclick: () => go(768) }, 'Tablet · 768 px'),
    h('button', { onclick: () => go(1280) }, 'Laptop · 1280 px'),
    h('button', { onclick: () => go(0) }, 'Full width'),
  );
  layer.append(menu);
}

function closeMenu() {
  if (menu) menu.remove();
  menu = null;
}

async function send() {
  if (!drafts().length) return;
  try {
    const r = await api('POST', '/send');
    setPickMode(false);
    if (r.route && r.route !== 'main') {
      toast(`Sent ${r.count} exact edit${r.count > 1 ? 's' : ''} to ${r.route}. No main-session turn needed.`, 'ok', [], 5000);
      return;
    }
    toast(W.state.claudeListening
      ? `Sent ${r.count} edit${r.count > 1 ? 's' : ''} to Claude`
      : `Queued ${r.count}. Claude is not listening: run /live-edit in Claude Code`, W.state.claudeListening ? 'ok' : 'warn', [], 5000);
  } catch (err) {
    toast('Send failed: ' + err.message, 'warn');
  }
}

async function revert(batchId) {
  try {
    const r = await api('POST', '/revert', { batch: batchId });
    ss.set('toast', `Reverted ${r.restored.length} file${r.restored.length === 1 ? '' : 's'}` + (r.addedNotRemoved.length ? ` (new files kept: ${r.addedNotRemoved.join(', ')})` : ''));
  } catch (err) {
    toast('Revert failed: ' + err.message, 'warn');
  }
}

/** Announce batches that finished since this page last looked. */
function announceFinished() {
  const seen = new Set(ss.get('announced', []));
  const fresh = W.state.batches.filter((b) => b.status === 'done' && !seen.has(b.id) && Date.now() - (b.finishedAt || 0) < 30000);
  for (const b of fresh) {
    seen.add(b.id);
    const n = b.itemIds.length;
    toast(`${b.route && b.route !== 'main' ? b.route[0].toUpperCase() + b.route.slice(1) : 'Claude'} applied ${n} edit${n > 1 ? 's' : ''}${b.changed.length ? ' · ' + b.changed.join(', ') : ''}`, 'ok',
      [h('button.small.danger', { onclick: () => revert(b.id) }, 'Revert')], 9000);
  }
  // Remember older batches too, so a fresh tab does not replay them.
  for (const b of W.state.batches) if (b.status !== 'queued' && b.status !== 'applying') seen.add(b.id);
  ss.set('announced', Array.from(seen).slice(-100));
}

W.renderBar = renderBar;
W.renderPanel = renderPanel;
W.togglePanel = togglePanel;
W.send = send;
W.closeMenu = closeMenu;
W.announceFinished = announceFinished;
