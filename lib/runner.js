import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, harnessPath, stopFilePath, snapshotsDir } from './config.js';
import { loadKeys } from './keys.js';
import { createProvider } from './providers/index.js';
import { runChecks, baselineScan } from './checks.js';
import { scanMilestones } from './milestones.js';
import { evaluateAttempt, evaluateProtocolError } from './gate.js';
import { freshState, loadState, saveState, gateEvent, emit } from './state.js';
import { costOf } from './costs.js';
import { writeManifest, stampResume } from './manifest.js';
import {
  ensureRepo,
  head,
  isClean,
  commitAll,
  resetHard,
  saveSnapshot,
  checkpointOfRound,
  git,
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

  if (state.status !== 'killed' && state.status !== 'halted') {
    // fresh run: reset per-run fields (completed runs may leave them behind)
    state.rounds = [];
    state.milestones = [];
    state.usage = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    state.baseline = null;
    state.latched = null;
    state.run = {
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
  return executeRun(root, cfg, state, { fresh: state.status !== 'killed' && state.status !== 'halted', force: !!flags.force });
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

  const target = targetRoot(root, cfg);

  // Recovery must surface out-of-band edits, not absorb them (P1, CODEX
  // review): a clean-HEAD-but-dirty tree would otherwise be silently swept
  // into the next baseline commit, and `reset --hard` + `clean -fd` under
  // --force deletes untracked work — so refuse without explicit force.
  const dirty = git(target, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) {
    if (!flags.force || !state.run.lastGoodCommit) {
      throw new Error(
        `working tree has out-of-band changes:\n${dirty.split('\n').slice(0, 12).join('\n')}\n` +
          'Commit or remove them before resuming, or use --force to reset to the recorded checkpoint.'
      );
    }
    resetHard(target, state.run.lastGoodCommit);
  }

  // Verify assumptions on resume (safe-to-resume): the repo must sit at the
  // last good checkpoint recorded in the state.
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
  stampResume(root);
  return executeRun(root, cfg, state, { fresh: false, force: !!flags.force });
}

async function executeRun(root, cfg, state, { fresh, force = false }) {
  const target = targetRoot(root, cfg);
  ensureRepo(target);
  const originalHead = head(target); // before any baseline commit — the user's own HEAD

  if (!fresh) {
    // continuation of a killed/halted run — the tree must be exactly at the
    // recorded checkpoint (resumeRun/startRun already force-gated this)
    if (!isClean(target)) {
      if (!force) {
        throw new Error('working tree has out-of-band changes — commit/remove them, or pass --force to reset to the checkpoint');
      }
      resetHard(target, state.run.lastGoodCommit);
    }
  } else if (!isClean(target)) {
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

  if (fresh) {
    state.baseline.commit = state.run.lastGoodCommit;
    saveState(root, state);
    // Per-run manifest (Area 3): configuration, hashes, caps, runtime.
    writeManifest(root, cfg, state, target, {
      originalHead,
      baselineCheckpoint: state.baseline.commit,
    });
    gateEvent(root, state, 'run-start', 0, `${state.run.provider}/${state.run.model} · rounds≤${state.run.roundsMax} · outputs_max=${state.run.outputsMax}`);
  }

  const provider = createProvider(cfg, loadKeys(root), state.run.id);
  const ac = new AbortController();
  const onSignal = () => ac.abort(new Error('signal received'));
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    if (!fresh) {
      gateEvent(root, state, 'run-resume', state.run.roundIndex + 1, `resuming run ${state.run.id} at round ${state.run.roundIndex + 1}`);
    }
    await loop(root, cfg, state, provider, ac);
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
    // Per-round usage across ALL attempts — the shipping attempt alone
    // undercounts rounds that needed retries (Area 2 P0, accounting fix).
    const roundUsage = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    const bumpUsage = (usage, usd) => {
      roundUsage.calls += 1;
      roundUsage.inputTokens += usage.input || 0;
      roundUsage.outputTokens += usage.output || 0;
      roundUsage.usd += usd;
    };
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
        emit(root, state, { type: 'protocol-error', round, message: err.message, payload: { attemptNo, outputsMax }, causalityId: `${state.run.id}-r${round}-a${attemptNo}` });
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
      bumpUsage(out.usage, usd);

      const attemptId = `${state.run.id}-r${round}-a${attemptNo}`;
      const applyErr = applyProposal(target, out.proposal);
      if (applyErr) {
        attemptLog.push({ attemptNo, kind: 'protocol', failures: [{ kind: 'protocol', message: applyErr }] });
        emit(root, state, { type: 'protocol-error', round, message: applyErr, payload: { attemptNo, outputsMax }, causalityId: attemptId });
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

      // Causal record: the check results and the verdict share attemptId —
      // `grep attemptId events.jsonl` reconstructs the decision (Area 3 P0).
      emit(root, state, {
        type: 'check-run',
        round,
        message: checks.pass ? 'all checks green' : checks.failures.map((f) => f.message).join('; '),
        causalityId: attemptId,
        payload: {
          attemptNo,
          outputsMax,
          pass: checks.pass,
          failures: checks.failures,
          gaps: checks.gaps,
          green: checks.green,
          loc: checks.loc,
          locDelta: checks.locDelta,
          locCap: cfg.verify.locCap ?? null,
          locDeltaCap: cfg.verify.locDeltaCap ?? null,
        },
      });
      emit(root, state, {
        type: 'gate-verdict',
        round,
        message: verdict.ship ? (verdict.flags.length ? 'shipped with flags' : 'ship') : verdict.halt ? `halt: ${verdict.halt}` : 'retry',
        causalityId: attemptId,
        payload: {
          attemptNo,
          ship: verdict.ship,
          halt: verdict.halt ?? null,
          flags: verdict.flags.map((f) => f.message),
          failures: verdict.failures,
          overbuildAction: state.run.overbuildAction,
        },
      });

      if (verdict.ship) {
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
          usage: { ...roundUsage },
          verdict: flags.length ? 'shipped-flagged' : 'shipped',
          flags,
          failures: [],
          summary: out.proposal.summary,
          commit,
        });
        if (flags.length) gateEvent(root, state, 'overbuild-flag', round, flags.join('; '));
        emit(root, state, {
          type: 'ship',
          round,
          message: flags.length ? `shipped (flagged: ${flags.join('; ')})` : 'shipped clean',
          causalityId: attemptId,
          payload: {
            commit,
            loc: checks.loc,
            locDelta: checks.loc - prevLoc,
            milestones: newMs.map((m) => m.id),
            usage: { ...roundUsage },
            summary: out.proposal.summary,
          },
        });
        if (newMs.length) gateEvent(root, state, 'milestone', round, newMs.map((m) => m.id).join(', '));
        state.run.lastGoodCommit = commit;
        shipped = true;
        break;
      }

      // Rejected: capture the offending proposal BEFORE rollback erases it
      // (Area 3 P2 incident artifact), then discard idempotently.
      const failures = verdict.failures.map((f) => ({ kind: f.kind, message: f.message, id: f.id, critical: !!f.critical }));
      attemptLog.push({ attemptNo, kind: 'rejected', failures });
      let incident = null;
      if (verdict.halt) {
        incident = {
          reason: verdict.halt,
          failures,
          checks: { gaps: checks.gaps, green: checks.green, loc: checks.loc, locDelta: checks.locDelta },
          attemptLog,
          proposal: boundProposal(out.proposal),
        };
      }
      emit(root, state, {
        type: 'attempt-rejected',
        round,
        message: failures.map((f) => `[${f.kind}] ${f.message}`).join('; '),
        causalityId: attemptId,
        payload: { attemptNo, failures, willHalt: !!verdict.halt },
      });
      resetHard(target, preHead);
      if (verdict.halt) return halt(root, target, state, round, verdict.halt, attemptLog, incident);
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

function boundProposal(proposal, perFile = 20000) {
  if (!proposal) return null;
  return {
    summary: proposal.summary ?? '',
    files: (proposal.files || []).map((f) => ({
      path: f.path,
      bytes: f.content?.length ?? 0,
      content: String(f.content ?? '').slice(0, perFile),
      truncated: (f.content?.length ?? 0) > perFile,
    })),
  };
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

// Proposal writes (P0, Area 2): the model must not gain filesystem authority
// outside the checkpointed tree. All paths are validated BEFORE the first
// write; existing symlink components are rejected (a write beneath a symlinked
// directory could escape the repo and survive rollback); each file is written
// to a temp sibling and atomically renamed, so a destination symlink is
// replaced rather than followed.
export function applyProposal(root, proposal) {
  if (!proposal || !Array.isArray(proposal.files) || proposal.files.length === 0) {
    return 'proposal contained no files';
  }
  for (const f of proposal.files) {
    if (typeof f.path !== 'string' || !f.path || f.path.includes('..') || path.isAbsolute(f.path)) {
      return `unsafe path in proposal: ${f.path}`;
    }
    if (typeof f.content !== 'string') return `file ${f.path} has no content`;
    const escape = assertNoSymlinkEscape(root, f.path);
    if (escape) return escape;
  }
  for (const f of proposal.files) {
    const abs = path.resolve(root, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeProposalFileAtomically(abs, f.content);
  }
  return null;
}

function lstatSafe(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

export function assertNoSymlinkEscape(root, relPath) {
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return `unsafe path in proposal: ${relPath} (escapes project root)`;
  }
  const parts = rel.split(path.sep);
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = path.join(cur, part);
    const st = lstatSafe(cur);
    if (st?.isSymbolicLink()) return `unsafe path in proposal: ${relPath} (traverses symlink: ${path.relative(root, cur)})`;
  }
  const st = lstatSafe(abs);
  if (st?.isSymbolicLink()) return `unsafe path in proposal: ${relPath} (destination is a symlink)`;
  return null;
}

function writeProposalFileAtomically(abs, content) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tship-${process.pid}-${Date.now().toString(36)}.tmp`);
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, abs); // rename replaces a destination symlink itself
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
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
  emit(root, state, { type: 'killed', round: round ?? state.run.roundIndex + 1, message: `kill switch engaged — rolled back to ${lg?.slice(0, 8) || 'baseline'}` });
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

function halt(root, target, state, round, reason, attemptLog, incident = null) {
  const lg = state.run.lastGoodCommit;
  if (lg && (!isClean(target) || head(target) !== lg)) resetHard(target, lg);
  state.status = 'halted';
  state.haltReason = reason;
  const detail =
    reason === 'outputs-max'
      ? `outputs budget (${state.run.outputsMax} agent outputs) exhausted at round ${round}`
      : reason;
  const e = emit(root, state, { type: 'halt', round, message: detail, payload: { reason, attempts: attemptLog?.length ?? 0 } });
  writeIncident(root, state, round, `halt-${reason}`, {
    ts: e.ts,
    reason,
    detail,
    incident,
  });
  saveState(root, state);
  return state;
}

// Incident artifacts live under harness metadata (never in the project tree —
// they must not be visible to later model rounds, and rollback must not be
// able to erase them). Root cause is derived from recorded check results,
// never from the model.
function writeIncident(root, state, round, kind, data) {
  const dir = harnessPath(root, 'incidents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}-r${round}-${Date.now().toString(36)}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        schema: 1,
        run: state.run?.id ?? null,
        round,
        kind,
        ...data,
      },
      null,
      2
    ) + '\n'
  );
  return file;
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
