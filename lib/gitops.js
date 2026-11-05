import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

export function isRepo(root) {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

export function ensureRepo(root) {
  if (!isRepo(root)) {
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'harness@tasteeship.local']);
    git(root, ['config', 'user.name', 'tasteeship harness']);
  }
}

export function head(root) {
  try {
    return git(root, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

export function isClean(root) {
  try {
    return git(root, ['status', '--porcelain']).length === 0;
  } catch {
    return false;
  }
}

export function commitAll(root, message) {
  // Mutable harness state is never tracked: checkpoints carry the repo, not
  // our bookkeeping (state.json/events/incidents/pid would re-dirty every
  // round and trip the resume guard).
  git(root, ['add', '-A']);
  if (git(root, ['status', '--porcelain']).length === 0) return head(root);
  git(root, ['commit', '-q', '-m', message]);
  return head(root);
}

// One-time per repo: keep mutable harness state out of both status and
// porcelain for repos the harness created or adopted mid-flight.
export function excludeHarnessState(root) {
  const excl = path.join(root, '.git', 'info', 'exclude');
  let lines = [];
  try { lines = fs.readFileSync(excl, 'utf8').split('\n'); } catch { lines = []; }
  const needed = ['.tasteeship/', '.env.local'].filter((n) => !lines.includes(n));
  if (!needed.length) return;
  fs.mkdirSync(path.dirname(excl), { recursive: true });
  fs.writeFileSync(excl, lines.concat(needed).join('\n').replace(/\n*$/, '\n'));
  try { git(root, ['rm', '-r', '--cached', '--quiet', '.tasteeship']); } catch { /* not tracked yet */ }
  try { git(root, ['rm', '--cached', '--quiet', '.env.local']); } catch { /* not tracked */ }
}

// Idempotent discard of a failed/killed attempt: the harness committed a
// checkpoint before writing anything, so resetting to it is side-effect free
// and safe to repeat (idempotent step semantics).
export function resetHard(root, sha) {
  git(root, ['reset', '--hard', sha]);
  git(root, ['clean', '-fd']);
}

export function checkpointOfRound(root, round) {
  try {
    const line = git(root, ['log', '--oneline', '--all', '--grep', `^tship: round ${round} \\[`]);
    const first = line.split('\n')[0];
    return first ? first.split(' ')[0] : null;
  } catch {
    return null;
  }
}

export function fileAt(root, ref, file) {
  try {
    return git(root, ['show', `${ref}:${file}`]);
  } catch {
    return null;
  }
}

export function saveSnapshot(root, ref, file, round) {
  const content = fileAt(root, ref, file);
  if (content == null) return null;
  const dir = path.join(root, '.tasteeship', 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `round-${String(round).padStart(3, '0')}.html`);
  fs.writeFileSync(dest, content);
  return dest;
}

export function commitLog(root, limit = 200) {
  try {
    return git(root, ['log', '--oneline', `-${limit}`])
      .split('\n')
      .map((l) => {
        const [sha, ...msg] = l.split(' ');
        return { sha, message: msg.join(' ') };
      });
  } catch {
    return [];
  }
}

// Read-only diff stat between two commits: [{ file, additions, deletions }]
export function diffStat(root, fromSha, toSha) {
  const out = git(root, ['diff', '--numstat', fromSha, toSha]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, ...rest] = line.split('\t');
      return {
        file: rest.join('\t'),
        additions: additions === '-' ? null : Number(additions),
        deletions: deletions === '-' ? null : Number(deletions),
      };
    });
}

// Bounded unified patch (for the diff drawer); truncates with a marker.
export function diffPatch(root, fromSha, toSha, maxBytes = 16384) {
  let patch = git(root, ['diff', '--no-color', fromSha, toSha]);
  if (patch.length > maxBytes) patch = patch.slice(0, maxBytes) + '\n… (patch truncated by harness)';
  return patch;
}
