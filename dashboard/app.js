/* tasteeship dashboard — vanilla JS, no build step. */

const params = new URLSearchParams(location.search);
const projectInput = document.getElementById('project');
projectInput.value = params.get('project') || '.';

let currentState = null;
let snapshots = [];
let allEvents = [];

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

async function api(path) {
  const res = await fetch(`${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectInput.value)}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- render ---

function render(state) {
  currentState = state;
  const g = state.gate || { status: 'idle', label: 'IDLE' };
  const chip = $('gate-chip');
  // The chip only renders gate truth — connection state lives in its own
  // class + the "updated" stat, so a lost stream can't masquerade as a verdict.
  chip.textContent = g.label;
  chip.className = `chip ${g.status === 'running' ? 'armed' : g.status === 'halted' || g.status === 'killed' ? 'tripped' : g.status === 'completed' ? 'armed' : 'idle'}`;
  if (g.status === 'killed') chip.className = 'chip killed';
  if (g.status === 'halted') chip.className = 'chip tripped';

  $('st-run').textContent = state.run ? `${state.run.provider}/${state.run.model}` : '—';
  $('st-round').textContent = state.run ? `${state.run.roundIndex}/${state.run.roundsMax}` : '—';
  $('st-outputs').textContent = state.run ? `${state.run.attemptsThisRound}/${state.run.outputsMax}` : '—';
  const frac = state.run && state.run.outputsMax ? Math.min(1, state.run.attemptsThisRound / state.run.outputsMax) : 0;
  const bar = document.querySelector('#gate-bar i');
  bar.style.width = `${frac * 100}%`;
  bar.style.background = frac >= 1 ? 'var(--bad)' : frac >= 0.5 ? 'var(--warn)' : 'var(--good)';
  $('st-loc').textContent = state.rounds?.length ? String(state.rounds[state.rounds.length - 1].loc) : state.baseline ? String(state.baseline.loc) : '—';
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
    ? ms.map((m) => `<span class="milestone"><b>r${m.round}</b> ${m.label}</span>`).join('')
    : '<span class="empty">none yet</span>';
}

// Round-wide spend: prefer the per-round usage totals (all attempts) and fall
// back to the legacy shipping-attempt-only fields for old runs.
const roundUsd = (r) => r.usage?.usd ?? r.usd;
const roundCalls = (r) => r.usage?.calls ?? r.attempts;

function renderRounds(rounds) {
  const tb = document.querySelector('#rounds tbody');
  tb.innerHTML = rounds
    .map(
      (r) => `<tr class="${r.verdict === 'shipped' ? '' : 'rejected'}" data-round="${r.round}" tabindex="0" aria-label="round ${r.round}, ${r.verdict} — show diff">
        <td>${r.round}</td><td>${r.attempts}</td><td>${r.loc}</td><td>${r.locDelta ?? '—'}</td>
        <td>${fmtUsd(roundUsd(r))}</td>
        <td class="${r.verdict === 'shipped' ? 'v-shipped' : r.verdict === 'shipped-flagged' ? 'v-flagged' : 'v-rejected'}">${r.verdict}${r.flags?.length ? ' ⚑' : ''}</td>
        <td class="sum">${escapeHtml((r.summary || '').slice(0, 90))}${r.flags?.length ? `<br><span class="v-flagged">⚑ ${escapeHtml(r.flags.join('; ').slice(0, 90))}</span>` : ''}</td>
      </tr>`
    )
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
  $('log-type-chips').innerHTML = LOG_TYPES.map(
    (t) => `<label class="log-chip"><input type="checkbox" data-type="${t}" /> ${t}</label>`
  ).join('');
  $('log-type-chips').addEventListener('change', (ev) => {
    const t = ev.target.dataset.type;
    if (!t) return;
    ev.target.checked ? logFilter.add(t) : logFilter.delete(t);
    renderLog();
  });
  $('log-tail').addEventListener('change', renderLog);
  const ex = $('export-link');
  ex.href = `/api/export?project=${encodeURIComponent(projectInput.value)}`;
}

async function refreshEvents() {
  try {
    allEvents = await api('/api/events');
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
  $('log').innerHTML = shown
    .map((e) => {
      const ft = eventFilterType(e);
      const t = (e.ts || '').slice(11, 19);
      return `<li class="ev-${e.type}" data-round="${e.round ?? ''}" tabindex="0" title="${escapeHtml(e.message || '')}">
        <span class="t">${e.type}</span><span class="r">r${e.round ?? '-'} ${t}</span>${escapeHtml((e.message || '').slice(0, 160))}${e.causalityId ? `<span class="cid" title="causality: ${escapeHtml(e.causalityId)}"> ⛓</span>` : ''}
      </li>`;
    })
    .join('');
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
  const rows = [...document.querySelectorAll('#rounds tbody tr')];
  const exact = rows.find((r) => Number(r.dataset.round) === round);
  const target = exact || rows.filter((r) => Number(r.dataset.round) < round).pop() || rows[0];
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1600);
  if (!exact) {
    $('diff-title').textContent = `round ${round} did not ship — showing nearest checkpoint (round ${target.dataset.round})`;
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
});

async function showDiff(round) {
  const d = await api(`/api/snapshot-diff?round=${round}`);
  if (d.error) {
    $('diff-title').textContent = `round ${round}: ${d.error}`;
    $('diff-drawer').hidden = false;
    return;
  }
  $('diff-title').textContent = `round ${round} — ${d.from.slice(0, 8)} → ${d.to.slice(0, 8)}`;
  document.querySelector('#diff-stat').innerHTML =
    `<thead><tr><th>file</th><th>+</th><th>−</th></tr></thead><tbody>` +
    d.stat
      .map((s) => `<tr><td>${escapeHtml(s.file)}</td><td class="v-shipped">${s.additions ?? '—'}</td><td class="v-rejected">${s.deletions ?? '—'}</td></tr>`)
      .join('') +
    `</tbody>`;
  $('diff-patch').textContent = d.patch || '(empty diff)';
  $('diff-drawer').hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- charts ---

function renderCharts(rounds, state) {
  const haltRound = state.status === 'halted' || state.status === 'killed' ? state.run.roundIndex + 1 : null;
  let acc = 0;
  const costs = rounds.map((r) => (acc += roundUsd(r) ?? 0));
  drawLine($('chart-loc'), rounds.map((r, i) => ({ x: r.round, y: rounds[i].loc })), '#c98a3d', true, haltRound, 'LOC');
  drawLine($('chart-cost'), rounds.map((r, i) => ({ x: r.round, y: costs[i] })), '#6fbf73', false, haltRound, 'USD');
}

function drawLine(svg, values, color, area, haltRound, unit) {
  svg.innerHTML = '';
  if (!values.length) return;
  const W = 600, H = 160, P = 8;
  const xs = values.map((v) => v.x);
  const xMax = Math.max(haltRound ?? 0, ...xs, 1);
  const ys = values.map((v) => v.y);
  const max = Math.max(...ys, 1);
  const min = Math.min(...ys, 0);
  const x = (rx) => P + ((rx - 1) / Math.max(xMax - 1, 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / Math.max(max - min, 1e-9)) * (H - 2 * P);
  const pts = values.map((v) => `${x(v.x).toFixed(1)},${y(v.y).toFixed(1)}`).join(' ');
  if (area) {
    svg.innerHTML += `<polygon points="${x(xs[0]).toFixed(1)},${H - P} ${pts} ${x(xs[xs.length - 1]).toFixed(1)},${H - P}" fill="${color}" opacity="0.12"/>`;
  }
  svg.innerHTML += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`;
  const last = values[values.length - 1];
  svg.innerHTML += `<circle cx="${x(last.x)}" cy="${y(last.y)}" r="3.5" fill="${color}"/>`;
  svg.innerHTML += `<text x="${x(last.x) - 6}" y="${Math.max(y(last.y) - 6, 10)}" fill="${color}" font-size="11" text-anchor="end">${Math.round(last.y).toLocaleString()}</text>`;
  if (haltRound) {
    const hx = x(haltRound).toFixed(1);
    svg.innerHTML += `<line x1="${hx}" y1="${P}" x2="${hx}" y2="${H - P}" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    svg.innerHTML += `<text x="${hx}" y="${P + 10}" fill="var(--bad)" font-size="11" text-anchor="middle">⛔ ${haltRound}</text>`;
  }
  svg.dataset.meta = JSON.stringify({ values, unit, x, y, W, H });
}

// crosshair + tooltip (coords map through getBoundingClientRect — the viewBox
// is stretched, not uniform)
for (const svgId of ['chart-loc', 'chart-cost']) {
  const svg = $(svgId);
  const tip = $('chart-tip');
  svg.addEventListener('mousemove', (ev) => {
    let meta;
    try {
      meta = JSON.parse(svg.dataset.meta || 'null');
    } catch {
      return;
    }
    if (!meta?.values?.length) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((ev.clientX - rect.left) / rect.width) * meta.W;
    let best = meta.values[0];
    for (const v of meta.values) {
      if (Math.abs(meta.x(v.x) - vx) < Math.abs(meta.x(best.x) - vx)) best = v;
    }
    const idx = meta.values.indexOf(best);
    const r = currentState?.rounds?.[idx];
    tip.hidden = false;
    tip.style.left = `${Math.min(ev.clientX - rect.left + 12, rect.width - 190)}px`;
    tip.innerHTML = `round <b>${best.x}</b> · ${meta.unit} <b>${fmtTokens(best.y)}</b>` + (r ? ` · Δ${r.locDelta ?? '—'} · ${fmtUsd(roundUsd(r))} · ${r.attempts} call(s) · ${r.verdict}` : '');
  });
  svg.addEventListener('mouseleave', () => {
    tip.hidden = true;
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
    $('scrub-label').textContent = 'no snapshots yet';
    $('scrub').setAttribute('aria-valuetext', 'no snapshots');
    $('preview').srcdoc = '<p style="font:14px sans-serif;color:#888;padding:1rem">snapshots appear after the first shipped round</p>';
    return;
  }
  const name = snapshots[i];
  const round = Number(name.match(/round-(\d+)/)?.[1] || '?');
  $('scrub-label').textContent = `round ${round} (${i + 1}/${snapshots.length})`;
  $('scrub').setAttribute('aria-valuetext', `round ${round}, snapshot ${i + 1} of ${snapshots.length}`);
  $('preview').src = `/api/snapshot?name=${encodeURIComponent(name)}&project=${encodeURIComponent(projectInput.value)}`;
}

$('scrub').addEventListener('input', updateScrub);
projectInput.addEventListener('change', () => {
  const u = new URL(location);
  u.searchParams.set('project', projectInput.value);
  location.href = u.href;
});

// ------------------------------------------------------------------ kill ---

$('kill').addEventListener('click', async () => {
  if (!confirm('KILL the run? In-flight agent calls abort and the repo rolls back to the last good checkpoint.')) return;
  try {
    const res = await fetch(`/api/kill?project=${encodeURIComponent(projectInput.value)}`, { method: 'POST' });
    if (res.ok) {
      $('gate-chip').textContent = 'KILLING…';
      $('gate-chip').className = 'chip killed';
    } else {
      const body = await res.json().catch(() => ({}));
      alert(`KILL FAILED (${res.status}): ${body.error || 'unknown error'} — the run is NOT stopped. Use \`tship stop\`.`);
    }
  } catch (e) {
    alert(`KILL FAILED: ${e.message} — the run is NOT stopped. Use \`tship stop\`.`);
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
  const es = new EventSource(`/api/stream?project=${encodeURIComponent(projectInput.value)}`);
  es.onopen = () => {
    attempt = 0;
  };
  es.addEventListener('state', (ev) => {
    attempt = 0;
    lastEventAt = Date.now();
    render(JSON.parse(ev.data));
  });
  es.onerror = () => {
    es.close();
    attempt++;
    const delay = Math.min(30000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
    const chip = $('gate-chip');
    if (!chip.className.includes('reconnecting')) {
      chip.dataset.prevLabel = chip.textContent;
      chip.dataset.prevClass = chip.className;
    }
    chip.className = 'chip reconnecting';
    chip.textContent = `RECONNECTING (${attempt})`;
    setTimeout(connect, delay);
  };
}

(async function init() {
  buildLogFilters();
  try {
    render(await api('/api/state'));
    await loadSnapshots();
  } catch (e) {
    $('gate-chip').textContent = 'NO DATA';
    $('gate-chip').className = 'chip idle';
  }
  connect();
})();
