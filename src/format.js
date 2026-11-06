// Turns a claimed batch into the text a Claude session reads.
// Used by `wed wait` for the main session and by the fast-model worker.

import { refPaths } from './refs.js';

export function formatBatch(payload) {
  const { batch, items, root, mode, url } = payload;
  const lines = [];
  lines.push(`WED BATCH ${batch.id}: ${items.length} edit${items.length > 1 ? 's' : ''} from ${url} (${mode} mode)`);
  lines.push(`Project root: ${root}`);
  lines.push(`Snapshot saved, so the user can revert this batch from the page.`);
  lines.push(`When finished: wed done <id> --note "what you changed" for each item (or --failed with the reason).`);
  lines.push('');
  items.forEach((it, i) => {
    lines.push(`[${i + 1}] id=${it.id}  kind=${it.kind}`);
    lines.push(`  instruction: ${String(it.instruction || '').replace(/\n/g, '\n    ')}`);
    if (it.src) lines.push(`  source: ${it.src}  (exact start tag; file relative to project root)`);
    else lines.push(`  source: unknown (proxy mode). Search for the text or classes below.`);
    lines.push(`  element: <${it.tag}> "${(it.text || '').slice(0, 120)}"`);
    lines.push(`  selector: ${it.selector}`);
    if (it.viewport) lines.push(`  viewport: ${it.viewport.w}x${it.viewport.h} (${it.viewport.device})${it.viewport.device !== 'desktop' ? '  -> scope CSS changes to this breakpoint unless told otherwise' : ''}`);
    if (it.styleDelta) {
      lines.push(`  style changes previewed by the user (write these into the stylesheet, not inline):`);
      for (const [k, v] of Object.entries(it.styleDelta)) lines.push(`    ${k}: ${v.from} -> ${v.to}`);
    }
    if (it.textChange) lines.push(`  text change: "${it.textChange.from}" -> "${it.textChange.to}"`);
    if (it.refs && it.refs.length) {
      lines.push(`  inspiration refs (read these files):`);
      for (const r of it.refs) {
        const ps = refPaths(r);
        lines.push(`    ${r}: ${ps.length ? ps.join(' , ') : '(missing)'}`);
      }
    }
    if (it.screenshot) lines.push(`  screenshot: ${it.screenshot}`);
    if (it.styles && Object.keys(it.styles).length) {
      lines.push(`  computed: ${Object.entries(it.styles).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    }
    if (it.outerHTML) lines.push(`  outerHTML:\n    ${it.outerHTML.replace(/\n/g, '\n    ')}`);
    lines.push('');
  });
  return lines.join('\n');
}

