import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProject, tship, readState, ok, done, section, CLI, REPO } from './helpers.js';

// FULL test on the user's OWN models (their own keys, their own plans).
//
//   light "sonnet" analog:  RIVER  zai-org/GLM-5.3-Flash
//   heavy "opus" analog:    IFM    IFM/K2-Horizon-375B-A23B (375B MoE)
//
// Keys are read from the host's ZCode provider config and injected into each
// temp project's .env.local — exactly the `tship keys add` path. They are
// never printed, never committed, and the temp projects live in /tmp.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT_DIR = path.join(REPO, 'docs', 'evidence');
fs.mkdirSync(OUT_DIR, { recursive: true });

const log = [];
const origLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.join(' ');
  log.push(line);
  origLog(line);
};

const hostCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json'), 'utf8'));
const hostRules = hostCfg.config?.providerConfigRules?.providerRules || [];

function hostKey(providerName) {
  const rule = hostRules.find((r) => (r.providerName || '').toLowerCase() === providerName.toLowerCase());
  return rule?.config?.access?.apiKey || null;
}

const MODELS = {
  light: {
    label: 'glm-5.3-flash',
    role: 'light (sonnet-slot)',
    baseUrl: 'https://api.river.ai/v1',
    model: 'zai-org/GLM-5.3-Flash',
    keyEnv: 'RIVER_API_KEY',
    keyProvider: 'RIVER',
    extraBody: { thinking: { type: 'disabled' } }, // z.ai-style param, passed through by RIVER
    cost: { in: 0.15, out: 0.55 }, // placeholder estimate — plan-included for the owner
  },
  heavy: {
    label: 'k2-horizon-375b',
    role: 'heavy (opus-slot)',
    baseUrl: 'https://api.ifm.ai/v1',
    model: 'IFM/K2-Horizon-375B-A23B',
    keyEnv: 'IFM_API_KEY',
    keyProvider: 'IFM',
    extraBody: {},
    cost: { in: 1.0, out: 5.0 }, // placeholder estimate — plan-included for the owner
  },
};

function setupProject(name, spec) {
  const dir = makeProject(name);
  tship(dir, ['init']);
  const cfgFile = path.join(dir, '.tasteeship', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.provider = { name: 'openai-compat', model: spec.model, baseUrl: spec.baseUrl, apiKeyEnv: spec.keyEnv, timeoutMs: 300000, extraBody: spec.extraBody || {} };
  cfg.verify.locCap = 8000;
  cfg.verify.locDeltaCap = 600;
  cfg.costs[spec.model] = spec.cost;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  // key injection — same effect as `tship keys add`, never printed
  const key = hostKey(spec.keyProvider);
  if (!key) throw new Error(`no ${spec.keyProvider} key in host config`);
  const envFile = path.join(dir, '.env.local');
  fs.writeFileSync(envFile, `${spec.keyEnv}=${key}\n`, { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  console.log(`[${spec.label}] project ready at ${dir} (key injected: ${spec.keyEnv}, ${(mode(envFile))})`);
  return dir;
}

function mode(file) {
  return `chmod ${(fs.statSync(file).mode & 0o777).toString(8)}`;
}

function runModel(dir, label, rounds = 50) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, 'run', '--rounds', String(rounds), '--outputs-max', '4'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    let lastRound = -1;
    const timer = setInterval(() => {
      try {
        const s = readState(dir);
        if (s.run && s.run.roundIndex !== lastRound) {
          lastRound = s.run.roundIndex;
          const last = s.rounds.at(-1);
          console.log(`[${label}] round ${lastRound}/${rounds} · loc ${last?.loc} · attempts ${last?.attempts} · verdict ${last?.verdict} · calls ${s.usage.calls}`);
        }
      } catch {
        /* not written yet */
      }
    }, 4000);
    child.on('exit', (code) => {
      clearInterval(timer);
      if (out.trim()) console.log(`[${label}] runner output: ${out.trim().slice(0, 400)}`);
      resolve(code);
    });
  });
}

const results = {};

console.log('tasteeship — FULL case-study test on the user\'s own AI models');
console.log('light:', MODELS.light.model, '@', MODELS.light.baseUrl);
console.log('heavy:', MODELS.heavy.model, '@', MODELS.heavy.baseUrl);
console.log('');

// ---- parallel: light 50 rounds + heavy 50 rounds ----------------------------
section('phase 1 — 50 rounds each, gate = halt, outputs_max 4 (real models)');
const lightDir = setupProject('live-light', MODELS.light);
const heavyDir = setupProject('live-heavy', MODELS.heavy);

const t0 = Date.now();
const [lightCode, heavyCode] = await Promise.all([
  runModel(lightDir, MODELS.light.label),
  runModel(heavyDir, MODELS.heavy.label),
]);
console.log(`phase 1 finished in ${Math.round((Date.now() - t0) / 1000)}s (exit codes: light ${lightCode}, heavy ${heavyCode})`);

for (const [k, dir] of [['light', lightDir], ['heavy', heavyDir]]) {
  const s = readState(dir);
  results[k] = s;
  fs.writeFileSync(path.join(OUT_DIR, `live-${MODELS[k].label}-state.json`), JSON.stringify(s, null, 2) + '\n');
}

// ---- assertions --------------------------------------------------------------
section('results — light (glm-5.3-flash)');
{
  const s = results.light;
  const spec = MODELS.light;
  ok(s.usage.calls >= 20, `meaningful run: ${s.usage.calls} agent calls, ${s.usage.inputTokens} in / ${s.usage.outputTokens} out tokens`);
  ok(s.run.roundIndex >= 25, `rounds shipped: ${s.run.roundIndex}/50 (status ${s.status}${s.haltReason ? `, halt: ${s.haltReason}` : ''})`);
  ok(s.milestones.length >= 2, `milestones fired: ${s.milestones.map((m) => `${m.id}@${m.round}`).join(', ') || 'none'}`);
  ok(s.usage.usd >= 0, `estimated spend: $${s.usage.usd.toFixed(4)} (placeholder rates — plan-included for owner)`);
  ok(fs.existsSync(path.join(lightDir, '.env.local')), 'key lived in .env.local (never committed)');
  const tracked = execFileSync('git', ['ls-files'], { cwd: lightDir, encoding: 'utf8' });
  ok(!tracked.includes('.env.local'), '.env.local not tracked by git');
  const gateEvents = s.gateEvents.filter((e) => ['attempt-rejected', 'halt', 'overbuild-flag'].includes(e.type));
  console.log(`  gate activity: ${gateEvents.length} enforcement events`);
  for (const e of gateEvents.slice(0, 8)) console.log(`   · [${e.type}] r${e.round} ${(e.message || '').slice(0, 100)}`);
}

section('results — heavy (k2-horizon-375b)');
{
  const s = results.heavy;
  ok(s.usage.calls >= 10, `meaningful run: ${s.usage.calls} agent calls, ${s.usage.inputTokens} in / ${s.usage.outputTokens} out tokens`);
  ok(s.run.roundIndex >= 10, `rounds shipped: ${s.run.roundIndex}/50 (status ${s.status}${s.haltReason ? `, halt: ${s.haltReason}` : ''})`);
  ok(s.usage.usd >= 0, `estimated spend: $${s.usage.usd.toFixed(4)} (placeholder rates — plan-included for owner)`);
  const gateEvents = s.gateEvents.filter((e) => ['attempt-rejected', 'halt', 'overbuild-flag'].includes(e.type));
  console.log(`  gate activity: ${gateEvents.length} enforcement events`);
  for (const e of gateEvents.slice(0, 10)) console.log(`   · [${e.type}] r${e.round} ${(e.message || '').slice(0, 100)}`);
  console.log(`  final: ${s.rounds.at(-1)?.loc ?? '—'} LOC · milestones: ${s.milestones.map((m) => `${m.id}@${m.round}`).join(', ') || '—'}`);
}

// ---- phase 2: kill-switch drill on the live light model ----------------------
section('phase 2 — kill-switch drill on the live glm-5.3-flash run');
{
  const dir = setupProject('live-kill', MODELS.light);
  const child = spawn('node', [CLI, 'run', '--rounds', '50', '--outputs-max', '4'], { cwd: dir, stdio: 'ignore' });
  let state = null;
  for (let i = 0; i < 600; i++) {
    await sleep(2000);
    try {
      state = readState(dir);
      if (state.run?.roundIndex >= 10 && state.status === 'running') break;
    } catch {
      /* not written yet */
    }
  }
  const killedDuring = state?.run?.roundIndex + 1;
  ok(!!state && state.run.roundIndex >= 10, `live run reached round ${state?.run?.roundIndex} before the kill`);
  tship(dir, ['stop']);
  await new Promise((resolve) => child.on('exit', resolve));
  state = readState(dir);
  const callsAtKill = state.usage.calls;
  ok(state.status === 'killed' && state.haltReason === 'user-rejection', `killed at round ${killedDuring}: ${state.status}/${state.haltReason}`);
  ok(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim() === state.run.lastGoodCommit,
    `repo rolled back to checkpoint ${state.run.lastGoodCommit?.slice(0, 8)}`
  );
  fs.writeFileSync(path.join(OUT_DIR, 'live-kill-drill-state.json'), JSON.stringify(state, null, 2) + '\n');

  tship(dir, ['resume', '--acknowledge', '--force']);
  state = readState(dir);
  fs.writeFileSync(path.join(OUT_DIR, 'live-kill-resumed-state.json'), JSON.stringify(state, null, 2) + '\n');
  ok(state.run.roundIndex > 0 && ['completed', 'halted'].includes(state.status), `resumed from checkpoint → ${state.status} at round ${state.run.roundIndex}/50`);
  ok(state.usage.calls > callsAtKill, `usage accumulated across the kill: ${callsAtKill} → ${state.usage.calls} calls`);
}

// ---- summary -------------------------------------------------------------------
const summary = {
  generatedAt: new Date().toISOString(),
  kind: 'live models (user-owned keys)',
  light: {
    model: MODELS.light.model, provider: MODELS.light.baseUrl,
    status: results.light.status, haltReason: results.light.haltReason,
    rounds: results.light.run.roundIndex, calls: results.light.usage.calls,
    inputTokens: results.light.usage.inputTokens, outputTokens: results.light.usage.outputTokens,
    usdEstimate: +results.light.usage.usd.toFixed(4),
    finalLoc: results.light.rounds.at(-1)?.loc,
    milestones: results.light.milestones,
  },
  heavy: {
    model: MODELS.heavy.model, provider: MODELS.heavy.baseUrl,
    status: results.heavy.status, haltReason: results.heavy.haltReason,
    rounds: results.heavy.run.roundIndex, calls: results.heavy.usage.calls,
    inputTokens: results.heavy.usage.inputTokens, outputTokens: results.heavy.usage.outputTokens,
    usdEstimate: +results.heavy.usage.usd.toFixed(4),
    finalLoc: results.heavy.rounds.at(-1)?.loc,
    milestones: results.heavy.milestones,
  },
};
fs.writeFileSync(path.join(OUT_DIR, 'live-summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'live-output.txt'), log.join('\n') + '\n');
console.log('\nlive evidence written to docs/evidence/live-*.json');

done('live validation');
