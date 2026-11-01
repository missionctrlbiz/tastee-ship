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
  switch (url.pathname) {
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
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(fs.readFileSync(file));
    }
    case '/api/stream': return stream(req, res, project);
    default: return notFound(res);
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
