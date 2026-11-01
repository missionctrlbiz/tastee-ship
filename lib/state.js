import fs from 'node:fs';
import path from 'node:path';
import { statePath, eventsPath } from './config.js';

export function freshState(root, cfg) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    project: path.basename(path.resolve(root)),
    status: 'idle', // idle | running | halted | killed | completed
    haltReason: null, // outputs-max | regression | overbuild | user-rejection | crash
    run: null,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
    rounds: [], // { round, attempts, shipped, loc, locDelta, tokens, usd, verdict, notes }
    milestones: [],
    gateEvents: [], // { ts, round, type, message }
    latched: { checks: {}, forbiddenAbsent: {} },
    baseline: null,
  };
}

export function loadState(root) {
  const file = statePath(root);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveState(root, state) {
  state.updatedAt = new Date().toISOString();
  const file = statePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file); // atomic — a crash mid-write can't corrupt the checkpoint
}

export function appendEvent(root, event) {
  const file = eventsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

export function tailEvents(root, n = 100) {
  const file = eventsPath(root);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  return lines.slice(-n).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { ts: null, type: 'corrupt', message: l };
    }
  });
}

export function gateEvent(root, state, type, round, message) {
  const e = { type, round, message };
  state.gateEvents.push(e);
  if (state.gateEvents.length > 500) state.gateEvents = state.gateEvents.slice(-500);
  appendEvent(root, e);
}
