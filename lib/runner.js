import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, harnessPath, stopFilePath, snapshotsDir } from './config.js';
import { loadKeys } from './keys.js';
import { createProvider } from './providers/index.js';
import { runChecks, baselineScan } from './checks.js';
import { scanMilestones } from './milestones.js';
import { evaluateAttempt, evaluateProtocolError } from './gate.js';
import { freshState, loadState, saveState, gateEvent } from './state.js';
import { costOf } from './costs.js';
import {
  ensureRepo,
  head,
  isClean,
  commitAll,
  resetHard,
  saveSnapshot,
  checkpointOfRound,
} from './gitops.js';
import { listProjectFiles, countLoc } from './loc.js';

// The orchestration layer. Everything that stops the run lives HERE — in Node
// code the model cannot see or influence:
//   - the outputs_max budget (no further agent messages after the cap)
//   - the verification layer's verdicts (ship / retry / halt)
//   - the kill switch (stop file + SIGTERM; abort in-flight calls; roll back)
//   - checkpoints (git commit per shipped round; atomic state.json per step)
// There is deliberately no prompt instruction like "stop when told" — the
// model has no vote in stopping.

export function readRules(root, cfg) {
  const file = path.resolve(root, cfg.taste?.rulesFile || 'rules.md');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '(no rules.md found — the agent ships without injected taste)';
  }
}

function writePid(root, pid) {
  const file = harnessPath(root, 'run.pid');
  if (pid == null) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  } else {
    fs.mkdirSync(harnessPath(root), { recursive: true });
    fs.writeFileSync(file, String(pid));
  }
}

function pidAlive(root) {
  let pid = null;
  try {
    pid = Number(fs.readFileSync(harnessPath(root, 'run.pid'), 'utf8').trim());
  } catch {
    return { alive: false, pid: null };
  }
  try {
    process.kill(pid, 0);
    return { alive: true, pid };
  } catch (err) {
    if (err.code === 'ESRCH') return { alive: false, pid: null };
    return { alive: true, pid }; // EPERM — alive but not ours
  }
}

export function stopRequested(root) {
  return fs.existsSync(stopFilePath(root));
}

function targetRoot(root, cfg) {
  return path.resolve(root, cfg.repo?.path || '.');
}

function applyFlags(cfg, flags) {
  const c = JSON.parse(JSON.stringify(cfg));
  if (flags.rounds) c.runner.roundsMax = Number(flags.rounds);
  if (flags['outputs-max']) c.runner.outputsMax = Number(flags['outputs-max']);
  if (flags.provider) c.provider.name = String(flags.provider);
  if (flags.model) c.provider.model = String(flags.model);
  if (flags['flag-overbuild']) c.overbuildAction = 'flag';
  if (flags['loc-cap']) c.verify.locCap = Number(flags['loc-cap']);
  if (flags['loc-delta-cap']) c.verify.locDeltaCap = Number(flags['loc-delta-cap']);
  return c;
}

export async function startRun(root, flags = {}) {
  const cfg = applyFlags(loadConfig(root), flags);
  const state = loadState(root) || freshState(root, cfg);

  if (state.status === 'running') {
    const { alive, pid } = pidAlive(root);
    if (alive) {
      throw new Error(`run ${state.run?.id || '?'} is already active (pid ${pid || 'unknown'}) — use \`tship stop\` to kill it`);
    }
    // crashed mid-round: recoverable, but require explicit resume
    state.status = 'halted';
    state.haltReason = 'crash';
    saveState(root, state);
    throw new Error('previous run crashed mid-round — recover with `tship resume`');
  }
  if (state.status === 'killed' && !flags.acknowledge) {
    throw new Error('previous run was killed — resume with `tship resume --acknowledge` to continue it, or delete .tasteeship/state.json to start fresh');
  }

  const runId = state.status === 'killed' || state.status === 'halted' ? state.run.id : `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (state.status !== 'killed' && state.status !== 'halted') {
    // fresh run: reset per-run fields (completed runs may leave them behind)
    state.rounds = [];
    state.milestones = [];
    state.usage = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    state.baseline = null;
    state.latched = null;
    state.run = {
      id: runId,
      provider: cfg.provider.name,
      model: cfg.provider.model,
      outputsMax: cfg.runner.outputsMax,
      roundsMax: cfg.runner.roundsMax,
      roundIndex: 0,
      attemptsThisRound: 0,
      lastGoodCommit: null,
      overbuildAction: cfg.overbuildAction || 'halt',
      startedAt: new Date().toISOString(),
    };
  }
  return executeRun(root, cfg, state, { fresh: state.status !== 'killed' && state.status !== 'halted' });
}

export async function resumeRun(root, flags = {}) {
  const cfg = loadConfig(root);
  const state = loadState(root);
  if (!state || !state.run) throw new Error('nothing to resume — run `tship run` first');
  if (state.status === 'running') {
    const { alive } = pidAlive(root);
    if (alive) throw new Error('run is still active');
  }
  if (state.status === 'completed') throw new Error('run already completed');
  if (state.status === 'killed' && !flags.acknowledge) {
    throw new Error('run was killed by the kill switch — resume with --acknowledge');
  }

  // Verify assumptions on resume (safe-to-resume): the repo must sit at the
  // last good checkpoint recorded in the state. A mismatch means out-of-band
  // edits happened after the kill — surface it instead of silently continuing.
  const target = targetRoot(root, cfg);
  const h = head(target);
  if (state.run.lastGoodCommit && h !== state.run.lastGoodCommit) {
    if (flags.force) {
      resetHard(target, state.run.lastGoodCommit);
    } else {
      throw new Error(
        `repo HEAD ${h?.slice(0, 8)} ≠ checkpoint ${state.run.lastGoodCommit?.slice(0, 8)} — \`tship rollback --to checkpoint\` or \`tship resume --force\``
      );
    }
  }
  state.status = 'running';
  state.haltReason = null;
  saveState(root, state);
  return executeRun(root, cfg, state, { fresh: false });
}

async function executeRun(root, cfg, state, { fresh }) {
  const target = targetRoot(root, cfg);
  ensureRepo(target);
  if (!isClean(target)) {
    // checkpoint-before-write: never operate on a dirty tree, or rollback
    // would destroy the user's uncommitted work
    const c = commitAll(target, 'tship: baseline checkpoint (user working tree)');
    gateEvent(root, state, 'baseline-commit', 0, `committed user working tree as ${c?.slice(0, 8)}`);
  }
  if (!state.baseline) {
    const b = baselineScan(target, cfg);
    cfg.verify.baselineForbidden = b.forbiddenPresent;
    state.baseline = {
      loc: b.loc,
      files: b.files,
      comicSans: b.comicSans,
      hasForm: b.hasForm,
      green: b.green,
      forbiddenPresent: b.forbiddenPresent,
    };
    state.latched = b.latch;
  } else {
    cfg.verify.baselineForbidden = state.baseline.forbiddenPresent;
  }
  state.run.lastGoodCommit = head(target);
  state.status = 'running';
  state.haltReason = null;
  saveState(root, state);
  writePid(root, process.pid);

  const provider = createProvider(cfg, loadKeys(root), state.run.id);
  const ac = new AbortController();
  const onSignal = () => ac.abort(new Error('signal received'));
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    if (fresh) {
      gateEvent(root, state, 'run-start', 0, `${state.run.provider}/${state.run.model} · rounds≤${state.run.roundsMax} · outputs_max=${state.run.outputsMax}`);
      await loop(root, cfg, state, provider, ac);
    } else {
      gateEvent(root, state, 'run-resume', state.run.roundIndex + 1, `resuming run ${state.run.id} at round ${state.run.roundIndex + 1}`);
      await loop(root, cfg, state, provider, ac);
    }
  } catch (err) {
    if (ac.signal.aborted || stopRequested(root)) {
      killNow(root, state, ac, state.run.roundIndex + 1);
    } else {
      resetHard(target, state.run.lastGoodCommit || head(target));
      state.status = 'halted';
      state.haltReason = 'crash';
      gateEvent(root, state, 'crash', state.run.roundIndex + 1, err.message);
      saveState(root, state);
      throw err;
    }
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    writePid(root, null);
  }
  return state;
}

async function loop(root, cfg, state, provider, ac) {
  const target = targetRoot(root, cfg);
  const { outputsMax, roundsMax } = state.run;

  for (let round = state.run.roundIndex + 1; round <= roundsMax; round++) {
    if (stopRequested(root)) return killNow(root, state, ac, round);

    const preHead = head(target);
    const prevLoc = state.rounds.length ? state.rounds[state.rounds.length - 1].loc : state.baseline.loc;
    state.run.attemptsThisRound = 0;
    const attemptLog = [];
    let shipped = false;

    while (state.run.attemptsThisRound < outputsMax) {
      if (stopRequested(root)) return killNow(root, state, ac, round);

      const attemptNo = state.run.attemptsThisRound + 1;
      state.run.attemptsThisRound = attemptNo;
      saveState(root, state); // checkpoint before write — a crash here resumes clean

      const ctx = {
        root: target,
        round,
        attemptNo,
        outputsMax,
        roundsMax,
        entry: cfg.entry,
        rules: readRules(root, cfg),
        loc: countLoc(target).lines,
        fileCount: state.baseline.files,
        files: listProjectFiles(target).slice(0, 80),
        fileContents: buildFileContext(target, cfg),
        lastFailures: attemptNo > 1 ? attemptLog[attemptLog.length - 1]?.failures : null,
      };

      let out;
      try {
        out = await provider.step(ctx, { signal: ac.signal });
      } catch (err) {
        if (ac.signal.aborted || stopRequested(root)) return killNow(root, state, ac, round);
        attemptLog.push({ attemptNo, kind: 'protocol', failures: [{ kind: 'protocol', message: err.message }] });
        gateEvent(root, state, 'protocol-error', round, err.message);
        const verdict = evaluateProtocolError({ attemptNo, outputsMax });
        if (verdict.halt) return halt(root, target, state, round, verdict.halt, attemptLog);
        continue;
      }

      // operations layer: accumulate usage on every agent output
      const usd = costOf(state.run.model, out.usage, cfg.costs);
      state.usage.calls += 1;
      state.usage.inputTokens += out.usage.input || 0;
      state.usage.outputTokens += out.usage.output || 0;
      state.usage.usd += usd;

      const applyErr = applyProposal(target, out.proposal);
      if (applyErr) {
        attemptLog.push({ attemptNo, kind: 'protocol', failures: [{ kind: 'protocol', message: applyErr }] });
        gateEvent(root, state, 'protocol-error', round, applyErr);
        resetHard(target, preHead);
        const verdict = evaluateProtocolError({ attemptNo, outputsMax });
        if (verdict.halt) return halt(root, target, state, round, verdict.halt, attemptLog);
        continue;
      }

      const checks = runChecks(target, cfg, prevLoc, state.latched);
      const verdict = evaluateAttempt({
        checks,
        attemptNo,
        outputsMax,
        overbuildAction: state.run.overbuildAction,
      });

      if (verdict.ship) {
        const attemptId = `${state.run.id}-r${round}-a${attemptNo}`;
        const commit = commitAll(target, `tship: round ${round} [${attemptId}]`);
        const newMs = scanMilestones(target, cfg, state.milestones, round, state.baseline);
        state.milestones.push(...newMs);
        saveSnapshot(target, commit, cfg.entry, round);
        const flags = verdict.flags.map((f) => f.message);
        state.rounds.push({
          round,
          attempts: attemptNo,
          shipped: true,
          loc: checks.loc,
          locDelta: checks.loc - prevLoc,
          tokens: (out.usage.input || 0) + (out.usage.output || 0),
          usd,
          verdict: flags.length ? 'shipped-flagged' : 'shipped',
          flags,
          failures: [],
          summary: out.proposal.summary,
          commit,
        });
        if (flags.length) gateEvent(root, state, 'overbuild-flag', round, flags.join('; '));
        if (newMs.length) gateEvent(root, state, 'milestone', round, newMs.map((m) => m.id).join(', '));
        state.run.lastGoodCommit = commit;
        shipped = true;
        break;
      }

      // rejected: idempotent discard of this attempt — the tree returns to the
      // pre-round checkpoint and stays there until a proposal passes
      resetHard(target, preHead);
      const failures = verdict.failures.map((f) => ({ kind: f.kind, message: f.message }));
      attemptLog.push({ attemptNo, kind: 'rejected', failures });
      gateEvent(root, state, 'attempt-rejected', round, failures.map((f) => `[${f.kind}] ${f.message}`).join('; '));
      if (verdict.halt) return halt(root, target, state, round, verdict.halt, attemptLog);
      // else: retry with the remaining outputs budget
    }

    if (!shipped) {
      return halt(root, target, state, round, 'outputs-max', attemptLog);
    }

    state.run.roundIndex = round;
    state.run.attemptsThisRound = 0;
    saveState(root, state);
  }

  state.status = 'completed';
  gateEvent(root, state, 'completed', roundsMax, `all ${roundsMax} rounds shipped`);
  saveState(root, state);
}

// Context layer: give the model the actual current files (bounded), so a live
// provider can edit what exists instead of guessing.
function buildFileContext(target, cfg) {
  const perFile = 7000;
  const budget = 32000;
  let used = 0;
  const out = [];
  const files = listProjectFiles(target)
    .filter((f) => /\.(html|css|js|json)$/.test(f))
    .sort((a, b) => (a === cfg.entry ? -1 : b === cfg.entry ? 1 : a.localeCompare(b)))
    .slice(0, 12);
  for (const rel of files) {
    if (used >= budget) break;
    let content = '';
    try {
      content = fs.readFileSync(path.join(target, rel), 'utf8');
    } catch {
      continue;
    }
    const truncated = content.length > perFile;
    if (truncated) content = content.slice(0, perFile) + '\n… (truncated by harness)';
    used += content.length;
    out.push({ path: rel, content, truncated });
  }
  return out;
}

function applyProposal(root, proposal) {
  if (!proposal || !Array.isArray(proposal.files) || proposal.files.length === 0) {
    return 'proposal contained no files';
  }
  for (const f of proposal.files) {
    if (typeof f.path !== 'string' || !f.path || f.path.includes('..') || path.isAbsolute(f.path)) {
      return `unsafe path in proposal: ${f.path}`;
    }
    if (typeof f.content !== 'string') return `file ${f.path} has no content`;
  }
  for (const f of proposal.files) {
    const abs = path.join(root, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
  }
  return null;
}

// The kill path. Runs entirely in the harness: abort in-flight provider calls,
// roll the repo back to the last good checkpoint, mark state, clear the flag.
// The model is never consulted and has no way to resist this.
export function killNow(root, state, ac, round) {
  try {
    ac?.abort(new Error('kill switch'));
  } catch {
    /* already aborted */
  }
  const cfg = loadConfig(root);
  const target = targetRoot(root, cfg);
  const lg = state.run?.lastGoodCommit || head(target);
  if (lg && !isClean(target)) resetHard(target, lg);
  else if (lg && head(target) !== lg) resetHard(target, lg);
  state.status = 'killed';
  state.haltReason = 'user-rejection';
  gateEvent(root, state, 'killed', round ?? state.run.roundIndex + 1, `kill switch engaged — rolled back to ${lg?.slice(0, 8) || 'baseline'}`);
  saveState(root, state);
  clearStopFile(root);
  return state;
}

export function clearStopFile(root) {
  try {
    fs.unlinkSync(stopFilePath(root));
  } catch {
    /* already gone */
  }
}

function halt(root, target, state, round, reason, attemptLog) {
  const lg = state.run.lastGoodCommit;
  if (lg && (!isClean(target) || head(target) !== lg)) resetHard(target, lg);
  state.status = 'halted';
  state.haltReason = reason;
  const detail =
    reason === 'outputs-max'
      ? `outputs budget (${state.run.outputsMax} agent outputs) exhausted at round ${round}`
      : reason;
  gateEvent(root, state, 'halt', round, detail);
  saveState(root, state);
  return state;
}

// ------------------------------------------------------------------ stop ----

export function stopRun(root) {
  const state = loadState(root);
  if (!state || !state.run) {
    throw new Error('no run to stop');
  }
  fs.mkdirSync(harnessPath(root), { recursive: true });
  fs.writeFileSync(stopFilePath(root), JSON.stringify({ ts: new Date().toISOString(), by: process.pid }));
  const { alive, pid } = pidAlive(root);
  if (alive && pid && pid !== process.pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* raced with natural exit */
    }
  }
  return { state, signaled: alive };
}

// -------------------------------------------------------------- rollback ----

export function rollbackTo(root, targetArg) {
  const cfg = loadConfig(root);
  const target = targetRoot(root, cfg);
  let sha = null;
  if (/^[0-9a-f]{7,40}$/i.test(String(targetArg))) {
    sha = String(targetArg);
  } else {
    const round = parseInt(targetArg, 10);
    if (Number.isNaN(round)) throw new Error(`cannot parse rollback target: ${targetArg}`);
    sha = checkpointOfRound(target, round);
  }
  if (!sha) throw new Error(`no checkpoint found for ${targetArg}`);
  resetHard(target, sha);
  const state = loadState(root);
  if (state?.run) {
    state.run.lastGoodCommit = sha;
    gateEvent(root, state, 'manual-rollback', 0, `repo reset to ${sha.slice(0, 8)}`);
    saveState(root, state);
  }
  return sha;
}
