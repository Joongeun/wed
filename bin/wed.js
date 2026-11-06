#!/usr/bin/env node
// wed: point at a local website, describe the change, Claude applies it.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { startServer, buildOverlay } from '../src/server.js';
import { readJson, readTaste, WED_HOME } from '../src/store.js';
import { addRef, openRef, listRefs } from '../src/refs.js';
import { formatBatch } from '../src/format.js';

export { formatBatch };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

const HELP = `wed: point-and-click website edits for Claude Code

Start a session
  wed [folder]                 Serve a static site folder (default: .) with the overlay
  wed <url|port>               Proxy a running dev server, e.g. wed 4000 (Jekyll)
      --port 4747  --root <dir>  --no-open  --watch-site
      --fast-model sonnet|haiku|off   model for exact text/style edits (default sonnet)

Commands Claude runs (via /live-edit)
  wed wait                     Block until you press Send, print the batch, exit
  wed done <id...> [--note ".."] [--failed]
  wed done --batch <batchId>   Mark every item in a batch done
  wed revert <batchId>         Restore files to before that batch
  wed status                   Show the queue

Taste and inspiration
  wed taste [-n 40]            Recent edits with outcomes (kept, reverted, re-edited)
  wed ref add <url> [--name x] Screenshot a site you like and extract its design tokens
  wed ref open <url>           Browse a site and click elements to save them as refs
  wed ref ls                   List saved refs

Setup
  wed install                  Install the /live-edit command into ~/.claude/commands
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--no-')) out[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        out[k] = next;
        i++;
      } else out[k] = true;
    } else if (a === '-n') out.n = argv[++i];
    else out._.push(a);
  }
  return out;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Find the wed server for this project: .wed/server.json upward, one level down, then the last started. */
function findServer() {
  const candidates = [];
  let dir = process.cwd();
  while (true) {
    candidates.push(path.join(dir, '.wed', 'server.json'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  try {
    for (const e of fs.readdirSync(process.cwd(), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') candidates.push(path.join(process.cwd(), e.name, '.wed', 'server.json'));
    }
  } catch {}
  candidates.push(path.join(WED_HOME, 'active.json'));
  for (const c of candidates) {
    const info = readJson(c, null);
    if (info && info.url && pidAlive(info.pid)) return info;
  }
  return null;
}

async function call(method, p, body, server = findServer()) {
  if (!server) throw new Error('No wed server is running. Start one with: wed <site-folder>');
  const r = await fetch(server.url + '/__wed' + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}

// ---- commands -------------------------------------------------------------------

async function cmdStart(args) {
  let target = args._[0] || '.';
  let upstream = null;
  if (/^\d+$/.test(target)) upstream = `http://localhost:${target}`;
  else if (/^https?:\/\//.test(target)) upstream = target;
  const fm = args['fast-model'];
  const opts = { fastModel: fm === false || fm === 'off' ? null : typeof fm === 'string' ? fm : 'sonnet', port: Number(args.port || 4747), reloadDelay: args['reload-delay'] ? Number(args['reload-delay']) : undefined, watchSite: !!args['watch-site'] };
  if (upstream) {
    opts.upstream = upstream;
    opts.root = args.root || process.cwd();
  } else {
    const folder = path.resolve(target);
    if (!fs.existsSync(folder)) throw new Error(`No such folder: ${folder}`);
    opts.folder = folder;
  }
  let srv;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      srv = await startServer(opts);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      opts.port += 1;
    }
  }
  if (!srv) throw new Error('No free port between 4747 and 4756');
  const shell = process.env.WED_QUIET ? () => {} : console.log;
  shell(`
  wed is running  ${srv.url}
  ${opts.fastModel ? `exact text and slider edits go to ${opts.fastModel}; notes go to your /live-edit session` : 'every edit goes to your /live-edit session'}
  ${srv.mode === 'static' ? `serving ${srv.root} (every element tagged with its source line)` : `proxying ${upstream}, project root ${srv.root}`}

  In the page:   P to pick · click an element · describe it · Send
  In Claude Code (cwd ${srv.root}):  /live-edit

  Ctrl+C to stop.
`);
  if (args.open !== false && !process.env.WED_QUIET) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [srv.url], () => {});
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function cmdWait(args) {
  let warned = false;
  const deadline = args['timeout-min'] ? Date.now() + Number(args['timeout-min']) * 60000 : Infinity;
  while (Date.now() < deadline) {
    const server = findServer();
    if (!server) {
      if (!warned) process.stderr.write('wed: no server running yet; waiting for `wed <folder>` to start...\n');
      warned = true;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    try {
      const r = await call('GET', '/next?timeout=25000', null, server);
      if (r.status === 200 && r.data) {
        process.stdout.write(args.json ? JSON.stringify(r.data, null, 2) + '\n' : formatBatch(r.data) + '\n');
        return;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  process.stdout.write('wed: wait timed out with no batch\n');
}

async function cmdDone(args) {
  const body = { status: args.failed ? 'failed' : 'done', note: typeof args.note === 'string' ? args.note : '' };
  if (args.batch) body.batch = args.batch;
  else body.ids = args._.slice(1);
  if (!body.batch && !body.ids.length) throw new Error('usage: wed done <id...> [--note ".."] | wed done --batch <batchId>');
  const r = await call('POST', '/done', body);
  for (const x of r.data.results || []) {
    console.log(x.error ? `${x.id}: ${x.error}` : `${x.id}: ${x.status}${x.batchComplete ? `  (batch complete; changed: ${(x.changed || []).join(', ') || 'nothing'})` : ''}`);
  }
}

async function cmdRevert(args) {
  const r = await call('POST', '/revert', { batch: args._[1] });
  if (!r.data.ok) throw new Error(r.data.reason);
  console.log(`Restored: ${r.data.restored.join(', ') || 'nothing changed'}`);
  if (r.data.addedNotRemoved.length) console.log(`New files left in place: ${r.data.addedNotRemoved.join(', ')}`);
}

async function cmdStatus() {
  const server = findServer();
  if (!server) return console.log('No wed server running.');
  const r = await call('GET', '/items', null, server);
  console.log(`${server.url}  ${server.mode}  root ${server.root}  Claude listening: ${r.data.claudeListening ? 'yes' : 'no'}`);
  for (const it of r.data.items.filter((i) => !i.direct).slice(-20)) {
    console.log(`  ${it.status.padEnd(9)} ${it.id}  ${(it.instruction || '').split('\n')[0].slice(0, 70)}  ${it.src || it.selector || ''}`);
  }
}

export function summarizeTaste(n = 40) {
  const edits = readTaste();
  if (!edits.length) return 'No taste history yet. It fills in as you use /live-edit.';
  const recent = edits.slice(-n);
  const by = (o) => recent.filter((e) => e.outcome === o);
  const fmt = (e) => {
    const what = e.textChange ? `text "${e.textChange.from.slice(0, 40)}" -> "${e.textChange.to.slice(0, 40)}"` : (e.instruction || '').replace(/\s+/g, ' ').slice(0, 110);
    const style = e.styleDelta ? ' [' + Object.entries(e.styleDelta).map(([k, v]) => `${k} ${v.from}->${v.to}`).join(', ') + ']' : '';
    return `  - <${e.element?.tag}> ${what}${style}${e.resultNote ? `  => ${e.resultNote.slice(0, 80)}` : ''}  (${path.basename(e.site || '')})`;
  };
  const out = [`Taste log: ${edits.length} edits total, showing the last ${recent.length}.`];
  const rev = by('reverted');
  const re = by('re-edited');
  if (rev.length) out.push('', `REVERTED by the user (${rev.length}). Avoid repeating these approaches:`, ...rev.map(fmt));
  if (re.length) out.push('', `RE-EDITED within 2 minutes (${re.length}). The first attempt missed:`, ...re.map(fmt));
  const kept = by('kept');
  if (kept.length) out.push('', `KEPT (${kept.length}):`, ...kept.slice(-20).map(fmt));
  const prefs = path.join(WED_HOME, 'taste.md');
  if (fs.existsSync(prefs)) out.push('', `Distilled preferences: ${prefs}`);
  return out.join('\n');
}

async function cmdRef(args) {
  const sub = args._[1];
  if (sub === 'add') {
    const url = args._[2];
    if (!url) throw new Error('usage: wed ref add <url> [--name x]');
    process.stderr.write(`Capturing ${url} ...\n`);
    const r = await addRef(url, args.name);
    console.log(`Saved ref "${r.name}" in ${r.dir}`);
    console.log(fs.readFileSync(path.join(r.dir, 'tokens.md'), 'utf8'));
  } else if (sub === 'open') {
    const url = args._[2];
    if (!url) throw new Error('usage: wed ref open <url> [--name x]');
    console.log('Opening a browser. Click elements you like to save them. Close the window when done.');
    const r = await openRef(url, args.name, buildOverlay({ mode: 'ref', refMode: true }), (id) => console.log(`  saved ${id}`));
    console.log(`Done. Refs are in ${r.dir}`);
  } else {
    const { refs, dir } = listRefs();
    if (!refs.length) return console.log('No refs yet. Add one: wed ref add https://example.com');
    console.log(`Refs in ${dir}:`);
    for (const r of refs) console.log(`  ${r.name.padEnd(24)} ${r.url}${r.elements.length ? `\n    elements: ${r.elements.join(', ')}` : ''}`);
  }
}

function cmdInstall() {
  const dest = path.join(os.homedir(), '.claude', 'commands', 'live-edit.md');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, 'claude', 'live-edit.md'), dest);
  fs.mkdirSync(WED_HOME, { recursive: true });
  const prefs = path.join(WED_HOME, 'taste.md');
  if (!fs.existsSync(prefs)) {
    fs.writeFileSync(prefs, '# Design preferences\n\nClaude maintains this file from the taste log. One line per preference, each with the evidence behind it.\n\n');
  }
  console.log(`Installed /live-edit -> ${dest}`);
  console.log(`Preferences file: ${prefs}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help || cmd === 'help' || cmd === '-h') return console.log(HELP);
  switch (cmd) {
    case 'wait': return cmdWait(args);
    case 'done': return cmdDone(args);
    case 'revert': return cmdRevert(args);
    case 'status': return cmdStatus(args);
    case 'taste': return console.log(summarizeTaste(Number(args.n) || 40));
    case 'ref': return cmdRef(args);
    case 'install': return cmdInstall(args);
    default: return cmdStart(args);
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error('wed: ' + e.message);
    process.exit(1);
  });
}
