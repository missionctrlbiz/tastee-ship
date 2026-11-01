import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProject, tship, readState, applyCaseStudyConfig, ok, done, section, CLI, REPO } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT_DIR = path.join(REPO, 'docs', 'evidence');
fs.mkdirSync(OUT_DIR, { recursive: true });

const log = [];
const origLog = console.log.bind(console);
console.log = (...args) => {
  log.push(args.join(' '));
  origLog(...args);
};

console.log('tasteeship — coffee-shop case-study validation');
console.log('reference: "I Told Claude to \'Make it better\' 100 Times" (https://www.youtube.com/watch?v=DByAR5Su1Yw)');
console.log('NOTE: no model API keys are present in this environment, so the runs use the');
console.log('deterministic mock provider (mock-sonnet / mock-opus) calibrated to the video\'s');
console.log('findings. Re-run with `tship keys add anthropic` + `--provider anthropic` for live models.\n');

const runs = {};

function finishRun(name, dir) {
  const state = readState(dir);
  runs[name] = state;
  fs.writeFileSync(path.join(OUT_DIR, `${name}-state.json`), JSON.stringify(state, null, 2) + '\n');
  const report = tship(dir, ['report', path.join(dir, '.tasteeship', 'state.json')]);
  console.log(report.split('\n').slice(1, 12).join('\n'));
  return state;
}

// -- run 1: mock-sonnet, 50 rounds, default gate (halt) ----------------------
section('run 1 — mock-sonnet · 50 rounds · outputs_max 4 · gate = halt');
{
  const dir = makeProject('sonnet');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir);
  tship(dir, ['run', '--rounds', '50', '--outputs-max', '4']);
  const s = finishRun('sonnet-50', dir);

  ok(s.status === 'completed', 'status: completed (never halted, never killed)');
  ok(s.run.roundIndex === 50, '50/50 rounds shipped');
  const ms = Object.fromEntries(s.milestones.map((m) => [m.id, m.round]));
  ok(ms['comic-sans-gone'] === 1, 'milestone comic-sans-gone @ r1');
  ok(ms['first-responsive'] === 2, 'milestone first-responsive @ r2');
  ok(ms['form-works'] === 3, 'milestone form-works @ r3');
  ok(ms['first-image'] === 5, 'milestone first-image @ r5');
  ok(ms['first-video'] === 12, 'milestone first-video @ r12');
  ok(ms['first-canvas'] === 18, 'milestone first-canvas @ r18');
  ok(s.usage.calls >= 50 && s.usage.usd > 0, `usage accumulated: ${s.usage.calls} calls, $${s.usage.usd.toFixed(2)}`);
  ok(s.rounds.every((r) => r.locDelta <= 350), 'every round stayed under the LOC-delta cap');
}

// -- run 2: mock-opus, default gate (halt on over-build) ---------------------
section('run 2 — mock-opus · 50 rounds attempted · gate = halt (over-build)');
{
  const dir = makeProject('opus-halt');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir);
  tship(dir, ['run', '--rounds', '50', '--outputs-max', '4', '--model', 'mock-opus']);
  const s = finishRun('opus-halted', dir);

  ok(s.status === 'halted' && s.haltReason === 'overbuild', 'gate halted the run: over-build');
  ok(s.run.roundIndex === 12, 'halted after round 12 — round 13 (pumpkin-carving configurator) rejected');
  const idx = fs.readFileSync(path.join(dir, 'index.html'), 'utf8') + fs.readFileSync(path.join(dir, 'css', 'style.css'), 'utf8');
  ok(!/pumpkin/i.test(idx), 'over-build feature rolled back — not in the shipped tree');
  ok(s.usage.usd > 0, `usage accumulated before the halt: $${s.usage.usd.toFixed(2)}`);
  const clean = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).length === 0;
  ok(clean, 'repo clean after the halt (rollback to last good checkpoint)');
}

// -- run 3: mock-opus, flag mode (the full 50-round trajectory) --------------
section('run 3 — mock-opus · 50 rounds · gate = flag over-build (watch it drift)');
{
  const dir = makeProject('opus-flag');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir, { locCap: 30000, locDeltaCap: 2000 });
  tship(dir, ['run', '--rounds', '50', '--outputs-max', '4', '--model', 'mock-opus', '--flag-overbuild']);
  const s = finishRun('opus-flagged-50', dir);

  ok(s.status === 'completed' && s.run.roundIndex === 50, '50/50 rounds shipped (flag mode)');
  const flagged = s.rounds.filter((r) => r.verdict === 'shipped-flagged');
  ok(flagged.length >= 35, `${flagged.length}/50 rounds flagged over-build`);
  ok(flagged[0]?.round === 13, 'first over-build flag @ r13 (pumpkin-carving configurator)');
  ok(s.rounds.find((r) => r.round === 30)?.attempts === 2, 'r30: broken language toggle rejected by gate, retry shipped');
  ok(s.rounds.find((r) => r.round === 38)?.attempts === 2, 'r38: order-form id rename rejected by gate, retry shipped');
  const sonnet = runs['sonnet-50'];
  ok(s.usage.usd > sonnet.usage.usd * 3, `cost: opus $${s.usage.usd.toFixed(2)} vs sonnet $${sonnet.usage.usd.toFixed(2)} (>3x)`);
  ok(s.rounds.at(-1).loc > sonnet.rounds.at(-1).loc * 4, `LOC: opus ${s.rounds.at(-1).loc} vs sonnet ${sonnet.rounds.at(-1).loc} (>4x)`);
  const ms = Object.fromEntries(s.milestones.map((m) => [m.id, m.round]));
  ok(ms['first-image'] === 4 && ms['first-canvas'] === 16, `opus milestones fired (image @4, canvas @16)`);
}

// -- run 4: kill-switch drill -------------------------------------------------
section('run 4 — kill-switch drill: stop mid-run, verify rollback, resume');
{
  const dir = makeProject('kill');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir);
  const child = spawn('node', [CLI, 'run', '--rounds', '50', '--outputs-max', '4'], { cwd: dir, stdio: 'ignore' });
  let state = null;
  for (let i = 0; i < 400; i++) {
    await sleep(50);
    try {
      state = readState(dir);
      if (state.run?.roundIndex >= 20 && state.status === 'running') break;
    } catch {
      /* not written yet */
    }
  }
  const killedDuring = state.run.roundIndex + 1;
  tship(dir, ['stop']);
  await new Promise((resolve) => child.on('exit', resolve));
  state = readState(dir);
  fs.writeFileSync(path.join(OUT_DIR, 'kill-drill-state.json'), JSON.stringify(state, null, 2) + '\n');

  ok(state.status === 'killed' && state.haltReason === 'user-rejection', `killed at round ${killedDuring}: status=killed, reason=user-rejection`);
  const lg = state.run.lastGoodCommit;
  ok(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim() === lg, `repo HEAD == last good checkpoint ${lg.slice(0, 8)} (rolled back)`);
  const clean = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).length === 0;
  ok(clean, 'working tree clean — in-flight attempt discarded');
  const callsAtKill = state.usage.calls;
  const usdAtKill = state.usage.usd;

  tship(dir, ['resume', '--acknowledge', '--force']);
  state = readState(dir);
  fs.writeFileSync(path.join(OUT_DIR, 'kill-drill-resumed-state.json'), JSON.stringify(state, null, 2) + '\n');
  ok(state.status === 'completed' && state.run.roundIndex === 50, 'resumed from checkpoint → completed all 50 rounds');
  ok(state.usage.calls > callsAtKill && state.usage.usd > usdAtKill, `usage continued across the kill (${callsAtKill} → ${state.usage.calls} calls, $${usdAtKill.toFixed(2)} → $${state.usage.usd.toFixed(2)})`);
}

// -- keys storage hygiene ------------------------------------------------------
section('keys: stored in .env.local, chmod 600, never committed');
{
  const dir = makeProject('keys');
  tship(dir, ['init']);
  execFileSync('node', [CLI, 'keys', 'add', 'anthropic'], {
    cwd: dir,
    encoding: 'utf8',
    input: 'sk-ant-api03-EXAMPLE-DO-NOT-USE\n',
  });
  const envFile = path.join(dir, '.env.local');
  ok(fs.existsSync(envFile), '.env.local written');
  ok((fs.statSync(envFile).mode & 0o777) === 0o600, 'permissions: 600');
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  ok(gi.includes('.env.local'), '.gitignore contains .env.local');
  const listed = tship(dir, ['keys', 'list']);
  ok(/ANTHROPIC_API_KEY\s+sk-ant-…-USE/.test(listed), 'keys list masks the value');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x'], { cwd: dir });
  const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
  ok(!tracked.includes('.env.local'), '.env.local is NOT tracked by git');
}

// -- summary -------------------------------------------------------------------
const sonnet = runs['sonnet-50'];
const opusHalted = runs['opus-halted'];
const opusFlagged = runs['opus-flagged-50'];
const summary = {
  generatedAt: new Date().toISOString(),
  provider: 'mock (deterministic; no API keys in environment)',
  sonnet: {
    status: sonnet.status, rounds: sonnet.run.roundIndex, calls: sonnet.usage.calls,
    inputTokens: sonnet.usage.inputTokens, outputTokens: sonnet.usage.outputTokens,
    usd: +sonnet.usage.usd.toFixed(4), finalLoc: sonnet.rounds.at(-1).loc,
    milestones: sonnet.milestones, rejectedAttempts: sonnet.gateEvents.filter((e) => e.type === 'attempt-rejected').length,
  },
  opusHalted: {
    status: opusHalted.status, haltReason: opusHalted.haltReason, rounds: opusHalted.run.roundIndex,
    calls: opusHalted.usage.calls, usd: +opusHalted.usage.usd.toFixed(4),
    finalLoc: opusHalted.rounds.at(-1)?.loc, milestones: opusHalted.milestones,
  },
  opusFlagged: {
    status: opusFlagged.status, rounds: opusFlagged.run.roundIndex, calls: opusFlagged.usage.calls,
    usd: +opusFlagged.usage.usd.toFixed(4), finalLoc: opusFlagged.rounds.at(-1).loc,
    flaggedRounds: opusFlagged.rounds.filter((r) => r.verdict === 'shipped-flagged').length,
    firstFlagRound: opusFlagged.rounds.find((r) => r.verdict === 'shipped-flagged')?.round,
    milestones: opusFlagged.milestones,
    rejectedAttempts: opusFlagged.gateEvents.filter((e) => e.type === 'attempt-rejected').length,
  },
};
fs.writeFileSync(path.join(OUT_DIR, 'validation-summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'validation-output.txt'), log.join('\n') + '\n');
console.log(`\nevidence written to docs/evidence/ (${Object.keys(runs).length} run states + summary)`);

done('validation');
