// Shared test setup. WED_HOME must point at a temp dir before any src module loads,
// so taste logs and refs written by tests never touch the real ~/.wed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'site');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wed-home-'));
process.env.WED_HOME = home;
export const WED_HOME = home;

/** Copy the fixture site to a fresh temp folder so tests can modify files freely. */
export function freshSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wed-site-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return fs.realpathSync(dir);
}

export function lineOf(text, needle) {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error('needle not found: ' + needle);
  return text.slice(0, i).split('\n').length;
}
