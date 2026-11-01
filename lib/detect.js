import fs from 'node:fs';
import path from 'node:path';

export function detectFramework(dir) {
  const pkgFile = path.join(dir, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return 'next';
      if (deps.gatsby) return 'gatsby';
      if (deps.vite) return 'vite';
      if (deps.react) return 'react';
      if (deps.express) return 'express';
      return 'node';
    } catch {
      return 'node';
    }
  }
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'static-site';
  return 'unknown';
}

export function guessEntry(dir) {
  for (const cand of ['index.html', 'src/index.html', 'public/index.html']) {
    if (fs.existsSync(path.join(dir, cand))) return cand;
  }
  return 'index.html';
}
