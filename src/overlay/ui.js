// Overlay host, styles, highlight box, toasts and numbered pins.
// Everything lives in a Shadow DOM, so the site's CSS cannot restyle the overlay
// and the overlay's CSS cannot leak into the site.

const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.hl { position: fixed; border: 2px solid #0a84ff; background: rgba(10,132,255,.08); border-radius: 3px; pointer-events: none; transition: all 60ms ease-out; display: none; }
.hl.pinned { border-color: #ff9f0a; background: rgba(255,159,10,.08); }
.tag { position: fixed; background: #0a84ff; color: #fff; font: 600 11px/1 ui-monospace, Menlo, monospace; padding: 4px 6px; border-radius: 4px; pointer-events: none; white-space: nowrap; display: none; max-width: 70vw; overflow: hidden; text-overflow: ellipsis; }
.tag .src { opacity: .75; font-weight: 400; margin-left: 6px; }
.pin { position: fixed; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 10px; background: #ff9f0a; color: #000; font: 700 11px/20px system-ui; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.4); pointer-events: auto; cursor: pointer; }
.pin.queued, .pin.applying { background: #0a84ff; color: #fff; }
.pin.applying { animation: pulse 1s infinite; }
@keyframes pulse { 50% { opacity: .45; } }

.bar { position: fixed; right: 16px; bottom: 16px; display: flex; gap: 4px; align-items: center; padding: 5px; background: rgba(28,28,30,.94); border: 1px solid rgba(255,255,255,.12); border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.35); pointer-events: auto; color: #f2f2f7; font-size: 13px; backdrop-filter: blur(12px); }
.bar.left { right: auto; left: 16px; }
button { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px; color: #f2f2f7; font-size: 13px; font-weight: 500; line-height: 1.2; white-space: nowrap; }
button:hover { background: rgba(255,255,255,.1); }
button.on { background: #0a84ff; color: #fff; }
button.primary { background: #0a84ff; color: #fff; }
button.primary:hover { background: #2a95ff; }
button.primary[disabled] { opacity: .4; cursor: default; }
button.ghost { color: #aeaeb2; }
button.danger { color: #ff6961; }
button.small { padding: 3px 7px; font-size: 12px; }
button[disabled] { opacity: .4; cursor: default; }
.dot { width: 8px; height: 8px; border-radius: 4px; background: #636366; margin: 0 6px 0 4px; flex: none; }
.dot.live { background: #30d158; box-shadow: 0 0 6px #30d158; }
.sep { width: 1px; height: 18px; background: rgba(255,255,255,.15); margin: 0 2px; }
.count { display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 4px; border-radius: 8px; background: rgba(255,255,255,.18); font-size: 11px; text-align: center; }

.pop { position: fixed; width: 360px; max-width: calc(100vw - 32px); background: #1c1c1e; color: #f2f2f7; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; box-shadow: 0 16px 50px rgba(0,0,0,.45); pointer-events: auto; padding: 10px; font-size: 13px; }
.pop .head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.pop .head code { font: 600 12px ui-monospace, Menlo, monospace; color: #ff9f0a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pop .head .src { font: 11px ui-monospace, Menlo, monospace; color: #8e8e93; white-space: nowrap; }
.pop .head .grow { flex: 1; }
textarea, input[type=text] { all: unset; display: block; width: 100%; box-sizing: border-box; background: #2c2c2e; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 8px 10px; color: #f2f2f7; font-size: 13px; line-height: 1.4; white-space: pre-wrap; }
textarea { min-height: 64px; resize: vertical; }
textarea:focus, input[type=text]:focus { border-color: #0a84ff; }
.row { display: flex; gap: 4px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.row .grow { flex: 1; }
.hint { color: #8e8e93; font-size: 11px; }
select { all: unset; cursor: pointer; padding: 5px 8px; border-radius: 8px; background: #2c2c2e; color: #f2f2f7; font-size: 12px; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border-radius: 10px; background: #3a3a3c; font-size: 11px; }
.chip button { padding: 0 4px; }

.nudge { margin-top: 8px; padding: 8px; background: #2c2c2e; border-radius: 8px; display: grid; grid-template-columns: 92px 1fr 54px; gap: 6px 8px; align-items: center; max-height: 280px; overflow: auto; }
.nudge label { color: #aeaeb2; font-size: 12px; }
.nudge .val { font: 11px ui-monospace, Menlo, monospace; text-align: right; color: #f2f2f7; }
.nudge .val.changed { color: #ff9f0a; }
input[type=range] { width: 100%; accent-color: #0a84ff; }
input[type=color] { width: 100%; height: 22px; border: 0; padding: 0; background: none; cursor: pointer; }

.panel { position: fixed; right: 16px; bottom: 64px; width: 380px; max-width: calc(100vw - 32px); max-height: 60vh; overflow: auto; background: #1c1c1e; color: #f2f2f7; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; box-shadow: 0 16px 50px rgba(0,0,0,.45); pointer-events: auto; padding: 8px; font-size: 13px; }
.panel h3 { margin: 8px 6px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8e8e93; font-weight: 600; }
.item { display: flex; gap: 8px; padding: 7px 6px; border-radius: 8px; align-items: flex-start; }
.item:hover { background: #2c2c2e; }
.item .n { flex: none; width: 20px; height: 20px; border-radius: 10px; background: #ff9f0a; color: #000; font: 700 11px/20px system-ui; text-align: center; }
.item .n.queued, .item .n.applying { background: #0a84ff; color: #fff; }
.item .n.done { background: #30d158; }
.item .n.failed { background: #ff453a; color: #fff; }
.item .n.reverted { background: #636366; color: #fff; }
.item .body { flex: 1; min-width: 0; cursor: pointer; }
.item .what { white-space: pre-wrap; word-break: break-word; }
.item .where { font: 11px ui-monospace, Menlo, monospace; color: #8e8e93; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .result { font-size: 12px; color: #aeaeb2; margin-top: 2px; }
.batch { display: flex; align-items: center; gap: 6px; padding: 4px 6px; color: #aeaeb2; font-size: 12px; }
.batch .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 14px 8px; color: #8e8e93; line-height: 1.5; }
.menu { position: fixed; right: 16px; bottom: 64px; background: #1c1c1e; border: 1px solid rgba(255,255,255,.14); border-radius: 10px; padding: 4px; pointer-events: auto; display: flex; flex-direction: column; min-width: 160px; box-shadow: 0 16px 50px rgba(0,0,0,.45); }

.toasts { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; align-items: center; pointer-events: none; }
.toast { background: rgba(28,28,30,.96); color: #f2f2f7; padding: 9px 14px; border-radius: 10px; font-size: 13px; box-shadow: 0 8px 30px rgba(0,0,0,.35); pointer-events: auto; display: flex; gap: 10px; align-items: center; border: 1px solid rgba(255,255,255,.12); max-width: 90vw; }
.toast.ok { border-color: rgba(48,209,88,.5); }
.toast.warn { border-color: rgba(255,159,10,.6); }
`;

const host = document.createElement('wed-overlay');
host.setAttribute('data-wed-ui', '');
const shadow = host.attachShadow({ mode: 'open' });
shadow.append(h('style', null, CSS_TEXT));
const layer = h('div.layer');
shadow.append(layer);
const hl = h('div.hl');
const tagLabel = h('div.tag');
const pinsLayer = h('div');
const toasts = h('div.toasts');
layer.append(pinsLayer, hl, tagLabel, toasts);

function mountHost() {
  if (!document.documentElement.contains(host)) document.documentElement.append(host);
}

const isOverlayEvent = (e) => e.composedPath && e.composedPath().includes(host);

function showHighlight(el, pinned) {
  if (!el) {
    hl.style.display = 'none';
    tagLabel.style.display = 'none';
    return;
  }
  const r = el.getBoundingClientRect();
  Object.assign(hl.style, { display: 'block', left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 4 + 'px', height: r.height + 4 + 'px' });
  hl.classList.toggle('pinned', !!pinned);
  tagLabel.replaceChildren(labelOf(el), h('span.src', null, shortSrc(srcOf(el)) || `${Math.round(r.width)}×${Math.round(r.height)}`));
  tagLabel.style.display = 'block';
  tagLabel.style.background = pinned ? '#ff9f0a' : '#0a84ff';
  tagLabel.style.color = pinned ? '#000' : '#fff';
  const above = r.top > 26;
  tagLabel.style.left = Math.max(4, r.left) + 'px';
  tagLabel.style.top = (above ? r.top - 24 : r.bottom + 4) + 'px';
}

function toast(msg, kind = '', actions = [], ms = 4500) {
  const t = h('div.toast' + (kind ? '.' + kind : ''), null, h('span', null, msg), ...actions);
  toasts.append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

/** Numbered pins on elements that have open edits. Repositioned on scroll and resize. */
function renderPins() {
  pinsLayer.replaceChildren();
  const open = W.state.items.filter((i) => ['draft', 'queued', 'capturing', 'applying'].includes(i.status) && !i.direct);
  open.forEach((it, idx) => {
    const el = findItemElement(it);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const n = idx + 1;
    pinsLayer.append(
      h('div.pin.' + it.status, { style: { left: r.left + 'px', top: r.top + 'px' }, title: it.instruction || '', onclick: () => W.togglePanel(true) }, String(n)),
    );
  });
}

let pinRaf = 0;
const schedulePins = () => {
  cancelAnimationFrame(pinRaf);
  pinRaf = requestAnimationFrame(() => {
    renderPins();
    if (W.pinned) showHighlight(W.pinned, true);
    if (W.positionPopover) W.positionPopover();
  });
};
addEventListener('scroll', schedulePins, { passive: true, capture: true });
addEventListener('resize', schedulePins);
