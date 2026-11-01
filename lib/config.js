import fs from 'node:fs';
import path from 'node:path';

export const HARNESS_DIR = '.tasteeship';

export function harnessPath(root, ...parts) {
  return path.join(root, HARNESS_DIR, ...parts);
}

export function statePath(root) {
  return harnessPath(root, 'state.json');
}

export function eventsPath(root) {
  return harnessPath(root, 'events.jsonl');
}

export function stopFilePath(root) {
  return harnessPath(root, 'stop');
}

export function snapshotsDir(root) {
  return harnessPath(root, 'snapshots');
}

export function defaultConfig(framework) {
  return {
    version: 1,
    framework,
    repo: { path: '.', url: null },
    entry: 'index.html',
    provider: { name: 'mock', model: 'mock-sonnet' },
    runner: { roundsMax: 50, outputsMax: 4 },
    taste: { rulesFile: 'rules.md' },
    // Verification layer (runs in Node, never in the model): each failure kind maps
    // to a gate halt reason — regression / overbuild / protocol.
    verify: {
      requiredSelectors: ['nav', 'footer'],
      criticalSelectors: [],
      forbiddenStrings: [],
      locCap: 4000,
      locDeltaCap: 350,
      maxFiles: 80,
    },
    costs: {
      // USD per million tokens, { in, out }. Overridable per project.
      'mock-sonnet': { in: 3, out: 15 },
      'mock-opus': { in: 15, out: 75 },
      'claude-sonnet-5-5': { in: 3, out: 15 },
      'claude-opus-5-5': { in: 15, out: 75 },
      // User's own models (estimates at GLM-4.5-era z.ai rates — edit freely).
      'GLM-5.3': { in: 0.6, out: 2.2 },
      'GLM-5.3-Flash': { in: 0.15, out: 0.55 },
    },
  };
}

export function loadConfig(root) {
  const file = harnessPath(root, 'config.json');
  if (!fs.existsSync(file)) {
    throw new Error(`no harness config at ${file} — run \`tship init\` first`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveConfig(root, cfg) {
  fs.mkdirSync(harnessPath(root), { recursive: true });
  fs.writeFileSync(harnessPath(root, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

export function projectRootFrom(dir) {
  return path.resolve(dir || '.');
}
