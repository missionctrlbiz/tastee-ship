import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultConfig, loadConfig, saveConfig, statePath, harnessPath } from './config.js';
import { detectFramework, guessEntry } from './detect.js';
import { addKey, listKeys, removeKey, ensureGitignore } from './keys.js';
import { loadState, tailEvents } from './state.js';
import { gateSummary } from './gate.js';
import { fmtUsd, fmtTokens } from './costs.js';
import { stopRun, resumeRun, rollbackTo } from './runner.js';
import { commitLog, ensureRepo, head } from './gitops.js';
import { runChecks, baselineScan, selectorPresent } from './checks.js';
import { evaluateAttempt } from './gate.js';

const RULES_TEMPLATE = `# rules.md — injected taste

This file is the user's taste, injected into every round as context. It is the
only place preferences come from; the agent has no memory or skills beyond it.

## Product
- The order form is the business. It must keep working.
- One bold, conversion-focused change per round. No filler.

## Taste
- No Comic Sans. No marquee tags. No autoplaying media.
- Mobile first: every change must survive a 375px viewport.
- Plain HTML/CSS/JS. No frameworks without asking.

## Hard "no" list (novelty features we don't want)
- No games, pumpkin-carving tools, or gimmick widgets.
- No language toggle unless it is fully functional.
- Don't inflate the file count or LOC; small is a feature.
`;

export async function runInit(dir, flags = {}) {
  const root = path.resolve(dir || '.');
  fs.mkdirSync(root, { recursive: true });
  const framework = detectFramework(root);
  const cfg = defaultConfig(framework);
  cfg.entry = guessEntry(root);
  if (flags['outputs-max']) cfg.runner.outputsMax = Number(flags['outputs-max']);
  if (flags.rounds) cfg.runner.roundsMax = Number(flags.rounds);
  saveConfig(root, cfg);
  const rulesFile = path.join(root, cfg.taste.rulesFile);
  if (!fs.existsSync(rulesFile)) {
    fs.writeFileSync(rulesFile, RULES_TEMPLATE);
  }
  ensureGitignore(root);
  console.log(`tship init:
  project:     ${root}
  framework:   ${framework} (entry: ${cfg.entry})
  harness dir: ${path.join(root, '.tasteeship')}
  rules:       ${path.basename(rulesFile)} — edit this to inject your taste
  next:
    tship keys add anthropic      # store your key (never committed)
    tship run --rounds 50         # start the loop
    tship dashboard               # open the dashboard`);
}

export async function runAttach(target, flags = {}) {
  if (!target) throw new Error('usage: tship attach <path|git-url>');
  const root = path.resolve('.');
  let repoPath;
  if (/^https?:\/\/|\.git$/.test(target)) {
    const name = path.basename(target).replace(/\.git$/, '');
    repoPath = path.join(root, name);
    console.log(`cloning ${target} → ${repoPath}`);
    execFileSync('git', ['clone', '-q', target, repoPath], { stdio: 'inherit' });
  } else {
    repoPath = path.resolve(target);
    if (!fs.existsSync(repoPath)) throw new Error(`not a directory: ${repoPath}`);
  }
  if (!fs.existsSync(path.join(root, '.tasteeship', 'config.json'))) {
    await runInit(root, flags);
  }
  const cfg = loadConfig(root);
  cfg.repo.path = repoPath;
  cfg.framework = detectFramework(repoPath);
  cfg.entry = guessEntry(repoPath);
  saveConfig(root, cfg);
  console.log(`tship attach:
  repo:      ${repoPath}
  framework: ${cfg.framework} (entry: ${cfg.entry})
  the loop will checkpoint and roll back inside this repo`);
}

export async function runKeys(rest) {
  const root = path.resolve('.');
  const [sub, provider] = rest;
  if (sub === 'add') {
    if (!provider) throw new Error('usage: tship keys add <provider>  (e.g. anthropic)');
    const { file, provider: envName, gitignored } = await addKey(root, provider);
    console.log(`tship keys:
  stored ${envName} → ${file} (chmod 600)
  ${gitignored.length ? `added to .gitignore: ${gitignored.join(', ')}` : 'already gitignored'}
  this file is never committed and is loaded only by the runner.`);
  } else if (sub === 'list') {
    const keys = listKeys(root);
    if (!keys.length) return console.log('no keys stored — `tship keys add <provider>`');
    for (const k of keys) console.log(`  ${k.name}  ${k.preview}`);
  } else if (sub === 'remove') {
    if (!provider) throw new Error('usage: tship keys remove <provider>');
    console.log(removeKey(root, provider) ? `removed ${provider.toUpperCase()}_API_KEY` : 'no key file');
  } else {
    throw new Error('usage: tship keys add|list|remove <provider>');
  }
}

export async function runStop() {
  const root = process.cwd();
  const { signaled } = stopRun(root);
  console.log(`tship stop: kill switch armed${signaled ? ' — SIGTERM sent to runner' : ' — no live runner process found'}`);
  console.log('the runner will abort in-flight calls, roll back to the last good checkpoint, and mark the run killed.');
}

export async function runResume(flags = {}) {
  const root = process.cwd();
  const state = await resumeRun(root, flags);
  console.log(`tship resume: finished at round ${state.run.roundIndex}/${state.run.roundsMax} (status: ${state.status})`);
}

export async function runRollback(flags = {}) {
  const root = process.cwd();
  if (!flags.to) throw new Error('usage: tship rollback --to <round|git-sha>');
  const sha = rollbackTo(root, flags.to);
  console.log(`tship rollback: repo reset to ${sha.slice(0, 8)}`);
}

export async function runStatus() {
  const root = process.cwd();
  const state = loadState(root);
  if (!state || !state.run) return console.log('idle — no runs yet');
  const g = gateSummary(state);
  console.log(`tship status — ${state.project}
  gate:        ${g.label}${g.reason ? ` (${g.reason})` : ''}
  run:         ${state.run.id} · ${state.run.provider}/${state.run.model}
  rounds:      ${state.run.roundIndex}/${state.run.roundsMax}
  outputs:     ${state.run.attemptsThisRound}/${state.run.outputsMax} this step (overbuild: ${state.run.overbuildAction})
  usage:       ${state.usage.calls} calls · ${fmtTokens(state.usage.inputTokens)} in / ${fmtTokens(state.usage.outputTokens)} out · ${fmtUsd(state.usage.usd)}
  milestones:  ${state.milestones.map((m) => `${m.label}@${m.round}`).join(', ') || '—'}`);
  const events = tailEvents(root, 6);
  if (events.length) {
    console.log('  recent events:');
    for (const e of events) console.log(`   · [${(e.type || '?').padEnd(16)}] r${e.round ?? '-'} ${e.message || ''}`);
  }
}

export async function runReport(stateFile, flags = {}) {
  const root = process.cwd();
  const file = stateFile ? path.resolve(stateFile) : statePath(root);
  if (!fs.existsSync(file)) throw new Error(`no state file at ${file}`);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!state.run) throw new Error('state has no run');

  const shipped = state.rounds.filter((r) => r.verdict === 'shipped');
  const flagged = state.rounds.filter((r) => r.verdict === 'shipped-flagged');
  // "good enough" horizon: last round shipped cleanly before the first flag/halt
  let horizon = 0;
  for (const r of state.rounds) {
    if (r.verdict === 'shipped') horizon = r.round;
    else break;
  }

  console.log(`tship report — ${state.project} (${state.run.id})
  model:       ${state.run.provider}/${state.run.model}
  status:      ${state.status}${state.haltReason ? ` (${state.haltReason})` : ''}
  rounds:      ${state.rounds.length}/${state.run.roundsMax} attempted · ${shipped.length} clean · ${flagged.length} flagged over-build
  gate:        ${gateSummary(state).label}${state.haltReason ? ` (${state.haltReason})` : ''}
  agent calls: ${state.usage.calls} · tokens ${fmtTokens(state.usage.inputTokens)} in / ${fmtTokens(state.usage.outputTokens)} out
  cost:        ${fmtUsd(state.usage.usd)}
  good-enough horizon (clean-ship streak): round ${horizon}
  milestones:
${state.milestones.map((m) => `    · ${m.label} @ round ${m.round}`).join('\n') || '    —'}

  per-round:
    round  att  loc    Δloc   usd       verdict
${state.rounds
  .map(
    (r) =>
      `    ${String(r.round).padStart(5)}  ${String(r.attempts).padStart(3)}  ${String(r.loc).padStart(6)}  ${String(r.locDelta ?? '—').padStart(5)}  ${fmtUsd(r.usage?.usd ?? r.usd).padStart(9)}  ${r.verdict}${r.flags.length ? ` (${r.flags[0].slice(0, 60)})` : ''}`
  )
  .join('\n')}

  gate events:
${(state.gateEvents || [])
  .slice(-25)
  .map((e) => `    · [${e.type}] r${e.round ?? '-'} ${e.message || ''}`)
  .join('\n') || '    —'}`);

  if (flags.json) console.log(JSON.stringify(state, null, 2));
}

// ------------------------------------------------------- dry-run / lint -----

// Read-only gate dry run: executes the REAL verification layer + gate against
// the CURRENT tree — no provider call, no writes, no persisted latch state
// (a fresh latch copy is passed so nothing is mutated). It evaluates the
// current tree, not a future proposal: the next round's LOC delta cannot be
// predicted before that proposal exists.
export async function runDryRun(flags = {}) {
  const root = process.cwd();
  const cfg = loadConfig(root);
  const target = path.resolve(root, cfg.repo?.path || '.');
  ensureRepo(target);
  const baseline = baselineScan(target, cfg);
  // mirror executeRun: baseline-present strings are tolerated gaps, not new violations
  cfg.verify.baselineForbidden = baseline.forbiddenPresent;
  const latch = structuredClone(baseline.latch ?? { checks: {}, forbiddenAbsent: {} });
  const checks = runChecks(target, cfg, baseline.loc, latch);
  const verdict = evaluateAttempt({
    checks,
    attemptNo: cfg.runner.outputsMax, // worst case: last allowed output
    outputsMax: cfg.runner.outputsMax,
    overbuildAction: cfg.overbuildAction || 'halt',
  });
  console.log(`tship dry-run — verification of the CURRENT tree (entry: ${cfg.entry})
  loc:         ${checks.loc} (cap ${cfg.verify.locCap ?? '—'}, baseline ${baseline.loc})
  files:       ${checks.fileCount} (cap ${cfg.verify.maxFiles ?? '—'})
  green:       ${checks.green.join(', ') || '—'}
  gaps:        ${checks.gaps.join(', ') || '—'}
  failures:    ${checks.failures.map((f) => `[${f.kind}] ${f.message}`).join('; ') || 'none'}
  verdict:     ${verdict.ship ? 'SHIP' : verdict.halt ? `HALT (${verdict.halt})` : 'RETRY (budget permitting)'}${verdict.flags.length ? ` + flags: ${verdict.flags.map((f) => f.message).join('; ')}` : ''}`);
  if (verdict.halt) process.exitCode = 2;
}

// Read-only calibration check for the taste/verification config.
export async function runLintRules(flags = {}) {
  const root = process.cwd();
  const cfg = loadConfig(root);
  const target = path.resolve(root, cfg.repo?.path || '.');
  let warnings = 0;
  const warn = (msg) => {
    warnings++;
    console.log(`  [WARN] ${msg}`);
  };
  const okLine = (msg) => console.log(`  [ok]   ${msg}`);

  const rulesFile = path.resolve(root, cfg.taste?.rulesFile || 'rules.md');
  if (!fs.existsSync(rulesFile)) warn(`rules.md not found at ${rulesFile} — the agent ships without injected taste`);
  else okLine(`rules.md present (${path.basename(rulesFile)})`);

  const entryHtml = fs.existsSync(path.join(target, cfg.entry)) ? fs.readFileSync(path.join(target, cfg.entry), 'utf8') : '';
  if (!entryHtml) warn(`entry file ${cfg.entry} missing in ${target}`);

  const baseline = baselineScan(target, cfg);
  for (const sel of cfg.verify.requiredSelectors || []) {
    if (!selectorPresent(entryHtml, sel)) warn(`requiredSelector ${sel} not found in the baseline tree — the check can never be green until the agent adds it`);
    else okLine(`requiredSelector ${sel} present`);
  }
  for (const s of cfg.verify.forbiddenStrings || []) {
    if (baseline.forbiddenPresent.includes(s)) {
      warn(`forbidden string "${s}" is already present in the baseline — it stays a tolerated gap until the agent removes it (then it latches)`);
    } else okLine(`forbidden string "${s}" absent at baseline — enforced from round 1`);
  }
  if (!cfg.costs?.[cfg.provider.model]) warn(`no costs entry for model ${cfg.provider.model} — spend will report $0.00`);
  else okLine(`costs entry present for ${cfg.provider.model}`);
  if (!cfg.verify.locDeltaCap || cfg.verify.locDeltaCap <= 0) warn(`locDeltaCap is ${cfg.verify.locDeltaCap} — per-round growth is unbounded`);
  if (!cfg.runner.outputsMax || cfg.runner.outputsMax < 1) warn(`outputsMax is ${cfg.runner.outputsMax} — every round would halt immediately`);

  console.log(warnings ? `tship lint-rules: ${warnings} warning(s)` : 'tship lint-rules: configuration looks calibrated');
  if (warnings) process.exitCode = 1;
}
