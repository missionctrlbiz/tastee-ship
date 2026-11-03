/* carve.js — the pumpkin carving studio.
   Drives the #carve-canvas from the form controls; everything is redrawn on
   every input so the canvas is always in sync. window.beanCarve exposes the
   current design + a dataURL for the order ticket. */
(function () {
  'use strict';

  const canvas = document.getElementById('carve-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const CX = W / 2, CY = H / 2 + 36;

  const $ = (id) => document.getElementById(id);
  const el = {
    shape: $('c-shape'), ribs: $('c-ribs'), stem: $('c-stem'), variety: $('c-variety'),
    eyes: $('c-eyes'), mouth: $('c-mouth'), face: $('c-face'), candle: $('c-candle'),
    name: $('c-name'), random: $('c-random'), download: $('c-download'), add: $('c-add'),
    status: $('carve-status'), oRibs: $('o-ribs'), oStem: $('o-stem'), oFace: $('o-face'),
    hudVar: $('hud-variety'), hudSku: $('hud-sku'),
  };

  const PRICES = { Sugar: 9.5, Lantern: 14.0, Ghost: 11.5 };
  const WEIGHTS = { Sugar: '3.2 kg', Lantern: '5.8 kg', Ghost: '2.6 kg' };

  const design = { shape: 'round', ribs: 9, stem: 6, variety: 'Sugar', eyes: 'classy', mouth: 'grin', face: 50, candle: true };

  function controller(id, fn) {
    const node = $(id);
    if (!node) return;
    node.addEventListener('input', () => { fn(node); draw(); });
    node.addEventListener('change', () => { fn(node); draw(); });
  }

  /* ---------------------------------------------------------------- body */

  function bodySize() {
    // per-shape radius + squash of the ellipse
    const base = Math.min(W, H) * 0.40;
    if (design.shape === 'tall') return { rx: base * 0.82, ry: base * 1.06 };
    if (design.shape === 'wide') return { rx: base * 1.12, ry: base * 0.78 };
    return { rx: base, ry: base * 0.88 };
  }

  function drawBody(g, x, y, rx, ry, ribs, t) {
    // outer silhouette with rib lobes
    const lobes = Math.max(5, ribs);
    g.save();
    const grad = g.createRadialGradient(x - rx * 0.35, y - ry * 0.42, ry * 0.18, x, y, rx * 1.25);
    grad.addColorStop(0, '#f08c46');
    grad.addColorStop(0.55, '#d96a2e');
    grad.addColorStop(1, '#8a3410');
    g.fillStyle = grad;
    g.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.001; a += Math.PI / 180) {
      const wob = 1 + 0.05 * Math.sin(a * lobes) + 0.012 * Math.sin(a * lobes * 3 + t * 0.0);
      const px = x + Math.cos(a) * rx * wob;
      const py = y + Math.sin(a) * ry * wob;
      if (a === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
    g.fill();
    // rib shading
    g.clip();
    g.strokeStyle = 'rgba(90, 30, 8, 0.5)';
    g.lineWidth = W * 0.006;
    for (let k = 1; k < lobes; k++) {
      const a = (k / lobes) * Math.PI * 2 - Math.PI / 2;
      const px = x + Math.cos(a) * rx * 0.97;
      const py = y + Math.sin(a) * ry * 0.97;
      g.beginPath();
      g.moveTo(x, y - ry);
      g.quadraticCurveTo(x + Math.cos(a) * rx * 0.55, y + Math.sin(a) * ry * 0.25, px, py);
      g.stroke();
    }
    // top light patch
    const hl = g.createRadialGradient(x - rx * 0.3, y - ry * 0.5, 4, x - rx * 0.3, y - ry * 0.5, ry);
    hl.addColorStop(0, 'rgba(255, 210, 140, 0.35)');
    hl.addColorStop(1, 'rgba(255, 210, 140, 0)');
    g.fillStyle = hl;
    g.fillRect(x - rx * 1.3, y - ry * 1.3, rx * 2.6, ry * 2.6);
    g.restore();
  }

  function drawStem(g, x, y, ry, curl) {
    const len = ry * (0.16 + curl * 0.02);
    g.save();
    g.strokeStyle = '#4f7a33';
    g.lineWidth = W * 0.014;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x, y - ry + 6);
    g.bezierCurveTo(
      x + curl * 3, y - ry - len * 0.4,
      x - curl * 2, y - ry - len * 0.8,
      x + curl * 5 + 6, y - ry - len
    );
    g.stroke();
    // little leaf
    g.fillStyle = '#6f9948';
    g.beginPath();
    g.ellipse(x - curl * 3 - 12, y - ry - len * 0.68, 13, 7, -0.6, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  /* ---------------------------------------------------------------- face */

  function faceGeom(rx, ry, sf) {
    // squash factor slides the features tighter together / wider apart
    const spread = rx * (0.22 + 0.16 * (sf / 100));
    const eyeY = y_(ry, -0.16);
    return { spread, eyeY };
  }
  function y_(ry, k) { return CY + ry * k; }

  function drawEyes(g, style, rx, ry, sf, lit) {
    const { spread, eyeY } = faceGeom(rx, ry, sf);
    const s = rx * (0.16 + 0.05 * (sf / 100));
    g.fillStyle = lit ? '#ffd98c' : '#241205';
    if (lit) { g.shadowColor = 'rgba(255, 170, 60, 0.9)'; g.shadowBlur = 26; }
    for (const side of [-1, 1]) {
      const ex = CX + side * spread;
      g.beginPath();
      if (style === 'classy') {
        g.moveTo(ex - s, eyeY + s * 0.62);
        g.lineTo(ex, eyeY - s * 0.66);
        g.lineTo(ex + s, eyeY + s * 0.62);
        g.closePath();
      } else if (style === 'round') {
        g.arc(ex, eyeY, s * 0.82, 0, Math.PI * 2);
      } else if (style === 'sly') {
        g.moveTo(ex - s, eyeY);
        g.quadraticCurveTo(ex, eyeY + s * 0.9, ex + s, eyeY);
        g.quadraticCurveTo(ex, eyeY - s * 0.55, ex - s, eyeY);
      } else { // stars
        for (let i = 0; i < 5; i++) {
          const aOut = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
          const aIn = aOut + Math.PI / 5;
          g.lineTo(ex + Math.cos(aOut) * s * 0.95, eyeY + Math.sin(aOut) * s * 0.95);
          g.lineTo(ex + Math.cos(aIn) * s * 0.42, eyeY + Math.sin(aIn) * s * 0.42);
        }
        g.closePath();
      }
      g.fill();
    }
    g.shadowBlur = 0;
  }

  function drawMouth(g, style, rx, ry, sf, lit) {
    const mw = rx * (0.5 + 0.16 * (sf / 100));
    const my = y_(ry, 0.34);
    g.fillStyle = lit ? '#ffd98c' : '#241205';
    if (lit) { g.shadowColor = 'rgba(255, 170, 60, 0.9)'; g.shadowBlur = 22; }
    g.beginPath();
    if (style === 'grin') {
      const tw = mw / 5;
      g.moveTo(CX - mw, my);
      g.quadraticCurveTo(CX, my + ry * 0.16, CX + mw, my);
      for (let i = 5; i >= 0; i--) g.lineTo(CX - mw + i * tw, my - (i % 2 ? ry * 0.05 : ry * 0.105));
      g.closePath();
    } else if (style === 'smile') {
      g.moveTo(CX - mw, my);
      g.quadraticCurveTo(CX, my + ry * 0.13, CX + mw, my);
      g.quadraticCurveTo(CX, my + ry * 0.05, CX - mw, my);
    } else if (style === 'fangs') {
      g.moveTo(CX - mw, my);
      g.quadraticCurveTo(CX, my + ry * 0.12, CX + mw, my);
      g.quadraticCurveTo(CX, my + ry * 0.02, CX - mw, my);
      g.moveTo(CX - mw * 0.62, my);
      g.lineTo(CX - mw * 0.45, my + ry * 0.14);
      g.lineTo(CX - mw * 0.28, my);
      g.moveTo(CX + mw * 0.3, my);
      g.lineTo(CX + mw * 0.47, my + ry * 0.14);
      g.lineTo(CX + mw * 0.64, my);
    } else { // tiny surprised ring
      g.arc(CX, my + ry * 0.02, rx * 0.09, 0, Math.PI * 2);
    }
    g.fill();
    g.shadowBlur = 0;
    // nose: small triangle above mouth
    g.beginPath();
    g.moveTo(CX - rx * 0.06, y_(ry, 0.08));
    g.lineTo(CX + rx * 0.06, y_(ry, 0.08));
    g.lineTo(CX, y_(ry, 0.17));
    g.closePath();
    g.fillStyle = lit ? '#ffd98c' : '#241205';
    g.fill();
  }

  function drawGround(g) {
    const grd = g.createLinearGradient(0, H * 0.82, 0, H);
    grd.addColorStop(0, 'rgba(80, 48, 18, 0)');
    grd.addColorStop(1, 'rgba(60, 34, 12, 0.85)');
    g.fillStyle = grd;
    g.fillRect(0, H * 0.8, W, H * 0.2);
    // few vines
    g.strokeStyle = 'rgba(111, 153, 72, 0.5)';
    g.lineWidth = 3;
    for (const [x0, x1, y] of [[40, 200, H - 34], [W - 230, W - 40, H - 26]]) {
      g.beginPath();
      g.moveTo(x0, y);
      g.quadraticCurveTo((x0 + x1) / 2, y - 16, x1, y);
      g.stroke();
    }
  }

  /* ------------------------------------------------------------- render */

  function sku() {
    const code = `BP-${design.variety.slice(0, 2).toUpperCase()}-${design.shape.slice(0, 2).toUpperCase()}-${design.eyes.slice(0, 1).toUpperCase()}${design.mouth.slice(0, 1).toUpperCase()}${design.ribs}${design.candle ? 'L' : 'D'}`;
    return code;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // night backdrop
    const bg = ctx.createRadialGradient(CX, CY - 40, 40, CX, CY, H * 0.8);
    bg.addColorStop(0, '#231408');
    bg.addColorStop(1, '#0d0803');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    drawGround(ctx);

    const { rx, ry } = bodySize();
    const lift = design.candle ? 0 : -0.02;
    // glow behind the whole lantern when lit
    if (design.candle) {
      const gl = ctx.createRadialGradient(CX, CY, 20, CX, CY, rx * 2.1);
      gl.addColorStop(0, 'rgba(255, 160, 60, 0.30)');
      gl.addColorStop(1, 'rgba(255, 160, 60, 0)');
      ctx.fillStyle = gl;
      ctx.fillRect(0, 0, W, H);
    }

    drawBody(ctx, CX, CY + lift * ry, rx, ry, design.ribs);
    drawStem(ctx, CX, CY + lift * ry - ry * 0.98, ry, design.stem);
    drawEyes(ctx, design.eyes, rx, ry, design.face, design.candle);
    drawMouth(ctx, design.mouth, rx, ry, design.face, design.candle);

    // inner candle light through the carved face when lit
    if (design.candle) {
      ctx.globalCompositeOperation = 'overlay';
      const inner = ctx.createRadialGradient(CX, CY, rx * 0.1, CX, CY, rx * 1.1);
      inner.addColorStop(0, 'rgba(255, 170, 70, 0.35)');
      inner.addColorStop(1, 'rgba(255, 170, 70, 0)');
      ctx.fillStyle = inner;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    // name tag
    const tag = (el.name.value || '').trim();
    if (tag) {
      ctx.save();
      ctx.translate(CX + rx * 0.86, CY + ry * 0.5);
      ctx.rotate(-0.12);
      ctx.fillStyle = '#f6ead6';
      ctx.strokeStyle = '#4f7a33';
      ctx.lineWidth = 3;
      const w2 = ctx.measureText(tag).width + 34;
      ctx.beginPath();
      ctx.roundRect(-w2 / 2, -26, w2, 52, 10);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#221708';
      ctx.font = '700 26px "Avenir Next", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(tag, 0, 1);
      ctx.restore();
    }

    // HUD
    el.hudVar.textContent = `${design.variety} · ${WEIGHTS[design.variety]}`;
    el.hudSku.textContent = 'SKU ' + sku();
  }

  /* ------------------------------------------------------------ actions */

  const STATUS = (msg, ok) => {
    el.status.textContent = msg;
    el.status.className = 'studio-hint' + (ok ? ' ok' : '');
  };

  controller('c-shape', (n) => (design.shape = n.value));
  controller('c-ribs', (n) => { design.ribs = +n.value; el.oRibs.textContent = n.value; });
  controller('c-stem', (n) => { design.stem = +n.value; el.oStem.textContent = n.value; });
  controller('c-variety', (n) => (design.variety = n.value));
  controller('c-eyes', (n) => (design.eyes = n.value));
  controller('c-mouth', (n) => (design.mouth = n.value));
  controller('c-face', (n) => { design.face = +n.value; el.oFace.textContent = n.value; });
  controller('c-candle', (n) => (design.candle = n.checked));
  controller('c-name', () => {});

  el.random.addEventListener('click', () => {
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    design.shape = pick(['round', 'tall', 'wide']);
    design.eyes = pick(['classy', 'round', 'sly', 'stars']);
    design.mouth = pick(['grin', 'smile', 'fangs', 'oh']);
    design.ribs = 5 + Math.floor(Math.random() * 12);
    design.stem = Math.floor(Math.random() * 11);
    design.face = Math.floor(Math.random() * 101);
    design.variety = pick(['Sugar', 'Lantern', 'Ghost']);
    el.shape.value = design.shape; el.eyes.value = design.eyes; el.mouth.value = design.mouth;
    el.ribs.value = design.ribs; el.stem.value = design.stem; el.face.value = design.face;
    el.variety.value = design.variety;
    el.oRibs.textContent = design.ribs; el.oStem.textContent = design.stem; el.oFace.textContent = design.face;
    draw();
    STATUS('Rolled a fresh one — ' + sku(), true);
  });

  el.download.addEventListener('click', () => {
    const a = document.createElement('a');
    a.download = `bean-street-${design.variety.toLowerCase()}-${sku()}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
    STATUS('Saved your carve as a PNG', true);
  });

  el.add.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('bean:add', {
      detail: {
        name: `Carved pumpkin (${design.variety})`,
        price: PRICES[design.variety],
        dim: `${design.shape} · ${design.eyes} eyes · ${sku()}`,
        png: canvas.toDataURL('image/png'),
      },
    }));
    STATUS('Added to your ticket — see the order section', true);
  });

  window.beanCarve = { design, sku, dataURL: () => canvas.toDataURL('image/png') };
  if (typeof ctx.roundRect !== 'function') {
    // tiny polyfill for older Safari
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
      return this;
    };
  }
  draw();
})();
