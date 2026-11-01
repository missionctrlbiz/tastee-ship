import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { harnessPath } from './config.js';
import { head, isRepo } from './gitops.js';

// Per-run manifest (Area 3, P0): the exact rules, limits, provider identity,
// repository checkpoint, and runtime a run executed under. Never contains
// credentials — keys live in .env.local and are never hashed or copied here.

function sha256File(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export function manifestPath(root) {
  return harnessPath(root, 'manifest.json');
}

export function writeManifest(root, cfg, state, target, { originalHead, baselineCheckpoint }) {
  const manifest = {
    schema: 1,
    run: state.run?.id ?? null,
    startedAt: state.run?.startedAt ?? new Date().toISOString(),
    gitHead: originalHead ?? (isRepo(target) ? head(target) : null),
    baselineCheckpoint: baselineCheckpoint ?? null,
    rulesSha256: sha256File(path.resolve(root, cfg.taste?.rulesFile || 'rules.md')),
    configSha256: sha256File(harnessPath(root, 'config.json')),
    provider: `${cfg.provider.name}/${cfg.provider.model}`,
    providerBaseUrl: cfg.provider.baseUrl ?? null,
    caps: {
      outputsMax: cfg.runner.outputsMax,
      roundsMax: cfg.runner.roundsMax,
      locCap: cfg.verify.locCap ?? null,
      locDeltaCap: cfg.verify.locDeltaCap ?? null,
      maxFiles: cfg.verify.maxFiles ?? null,
      overbuildAction: state.run?.overbuildAction ?? cfg.overbuildAction ?? 'halt',
    },
    node: process.version,
  };
  fs.writeFileSync(manifestPath(root), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// On resume the ORIGINAL manifest is authoritative — record the resume, don't
// replace the recorded configuration (Area 3: "preserve the original manifest").
export function stampResume(root) {
  const file = manifestPath(root);
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.resumedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function readManifest(root) {
  const file = manifestPath(root);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
