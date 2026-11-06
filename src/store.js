// Persistent state for one project.
//
// The server is the only writer of .wed/queue.json, so there are no cross-process races.
// The CLI commands (wait, done, revert) talk to the server over HTTP instead of
// touching this file. Snapshots and the global taste log also live here.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const WED_HOME = process.env.WED_HOME || path.join(os.homedir(), '.wed');

const SNAP_EXT = /\.(html?|css|scss|js|mjs|cjs|jsx|tsx?|json|md|svg|liquid|ya?ml|txt)$/i;
const SNAP_SKIP_DIR = new Set(['node_modules', '.git', '.wed', '_site', 'dist', 'build', '.jekyll-cache', 'vendor', '.next', '.cache']);
const SNAP_MAX_FILE = 2 * 1024 * 1024;
const SNAP_MAX_TOTAL = 50 * 1024 * 1024;

export const newId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, '.wed');
    this.file = path.join(this.dir, 'queue.json');
    fs.mkdirSync(this.dir, { recursive: true });
    // A nested .gitignore keeps .wed out of the site's repo without editing the site's own files.
    const gi = path.join(this.dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
    this.state = readJson(this.file, { items: [], batches: [] });
  }

  save() {
    writeJsonAtomic(this.file, this.state);
  }

  item(id) {
    return this.state.items.find((i) => i.id === id);
  }

  batch(id) {
    return this.state.batches.find((b) => b.id === id);
  }

  addItem(fields) {
    const item = { id: newId('e'), status: 'draft', createdAt: Date.now(), ...fields };
    this.state.items.push(item);
    this.detectReEdit(item);
    this.save();
    return item;
  }

  updateItem(id, patch) {
    const item = this.item(id);
    if (!item) return null;
    Object.assign(item, patch);
    this.save();
    return item;
  }

  deleteItem(id) {
    const item = this.item(id);
    if (!item || item.status !== 'draft') return false;
    this.state.items = this.state.items.filter((i) => i.id !== id);
    this.save();
    return true;
  }

  /** Turn every draft into one queued batch. */
  send() {
    const drafts = this.state.items.filter((i) => i.status === 'draft');
    if (!drafts.length) return null;
    const batch = { id: newId('b'), itemIds: drafts.map((d) => d.id), status: 'capturing', createdAt: Date.now() };
    for (const d of drafts) {
      d.status = 'queued';
      d.batchId = batch.id;
    }
    this.state.batches.push(batch);
    this.save();
    return batch;
  }

  /** Claim the oldest ready batch: snapshot files, mark it applying. */
  claimNext(status = 'queued') {
    const batch = this.state.batches.find((b) => b.status === status);
    if (!batch) return null;
    batch.snapshot = this.snapshot(batch.id);
    batch.status = 'applying';
    batch.claimedAt = Date.now();
    for (const id of batch.itemIds) {
      const it = this.item(id);
      if (it) it.status = 'applying';
    }
    this.save();
    return { batch, items: batch.itemIds.map((id) => this.item(id)).filter(Boolean) };
  }

  /** Mark one item finished. Returns the batch when its last item finishes. */
  finishItem(id, status = 'done', note = '') {
    const item = this.item(id);
    if (!item) return null;
    item.status = status;
    item.resultNote = note;
    item.finishedAt = Date.now();
    const batch = this.batch(item.batchId);
    let completed = null;
    if (batch && batch.itemIds.every((i) => ['done', 'failed'].includes(this.item(i)?.status))) {
      batch.status = 'done';
      batch.finishedAt = Date.now();
      batch.diff = this.diffSnapshot(batch);
      completed = batch;
      this.logTaste(batch);
    }
    this.save();
    return { item, completed };
  }

  // ---- snapshots ---------------------------------------------------------

  listSourceFiles() {
    const out = [];
    let total = 0;
    const visit = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SNAP_SKIP_DIR.has(e.name) && !e.name.startsWith('.')) visit(abs);
        } else if (e.isFile() && SNAP_EXT.test(e.name)) {
          const size = fs.statSync(abs).size;
          if (size > SNAP_MAX_FILE || total + size > SNAP_MAX_TOTAL) continue;
          total += size;
          out.push(path.relative(this.root, abs));
        }
      }
    };
    visit(this.root);
    return out;
  }

  snapshot(batchId) {
    const dir = path.join(this.dir, 'snapshots', batchId);
    const files = this.listSourceFiles();
    for (const rel of files) {
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(this.root, rel), dest);
    }
    return { dir, files };
  }

  /** Files that differ from the snapshot, plus a short unified diff. */
  diffSnapshot(batch) {
    if (!batch.snapshot) return { changed: [], added: [], text: '' };
    const { dir, files } = batch.snapshot;
    const before = new Set(files);
    const changed = [];
    let text = '';
    for (const rel of files) {
      const cur = path.join(this.root, rel);
      const old = path.join(dir, rel);
      let a, b;
      try {
        a = fs.readFileSync(old);
        b = fs.readFileSync(cur);
      } catch {
        changed.push(rel);
        continue;
      }
      if (!a.equals(b)) {
        changed.push(rel);
        text += unifiedDiff(old, cur, rel);
      }
    }
    const added = this.listSourceFiles().filter((f) => !before.has(f));
    return { changed, added, text: text.slice(0, 8000) };
  }

  revert(batchId) {
    const batch = this.batch(batchId);
    if (!batch || !batch.snapshot) return { ok: false, reason: 'no snapshot for that batch' };
    // Reverting before Claude marked the batch done: log the edits first so the
    // reverted outcome has something to attach to.
    if (batch.status === 'applying') {
      batch.diff = this.diffSnapshot(batch);
      this.logTaste(batch);
    }
    const { dir, files } = batch.snapshot;
    const restored = [];
    for (const rel of files) {
      const src = path.join(dir, rel);
      const dest = path.join(this.root, rel);
      const a = fs.readFileSync(src);
      let b = null;
      try {
        b = fs.readFileSync(dest);
      } catch {}
      if (!b || !a.equals(b)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, a);
        restored.push(rel);
      }
    }
    const before = new Set(files);
    const added = this.listSourceFiles().filter((f) => !before.has(f));
    batch.status = 'reverted';
    for (const id of batch.itemIds) {
      const it = this.item(id);
      if (it) it.status = 'reverted';
    }
    this.save();
    appendTaste({ type: 'outcome', batchId, outcome: 'reverted', ts: Date.now() });
    return { ok: true, restored, addedNotRemoved: added };
  }

  // ---- taste log ---------------------------------------------------------

  logTaste(batch) {
    for (const id of batch.itemIds) {
      const it = this.item(id);
      if (!it) continue;
      appendTaste({
        type: 'edit',
        ts: Date.now(),
        site: this.root,
        batchId: batch.id,
        itemId: it.id,
        kind: it.kind,
        instruction: it.instruction || '',
        styleDelta: it.styleDelta || null,
        textChange: it.textChange || null,
        refs: it.refs || [],
        element: { tag: it.tag, text: (it.text || '').slice(0, 80), src: it.src || null, selector: it.selector },
        model: batch.model || 'main',
        status: it.status,
        resultNote: it.resultNote || '',
        files: batch.diff ? batch.diff.changed : [],
      });
    }
  }

  /** An element edited again within 2 minutes of a finished edit means the first try missed. */
  detectReEdit(item) {
    const cutoff = Date.now() - 2 * 60 * 1000;
    for (const prev of this.state.items) {
      if (prev === item || prev.status !== 'done' || !prev.finishedAt || prev.finishedAt < cutoff) continue;
      const same = (item.src && prev.src === item.src) || (!item.src && prev.selector === item.selector);
      if (same) appendTaste({ type: 'outcome', itemId: prev.id, outcome: 're-edited', ts: Date.now() });
    }
  }
}

function unifiedDiff(a, b, label) {
  try {
    execFileSync('diff', ['-u', '--label', `a/${label}`, '--label', `b/${label}`, a, b], { encoding: 'utf8' });
    return '';
  } catch (e) {
    return e.stdout || '';
  }
}

export function appendTaste(entry) {
  fs.mkdirSync(WED_HOME, { recursive: true });
  fs.appendFileSync(path.join(WED_HOME, 'taste.jsonl'), JSON.stringify(entry) + '\n');
}

/** Merge edit entries with their later outcome events. */
export function readTaste() {
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(WED_HOME, 'taste.jsonl'), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const edits = [];
  const byItem = new Map();
  const byBatch = new Map();
  for (const l of lines) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === 'edit') {
      e.outcome = e.status === 'failed' ? 'failed' : 'kept';
      edits.push(e);
      byItem.set(e.itemId, e);
      if (!byBatch.has(e.batchId)) byBatch.set(e.batchId, []);
      byBatch.get(e.batchId).push(e);
    } else if (e.type === 'outcome') {
      if (e.itemId && byItem.has(e.itemId)) byItem.get(e.itemId).outcome = e.outcome;
      if (e.batchId && byBatch.has(e.batchId)) for (const x of byBatch.get(e.batchId)) x.outcome = e.outcome;
    }
  }
  return edits;
}
