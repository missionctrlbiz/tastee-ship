import fs from 'node:fs';
import path from 'node:path';

const CODE_EXTS = new Set(['.html', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.tasteeship', 'dist', 'build', '.next', '.cache', 'coverage']);

export function listProjectFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (CODE_EXTS.has(path.extname(entry.name))) {
        out.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
  };
  walk(root);
  return out.sort();
}

export function countLoc(root) {
  let lines = 0;
  let files = 0;
  for (const rel of listProjectFiles(root)) {
    files++;
    lines += fs.readFileSync(path.join(root, rel), 'utf8').split('\n').length;
  }
  return { lines, files };
}
