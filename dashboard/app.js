/* tasteeship dashboard — vanilla JS, no build step. */

const params = new URLSearchParams(location.search);
const projectInput = document.getElementById('project');
projectInput.value = params.get('project') || '.';

let currentState = null;
let snapshots = [];
let allEvents = [];
let selectedRound = null;

const $ = (id) => document.getElementById(id);

function fmtUsd(usd) {
  if (usd == null) return '—';
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n || 0);
}
function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

async function api(path) {
  const res = await fetch(`${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectInput.value)}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------ presentation ---
// Display-only mappings. They never touch gate decisions, runner state or
// rollback behavior — those live in the Node orchestration layer.

function gatePresentation(g) {
  const status = g?.status || 'idle';
  if (status === 'running') return { label: 'Running', cls: 'gate-chip--running' };
  if (status === 'completed') return { label: 'Completed', cls: 'gate-chip--completed' };
  if (status === 'killed') return { label: 'Stopped by user', cls: 'gate-chip--killed' };
  if (status === 'halted') {
    const reasons = {
      overbuild: 'Halted · overbuild',
      regression: 'Halted · regression',
      'outputs-max': 'Halted · output budget',
      crash: 'Halted · crash',
    };
    return { label: reasons[g.reason] || `Halted · ${g.reason || 'unknown'}`, cls: 'gate-chip--halted' };
  }
  return { label: 'Idle', cls: 'gate-chip--idle' };
}

function verdictPresentation(verdict) {
  const map = {
    shipped: { label: 'Shipped', className: 'status-badge--success', rowClass: 'row--shipped' },
    'shipped-flagged': { label: 'Shipped with flags', className: 'status-badge--warning', rowClass: 'row--flagged' },
    rejected: { label: 'Rejected', className: 'status-badge--danger', rowClass: 'row--rejected' },
  };
  return map[verdict] || { label: String(verdict || 'Unknown'), className: 'status-badge--neutral', rowClass: '' };
}

const EVENT_LABELS = {
  'attempt-rejected': 'Attempt rejected',
  'overbuild-flag': 'Overbuild flagged',
  'protocol-error': 'Provider/protocol error',
  'run-start': 'Run started',
  'run-resume': 'Run resumed',
  'baseline-commit': 'Baseline checkpoint',
  'manual-rollback': 'Manual rollback',
  'milestone': 'Milestone reached',
  'ship': 'Round shipped',
  'halt': 'Gate halted',
  'killed': 'Run stopped',
  'crash': 'Run crashed',
  'completed': 'Run completed',
  'corrupt': 'Unreadable event',
  'check-run': 'Checks ran',
  'gate-verdict': 'Gate verdict',
};

function eventLabel(type) {
  if (EVENT_LABELS[type]) return EVENT_LABELS[type];
  return String(type || 'Unknown event')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function haltReasonLabel(reason) {
  const map = {
    overbuild: 'Overbuild',
    regression: 'Regression',
    'outputs-max': 'Output budget exhausted',
    'user-rejection': 'Stopped by user',
    crash: 'Unexpected crash',
  };
  return map[reason] || eventLabel(reason);
}

function setConnectionStatus(state, label) {
  const el = $('connection-status');
  const text = $('connection-label');
  if (!el || !text) return;
  el.dataset.state = state;
  text.textContent = label;
}

// ---------------------------------------------------------------- render ---

function render(state) {
  currentState = state;
  lastEventAt = Date.now();
  const g = state.gate || { status: 'idle' };
  const chip = $('gate-chip');
  // The chip renders gate truth only — connection health lives in its own
  // indicator, so a lost stream can never masquerade as a verdict.
  const gp = gatePresentation(g);
  chip.textContent = gp.label;
  chip.className = `gate-chip ${gp.cls}`;

  $('st-run').textContent = state.run ? `${state.run.provider}/${state.run.model}` : '—';
  $('st-round').textContent = state.run ? `${state.run.roundIndex}/${state.run.roundsMax}` : '—';
  $('st-outputs').textContent = state.run ? `${state.run.attemptsThisRound}/${state.run.outputsMax}` : '—';
  const frac = state.run && state.run.outputsMax ? Math.min(1, state.run.attemptsThisRound / state.run.outputsMax) : 0;
  const bar = document.querySelector('#gate-bar i');
  bar.style.width = `${frac * 100}%`;
  bar.style.background = frac >= 1 ? 'var(--danger)' : frac >= 0.5 ? 'var(--warning)' : 'var(--success)';
  $('st-loc').textContent = state.rounds?.length ? fmtNum(state.rounds[state.rounds.length - 1].loc) : state.baseline ? fmtNum(state.baseline.loc) : '—';
  $('st-cost').textContent = fmtUsd(state.usage?.usd);
  $('st-calls').textContent = String(state.usage?.calls ?? 0);

  renderMilestones(state.milestones || []);
  renderCharts(state.rounds || [], state);
  renderRounds(state.rounds || []);
  refreshEvents();
}

function renderMilestones(ms) {
  const el = $('milestones');
  el.innerHTML = ms.length
    ? ms.map((m) => `<span class="milestone"><b>r${m.round}</b> ${escapeHtml(m.label || m.id || '')}</span>`).join('')
    : '<span class="empty">No milestones yet</span>';
}

// Round-wide spend: prefer the per-round usage totals (all attempts) and fall
// back to the legacy shipping-attempt-only fields for old runs.
const roundUsd = (r) => r.usage?.usd ?? r.usd;

function renderRounds(rounds) {
  const tb = document.querySelector('#rounds tbody');
  if (!rounds.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="7" class="empty">No rounds yet — shipped rounds will appear here.</td></tr>';
    return;
  }
  tb.innerHTML = rounds
    .map((r) => {
      const p = verdictPresentation(r.verdict);
      return `<tr class="${p.rowClass}${r.round === selectedRound ? ' is-selected' : ''}" data-round="${r.round}" tabindex="0" aria-label="Round ${r.round}, ${p.label}. Select to inspect the diff.">
        <td>${r.round}</td><td>${r.attempts}</td><td>${fmtNum(r.loc)}</td><td>${r.locDelta ?? '—'}</td>
        <td>${fmtUsd(roundUsd(r))}</td>
        <td><span class="status-badge ${p.className}">${escapeHtml(p.label)}${r.flags?.length ? ` · ${r.flags.length} flag${r.flags.length === 1 ? '' : 's'}` : ''}</span></td>
        <td class="sum">${escapeHtml((r.summary || '').slice(0, 90))}${r.flags?.length ? `<br><span class="flag-note">⚑ ${escapeHtml(r.flags.join('; ').slice(0, 90))}</span>` : ''}</td>
      </tr>`;
    })
    .join('');
}

// ---------------------------------------------------------------- gate log ---

const LOG_TYPES = ['attempt-rejected', 'overbuild-flag', 'halt', 'protocol-error', 'killed', 'milestone', 'ship', 'lifecycle'];
const LIFECYCLE = new Set(['run-start', 'run-resume', 'baseline-commit', 'completed', 'crash', 'manual-rollback', 'corrupt']);
const logFilter = new Set();

function eventFilterType(e) {
  if (LIFECYCLE.has(e.type)) return 'lifecycle';
  return LOG_TYPES.includes(e.type) ? e.type : 'lifecycle';
}

function buildLogFilters() {
  $('log-type-chips').innerHTML = LOG_TYPES.map((t) => {
    const label = t === 'lifecycle' ? 'Lifecycle' : eventLabel(t);
    return `<label class="log-chip"><input type="checkbox" data-type="${t}" /> ${escapeHtml(label)}</label>`;
  }).join('');
  $('log-type-chips').addEventListener('change', (ev) => {
    const t = ev.target.dataset.type;
    if (!t) return;
    ev.target.checked ? logFilter.add(t) : logFilter.delete(t);
    renderLog();
  });
  $('log-tail').addEventListener('change', renderLog);
  $('export-link').href = `/api/export?project=${encodeURIComponent(projectInput.value)}`;
}

async function refreshEvents() {
  try {
    allEvents = await api('/api/events');
    $('log-count').textContent = `${allEvents.length} event${allEvents.length === 1 ? '' : 's'} · decisions the model never sees`;
    renderLog();
  } catch {
    /* keep the previous event list on transient errors */
  }
}

function renderLog() {
  const tail = $('log-tail').value;
  const shown = allEvents
    .filter((e) => !logFilter.size || logFilter.has(eventFilterType(e)))
    .slice(tail === 'all' ? -Infinity : -Number(tail) || -150)
    .reverse();
  $('log').innerHTML = shown.length
    ? shown
        .map((e) => {
          const t = (e.ts || '').slice(11, 19);
          return `<li class="ev-${escapeHtml(e.type)}" data-round="${e.round ?? ''}" tabindex="0" title="${escapeHtml(e.message || '')}">
          <span class="t">${escapeHtml(eventLabel(e.type))}</span>
          <span class="r">${e.round != null ? `r${e.round}` : '—'} · ${t}</span>
          <span class="m">${escapeHtml((e.message || '').slice(0, 160))}</span>${e.causalityId ? `<span class="cid" title="Causality: ${escapeHtml(e.causalityId)}" aria-label="Linked by causality id">⛓</span>` : ''}
        </li>`;
        })
        .join('')
    : '<li class="empty-item"><span class="empty">No events match the current filters.</span></li>';
}

// Click-to-jump: an event for a rejected/halted round may have no shipped
// table row — scroll to the nearest shipped round and say so.
$('log').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-round]');
  if (!li || !li.dataset.round) return;
  jumpToRound(Number(li.dataset.round));
});
$('log').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const li = ev.target.closest('li[data-round]');
  if (li?.dataset.round) jumpToRound(Number(li.dataset.round));
});

function jumpToRound(round) {
  const rows = [...document.querySelectorAll('#rounds tbody tr[data-round]')];
  const exact = rows.find((r) => Number(r.dataset.round) === round);
  const target = exact || rows.filter((r) => Number(r.dataset.round) < round).pop() || rows[0];
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1600);
  if (!exact) {
    $('diff-title').textContent = `Round ${round} did not ship`;
    $('diff-meta').textContent = `Showing the nearest checkpoint (round ${target.dataset.round})`;
    $('diff-drawer').hidden = false;
  }
}

// ------------------------------------------------------------- diff drawer ---

document.querySelector('#rounds tbody').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-round]');
  if (tr) showDiff(Number(tr.dataset.round));
});
document.querySelector('#rounds tbody').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const tr = ev.target.closest('tr[data-round]');
  if (tr) showDiff(Number(tr.dataset.round));
});
$('diff-close').addEventListener('click', () => {
  $('diff-drawer').hidden = true;
  selectedRound = null;
  document.querySelector('#rounds tbody tr.is-selected')?.classList.remove('is-selected');
});

async function showDiff(round) {
  const drawer = $('diff-drawer');
  selectedRound = round;
  document.querySelectorAll('#rounds tbody tr').forEach((tr) => tr.classList.toggle('is-selected', Number(tr.dataset.round) === round));
  $('diff-title').textContent = `Round ${round}`;
  $('diff-meta').textContent = 'Loading diff…';
  $('diff-stat').innerHTML = '';
  $('diff-patch').textContent = '';
  drawer.hidden = false;
  let d;
  try {
    d = await api(`/api/snapshot-diff?round=${round}`);
  } catch (e) {
    $('diff-meta').textContent = `Failed to load diff: ${e.message}`;
    return;
  }
  if (d.error) {
    $('diff-title').textContent = `Round ${round}`;
    $('diff-meta').textContent = d.error;
    return;
  }
  const adds = d.stat.reduce((a, s) => a + (s.additions ?? 0), 0);
  const dels = d.stat.reduce((a, s) => a + (s.deletions ?? 0), 0);
  $('diff-title').textContent = `Round ${round}`;
  $('diff-meta').textContent = `${d.from.slice(0, 8)} → ${d.to.slice(0, 8)} · ${d.stat.length} file${d.stat.length === 1 ? '' : 's'} · +${adds} −${dels}`;
  document.querySelector('#diff-stat').innerHTML =
    `<thead><tr><th>File</th><th>+</th><th>−</th></tr></thead><tbody>` +
    d.stat
      .map((s) => `<tr><td>${escapeHtml(s.file)}</td><td class="d-add">${s.additions ?? '—'}</td><td class="d-del">${s.deletions ?? '—'}</td></tr>`)
      .join('') +
    `</tbody>`;
  $('diff-patch').textContent = d.patch || '(empty diff)';
  drawer.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ----------------------------------------------------------------- charts ---

function renderCharts(rounds, state) {
  const haltRound = (state.status === 'halted' || state.status === 'killed') && state.run ? state.run.roundIndex + 1 : null;
  let acc = 0;
  const costs = rounds.map((r) => (acc += roundUsd(r) ?? 0));
  drawLine($('chart-loc'), rounds.map((r) => ({ x: r.round, y: r.loc })), 'var(--accent)', true, haltRound, 'LOC');
  drawLine($('chart-cost'), rounds.map((r, i) => ({ x: r.round, y: costs[i] })), 'var(--info)', false, haltRound, 'USD');
}

function drawLine(svg, values, color, area, haltRound, unit) {
  svg.innerHTML = '';
  delete svg.__chartMeta;
  const W = 600, H = 160, PT = 14, PB = 22, PL = 10, PR = 10;
  if (!values.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" class="chart-empty">No rounds yet</text>`;
    return;
  }
  const xs = values.map((v) => v.x);
  const xMax = Math.max(haltRound ?? 0, ...xs, 1);
  const ys = values.map((v) => v.y);
  const max = Math.max(...ys, 0);
  const denom = max - 0 > 1e-9 ? max : Math.abs(max) || 1;
  const step = (W - PL - PR) / Math.max(xMax, 1);
  const x = (rx) => PL + (rx - 0.5) * step;
  const y = (v) => H - PB - (v / denom) * (H - PT - PB);

  const parts = [];
  // restrained horizontal gridlines
  for (let i = 1; i <= 3; i++) {
    const gy = (PT + (H - PT - PB) * (i / 4)).toFixed(1);
    parts.push(`<line x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}" class="grid"/>`);
  }
  // round axis ticks
  const tickCount = Math.min(xMax, 6);
  for (let i = 0; i < tickCount; i++) {
    const rx = tickCount === 1 ? 1 : Math.round(1 + ((xMax - 1) * i) / (tickCount - 1));
    const gx = x(rx).toFixed(1);
    parts.push(`<line x1="${gx}" y1="${PT}" x2="${gx}" y2="${H - PB}" class="grid grid--v"/>`);
    parts.push(`<text x="${gx}" y="${H - 8}" text-anchor="middle" class="tick">r${rx}</text>`);
  }
  const pts = values.map((v) => `${x(v.x).toFixed(1)},${y(v.y).toFixed(1)}`).join(' ');
  if (area) {
    parts.push(`<polygon points="${x(xs[0]).toFixed(1)},${H - PB} ${pts} ${x(xs[xs.length - 1]).toFixed(1)},${H - PB}" fill="${color}" opacity="0.10"/>`);
  }
  parts.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
  const last = values[values.length - 1];
  parts.push(`<circle cx="${x(last.x).toFixed(1)}" cy="${y(last.y).toFixed(1)}" r="3.5" fill="${color}"/>`);
  const endLabel = unit === 'USD' ? fmtUsd(last.y) : fmtTokens(last.y);
  parts.push(`<text x="${(x(last.x) - 7).toFixed(1)}" y="${Math.max(y(last.y) - 7, 10).toFixed(1)}" fill="${color}" font-size="11" font-weight="600" text-anchor="end">${endLabel}</text>`);
  if (haltRound) {
    const hx = x(haltRound).toFixed(1);
    parts.push(`<line x1="${hx}" y1="${PT}" x2="${hx}" y2="${H - PB}" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="4 3"/>`);
    // bottom placement keeps the label clear of the terminal value marker
    parts.push(`<text x="${(x(haltRound) - 2).toFixed(1)}" y="${H - PB - 7}" fill="var(--danger)" font-size="10" font-weight="600" text-anchor="end">halt @ r${haltRound}</text>`);
  }
  // crosshair, moved by the hover handler
  parts.push(`<line class="crosshair" x1="-99" y1="${PT}" x2="-99" y2="${H - PB}"/>`);
  parts.push(`<circle class="crosshair-dot" cx="-99" cy="-99" r="3.5"/>`);
  svg.innerHTML = parts.join('');
  // Metadata lives as a real property — functions can't survive JSON stringification.
  svg.__chartMeta = { values, unit, x, y, W, H };
}

// crosshair + tooltip (coords map through getBoundingClientRect — the viewBox
// is stretched, not uniform; the tooltip is position:fixed, so it is placed in
// viewport coordinates and clamped to the window)
for (const svgId of ['chart-loc', 'chart-cost']) {
  const svg = $(svgId);
  const tip = $('chart-tip');
  svg.addEventListener('mousemove', (ev) => {
    const meta = svg.__chartMeta;
    if (!meta?.values?.length) return;
    const rect = svg.getBoundingClientRect();
    const chartX = ((ev.clientX - rect.left) / rect.width) * meta.W;
    let nearest = meta.values[0];
    for (const point of meta.values) {
      if (Math.abs(meta.x(point.x) - chartX) < Math.abs(meta.x(nearest.x) - chartX)) nearest = point;
    }
    const idx = meta.values.indexOf(nearest);
    const r = currentState?.rounds?.[idx];
    const px = meta.x(nearest.x);
    const py = meta.y(nearest.y);
    const cross = svg.querySelector('.crosshair');
    const dot = svg.querySelector('.crosshair-dot');
    if (cross) cross.setAttribute('x1', px), cross.setAttribute('x2', px);
    if (dot) dot.setAttribute('cx', px), dot.setAttribute('cy', py);

    const value = meta.unit === 'USD' ? fmtUsd(nearest.y) : `${fmtTokens(nearest.y)} ${meta.unit}`;
    tip.hidden = false;
    tip.innerHTML = `<b>Round ${nearest.x}</b><span class="tip-value">${value}</span>` +
      (r ? `<span class="tip-row">Δ ${r.locDelta ?? '—'} LOC · ${fmtUsd(roundUsd(r))} · ${r.attempts} call${r.attempts === 1 ? '' : 's'}</span><span class="tip-verdict">${escapeHtml(verdictPresentation(r.verdict).label)}</span>` : '');
    tip.style.left = `${Math.max(12, Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 12))}px`;
    tip.style.top = `${Math.max(12, Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 12))}px`;
  });
  svg.addEventListener('mouseleave', () => {
    tip.hidden = true;
    const cross = svg.querySelector('.crosshair');
    const dot = svg.querySelector('.crosshair-dot');
    if (cross) cross.setAttribute('x1', '-99'), cross.setAttribute('x2', '-99');
    if (dot) dot.setAttribute('cx', '-99'), dot.setAttribute('cy', '-99');
  });
}

// --------------------------------------------------------------- scrubber ---

async function loadSnapshots() {
  snapshots = await api('/api/snapshots');
  const scrub = $('scrub');
  scrub.max = String(Math.max(snapshots.length - 1, 0));
  scrub.value = snapshots.length ? String(snapshots.length - 1) : '0';
  updateScrub();
}

function updateScrub() {
  const i = Number($('scrub').value);
  if (!snapshots.length) {
    $('scrub-label').textContent = 'No snapshots yet';
    $('scrub').setAttribute('aria-valuetext', 'no snapshots');
    $('preview').srcdoc = '<p style="font:14px sans-serif;color:#7d8ca4;padding:1rem">Snapshots appear after the first shipped round.</p>';
    document.querySelector('.frame-wrap')?.classList.remove('is-loading');
    return;
  }
  const name = snapshots[i];
  const round = Number(name.match(/round-(\d+)/)?.[1] || '?');
  $('scrub-label').textContent = `Round ${round} · ${i + 1} of ${snapshots.length}`;
  $('scrub').setAttribute('aria-valuetext', `round ${round}, snapshot ${i + 1} of ${snapshots.length}`);
  document.querySelector('.frame-wrap')?.classList.add('is-loading');
  $('preview').src = `/api/snapshot?name=${encodeURIComponent(name)}&project=${encodeURIComponent(projectInput.value)}`;
}

$('preview').addEventListener('load', () => {
  document.querySelector('.frame-wrap')?.classList.remove('is-loading');
});
$('scrub').addEventListener('input', updateScrub);
projectInput.addEventListener('change', () => {
  const u = new URL(location);
  u.searchParams.set('project', projectInput.value);
  location.href = u.href;
});

// ------------------------------------------------------------------ kill ---

$('kill').addEventListener('click', async () => {
  if (!confirm('Stop the run? In-flight agent calls abort and the repo rolls back to the last good checkpoint.')) return;
  try {
    const res = await fetch(`/api/kill?project=${encodeURIComponent(projectInput.value)}`, { method: 'POST' });
    if (res.ok) {
      $('gate-chip').textContent = 'Stopping…';
      $('gate-chip').className = 'gate-chip gate-chip--killed';
    } else {
      const body = await res.json().catch(() => ({}));
      alert(`STOP FAILED (${res.status}): ${body.error || 'unknown error'} — the run is NOT stopped. Use \`tship stop\`.`);
    }
  } catch (e) {
    alert(`STOP FAILED: ${e.message} — the run is NOT stopped. Use \`tship stop\`.`);
  }
});

// ------------------------------------------------------------------- live ---

let attempt = 0;
let lastEventAt = null;

function tickUpdated() {
  if (!lastEventAt) return;
  const age = Math.max(0, Math.round((Date.now() - lastEventAt) / 1000));
  $('st-updated').textContent = `${age}s ago`;
}

setInterval(tickUpdated, 1000);

function connect() {
  setConnectionStatus('connecting', 'Connecting');
  const es = new EventSource(`/api/stream?project=${encodeURIComponent(projectInput.value)}`);
  es.onopen = () => {
    attempt = 0;
    setConnectionStatus('live', 'Live');
  };
  es.addEventListener('state', (ev) => {
    attempt = 0;
    lastEventAt = Date.now();
    setConnectionStatus('live', 'Live');
    render(JSON.parse(ev.data));
  });
  es.onerror = () => {
    es.close();
    attempt++;
    // Connection health is reported on its own indicator — the gate chip keeps
    // showing the last known gate verdict.
    setConnectionStatus('reconnecting', `Reconnecting · attempt ${attempt}`);
    const delay = Math.min(30000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
    setTimeout(connect, delay);
  };
}

(async function init() {
  buildLogFilters();
  try {
    render(await api('/api/state'));
    await loadSnapshots();
  } catch {
    $('gate-chip').textContent = 'No data';
    $('gate-chip').className = 'gate-chip gate-chip--idle';
  }
  connect();
})();
