import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(REPO, 'bin', 'tship.js');

let failures = 0;

export function ok(cond, label, extra = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
  return cond;
}

export function done(suite) {
  if (failures) {
    console.error(`\n${suite}: ${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log(`\n${suite}: all assertions passed`);
}

export function section(title) {
  console.log(`\n— ${title}`);
}

export function makeProject(name) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `tship-${name}-`)), 'proj');
  fs.cpSync(path.join(REPO, 'examples', 'coffee-shop'), dir, { recursive: true });
  return dir;
}

export function tship(dir, args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8', ...opts });
}

export function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.tasteeship', 'state.json'), 'utf8'));
}

export function applyCaseStudyConfig(dir, verifyOverrides = {}) {
  const file = path.join(dir, '.tasteeship', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(cfg.verify, {
    requiredSelectors: ['nav', 'footer'],
    criticalSelectors: ['#order-form'],
    forbiddenStrings: ['Comic Sans', 'pumpkin', 'marquee'],
    locCap: 4000,
    locDeltaCap: 350,
    maxFiles: 80,
  }, verifyOverrides);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}
