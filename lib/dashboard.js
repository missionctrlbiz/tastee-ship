import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessPath, stopFilePath } from './config.js';
import { loadState, tailEvents } from './state.js';
import { stopRun } from './runner.js';
import { gateSummary } from './gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local, single-user dashboard. Serves the static UI plus a JSON API over the
// harness state of any project directory under the working root. The kill
// button POSTs to /api/kill, which takes the exact same code path as
// `tship stop` — out-of-band, model-unreachable.

export function startDashboard(root, flags = {}) {
  const port = Number(flags.port || 4777);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const project = resolveProject(root, url.searchParams.get('project') || '.');
    try {
      if (req.method === 'GET') handleGet(req, res, url, root, project, port);
      else if (req.method === 'POST' && url.pathname === '/api/kill') handleKill(req, res, project);
      else notFound(res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  server.listen(port, () => {
    console.log(`tship dashboard: http://localhost:${port}  (project root: ${root})`);
    console.log('open a project with ?project=<relative/path> — the kill button goes through the same code path as `tship stop`.');
  });
  return server;
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

function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function handleGet(req, res, url, root, project, port) {
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
    case '/api/events': return json(res, tailEvents(project, 300));
    case '/api/snapshots': {
      const dir = path.join(project, '.tasteeship', 'snapshots');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort() : [];
      return json(res, files);
    }
    case '/api/snapshot': {
      const name = path.basename(url.searchParams.get('name') || '');
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
    case '/api/stream': return stream(req, res, project);
    default: return notFound(res);
  }
}

// GET /api/pf/<encoded-project>/<file/path> — serves any file inside that
// project root (traversal-guarded) so scrubber snapshots render with their
// real css/js/images.
function serveProjectFile(res, root, pathname) {
  try {
    const m = pathname.match(/^\/api\/pf\/([^/]+)\/(.*)$/);
    if (!m) return notFound(res);
    const project = resolveProject(root, decodeURIComponent(m[1]));
    const rel = decodeURIComponent(m[2]);
    if (!rel) return notFound(res);
    const abs = path.resolve(project, rel);
    if (abs !== project && !abs.startsWith(project + path.sep)) return notFound(res);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return notFound(res);
    const types = {
      '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
      '.webmanifest': 'application/manifest+json', '.json': 'application/json',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2',
    };
    const type = types[path.extname(abs).toLowerCase()] || 'application/octet-stream';
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
