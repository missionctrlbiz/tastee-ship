import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tship, readState, ok, done, section, REPO } from './helpers.js';
import { readEvents } from '../lib/state.js';

// Resume half of the live kill drill: continues the already-killed drill run
// (docs/evidence/live-kill-drill-state.json) from its checkpoint to completion.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT_DIR = path.join(REPO, 'docs', 'evidence');
const dir = fs.readFileSync('/tmp/tship-drill-dir.txt', 'utf8').trim();

section('live kill drill — resume from checkpoint');
const before = readState(dir);
const callsAtKill = before.usage.calls;
const usdAtKill = before.usage.usd;
const events = readEvents(dir);
ok(events.some((e) => e.type === 'killed'), 'killed event present in the append-only log');

tship(dir, ['resume', '--acknowledge', '--force']);
const state = readState(dir);
fs.writeFileSync(path.join(OUT_DIR, 'live-kill-resumed-state.json'), JSON.stringify(state, null, 2) + '\n');
ok(state.run.roundIndex > 0 && ['completed', 'halted'].includes(state.status), `resumed from checkpoint → ${state.status} at round ${state.run.roundIndex}/50`);
ok(state.usage.calls > callsAtKill && state.usage.usd > usdAtKill, `usage accumulated across the kill (${callsAtKill} → ${state.usage.calls} calls, $${usdAtKill.toFixed(4)} → $${state.usage.usd.toFixed(4)})`);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.tasteeship', 'manifest.json'), 'utf8'));
ok(manifest.run === state.run.id && !!manifest.resumedAt, 'manifest preserved through resume with resumedAt');
const sumRoundUsd = state.rounds.reduce((a, r) => a + (r.usage?.usd ?? 0), 0);
ok(Math.abs(sumRoundUsd - state.usage.usd) < 1e-6, 'per-round usage reconciles with the global counter');
console.log(`[drill] final: ${state.run.roundIndex}/50 rounds, ${state.usage.calls} calls, $${state.usage.usd.toFixed(4)}`);
done('live kill drill (resume half)');
