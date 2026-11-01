import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';

// Keys are the user's, injected as context — never shipped with the harness and
// never committed. They live in <project>/.env.local (chmod 600, gitignored).

export function envLocalPath(root) {
  return path.join(root, '.env.local');
}

export function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  }
  const needed = ['.env.local', '.tasteeship/'];
  const missing = needed.filter((n) => !lines.some((l) => l.trim() === n));
  if (missing.length) {
    fs.writeFileSync(file, [...lines, ...missing].join('\n').replace(/\n*$/, '\n'));
    return missing;
  }
  return [];
}

export function assertNotTracked(root) {
  const rel = path.relative(root, envLocalPath(root));
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: root, stdio: 'pipe' });
    throw new Error(
      `${rel} is tracked by git — remove it from the index (\`git rm --cached ${rel}\`) before storing keys`
    );
  } catch (err) {
    if (err.message.startsWith(rel) || err.message.includes('tracked by git')) throw err;
    // not tracked — good
  }
}

export async function addKey(root, provider, value) {
  if (!value) value = await promptHidden(`Paste ${provider} key (hidden): `);
  if (!value) throw new Error('empty key — aborted');
  const file = envLocalPath(root);
  const lines = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${providerEnvName(provider)}=`))
    : [];
  lines.push(`${providerEnvName(provider)}=${value.trim()}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const gitignored = ensureGitignore(root);
  assertNotTracked(root);
  return { file, provider: providerEnvName(provider), gitignored };
}

export function providerEnvName(provider) {
  return `${provider.toUpperCase()}_API_KEY`;
}

export function removeKey(root, provider) {
  const file = envLocalPath(root);
  if (!fs.existsSync(file)) return false;
  const name = providerEnvName(provider);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${name}=`));
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return true;
}

export function listKeys(root) {
  const file = envLocalPath(root);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const [name, value] = l.split('=', 2);
      return { name, preview: value ? `${value.slice(0, 7)}…${value.slice(-4)}` : '(empty)' };
    });
}

export function loadKeys(root) {
  const file = envLocalPath(root);
  const keys = {};
  if (!fs.existsSync(file)) return keys;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) keys[m[1]] = m[2].trim();
  }
  return keys;
}

async function promptHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const chars = [];
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // piped input (e.g. `tship keys add anthropic < file`)
      let buf = '';
      stdin.on('data', (d) => (buf += d));
      stdin.on('end', () => resolve(buf.trim()));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (ch) => {
      const c = ch.toString();
      if (c === '\r' || c === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(chars.join('').trim());
      } else if (c === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (c === '\u007f') {
        chars.pop();
      } else {
        chars.push(c);
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}
