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
    rounds: [], // { round, attempts, shipped, loc, locDelta, tokens, usd, usage, verdict, notes }
    milestones: [],
    gateEvents: [], // trimmed mirror of events.jsonl (flat legacy shape + ts)
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

// Canonical event emitter (Area 3 schema): { ts, run, round, type, message,
// payload, causalityId }. events.jsonl is the authoritative, unbounded log;
// state.gateEvents keeps a trimmed flat mirror for the live dashboard.
export function emit(root, state, { type, round = null, message = '', payload = null, causalityId = null }) {
  const e = {
    ts: new Date().toISOString(),
    run: state.run?.id ?? null,
    round,
    type,
    message,
    payload,
    causalityId,
  };
  appendEvent(root, e);
  state.gateEvents.push({ ts: e.ts, type, round, message });
  if (state.gateEvents.length > 500) state.gateEvents = state.gateEvents.slice(-500);
  return e;
}

// Legacy-shaped helper kept for all existing call sites; now carries an
// optional structured payload and a timestamp in the in-memory mirror too.
export function gateEvent(root, state, type, round, message, payload = null) {
  return emit(root, state, { type, round, message, payload });
}

// Full historical read: events.jsonl is append-only and unbounded — the
// dashboard's audit log reads from here, not from the capped in-memory array.
export function readEvents(root, n = Infinity) {
  const file = eventsPath(root);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines
    .slice(-n)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { ts: null, type: 'corrupt', message: l.slice(0, 200) };
      }
    });
}

export function tailEvents(root, n = 100) {
  return readEvents(root, n);
}
