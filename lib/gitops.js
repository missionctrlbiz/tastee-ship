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
  git(root, ['add', '-A']);
  if (git(root, ['status', '--porcelain']).length === 0) return head(root);
  git(root, ['commit', '-q', '-m', message]);
  return head(root);
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
