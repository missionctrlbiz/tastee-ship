import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { makeProject, tship, readState, applyCaseStudyConfig, ok, done, section, CLI, REPO } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('tship smoke test — end-to-end mechanics on the coffee-shop fixture');

// 1 — clean run, milestones, usage accumulation, snapshots -------------------
section('clean run: 8 rounds, mock-sonnet');
{
  const dir = makeProject('basic');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir);
  const out = tship(dir, ['run', '--rounds', '8', '--outputs-max', '4']);
  const state = readState(dir);

  ok(state.status === 'completed', 'run completed');
  ok(state.run.roundIndex === 8, '8 rounds shipped', `roundIndex=${state.run.roundIndex}`);
  const ms = Object.fromEntries(state.milestones.map((m) => [m.id, m.round]));
  ok(ms['comic-sans-gone'] === 1, 'milestone: Comic Sans removed @ r1', JSON.stringify(ms));
  ok(ms['first-responsive'] === 2, 'milestone: first responsive layout @ r2');
  ok(ms['form-works'] === 3, 'milestone: order form works @ r3');
  ok(ms['first-image'] === 5, 'milestone: first image @ r5');
  ok(state.usage.calls >= 8, `usage accumulated: ${state.usage.calls} calls`, `calls=${state.usage.calls}`);
  ok(state.usage.usd > 0, `cost accumulated: $${state.usage.usd.toFixed(4)}`);
  ok(fs.existsSync(path.join(dir, '.tasteeship', 'snapshots', 'round-008.html')), 'snapshot saved for scrubber');
  ok(/tship: round 8 \[/.test(execFileSync('git', ['log', '--oneline', '-3'], { cwd: dir, encoding: 'utf8' })), 'checkpoint commits in git log');

  // dashboard API serves this project
  const { startDashboard } = await import(path.join(REPO, 'lib', 'dashboard.js'));
  const server = startDashboard(path.dirname(dir), { port: 4891 });
  await sleep(200);
  const proj = path.basename(dir);
  const res = await fetch(`http://localhost:4891/api/state?project=${proj}`);
  const dash = await res.json();
  ok(dash.run?.roundIndex === 8, 'dashboard /api/state serves the run');
  const killRes = await fetch(`http://localhost:4891/api/kill?project=${proj}`, { method: 'POST' });
  ok(killRes.ok && fs.existsSync(path.join(dir, '.tasteeship', 'stop')), 'dashboard kill endpoint writes stop flag (same path as CLI)');
  fs.rmSync(path.join(dir, '.tasteeship', 'stop'));
  server.close();
}

// 2 — the gate halts on over-build and rolls back ----------------------------
section('gate: over-build halt at the pumpkin round (default action = halt)');
{
  const dir = makeProject('overbuild');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir);
  tship(dir, ['run', '--rounds', '20', '--outputs-max', '4', '--model', 'mock-opus']);
  const state = readState(dir);

  ok(state.status === 'halted', 'run halted by the gate', `status=${state.status}`);
  ok(state.haltReason === 'overbuild', `halt reason: ${state.haltReason}`);
  ok(state.run.roundIndex === 12, 'halted after round 12 (pumpkin round 13 rejected)', `roundIndex=${state.run.roundIndex}`);
  const idx = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  ok(!/pumpkin/i.test(idx), 'pumpkin feature NOT shipped — rolled back');
  ok(state.usage.calls > 0 && state.usage.usd > 0, 'usage still accumulated for spent outputs');
  const flag = state.rounds.every((r) => !/pumpkin/i.test(r.summary || ''));
  ok(flag, 'no shipped round mentions pumpkin');
}

// 3 — kill switch: out-of-band stop + rollback + resume ----------------------
section('kill switch: mid-run stop, rollback, checkpoint resume');
{
  const dir = makeProject('kill');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir);
  const child = spawn('node', [CLI, 'run', '--rounds', '50', '--outputs-max', '4'], { cwd: dir, stdio: 'ignore' });

  // wait until the run is past round 5
  let state = null;
  for (let i = 0; i < 300; i++) {
    await sleep(50);
    try {
      state = readState(dir);
      if (state.run?.roundIndex >= 5 && state.status === 'running') break;
    } catch {
      /* state not written yet */
    }
  }
  ok(!!state && state.run.roundIndex >= 5, `run reached round ${state?.run?.roundIndex} before the kill`);
  const preKillRound = state.run.roundIndex;

  tship(dir, ['stop']);
  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  state = readState(dir);

  ok(exitCode === 0, `runner exited cleanly (code ${exitCode})`);
  ok(state.status === 'killed', 'run marked killed');
  ok(state.haltReason === 'user-rejection', 'halt reason: user-rejection');
  ok(
    state.run.roundIndex >= preKillRound && state.run.roundIndex < preKillRound + 4,
    `no meaningful progress after the kill (killed during round ${state.run.roundIndex + 1}, pre-kill round ${preKillRound})`
  );
  ok(!fs.existsSync(path.join(dir, '.tasteeship', 'stop')), 'stop flag cleared');
  const clean = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).length === 0;
  ok(clean, 'working tree clean after rollback');

  // resume guard: out-of-band edits after the kill are surfaced, not silently accepted
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'user edited after the kill\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'user edit after kill'], { cwd: dir });
  let mismatch = '';
  try {
    tship(dir, ['resume', '--acknowledge']);
  } catch (err) {
    mismatch = err.stdout?.toString() || err.message;
  }
  ok(/≠|checkpoint/.test(mismatch), 'resume refused on HEAD/checkpoint mismatch', mismatch.slice(0, 80));
  execFileSync('node', [CLI, 'resume', '--acknowledge', '--force'], { cwd: dir, encoding: 'utf8' });
  state = readState(dir);
  ok(state.status === 'completed' && state.run.roundIndex === 50, 'resumed from checkpoint and completed all 50 rounds');
  ok(state.usage.calls >= 50, `usage spans both phases: ${state.usage.calls} calls`);
}

// 4 — flag mode: over-build flagged instead of halting ------------------------
section('flag mode: opus runs 50 rounds with over-build flags');
{
  const dir = makeProject('flagged');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir, { locCap: 30000, locDeltaCap: 2000 });
  tship(dir, ['run', '--rounds', '50', '--outputs-max', '4', '--model', 'mock-opus', '--flag-overbuild']);
  const state = readState(dir);

  ok(state.status === 'completed', 'run completed in flag mode');
  ok(state.run.roundIndex === 50, 'all 50 rounds shipped');
  const flagged = state.rounds.filter((r) => r.verdict === 'shipped-flagged');
  ok(flagged.length >= 35, `${flagged.length} rounds flagged over-build (pumpkin persists + LOC cap)`);
  const firstFlag = flagged[0];
  ok(firstFlag?.round === 13, `first flag at round 13 (${firstFlag?.flags?.[0]?.slice(0, 50)})`);
  const r30 = state.rounds.find((r) => r.round === 30);
  ok(r30?.attempts === 2, 'regression drill at r30: broken language toggle rejected, retry shipped (2 attempts)');
  const r38 = state.rounds.find((r) => r.round === 38);
  ok(r38?.attempts === 2, 'regression drill at r38: form-id rename rejected, retry shipped (2 attempts)');
  const ms = Object.fromEntries(state.milestones.map((m) => [m.id, m.round]));
  ok(ms['first-canvas'] === 16, 'opus milestones fired (canvas @16)');
  ok(state.usage.usd > 0, `opus usage accumulated: $${state.usage.usd.toFixed(2)}`);
}

done('smoke');
