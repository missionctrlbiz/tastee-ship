import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProject, tship, readState, applyCaseStudyConfig, ok, done, section, CLI, REPO } from './helpers.js';
import { readEvents } from '../lib/state.js';

// Standalone live kill-switch drill: run the light model, kill it mid-flight
// out-of-band, verify the rollback, then resume from the checkpoint to
// completion. Evidence → docs/evidence/live-kill-drill*.json
const MODELS = {
  light: {
    label: 'deepseek-1017',
    baseUrl: 'https://api.river.ai/v1',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    keyEnv: 'RIVER_API_KEY',
    keyProvider: 'RIVER',
    extraBody: {},
    cost: { in: 0.3, out: 1.2 },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT_DIR = path.join(REPO, 'docs', 'evidence');
fs.mkdirSync(OUT_DIR, { recursive: true });

const hostCfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
const hostRules = hostCfg.config?.providerConfigRules?.providerRules || [];
const spec = MODELS.light;
const key = hostRules.find((r) => (r.providerName || '').toLowerCase() === spec.keyProvider.toLowerCase())?.config?.access?.apiKey;
if (!key) throw new Error(`no ${spec.keyProvider} key in host config`);

const dir = makeProject('drill');
tship(dir, ['init']);
const cfgFile = path.join(dir, '.tasteeship', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
cfg.provider = { name: 'openai-compat', model: spec.model, baseUrl: spec.baseUrl, apiKeyEnv: spec.keyEnv, timeoutMs: 300000, extraBody: spec.extraBody || {} };
cfg.verify.locCap = 8000;
cfg.verify.locDeltaCap = 600;
cfg.costs[spec.model] = spec.cost;
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
fs.writeFileSync(path.join(dir, '.env.local'), `${spec.keyEnv}=${key}\n`, { mode: 0o600 });
fs.chmodSync(path.join(dir, '.env.local'), 0o600);
console.log(`[drill] project ready: ${dir}`);

const child = spawn('node', [CLI, 'run', '--rounds', '50', '--outputs-max', '4'], { cwd: dir, stdio: 'ignore' });
let state = null;
for (let i = 0; i < 900; i++) {
  await sleep(2000);
  try {
    state = readState(dir);
    if (state.run?.roundIndex >= 8 && state.status === 'running') break;
  } catch {
    /* not written yet */
  }
}
const killedDuring = state?.run?.roundIndex + 1;
ok(!!state && state.run.roundIndex >= 8, `live run reached round ${state?.run?.roundIndex} before the kill`);
const callsAtKillPrep = state.usage.calls;

tship(dir, ['stop']);
const exitCode = await new Promise((resolve) => child.on('exit', resolve));
state = readState(dir);
const callsAtKill = state.usage.calls;
const usdAtKill = state.usage.usd;

ok(exitCode === 0, `runner exited cleanly (code ${exitCode})`);
ok(state.status === 'killed' && state.haltReason === 'user-rejection', `killed at round ${killedDuring}: ${state.status}/${state.haltReason}`);
ok(
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim() === state.run.lastGoodCommit,
  `repo rolled back to the last good checkpoint ${state.run.lastGoodCommit?.slice(0, 8)}`
);
ok(
  execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).length === 0,
  'working tree clean — in-flight attempt discarded'
);
const killEvents = readEvents(dir).filter((e) => e.type === 'killed' || e.type === 'halt');
ok(killEvents.some((e) => e.type === 'killed'), 'killed event in the append-only log');
fs.writeFileSync(path.join(OUT_DIR, 'live-kill-drill-state.json'), JSON.stringify(state, null, 2) + '\n');

tship(dir, ['resume', '--acknowledge', '--force']);
state = readState(dir);
fs.writeFileSync(path.join(OUT_DIR, 'live-kill-resumed-state.json'), JSON.stringify(state, null, 2) + '\n');
ok(state.run.roundIndex > 0 && ['completed', 'halted'].includes(state.status), `resumed from checkpoint → ${state.status} at round ${state.run.roundIndex}/50`);
ok(state.usage.calls > callsAtKill && state.usage.usd > usdAtKill, `usage accumulated across the kill (${callsAtKill} → ${state.usage.calls} calls)`);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.tasteeship', 'manifest.json'), 'utf8'));
ok(manifest.run === state.run.id && !!manifest.resumedAt, 'manifest preserved through resume with resumedAt');
console.log(`[drill] final: ${state.run.roundIndex}/50 rounds, ${state.usage.calls} calls, $${state.usage.usd.toFixed(4)}`);

done('live kill drill');
