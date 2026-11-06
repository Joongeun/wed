// Fast-model worker.
//
// Some edits need no design judgment: a text change with the exact new words, or a
// style change with exact before and after values from the sliders. Sending those to
// the main Opus session spends a full high-effort turn on mechanical work. Instead,
// wed runs a headless `claude -p --model sonnet` in the project folder, limited to
// reading and editing files, and marks each item done from its reply.
// Batches with a free-form note or an inspiration ref still go to the main session.

import { spawn } from 'node:child_process';
import { formatBatch } from './format.js';

/** True when an edit can be applied without judgment calls. */
export function isMechanical(item) {
  if (item.refs && item.refs.length) return false;
  if (item.kind === 'text' && item.textChange) return true;
  if (item.kind === 'style' && item.styleDelta && Object.keys(item.styleDelta).length) return true;
  return false;
}

export function batchIsMechanical(items) {
  return items.length > 0 && items.every(isMechanical);
}

export const FAST_RULES = `You are applying mechanical website edits for the wed tool. The user already chose exact values, so no design judgment is needed.

Rules:
1. Each item gives a source location (file:line:col of the element's start tag) or, without one, text and classes to search for. Read only the lines you need.
2. Text changes: replace the old words with the new words exactly. Keep any inline tags shown in the instruction.
3. Style changes: write the exact "to" values into the stylesheet rule that styles this element (a <style> block or a .css file). Add a narrowly scoped rule if none fits. Never add inline style attributes. For a phone or tablet viewport, put the rule in a matching media query.
4. Change nothing else. Do not reformat, rename or refactor.
5. You cannot run commands. Only read and edit files.

When finished, reply with exactly one line per item and nothing else:
<id> | done | <what you changed, under 12 words>
or
<id> | failed | <reason>`;

/** Parse "<id> | done | note" lines from the model's final reply. */
export function parseReply(text, ids) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*[-*]?\s*`?(e-[0-9a-f]+)`?\s*\|\s*(done|failed)\s*\|\s*(.*)$/i.exec(line);
    if (m && ids.includes(m[1])) out[m[1]] = { status: m[2].toLowerCase(), note: m[3].trim() };
  }
  return out;
}

/**
 * Run one batch through the fast model. Resolves to
 * { ok, results: {id: {status, note}}, raw, error }.
 */
export function runFast(payload, { model = 'sonnet', claudeBin = 'claude', timeoutMs = 240000 } = {}) {
  const prompt = `${FAST_RULES}\n\n${formatBatch(payload)}`;
  const args = [
    '-p',
    '--model', model,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read', 'Edit', 'MultiEdit', 'Grep', 'Glob',
    '--disallowedTools', 'Bash', 'Write', 'WebFetch', 'WebSearch', 'Agent',
    '--output-format', 'json',
    '--no-session-persistence',
  ];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudeBin, args, { cwd: payload.root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, results: {}, error: e.message });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, results: {}, error: e.code === 'ENOENT' ? `${claudeBin} not found on PATH` : e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let text = stdout;
      let cost = null;
      try {
        const j = JSON.parse(stdout);
        text = j.result ?? '';
        cost = j.total_cost_usd ?? null;
        if (j.is_error) return resolve({ ok: false, results: {}, raw: text, error: text || 'model reported an error' });
      } catch {}
      const ids = payload.items.map((i) => i.id);
      resolve({ ok: code === 0, results: parseReply(text, ids), raw: text, cost, error: code === 0 ? null : (stderr || `exit ${code}`).slice(0, 300) });
    });
    child.stdin.end(prompt);
  });
}
