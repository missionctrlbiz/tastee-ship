import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, readEvents } from './state.js';
import { stopRun } from './runner.js';
import { gateSummary } from './gate.js';
import { readManifest } from './manifest.js';
import { diffStat, diffPatch } from './gitops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local, single-user dashboard. Security boundary (CODEX review, Area 1 P0):
//   - bound to loopback by default
//   - POST /api/kill requires a matching loopback Origin — generated page
//     content (the preview iframe) cannot reach the kill endpoint even if it
//     breaks out of its sandbox
//   - /api/snapshot serves only the harness's own snapshot filenames
//   - /api/pf (project files for preview assets) refuses secrets and
//     harness-private directories (.env.local, .git, .tasteeship, node_modules,
//     dotted files)
//   - /api/snapshot-diff derives every Git reference from recorded state,
//     never from browser-supplied refs
// The preview iframe itself is sandboxed in dashboard/index.html without
// allow-same-origin.

export function startDashboard(root, flags = {}) {
  const port = Number(flags.port || 4777);
  const bind = flags.bind || '127.0.0.1';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let project;
    try {
      project = resolveProject(root, url.searchParams.get('project') || '.');
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
    try {
      if (req.method === 'GET') handleGet(req, res, url, root, project);
      else if (req.method === 'POST' && url.pathname === '/api/kill') {
        if (!isAllowedDashboardOrigin(req, port)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'forbidden: kill endpoint requires a same-origin request' }));
        }
        return handleKill(req, res, project);
      } else notFound(res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  server.listen(port, bind, () => {
    const display = bind === '0.0.0.0' ? 'localhost' : bind;
    console.log(`tship dashboard: http://${display}:${port}  (project root: ${root}, bound to ${bind})`);
    console.log('open a project with ?project=<relative/path> — the kill button goes through the same code path as `tship stop`.');
  });
  return server;
}

function isAllowedDashboardOrigin(req, port) {
  const origin = req.headers.origin;
  if (!origin) return false; // browser-originated POSTs always carry Origin
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function resolveProject(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('project escapes root');
  return p;
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function json(res, obj, headers = {}) {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
}

function handleGet(req, res, url, root, project) {
  const pathname = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  if (pathname === '/api/pf' || pathname.startsWith('/api/pf/')) {
    return serveProjectFile(res, root, pathname);
  }
  switch (pathname) {
    case '/': return serveStatic(res, 'index.html', 'text/html');
    case '/app.js': return serveStatic(res, 'app.js', 'text/javascript');
    case '/style.css': return serveStatic(res, 'style.css', 'text/css');
    case '/api/state': {
      const state = loadState(project);
      return json(res, state ? { ...state, gate: gateSummary(state) } : { status: 'idle', gate: { status: 'idle', label: 'IDLE' } });
    }
    case '/api/events': {
      // The authoritative, unbounded log — not the capped in-memory mirror.
      const n = Math.min(Math.max(Number(url.searchParams.get('n')) || 2000, 1), 50000);
      return json(res, readEvents(project, n));
    }
    case '/api/snapshots': {
      const dir = path.join(project, '.tasteeship', 'snapshots');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^round-\d{3}\.html$/.test(f)).sort() : [];
      return json(res, files);
    }
    case '/api/snapshot': {
      const name = path.basename(url.searchParams.get('name') || '');
      if (!/^round-\d{3}\.html$/.test(name)) return notFound(res); // harness-owned filenames only
      const file = path.join(project, '.tasteeship', 'snapshots', name);
      if (!fs.existsSync(file)) return notFound(res);
      let html = fs.readFileSync(file, 'utf8');
      // make relative assets (css/js/images) resolve against the project root:
      // base is a plain path prefix so relative refs compose onto it
      const pfBase = `/api/pf/${encodeURIComponent(url.searchParams.get('project') || '.')}/`;
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head([^>]*)>/i, `<head$1>\n  <base href="${pfBase}" />`)
        : `<base href="${pfBase}" />\n${html}`;
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end(html);
    }
    case '/api/snapshot-diff': {
      // Round diff from RECORDED state only — no git refs from the browser.
      const state = loadState(project);
      const round = Number(url.searchParams.get('round'));
      if (!state?.run) return json(res, { error: 'no run' });
      const entry = (state.rounds || []).find((r) => r.round === round);
      if (!entry?.commit) return json(res, { error: `round ${round} has no shipped checkpoint` });
      const prev = (state.rounds || [])
        .filter((r) => r.round < round && r.commit)
        .sort((a, b) => b.round - a.round)[0];
      const from = prev?.commit || state.baseline?.commit || `${entry.commit}^`;
      return json(res, {
        round,
        from,
        to: entry.commit,
        stat: diffStat(project, from, entry.commit),
        patch: diffPatch(project, from, entry.commit),
      });
    }
    case '/api/export': {
      const bundle = {
        schema: 1,
        exportedAt: new Date().toISOString(),
        manifest: readManifest(project),
        state: loadState(project),
        events: readEvents(project, 50000),
      };
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="tship-export-${path.basename(project)}.json"`,
      });
      return res.end(JSON.stringify(bundle, null, 2));
    }
    case '/api/stream': return stream(req, res, project);
    default: return notFound(res);
  }
}

// GET /api/pf/<encoded-project>/<file/path> — serves any file inside that
// project root (traversal-guarded) so scrubber snapshots render with their
// real css/js/images. Hardened: no secrets, no git/harness internals.
const PF_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const PF_DENIED_DIRS = new Set(['.git', '.tasteeship', 'node_modules', '.env.local']);

function projectFileDenied(rel) {
  const parts = rel.split(path.sep);
  if (parts.some((p) => PF_DENIED_DIRS.has(p) || PF_DENIED_DIRS.has(p.toLowerCase()))) return true;
  if (parts.some((p) => p.startsWith('.') && p !== '.well-known')) return true; // .env.local, .npmrc, …
  return false;
}

function serveProjectFile(res, root, pathname) {
  try {
    const m = pathname.match(/^\/api\/pf\/([^/]+)\/(.*)$/);
    if (!m) return notFound(res);
    const project = resolveProject(root, decodeURIComponent(m[1]));
    const rel = decodeURIComponent(m[2]);
    if (!rel) return notFound(res);
    const abs = path.resolve(project, rel);
    if (abs !== project && !abs.startsWith(project + path.sep)) return notFound(res);
    if (projectFileDenied(path.relative(project, abs))) return notFound(res);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return notFound(res);
    const type = PF_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(abs));
  } catch {
    return notFound(res);
  }
}

function serveStatic(res, name, type) {
  const file = path.join(__dirname, '..', 'dashboard', name);
  res.writeHead(200, { 'content-type': type });
  res.end(fs.readFileSync(file));
}

function handleKill(req, res, project) {
  // Same code path as the CLI: write the stop flag, signal the runner pid.
  stopRun(project);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, killed: true }));
}

function stream(req, res, project) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: {}\n\n`);
  let last = null;
  const send = () => {
    const state = loadState(project);
    if (!state) return;
    const payload = JSON.stringify({ ...state, gate: gateSummary(state) });
    if (payload !== last) {
      last = payload;
      res.write(`event: state\ndata: ${payload}\n\n`);
    }
  };
  send();
  const timer = setInterval(send, 1000);
  req.on('close', () => clearInterval(timer));
}
