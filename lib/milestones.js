import fs from 'node:fs';
import path from 'node:path';
import { selectorPresent, findMissingJsRefs } from './checks.js';

// Milestones mirror the reference video's dashboard: first image, first working
// form, first video, first canvas — plus responsive layout. They are derived
// from the shipped tree by the harness, not claimed by the model.

const DEFS = [
  { id: 'first-image', label: 'First image', test: (s) => /<img[\s>]/i.test(s.html) },
  { id: 'first-video', label: 'First video', test: (s) => /<video[\s>]/i.test(s.html) },
  { id: 'first-canvas', label: 'First canvas', test: (s) => /<canvas[\s>]/i.test(s.html) },
  { id: 'first-form', label: 'First form', test: (s) => /<form[\s>]/i.test(s.html) && !s.baselineHadForm },
  { id: 'form-works', label: 'Order form works', test: (s) => selectorPresent(s.html, '#order-form') && !s.brokenForm },
  { id: 'first-responsive', label: 'First responsive layout', test: (s) => /@media[^{]*\{/i.test(s.css) },
  {
    id: 'comic-sans-gone',
    label: 'Comic Sans removed',
    test: (s) => s.baselineHadComicSans && !/comic\s*sans/i.test(`${s.html}${s.css}`),
  },
];

export function scanMilestones(root, cfg, existing, round, baseline) {
  const s = {
    html: safeRead(path.join(root, cfg.entry)),
    css: collect(root, '.css'),
    baselineHadForm: !!baseline.hasForm,
    brokenForm: findMissingJsRefs(root, cfg.entry).length > 0,
    baselineHadComicSans: baseline.comicSans,
  };
  const added = [];
  for (const def of DEFS) {
    if (existing.some((m) => m.id === def.id)) continue;
    let hit = false;
    try {
      hit = def.test(s);
    } catch {
      hit = false;
    }
    if (hit) added.push({ id: def.id, label: def.label, round, ts: new Date().toISOString() });
  }
  return added;
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function collect(root, ext) {
  let out = '';
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(ext)) out += `\n${safeRead(p)}`;
    }
  };
  walk(root);
  return out;
}
