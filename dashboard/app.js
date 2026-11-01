/* tasteeship dashboard — vanilla JS, no build step. */

const params = new URLSearchParams(location.search);
const projectInput = document.getElementById('project');
projectInput.value = params.get('project') || '.';

let currentState = null;
let snapshots = [];

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
  const res = await fetch(`${path}?project=${encodeURIComponent(projectInput.value)}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- render ---

function render(state) {
  currentState = state;
  const g = state.gate || { status: 'idle', label: 'IDLE' };
  const chip = $('gate-chip');
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
  renderCharts(state.rounds || []);
  renderRounds(state.rounds || []);
  renderLog(state.gateEvents || []);
}

function renderMilestones(ms) {
  const el = $('milestones');
  el.innerHTML = ms.length
    ? ms.map((m) => `<span class="milestone"><b>r${m.round}</b> ${m.label}</span>`).join('')
    : '<span class="empty">none yet</span>';
}

function renderRounds(rounds) {
  const tb = document.querySelector('#rounds tbody');
  tb.innerHTML = rounds
    .map(
      (r) => `<tr class="${r.verdict === 'shipped' ? '' : 'rejected'}">
        <td>${r.round}</td><td>${r.attempts}</td><td>${r.loc}</td><td>${r.locDelta ?? '—'}</td>
        <td>${fmtUsd(r.usd)}</td>
        <td class="${r.verdict === 'shipped' ? 'v-shipped' : r.verdict === 'shipped-flagged' ? 'v-flagged' : 'v-rejected'}">${r.verdict}${r.flags?.length ? ' ⚑' : ''}</td>
        <td class="sum">${escapeHtml((r.summary || '').slice(0, 90))}${r.flags?.length ? `<br><span class="v-flagged">⚑ ${escapeHtml(r.flags.join('; ').slice(0, 90))}</span>` : ''}</td>
      </tr>`
    )
    .join('');
}

function renderLog(events) {
  const el = $('log');
  el.innerHTML = events
    .slice(-120)
    .reverse()
    .map((e) => {
      const cls = e.type ? `ev-${e.type}` : '';
      const t = (e.ts || '').slice(11, 19);
      return `<li class="${cls}"><span class="t">${e.type}</span><span class="r">r${e.round ?? '-'} ${t}</span>${escapeHtml(e.message || '')}</li>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- charts ---

function renderCharts(rounds) {
  drawLine($('chart-loc'), rounds.map((r) => r.loc), '#c98a3d', true);
  let acc = 0;
  drawLine($('chart-cost'), rounds.map((r) => (acc += r.usd)), '#6fbf73', false);
}

function drawLine(svg, values, color, area) {
  svg.innerHTML = '';
  if (!values.length) return;
  const W = 600, H = 160, P = 8;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const x = (i) => P + (i / Math.max(values.length - 1, 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / Math.max(max - min, 1e-9)) * (H - 2 * P);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  if (area) {
    svg.innerHTML += `<polygon points="${P},${H - P} ${pts} ${W - P},${H - P}" fill="${color}" opacity="0.12"/>`;
  }
  svg.innerHTML += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`;
  const last = values[values.length - 1];
  svg.innerHTML += `<circle cx="${x(values.length - 1)}" cy="${y(last)}" r="3.5" fill="${color}"/>`;
  svg.innerHTML += `<text x="${W - P}" y="${y(last) - 6}" fill="${color}" font-size="11" text-anchor="end">${Math.round(last).toLocaleString()}</text>`;
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
    $('preview').srcdoc = '<p style="font:14px sans-serif;color:#888;padding:1rem">snapshots appear after the first shipped round</p>';
    return;
  }
  const name = snapshots[i];
  const round = Number(name.match(/round-(\d+)/)?.[1] || '?');
  $('scrub-label').textContent = `round ${round} (${i + 1}/${snapshots.length})`;
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
  const res = await fetch(`/api/kill?project=${encodeURIComponent(projectInput.value)}`, { method: 'POST' });
  if (res.ok) {
    $('gate-chip').textContent = 'KILLING…';
    $('gate-chip').className = 'chip killed';
  }
});

// ------------------------------------------------------------------- live ---

function connect() {
  const es = new EventSource(`/api/stream?project=${encodeURIComponent(projectInput.value)}`);
  es.addEventListener('state', (ev) => {
    render(JSON.parse(ev.data));
  });
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2000);
  };
}

(async function init() {
  try {
    render(await api('/api/state'));
    await loadSnapshots();
  } catch (e) {
    $('gate-chip').textContent = 'NO DATA';
    $('gate-chip').className = 'chip idle';
  }
  connect();
})();
