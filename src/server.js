// The wed server.
//
// Static mode serves a folder and tags every element with its source line.
// Proxy mode forwards to a running dev server (Jekyll, python http.server, anything).
// Both modes inject the overlay script into HTML responses and expose /__wed/* for the
// overlay and for the `wed wait` / `wed done` commands Claude runs.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Store, writeJsonAtomic, WED_HOME } from './store.js';
import { annotateHtml } from './annotate.js';
import { injectOverlay, looksLikeHtml } from './inject.js';
import { applyTextEdit } from './textEdit.js';
import { captureItems } from './shots.js';
import { listRefs } from './refs.js';
import { closeShared } from './browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = path.join(HERE, 'overlay');
// Concatenation order matters: later files use helpers defined by earlier ones.
export const OVERLAY_FILES = ['core.js', 'selector.js', 'ui.js', 'nudge.js', 'picker.js', 'panel.js', 'main.js'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};

export function buildOverlay(config) {
  const parts = OVERLAY_FILES.map((f) => `// ---- ${f}\n` + fs.readFileSync(path.join(OVERLAY_DIR, f), 'utf8'));
  return `(function(){\n"use strict";\nif (window.__wedLoaded) return; window.__wedLoaded = true;\nconst CONFIG = ${JSON.stringify(config)};\n${parts.join('\n')}\n})();\n`;
}

export async function startServer(opts) {
  const mode = opts.upstream ? 'proxy' : 'static';
  const root = path.resolve(opts.root || (mode === 'static' ? opts.folder : process.cwd()));
  const store = new Store(root);
  const upstream = opts.upstream ? new URL(opts.upstream) : null;
  const sseClients = new Set();
  const waiters = [];
  let lastWaiterSeen = 0;
  let baseUrl = '';

  const broadcast = (event, data = {}) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };

  const publicItems = () => ({
    items: store.state.items.filter((i) => i.status !== 'archived').slice(-200),
    batches: store.state.batches.slice(-30).map(({ id, status, itemIds, createdAt, finishedAt, diff }) => ({
      id, status, itemIds, createdAt, finishedAt, changed: diff ? diff.changed : [],
    })),
    claudeListening: waiters.length > 0 || Date.now() - lastWaiterSeen < 4000,
    mode,
  });

  const statusChanged = () => broadcast('status', publicItems());

  const serveWaiters = () => {
    while (waiters.length) {
      const claimed = store.claimNext();
      if (!claimed) return;
      const w = waiters.shift();
      clearTimeout(w.timer);
      sendJson(w.res, 200, { ...claimed, root, mode, url: baseUrl });
      statusChanged();
    }
  };

  // ---- file watcher drives live reload --------------------------------------
  let reloadTimer = null;
  const reloadDelay = opts.reloadDelay ?? (mode === 'proxy' ? 700 : 150);
  let watcher = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
      if (!file) return;
      const parts = String(file).split(path.sep);
      if (parts.some((p) => p === '.wed' || p === 'node_modules' || p === '.git' || p === '.jekyll-cache')) return;
      if (mode === 'proxy' && parts[0] === '_site' && !opts.watchSite) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => broadcast('reload', { file: String(file) }), reloadDelay);
    });
  } catch {
    // Recursive watch is unavailable on some platforms; manual reload still works.
  }

  // ---- request handling -------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith('/__wed/')) return await api(req, res, u);
      if (mode === 'proxy') return proxy(req, res);
      return serveStatic(req, res, u);
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
      else res.end();
    }
  });

  async function api(req, res, u) {
    const p = u.pathname.slice('/__wed'.length);
    const m = req.method;
    if (p === '/overlay.js') {
      const body = buildOverlay({ mode, refMode: false });
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      return res.end(body);
    }
    if (p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(publicItems())}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }
    if (p === '/items' && m === 'GET') return sendJson(res, 200, publicItems());
    if (p === '/items' && m === 'POST') {
      const item = store.addItem(sanitizeItem(await readBody(req)));
      statusChanged();
      return sendJson(res, 200, item);
    }
    let mm = /^\/items\/([\w-]+)$/.exec(p);
    if (mm && m === 'PATCH') {
      const item = store.updateItem(mm[1], sanitizeItem(await readBody(req), true));
      statusChanged();
      return sendJson(res, item ? 200 : 404, item || { error: 'not found' });
    }
    if (mm && m === 'DELETE') {
      const ok = store.deleteItem(mm[1]);
      statusChanged();
      return sendJson(res, ok ? 200 : 409, { ok });
    }
    if (p === '/send' && m === 'POST') {
      const batch = store.send();
      if (!batch) return sendJson(res, 409, { error: 'nothing to send' });
      statusChanged();
      sendJson(res, 200, { batchId: batch.id, count: batch.itemIds.length });
      // Screenshots are best effort and capped at 20 s so a slow page cannot stall Claude.
      const items = batch.itemIds.map((id) => store.item(id));
      const shots = opts.shots === false ? {} : await Promise.race([
        captureItems(baseUrl, items, path.join(store.dir, 'shots')).catch(() => ({})),
        new Promise((r) => setTimeout(() => r({}), opts.shotTimeout ?? 20000)),
      ]);
      for (const it of items) if (shots[it.id]) it.screenshot = shots[it.id];
      batch.status = 'queued';
      store.save();
      serveWaiters();
      statusChanged();
      return;
    }
    if (p === '/next' && m === 'GET') {
      lastWaiterSeen = Date.now();
      const claimed = store.claimNext();
      if (claimed) {
        statusChanged();
        return sendJson(res, 200, { ...claimed, root, mode, url: baseUrl });
      }
      const timeout = Math.min(Number(u.searchParams.get('timeout')) || 25000, 60000);
      const w = { res };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        lastWaiterSeen = Date.now();
        sendJson(res, 204, null);
      }, timeout);
      req.on('close', () => {
        const i = waiters.indexOf(w);
        if (i >= 0) {
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          statusChanged();
        }
      });
      const wasListening = waiters.length > 0;
      waiters.push(w);
      if (!wasListening) statusChanged();
      return;
    }
    if (p === '/done' && m === 'POST') {
      const body = await readBody(req);
      let ids = body.ids || (body.id ? [body.id] : []);
      if (body.batch) {
        const b = store.batch(body.batch);
        if (!b) return sendJson(res, 404, { error: 'no such batch' });
        ids = b.itemIds.filter((id) => store.item(id)?.status === 'applying');
      }
      const results = [];
      for (const id of ids) {
        const r = store.finishItem(id, body.status === 'failed' ? 'failed' : 'done', body.note || '');
        if (!r) results.push({ id, error: 'not found' });
        else results.push({ id, status: r.item.status, batchComplete: !!r.completed, changed: r.completed?.diff?.changed });
      }
      statusChanged();
      broadcast('reload', { reason: 'done' });
      return sendJson(res, 200, { results });
    }
    if (p === '/revert' && m === 'POST') {
      const body = await readBody(req);
      const r = store.revert(body.batch);
      statusChanged();
      if (r.ok) broadcast('reload', { reason: 'revert' });
      return sendJson(res, r.ok ? 200 : 404, r);
    }
    if (p === '/text' && m === 'POST') {
      const body = await readBody(req);
      if (mode !== 'static') return sendJson(res, 200, { ok: false, reason: 'proxy mode: no source lines' });
      const r = applyTextEdit(root, body.src, body.oldText || '', body.newText || '', typeof body.newHtml === 'string' ? body.newHtml : null);
      if (r.ok) {
        // Direct edits skip Claude, but they still teach the taste log what copy was changed.
        store.addItem({ kind: 'text', src: body.src, tag: body.tag, selector: body.selector, text: body.oldText,
          textChange: { from: body.oldText, to: body.newText }, instruction: 'direct text edit', status: 'done', finishedAt: Date.now(), direct: true });
        statusChanged();
      }
      return sendJson(res, 200, r);
    }
    if (p === '/refs' && m === 'GET') return sendJson(res, 200, listRefs());
    mm = /^\/refs\/file\/(.+)$/.exec(p);
    if (mm && m === 'GET') return serveFile(res, path.join(WED_HOME, 'refs'), decodeURIComponent(mm[1]));
    mm = /^\/shots\/([\w-]+\.png)$/.exec(p);
    if (mm && m === 'GET') return serveFile(res, path.join(store.dir, 'shots'), mm[1]);
    if (p === '/device') return deviceShell(res, u);
    sendJson(res, 404, { error: 'unknown wed endpoint' });
  }

  function serveStatic(req, res, u) {
    let rel = decodeURIComponent(u.pathname);
    let abs = path.join(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return sendText(res, 403, 'forbidden');
    if (rel.split('/').some((s) => s === '.wed')) return sendText(res, 404, 'not found');
    let st = statSafe(abs);
    if (st && st.isDirectory()) {
      if (!rel.endsWith('/')) {
        res.writeHead(301, { location: rel + '/' + u.search });
        return res.end();
      }
      abs = path.join(abs, 'index.html');
      st = statSafe(abs);
    }
    if (!st && !path.extname(abs) && statSafe(abs + '.html')) {
      abs += '.html';
      st = statSafe(abs);
    }
    if (!st) return sendText(res, 404, `wed: ${rel} not found in ${root}`);
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html' || ext === '.htm') {
      let html = fs.readFileSync(abs, 'utf8');
      const relFile = path.relative(root, abs).split(path.sep).join('/');
      try {
        html = annotateHtml(html, relFile);
      } catch {
        // Unparseable HTML still gets served; it just has no line tags.
      }
      if (!u.searchParams.has('__wed_raw')) html = injectOverlay(html);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': st.size });
    fs.createReadStream(abs).pipe(res);
  }

  function proxy(req, res) {
    const headers = { ...req.headers, host: upstream.host, 'accept-encoding': 'identity' };
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
    const up = http.request(
      { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers },
      (ur) => {
        const h = { ...ur.headers };
        if (h.location) h.location = h.location.replace(upstream.origin, baseUrl);
        if (!looksLikeHtml(h['content-type'])) {
          res.writeHead(ur.statusCode, h);
          return ur.pipe(res);
        }
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = (h['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          } catch {}
          const html = injectOverlay(buf.toString('utf8'));
          for (const k of ['content-encoding', 'content-length', 'transfer-encoding', 'content-security-policy', 'etag']) delete h[k];
          h['cache-control'] = 'no-store';
          res.writeHead(ur.statusCode, h);
          res.end(html);
        });
      },
    );
    up.on('error', (e) => sendText(res, 502, `wed: upstream ${upstream.origin} is not responding (${e.code}). Is the dev server running?`));
    req.pipe(up);
  }

  function deviceShell(res, u) {
    const w = Number(u.searchParams.get('w')) || 375;
    const target = u.searchParams.get('path') || '/';
    const btn = (label, width) =>
      `<a href="${width ? `/__wed/device?w=${width}&path=${encodeURIComponent(target)}` : target}" class="${width === w ? 'on' : ''}">${label}</a>`;
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>wed · ${w}px</title>
<style>html,body{margin:0;height:100%;background:#1c1c1e;font:13px system-ui;color:#ddd}
nav{height:40px;display:flex;gap:6px;align-items:center;justify-content:center}
nav a{color:#ddd;text-decoration:none;padding:5px 12px;border-radius:6px;background:#2c2c2e}nav a.on{background:#0a84ff;color:#fff}
iframe{display:block;margin:0 auto;border:0;background:#fff;width:${w}px;height:calc(100% - 52px);border-radius:10px}</style>
<nav>${btn('Phone 375', 375)}${btn('Tablet 768', 768)}${btn('Laptop 1280', 1280)}${btn('Full width', 0)}</nav>
<iframe src="${target.replace(/"/g, '&quot;')}"></iframe>`);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4747, opts.host || '127.0.0.1', resolve);
  });
  baseUrl = `http://${opts.host || '127.0.0.1'}:${server.address().port}`.replace('127.0.0.1', 'localhost');

  const info = { url: baseUrl, root, mode, upstream: upstream?.origin || null, pid: process.pid, startedAt: Date.now() };
  writeJsonAtomic(path.join(store.dir, 'server.json'), info);
  writeJsonAtomic(path.join(WED_HOME, 'active.json'), info);

  return {
    url: baseUrl,
    root,
    mode,
    store,
    async close() {
      for (const r of sseClients) r.end();
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.res.end();
      }
      watcher?.close();
      clearTimeout(reloadTimer);
      // close() waits for open keep-alive sockets, so drop them first or it never resolves.
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await closed;
      await closeShared();
    },
  };
}

// ---- helpers ------------------------------------------------------------------

const ITEM_FIELDS = ['kind', 'instruction', 'url', 'viewport', 'selector', 'src', 'tag', 'text', 'outerHTML', 'styles',
  'rect', 'styleDelta', 'refs', 'textChange', 'classes', 'id_attr', 'path'];

function sanitizeItem(body, partial = false) {
  const out = {};
  for (const k of ITEM_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  if (typeof out.outerHTML === 'string') out.outerHTML = out.outerHTML.slice(0, 2000);
  if (typeof out.text === 'string') out.text = out.text.slice(0, 300);
  if (!partial && !out.kind) out.kind = 'note';
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, code, data) {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(code === 204 ? '' : JSON.stringify(data));
}

function sendText(res, code, text) {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function serveFile(res, dir, rel) {
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) return sendText(res, 403, 'forbidden');
  const st = statSafe(abs);
  if (!st || !st.isFile()) return sendText(res, 404, 'not found');
  res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(abs).pipe(res);
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
