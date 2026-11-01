import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { makeProject, tship, readState, applyCaseStudyConfig, ok, done, section, CLI, REPO } from './helpers.js';
import { applyProposal } from '../lib/runner.js';
import { readEvents } from '../lib/state.js';
import { readManifest } from '../lib/manifest.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// execFileSync throws on non-zero exit — the CLI prints errors to stderr.
function childOutput(err) {
  return `${err.stdout?.toString() || ''}${err.stderr?.toString() || ''}` || err.message;
}

console.log('tship smoke test — end-to-end mechanics on the coffee-shop fixture');

// 1 — clean run, milestones, usage accounting, manifest, causal events --------
section('clean run: 8 rounds, mock-sonnet');
{
  const dir = makeProject('basic');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir);
  tship(dir, ['run', '--rounds', '8', '--outputs-max', '4']);
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

  // manifest (Area 3): configuration identity for the run
  const manifest = readManifest(dir);
  ok(manifest?.run === state.run.id, 'manifest.run matches state.run.id');
  ok(!!manifest?.rulesSha256 && manifest.rulesSha256.length === 64, 'manifest hashes rules.md (sha256)');
  ok(manifest?.caps?.outputsMax === 4 && manifest?.caps?.roundsMax === 8, 'manifest records the effective caps');
  ok(!!manifest?.gitHead && !!manifest?.baselineCheckpoint, 'manifest distinguishes gitHead and baselineCheckpoint');
  ok(!JSON.stringify(manifest).includes('API_KEY'), 'manifest contains no credentials');

  // causal events (Area 3): check-run + gate-verdict share the attemptId,
  // every shipped round gets an explicit ship event
  const events = readEvents(dir);
  const r1check = events.find((e) => e.type === 'check-run' && e.round === 1);
  const r1verdict = events.find((e) => e.type === 'gate-verdict' && e.round === 1);
  ok(!!r1check && !!r1verdict, 'check-run + gate-verdict events recorded');
  ok(r1check?.causalityId && r1check.causalityId === r1verdict?.causalityId, 'causalityId links check-run to its verdict');
  ok(r1check.causalityId === `${state.run.id}-r1-a1`, 'causalityId matches the checkpoint commit id');
  ok(r1check.payload?.loc > 0 && Array.isArray(r1check.payload?.green), 'check-run payload carries structured check results');
  const ships = events.filter((e) => e.type === 'ship');
  ok(ships.length === 8, `explicit ship event per shipped round (${ships.length})`);
  ok(events.every((e) => e.ts && (e.run === state.run.id || e.type === 'corrupt')), 'events carry ts + run id');

  // per-round usage (Area 2): all attempts of a round land on the round
  const sumRoundUsd = state.rounds.reduce((a, r) => a + (r.usage?.usd ?? 0), 0);
  ok(state.rounds.every((r) => r.usage?.calls >= 1), 'every shipped round carries usage {calls, tokens, usd}');
  ok(state.rounds.every((r) => r.usage.calls === r.attempts), 'round usage.calls === attempts taken');
  ok(Math.abs(sumRoundUsd - state.usage.usd) < 1e-9, 'per-round spend reconciles with the global counter');

  // dashboard API serves this project — including the hardened kill endpoint
  const { startDashboard } = await import(path.join(REPO, 'lib', 'dashboard.js'));
  const server = startDashboard(path.dirname(dir), { port: 4891 });
  await sleep(200);
  const proj = path.basename(dir);
  const stateRes = await fetch(`http://127.0.0.1:4891/api/state?project=${proj}`);
  const dash = await stateRes.json();
  ok(dash.run?.roundIndex === 8, 'dashboard /api/state serves the run');

  const killNoOrigin = await fetch(`http://127.0.0.1:4891/api/kill?project=${proj}`, { method: 'POST' });
  ok(killNoOrigin.status === 403, 'kill endpoint rejects requests without a loopback Origin (403)');
  const killBadOrigin = await fetch(`http://127.0.0.1:4891/api/kill?project=${proj}`, {
    method: 'POST',
    headers: { origin: 'http://evil.example' },
  });
  ok(killBadOrigin.status === 403, 'kill endpoint rejects foreign Origins (403)');
  const killOk = await fetch(`http://127.0.0.1:4891/api/kill?project=${proj}`, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:4891' },
  });
  ok(killOk.ok && fs.existsSync(path.join(dir, '.tasteeship', 'stop')), 'kill endpoint works for same-origin requests (same path as CLI)');
  fs.rmSync(path.join(dir, '.tasteeship', 'stop'));

  const diff = await (await fetch(`http://127.0.0.1:4891/api/snapshot-diff?project=${proj}&round=2`)).json();
  ok(Array.isArray(diff.stat) && diff.stat.length > 0 && !!diff.to, `snapshot-diff serves numstat from recorded commits (${diff.stat.length} files)`);
  const exportBody = await (await fetch(`http://127.0.0.1:4891/api/export?project=${proj}`)).json();
  ok(exportBody.manifest?.run === state.run.id && exportBody.events?.length > 0, '/api/export bundles manifest + state + events');
  const pfDenied = await fetch(`http://127.0.0.1:4891/api/pf/${encodeURIComponent(proj)}/.tasteeship/state.json`);
  ok(pfDenied.status === 404, '/api/pf refuses harness-private files (.tasteeship)');
  server.close();
}

// 2 — the gate halts on over-build, rolls back, writes an incident -----------
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
  const last = state.rounds.at(-1);
  ok(last.usage.calls === last.attempts, `per-round usage covers all attempts (r${last.round}: ${last.usage.calls} calls)`);
  const incidents = fs.existsSync(path.join(dir, '.tasteeship', 'incidents'))
    ? fs.readdirSync(path.join(dir, '.tasteeship', 'incidents'))
    : [];
  ok(incidents.length >= 1 && incidents[0].includes('halt-overbuild'), 'halt incident artifact written under .tasteeship/incidents');
  const incident = JSON.parse(fs.readFileSync(path.join(dir, '.tasteeship', 'incidents', incidents[0]), 'utf8'));
  ok(incident.reason === 'overbuild' && incident.incident?.failures?.length > 0, 'incident captures structured failures (not model text)');
  ok(/pumpkin/i.test(JSON.stringify(incident.incident?.proposal)), 'incident preserves the offending proposal evidence');
}

// 3 — kill switch: out-of-band stop + rollback + hardened resume --------------
section('kill switch: mid-run stop, rollback, resume hardening');
{
  const dir = makeProject('kill');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir);
  const child = spawn('node', [CLI, 'run', '--rounds', '50', '--outputs-max', '4'], { cwd: dir, stdio: 'ignore' });

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

  // resume hardening (P1): uncommitted and untracked out-of-band edits are
  // refused — HEAD equality alone is not "same work"
  fs.writeFileSync(path.join(dir, 'notes-untracked.txt'), 'untracked after the kill\n');
  let refused = '';
  try {
    tship(dir, ['resume', '--acknowledge']);
  } catch (err) {
    refused = childOutput(err);
  }
  ok(/out-of-band changes/.test(refused) && /notes-untracked/.test(refused), 'resume refused over an untracked file (paths reported)');
  fs.rmSync(path.join(dir, 'notes-untracked.txt'));

  fs.appendFileSync(path.join(dir, 'index.html'), '<!-- user edit -->\n');
  refused = '';
  try {
    tship(dir, ['resume', '--acknowledge']);
  } catch (err) {
    refused = childOutput(err);
  }
  ok(/out-of-band changes/.test(refused), 'resume refused over an uncommitted tracked-file edit');
  execFileSync('git', ['checkout', '--', 'index.html'], { cwd: dir });

  // committed out-of-band edits surface as a HEAD/checkpoint mismatch
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'user edit after the kill\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'user edit after kill'], { cwd: dir });
  refused = '';
  try {
    tship(dir, ['resume', '--acknowledge']);
  } catch (err) {
    refused = childOutput(err);
  }
  ok(/≠|checkpoint/.test(refused), 'resume refused on HEAD/checkpoint mismatch', refused.slice(0, 80));
  execFileSync('node', [CLI, 'resume', '--acknowledge', '--force'], { cwd: dir, encoding: 'utf8' });
  state = readState(dir);
  ok(state.status === 'completed' && state.run.roundIndex === 50, 'resumed from checkpoint and completed all 50 rounds');
  ok(state.usage.calls >= 50, `usage spans both phases: ${state.usage.calls} calls`);
  const manifest = readManifest(dir);
  ok(manifest.run === state.run.id && manifest.resumedAt, 'original manifest preserved through resume (resumedAt stamped)');
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
  const overbuildFlags = readEvents(dir).filter((e) => e.type === 'overbuild-flag');
  ok(overbuildFlags.length >= 35, 'overbuild-flag events recorded in the append-only log');
}

// 5 — proposal filesystem boundary (P0) ---------------------------------------
section('proposal writes: symlink escape rejected, atomic replacement');
{
  const dir = makeProject('symlink');
  tship(dir, ['init']);
  const evil = '/tmp/tship-evil-target';
  fs.mkdirSync(evil, { recursive: true });
  fs.rmSync(path.join(evil, 'escape.txt'), { force: true });
  fs.symlinkSync(evil, path.join(dir, 'evil-link'), 'dir');

  const err1 = applyProposal(dir, { files: [{ path: 'evil-link/escape.txt', content: 'escaped' }] });
  ok(!!err1 && /symlink/.test(err1), `symlink-traversing proposal path rejected (${err1})`);
  ok(!fs.existsSync(path.join(evil, 'escape.txt')), 'nothing was written outside the project');

  fs.writeFileSync(path.join(dir, 'real.txt'), 'real');
  fs.symlinkSync(path.join(evil, 'victim.txt'), path.join(dir, 'alias.txt'));
  const err2 = applyProposal(dir, { files: [{ path: 'alias.txt', content: 'evil' }] });
  ok(!!err2 && /symlink/.test(err2), 'symlinked destination rejected (would be replaced, not followed)');

  const okWrite = applyProposal(dir, { files: [{ path: 'real.txt', content: 'updated' }] });
  ok(okWrite === null && fs.readFileSync(path.join(dir, 'real.txt'), 'utf8') === 'updated', 'normal writes still work (atomic replace)');

  const err3 = applyProposal(dir, { files: [{ path: '../outside.txt', content: 'x' }] });
  ok(!!err3 && /unsafe path/.test(err3), 'plain traversal still rejected');
}

// 6 — dry-run + lint-rules -----------------------------------------------------
section('tship dry-run / lint-rules (read-only calibration)');
{
  const dir = makeProject('dryrun');
  tship(dir, ['init']);
  applyCaseStudyConfig(dir);
  const dry = tship(dir, ['dry-run']);
  ok(/verdict:\s+SHIP/.test(dry), 'dry-run evaluates the current tree (SHIP on untouched fixture)');
  ok(!fs.existsSync(path.join(dir, '.tasteeship', 'state.json')), 'dry-run does not create run state');
  let lint = '';
  try {
    lint = tship(dir, ['lint-rules']);
  } catch (err) {
    lint = childOutput(err); // warnings exit non-zero by design
  }
  ok(/\[ok\]/.test(lint), 'lint-rules reports calibrated entries');
  ok(/WARN.*Comic Sans.*already present|WARN.*marquee.*already present/.test(lint), 'lint-rules flags baseline-present forbidden strings as tolerated gaps');
}

done('smoke');
