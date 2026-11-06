// Boot: mount the overlay, connect to the server's event stream, wire shortcuts.

function applyStatus(s) {
  Object.assign(W.state, s);
  renderBar();
  renderPanel();
  renderPins();
  announceFinished();
}

W.reloadNow = () => {
  W.pendingReload = false;
  ss.set('scroll', { path: location.pathname, y: scrollY });
  location.reload();
};

function onReload() {
  // Never reload under someone who is mid-sentence. Reload once they finish.
  if (W.busy) {
    if (!W.pendingReload) toast('Files changed. The page reloads when you finish this note.', '', [], 3000);
    W.pendingReload = true;
    return;
  }
  W.reloadNow();
}

function connect() {
  const es = new EventSource('/__wed/events');
  es.addEventListener('status', (e) => applyStatus(JSON.parse(e.data)));
  es.addEventListener('reload', onReload);
  es.onerror = () => {
    W.state.claudeListening = false;
    renderBar();
  };
}

document.addEventListener('keydown', (e) => {
  if (isOverlayEvent(e) && e.key !== 'Escape') return;
  if (e.key === 'Escape') {
    if (W.pinned) W.closePopover();
    else if (W.pickMode) setPickMode(false);
    W.closeMenu();
    return;
  }
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) {
    if (!REF_MODE && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey) W.send();
    return;
  }
  if (e.key === 'p' || e.key === 'P') {
    e.preventDefault();
    setPickMode(!W.pickMode);
  } else if (W.pinned && e.key === 'ArrowUp' && W.pinned.parentElement && W.pinned.parentElement !== document.documentElement) {
    e.preventDefault();
    W.openPopover(W.pinned.parentElement);
  }
}, true);

function boot() {
  mountHost();
  // Re-mount if a framework replaces <html> children.
  new MutationObserver(() => mountHost()).observe(document.documentElement, { childList: true });
  if (REF_MODE) {
    setPickMode(true);
    return;
  }
  const saved = ss.get('scroll', null);
  if (saved && saved.path === location.pathname) {
    ss.set('scroll', null);
    const restore = () => scrollTo(0, saved.y);
    restore();
    addEventListener('load', restore, { once: true });
  }
  const t = ss.get('toast', null);
  if (t) {
    ss.set('toast', null);
    toast(t, 'ok');
  }
  setPickMode(ss.get('pick', false));
  if (ss.get('panel', false)) togglePanel(true);
  renderBar();
  connect();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
