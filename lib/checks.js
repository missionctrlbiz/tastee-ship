import fs from 'node:fs';
import path from 'node:path';
import { listProjectFiles, countLoc } from './loc.js';

// The verification layer (per the five-layer harness architecture). Checks run
// in Node before anything is committed — the model never executes here and
// cannot observe or bypass the enforcement decision.
//
// Latch semantics: a check becomes *enforced* the first time it passes (or,
// for forbidden strings, the first time the string is absent). A failing check
// that was never green — e.g. the deliberately broken order form in the
// baseline fixture — is reported as a "gap", not a regression. A green→red
// transition is a regression and trips the gate.

export const CHECK_IDS = {
  SELECTOR: 'required-selectors',
  CRITICAL: 'critical-selectors',
  FORBIDDEN: 'forbidden-strings',
  JS_REFS: 'js-refs-resolve',
  LOC_CAP: 'loc-cap',
  LOC_DELTA: 'loc-delta-cap',
  FILE_CAP: 'max-files',
};

export function freshLatch() {
  return {
    checks: {}, // checkId -> true once green at least once
    forbiddenAbsent: {}, // string -> true once observed absent
  };
}

export function baselineScan(root, cfg) {
  const latch = freshLatch();
  const res = runChecks(root, cfg, null, latch);
  return {
    loc: res.loc,
    files: res.fileCount,
    green: res.green, // checks already satisfied at baseline
    forbiddenPresent: res.forbiddenPresent, // strings present in the baseline fixture
    comicSans: res.forbiddenPresent.some((s) => /comic\s*sans/i.test(s)),
    hasForm: /<form[\s>]/i.test(readEntry(root, cfg.entry)),
    latch,
  };
}

export function runChecks(root, cfg, prevLoc, latchState) {
  const v = cfg.verify;
  const failures = [];
  const gaps = [];
  const loc = countLoc(root);
  const fileCount = loc.files;

  const entryHtml = readEntry(root, cfg.entry);
  const allHtml = collectHtml(root);
  const cssText = collectExt(root, '.css');
  const jsText = collectExt(root, '.js');

  const latch = latchState || freshLatch();

  // --- required / critical selectors --------------------------------------
  const selectorMissing = [];
  for (const sel of v.requiredSelectors || []) {
    if (!selectorPresent(entryHtml, sel) && !selectorPresent(allHtml, sel)) selectorMissing.push(sel);
  }
  if (selectorMissing.length) {
    failures.push({
      id: CHECK_IDS.SELECTOR,
      kind: 'regression',
      critical: false,
      message: `missing required selectors: ${selectorMissing.join(', ')}`,
    });
  }
  const criticalMissing = [];
  for (const sel of v.criticalSelectors || []) {
    if (!selectorPresent(entryHtml, sel) && !selectorPresent(allHtml, sel)) criticalMissing.push(sel);
  }
  if (criticalMissing.length) {
    failures.push({
      id: CHECK_IDS.CRITICAL,
      kind: 'regression',
      critical: true,
      message: `critical selector(s) removed: ${criticalMissing.join(', ')}`,
    });
  }

  // --- forbidden strings (taste, from rules/config) -------------------------
  const corpus = `${entryHtml}\n${allHtml}\n${cssText}\n${jsText}`.toLowerCase();
  const forbiddenPresent = (v.forbiddenStrings || []).filter((s) => corpus.includes(s.toLowerCase()));
  const newForbidden = forbiddenPresent.filter(
    (s) => !(v.baselineForbidden || []).includes(s) || latch.forbiddenAbsent[s.toLowerCase()]
  );
  if (newForbidden.length) {
    failures.push({
      id: CHECK_IDS.FORBIDDEN,
      kind: 'overbuild',
      critical: true,
      message: `forbidden content present: ${newForbidden.join(', ')}`,
    });
  }

  // --- JS references resolve (catches the "language toggle that didn't
  //     work" and the broken order form) -------------------------------------
  const missingRefs = findMissingJsRefs(root, cfg.entry);
  if (missingRefs.length) {
    failures.push({
      id: CHECK_IDS.JS_REFS,
      kind: 'regression',
      critical: true,
      message: `JS references missing DOM ids: ${missingRefs.join(', ')}`,
    });
  }

  // --- overbuild budget checks ----------------------------------------------
  if (v.locCap && loc.lines > v.locCap) {
    failures.push({
      id: CHECK_IDS.LOC_CAP,
      kind: 'overbuild',
      critical: true,
      message: `total LOC ${loc.lines} exceeds cap ${v.locCap}`,
    });
  }
  if (prevLoc != null && v.locDeltaCap && loc.lines - prevLoc > v.locDeltaCap) {
    failures.push({
      id: CHECK_IDS.LOC_DELTA,
      kind: 'overbuild',
      critical: true,
      message: `round added ${loc.lines - prevLoc} LOC (cap ${v.locDeltaCap})`,
    });
  }
  if (v.maxFiles && fileCount > v.maxFiles) {
    failures.push({
      id: CHECK_IDS.FILE_CAP,
      kind: 'overbuild',
      critical: true,
      message: `${fileCount} files exceeds cap ${v.maxFiles}`,
    });
  }

  // --- latch bookkeeping ------------------------------------------------------
  const green = [];
  const currentlyGreen = {
    [CHECK_IDS.SELECTOR]: selectorMissing.length === 0,
    [CHECK_IDS.CRITICAL]: criticalMissing.length === 0,
    [CHECK_IDS.FORBIDDEN]: newForbidden.length === 0,
    [CHECK_IDS.JS_REFS]: missingRefs.length === 0,
    [CHECK_IDS.LOC_CAP]: !(v.locCap && loc.lines > v.locCap),
    [CHECK_IDS.FILE_CAP]: !(v.maxFiles && fileCount > v.maxFiles),
  };
  const latchBefore = { ...latch.checks };
  for (const [id, okNow] of Object.entries(currentlyGreen)) {
    if (okNow) {
      green.push(id);
      latch.checks[id] = true;
    } else if (!latchBefore[id]) {
      gaps.push(id);
    }
  }
  for (const s of v.forbiddenStrings || []) {
    if (!corpus.includes(s.toLowerCase())) latch.forbiddenAbsent[s.toLowerCase()] = true;
  }

  // Latch enforcement: a regression-kind failure only blocks when the check
  // was green in a previous round (or baseline). Never-green failures are
  // pre-existing gaps (e.g. the fixture's broken order form) — reported, not
  // blocking, until the agent fixes them and the check turns green once.
  const blockingFailures = failures.filter(
    (f) => f.kind !== 'regression' || latchBefore[f.id]
  );

  return {
    pass: blockingFailures.length === 0,
    failures: blockingFailures,
    gaps,
    green,
    loc: loc.lines,
    locDelta: prevLoc != null ? loc.lines - prevLoc : null,
    fileCount,
    forbiddenPresent,
  };
}

function readEntry(root, entry) {
  try {
    return fs.readFileSync(path.join(root, entry), 'utf8');
  } catch {
    return '';
  }
}

function collectHtml(root) {
  let out = '';
  for (const rel of listProjectFiles(root)) {
    if (rel.endsWith('.html')) out += `\n${fs.readFileSync(path.join(root, rel), 'utf8')}`;
  }
  return out;
}

function collectExt(root, ext) {
  let out = '';
  for (const rel of listProjectFiles(root)) {
    if (rel.endsWith(ext)) out += `\n${fs.readFileSync(path.join(root, rel), 'utf8')}`;
  }
  return out;
}

export function selectorPresent(html, sel) {
  if (!html) return false;
  if (sel.startsWith('#')) {
    const id = sel.slice(1);
    return new RegExp(`id\\s*=\\s*["']${id}["']`).test(html);
  }
  if (sel.startsWith('.')) {
    const cls = sel.slice(1);
    return new RegExp(`class\\s*=\\s*["'][^"']*\\b${cls}\\b`).test(html);
  }
  return new RegExp(`<${sel}[\\s>]`, 'i').test(html);
}

// Scan local <script src> files for getElementById('x') / querySelector('#x')
// calls and confirm those ids exist in the page's HTML.
export function findMissingJsRefs(root, entry) {
  const entryHtml = readEntry(root, entry);
  if (!entryHtml) return [];
  const htmlAll = collectHtml(root);
  const missing = new Set();
  const scriptRe = /<script[^>]*src=["']([^"']+\.js)["'][^>]*>/gi;
  let m;
  while ((m = scriptRe.exec(entryHtml))) {
    const src = m[1].replace(/^\.\//, '').replace(/^\//, '').split('?')[0];
    let code = null;
    try {
      code = fs.readFileSync(path.join(root, src), 'utf8');
    } catch {
      continue; // external CDN script — not a DOM-ref bug we can check
    }
    const refRe = /getElementById\(\s*["']([\w-]+)["']\s*\)|querySelector\(\s*["']#([\w-]+)["']\s*\)/g;
    let r;
    while ((r = refRe.exec(code))) {
      const id = r[1] || r[2];
      if (
        id &&
        !new RegExp(`id\\s*=\\s*["']${id}["']`).test(entryHtml) &&
        !new RegExp(`id\\s*=\\s*["']${id}["']`).test(htmlAll)
      ) {
        missing.add(`${src}:#${id}`);
      }
    }
  }
  return [...missing];
}
