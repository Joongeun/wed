#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Logs its arguments and prompt, makes one
// edit the way the real model would, and replies in the format the worker parses.
import fs from 'node:fs';
const log = process.env.FAKE_CLAUDE_LOG;
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  fs.writeFileSync(log, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }));
  if (process.env.FAKE_CLAUDE_MODE === 'fail') {
    process.stderr.write('auth error');
    process.exit(1);
  }
  const ids = [...prompt.matchAll(/id=(e-[0-9a-f]+)/g)].map((m) => m[1]);
  fs.appendFileSync('css/style.css', '\n.card { font-size: 30px; }\n');
  const result = ids.map((id) => `${id} | done | font-size 16px -> 30px in style.css`).join('\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result, total_cost_usd: 0.004 }));
});
