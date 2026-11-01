import fs from 'node:fs';
import path from 'node:path';

// Deterministic mock provider. Used to validate the harness mechanics (gate,
// kill switch, checkpoints, usage accounting) without API keys. Profiles are
// calibrated to the reference case study:
//
//   mock-sonnet — conservative, small diffs, fixes the form early, rarely
//                 trips anything (the video's "usable around round 65" model).
//   mock-opus   — bold, escalating diffs, ships a pumpkin-carving novelty
//                 feature (over-build), a broken language toggle and a form
//                 regression along the way; LOC ramps toward the video's
//                 ~21k-LOC trajectory (scaled to 50 rounds).
//
// The mock never "decides" anything about the gate — it just emits proposals
// the same way the Anthropic provider does; the gate treats them identically.
//
// Plan discipline: every entry in plan.edits is a function (ctx) => W | [W...]
// | void, evaluated when the harness applies the proposal. Helpers below are
// *builders* — calling them returns the edit function. Edits compose: ctx.read
// sees earlier edits of the same proposal via the overlay (see MockProvider.step).

export class MockProvider {
  constructor(cfg, runId) {
    this.cfg = cfg;
    this.model = cfg.provider.model || 'mock-sonnet';
    this.profile = /opus/i.test(this.model) ? 'opus' : 'sonnet';
    this.runId = runId;
  }

  async step(ctx, { signal } = {}) {
    await sleep(10, signal); // abort-aware so the kill switch can cancel in-flight "calls"
    const plan = this.profile === 'opus' ? opusPlan(ctx) : sonnetPlan(ctx);
    // Edits within one proposal compose through an overlay: an edit reads what
    // previous edits in the same proposal wrote, not stale disk state. The
    // final overlay is emitted as one full-content write per file — the same
    // proposal shape the Anthropic provider returns.
    const overlay = new Map();
    const ictx = {
      ...ctx,
      read: (rel, fallback = '') => (overlay.has(rel) ? overlay.get(rel) : read(ctx.root, rel, fallback)),
      write: (rel, content) => overlay.set(rel, content),
    };
    for (const edit of plan.edits) {
      const res = edit(ictx);
      for (const f of [res].flat()) {
        if (f && typeof f === 'object' && typeof f.path === 'string') ictx.write(f.path, f.content);
      }
    }
    const files = [...overlay].map(([p, content]) => ({ path: p, content }));
    return {
      usage: simulatedUsage(this.profile, ctx),
      proposal: { summary: plan.summary, files },
    };
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(settle, ms);
    const onAbort = () => {
      clearTimeout(t);
      settle();
    };
    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(signal.reason || new Error('aborted'));
      else resolve();
    }
    if (signal) {
      if (signal.aborted) return settle();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function simulatedUsage(profile, ctx) {
  if (profile === 'opus') {
    return {
      input: Math.round(4300 + ctx.round * 14 + ctx.attemptNo * 500),
      output: Math.round(850 + ctx.round * 3 + ctx.attemptNo * 120),
    };
  }
  return {
    input: Math.round(2800 + ctx.round * 8 + ctx.attemptNo * 400),
    output: Math.round(520 + ctx.round * 2 + ctx.attemptNo * 60),
  };
}

// ---------------------------------------------------------------- helpers ---

function read(root, rel, fallback = '') {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return fallback;
  }
}

const W = (rel, content) => ({ path: rel, content });

const editFile = (rel, fn) => (ctx) => ctx.write(rel, fn(ctx.read(rel)));

const appendCss = (block) => (ctx) =>
  ctx.write('css/style.css', `${ctx.read('css/style.css')}\n${block}`);

const insertIntoMain = (snippet) => (ctx) =>
  ctx.write('index.html', ctx.read('index.html').replace('</main>', `${snippet}\n</main>`));

const heroWithImage = (file, alt) =>
  insertIntoMain(
    `  <section class="hero">\n    <img src="${file}" alt="${alt}" class="hero-img" />\n    <p class="hero-copy">Freshly roasted, every morning.</p>\n  </section>`
  );

const addScript = (name, code) => (ctx) => {
  const tag = `<script src="js/${name}" defer></script>`;
  let html = ctx.read('index.html');
  if (!html.includes(`js/${name}`)) {
    html = html.replace('</body>', `  ${tag}\n</body>`);
  }
  ctx.write('index.html', html);
  ctx.write(`js/${name}`, code);
};

const writeAsset = (rel, content) => (ctx) => {
  fs.mkdirSync(path.join(ctx.root, path.dirname(rel)), { recursive: true });
  ctx.write(rel, content);
};

const titleCase = (name) =>
  name
    .split('-')
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join(' ');

function featureJs(name, methods) {
  const Cap = name
    .split('-')
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');
  let out = `// ${name} module — simulated bold feature\n(function () {\n  'use strict';\n\n  class ${Cap}Manager {\n    constructor() {\n      this.state = {};\n      this.ready = false;\n    }\n\n    init() {\n      this.ready = true;\n      return this;\n    }\n`;
  for (let i = 0; i < methods; i++) {
    out += `
    handle${Cap}Step${i}(payload = {}) {
      const key = '${name}:step${i}';
      this.state[key] = Object.assign({ at: Date.now() }, payload);
      if (!payload.silent) {
        this.render${i}();
      }
      return this.state[key];
    }

    render${i}() {
      const node = document.getElementById('${name}-slot-0');
      if (!node) return;
      node.dataset.${Cap.toLowerCase()}Step = '${i}';
      node.classList.add('${name}-active');
    }
`;
  }
  out += `  }\n\n  const manager = new ${Cap}Manager();\n  if (document.readyState !== 'loading') manager.init();\n  else document.addEventListener('DOMContentLoaded', () => manager.init());\n})();\n`;
  return out;
}

function featureCss(name, blocks) {
  let out = `/* ${name} — simulated bold styling */\n:root {\n  --${name}-accent: #b3541e;\n  --${name}-surface: #fff8f0;\n  --${name}-radius: 12px;\n}\n\n.${name} {\n  background: var(--${name}-surface);\n  border-radius: var(--${name}-radius);\n  padding: 1.5rem;\n  box-shadow: 0 2px 12px rgba(60, 30, 10, 0.12);\n}\n`;
  for (let i = 0; i < blocks; i++) {
    out += `.${name}__row-${i} {\n  display: flex;\n  gap: 0.75rem;\n  align-items: center;\n  padding: 0.5rem 0;\n  border-bottom: 1px dashed rgba(0, 0, 0, 0.08);\n}\n\n.${name}__row-${i}:hover {\n  background: rgba(179, 84, 30, 0.06);\n}\n`;
  }
  return out;
}

function featureSection(name, title, rows = 4) {
  let rowsHtml = '';
  for (let i = 0; i < rows; i++) {
    rowsHtml += `\n      <div class="${name}__row-${i}"><strong>${title} ${i + 1}</strong><span id="${name}-slot-${i}" data-slot="${name}-slot-${i}">—</span></div>`;
  }
  return `  <section class="${name}" aria-label="${title}">\n    <h2>${title}</h2>${rowsHtml}\n  </section>`;
}

const big = (name, methods, rows = 3) => [
  appendCss(featureCss(name, Math.max(2, Math.round(methods / 4)))),
  insertIntoMain(featureSection(name, titleCase(name), rows)),
  addScript(`${name}.js`, featureJs(name, methods)),
];

// ----------------------------------------------------------------- sonnet ---

function sonnetPlan(ctx) {
  const r = ctx.round;
  const a = ctx.attemptNo;

  switch (r) {
    case 1:
      return {
        summary: 'Drop Comic Sans for a proper type stack and add color tokens.',
        edits: [
          editFile('css/style.css', (css) =>
            css.replace(/font-family:\s*"Comic Sans MS"[^;]*;/i, 'font-family: system-ui, -apple-system, "Segoe UI", sans-serif;') +
            `\n:root {\n  --brand: #6f4e37;\n  --brand-dark: #4b3423;\n  --cream: #fdf6ec;\n  --accent: #c98a3d;\n  --text: #2b2118;\n  --radius: 10px;\n  --space-1: 0.5rem;\n  --space-2: 1rem;\n  --space-3: 1.5rem;\n}\n\nbody {\n  background: var(--cream);\n  color: var(--text);\n  line-height: 1.6;\n}\n\nh1, h2, h3 {\n  color: var(--brand-dark);\n  letter-spacing: -0.01em;\n}\n`
          ),
        ],
      };
    case 2:
      return {
        summary: 'Mobile-first breakpoints so the site stops breaking on phones.',
        edits: [
          appendCss(
            `@media (max-width: 900px) {\n  .wrap { width: auto; padding: 0 var(--space-2); }\n  nav ul { flex-wrap: wrap; gap: var(--space-1); }\n}\n\n@media (max-width: 600px) {\n  h1 { font-size: 1.6rem; }\n  .menu-item { display: block; }\n  .order-form input, .order-form select { width: 100%; }\n  nav ul { flex-direction: column; }\n}\n`
          ),
        ],
      };
    case 3:
      return {
        summary: 'Fix the order form: correct DOM ids and a working submit handler.',
        edits: [
          (ctx) =>
            W(
              'js/form.js',
              `(function () {\n  'use strict';\n\n  var form = document.getElementById('order-form');\n  var status = document.getElementById('order-status');\n  if (!form) return;\n\n  form.addEventListener('submit', function (event) {\n    event.preventDefault();\n    var drink = form.elements['drink'].value;\n    var size = form.elements['size'].value;\n    var name = form.elements['name'].value;\n    if (!name) {\n      status.textContent = 'Please add your name so we can label the cup.';\n      status.className = 'form-status error';\n      return;\n    }\n    status.textContent = 'Thanks ' + name + ' — one ' + size + ' ' + drink + ' coming up!';\n    status.className = 'form-status ok';\n    form.reset();\n  });\n})();\n`
            ),
        ],
      };
    case 4:
      return {
        summary: 'Conversion-focused button styles with visible focus states.',
        edits: [
          appendCss(
            `button, .btn {\n  background: var(--brand);\n  color: #fff;\n  border: 0;\n  border-radius: var(--radius);\n  padding: 0.7rem 1.4rem;\n  font-size: 1rem;\n  cursor: pointer;\n  transition: background 0.15s ease, transform 0.15s ease;\n}\n\nbutton:hover, .btn:hover {\n  background: var(--brand-dark);\n  transform: translateY(-1px);\n}\n\nbutton:focus-visible, .btn:focus-visible {\n  outline: 3px solid var(--accent);\n  outline-offset: 2px;\n}\n\n.btn-order {\n  background: var(--accent);\n  font-weight: 700;\n}\n`
          ),
        ],
      };
    case 5:
      return {
        summary: 'Add a hero image above the fold — the strongest visual anchor we have.',
        edits: [
          writeAsset(
            'assets/hero.svg',
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" role="img" aria-label="Coffee hero">\n  <rect width="800" height="400" fill="#4b3423"/>\n  <circle cx="400" cy="210" r="120" fill="#fdf6ec"/>\n  <circle cx="400" cy="210" r="95" fill="#6f4e37"/>\n  <path d="M 330 170 Q 400 130 470 170" stroke="#fdf6ec" stroke-width="10" fill="none"/>\n  <path d="M 340 210 Q 400 175 460 210" stroke="#fdf6ec" stroke-width="8" fill="none" opacity="0.7"/>\n  <rect x="120" y="330" width="560" height="18" rx="9" fill="#c98a3d"/>\n</svg>\n`
          ),
          heroWithImage('assets/hero.svg', 'A latte with latte art on a dark background'),
        ],
      };
    case 6:
      return {
        summary: 'Menu as a scannable grid — the page customers actually came for.',
        edits: [
          insertIntoMain(
            `  <section class="menu-grid" aria-label="Menu">\n    <h2>Menu</h2>\n    <div class="menu-cards">\n      <article class="menu-card"><h3>Espresso</h3><p>Double shot, single origin.</p><data value="3.50">$3.50</data></article>\n      <article class="menu-card"><h3>Flat White</h3><p>Silky microfoam.</p><data value="4.25">$4.25</data></article>\n      <article class="menu-card"><h3>Cold Brew</h3><p>Steeped 18 hours.</p><data value="4.75">$4.75</data></article>\n      <article class="menu-card"><h3>Mocha</h3><p>House ganache.</p><data value="5.00">$5.00</data></article>\n    </div>\n  </section>`
          ),
          appendCss(
            `.menu-cards {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));\n  gap: var(--space-2);\n}\n\n.menu-card {\n  background: #fff;\n  border-radius: var(--radius);\n  padding: var(--space-2);\n  box-shadow: 0 1px 6px rgba(43, 33, 24, 0.1);\n}\n\n.menu-card data {\n  font-weight: 700;\n  color: var(--brand);\n}\n`
          ),
        ],
      };
    case 7:
      return {
        summary: 'Social proof: testimonials section near the order form.',
        edits: [insertIntoMain(featureSection('testimonials', 'What regulars say', 3))],
      };
    case 8:
      return {
        summary: 'Order form UX: labels, hints, and an inline status region.',
        edits: [
          editFile('index.html', (html) =>
            html.replace(
              /<form([\s\S]*?)>([\s\S]*?)<\/form>/,
              (m, attrs, inner) =>
                `<form${attrs}>\n  <label for="drink">Drink</label>\n  <input id="drink" name="drink" list="drink-list" required />\n  <datalist id="drink-list"><option>Espresso</option><option>Flat White</option><option>Cold Brew</option></datalist>\n  <label for="size">Size</label>\n  <select id="size" name="size"><option>Small</option><option selected>Medium</option><option>Large</option></select>\n  <label for="name">Name on the cup</label>\n  <input id="name" name="name" autocomplete="given-name" required />\n  <button type="submit" class="btn-order">Order now</button>\n  <p id="order-status" class="form-status" role="status" aria-live="polite"></p>\n</form>`
            )
          ),
        ],
      };
    case 9:
      return {
        summary: 'Hours and location in the footer — removes pre-visit friction.',
        edits: [
          editFile('index.html', (html) =>
            html.replace(
              '</footer>',
              `  <div class="hours">\n    <strong>Hours</strong>\n    <p>Mon–Fri 7–18 · Sat–Sun 8–17</p>\n    <p>12 Bean Street · free 30-min parking</p>\n  </div>\n</footer>`
            )
          ),
        ],
      };
    case 10:
      return {
        summary: 'Sticky nav so the order button is always one tap away.',
        edits: [
          appendCss(
            `nav {\n  position: sticky;\n  top: 0;\n  z-index: 10;\n  background: var(--cream);\n  border-bottom: 1px solid rgba(111, 78, 55, 0.2);\n}\n\nnav a {\n  text-decoration: none;\n  color: var(--brand-dark);\n  padding: var(--space-1) var(--space-2);\n  border-radius: var(--radius);\n}\n\nnav a:hover {\n  background: rgba(201, 138, 61, 0.18);\n}\n`
          ),
        ],
      };
    case 11:
      return {
        summary: 'Gallery with three drink photos (local SVGs, zero external requests).',
        edits: [
          (ctx) => {
            fs.mkdirSync(path.join(ctx.root, 'assets'), { recursive: true });
            return ['latte', 'brew', 'pastry'].map((n, i) =>
              W(
                `assets/${n}.svg`,
                `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="${['#6f4e37', '#4b3423', '#c98a3d'][i]}"/><circle cx="200" cy="150" r="70" fill="#fdf6ec"/></svg>\n`
              )
            );
          },
          insertIntoMain(
            `  <section class="gallery" aria-label="Gallery">\n    <img src="assets/latte.svg" alt="Latte" width="200" />\n    <img src="assets/brew.svg" alt="Cold brew" width="200" />\n    <img src="assets/pastry.svg" alt="Pastry" width="200" />\n  </section>`
          ),
        ],
      };
    case 12:
      return {
        summary: 'Autoplay-free teaser video with poster — motion without annoyance.',
        edits: [
          writeAsset(
            'assets/teaser.svg',
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#2b2118"/><polygon points="280,120 400,180 280,240" fill="#fdf6ec"/></svg>\n'
          ),
          insertIntoMain(
            `  <section class="teaser">\n    <video controls poster="assets/teaser.svg" width="640" preload="none">\n      <source src="assets/teaser.mp4" type="video/mp4" />\n      Your browser can’t play this teaser.\n    </video>\n  </section>`
          ),
        ],
      };
    case 13:
      return {
        summary: 'Prices table with sizes so customers stop guessing.',
        edits: [
          insertIntoMain(
            `  <table class="prices">\n    <caption>Size pricing</caption>\n    <thead><tr><th>Drink</th><th>Small</th><th>Medium</th><th>Large</th></tr></thead>\n    <tbody>\n      <tr><td>Espresso</td><td>$3.50</td><td>$4.00</td><td>$4.50</td></tr>\n      <tr><td>Flat White</td><td>$4.25</td><td>$4.75</td><td>$5.25</td></tr>\n      <tr><td>Cold Brew</td><td>$4.75</td><td>$5.25</td><td>$5.75</td></tr>\n    </tbody>\n  </table>`
          ),
        ],
      };
    case 14:
      return {
        summary: 'Rewrite the hero copy around the first order, not the building.',
        edits: [
          editFile('index.html', (html) => html.replace(/<h1>[\s\S]*?<\/h1>/, '<h1>Your usual, ready when you walk in.</h1>')),
        ],
      };
    case 15:
      return {
        summary: 'Loyalty signup form — the second conversion path.',
        edits: [
          insertIntoMain(
            `  <form class="loyalty" aria-label="Loyalty signup">\n    <h2>10th coffee free</h2>\n    <label for="loyalty-email">Email</label>\n    <input id="loyalty-email" name="email" type="email" required />\n    <button type="submit">Join free</button>\n  </form>`
          ),
        ],
      };
    case 16:
      return {
        summary: 'Accessibility pass: skip link and reduced-motion guard.',
        edits: [
          appendCss(
            `.skip-link {\n  position: absolute;\n  left: -999px;\n}\n\n.skip-link:focus {\n  left: var(--space-2);\n  top: var(--space-2);\n  background: #fff;\n  padding: var(--space-1);\n  z-index: 20;\n}\n\n@media (prefers-reduced-motion: reduce) {\n  * { transition: none !important; animation: none !important; }\n}\n`
          ),
          editFile('index.html', (html) => html.replace('<body>', '<body>\n  <a class="skip-link" href="#order-form">Skip to order form</a>')),
        ],
      };
    case 17:
      return {
        summary: 'Preload the hero image — faster first paint, more scrolls.',
        edits: [
          editFile('index.html', (html) => html.replace('</title>', '</title>\n  <link rel="preload" as="image" href="assets/hero.svg" />')),
        ],
      };
    case 18:
      return {
        summary: 'Interactive brew-ratio canvas — engagement for the coffee-curious.',
        edits: [
          insertIntoMain(
            `  <section class="brew-widget">\n    <h2>Brew ratio lab</h2>\n    <canvas id="brew-canvas" width="420" height="240" aria-label="Brew ratio visualiser"></canvas>\n  </section>`
          ),
          addScript(
            'brew.js',
            `(function () {\n  var canvas = document.getElementById('brew-canvas');\n  if (!canvas) return;\n  var ctx2d = canvas.getContext('2d');\n  function draw(ratio) {\n    ctx2d.fillStyle = '#fdf6ec';\n    ctx2d.fillRect(0, 0, canvas.width, canvas.height);\n    ctx2d.fillStyle = '#6f4e37';\n    var h = Math.min(200, 600 / ratio);\n    ctx2d.fillRect(40, canvas.height - 20 - h, 120, h);\n    ctx2d.fillStyle = '#4b3423';\n    ctx2d.font = '16px sans-serif';\n    ctx2d.fillText('1 : ' + ratio, 200, 40);\n  }\n  [14, 15, 16, 17, 18].forEach(function (r, i) {\n    setTimeout(function () { draw(r); }, i * 600);\n  });\n})();\n`
          ),
        ],
      };
    case 19:
      return {
        summary: 'Seasonal banner driven by one CSS variable — easy to retire.',
        edits: [
          appendCss(
            `.seasonal {\n  background: linear-gradient(90deg, var(--brand), var(--accent));\n  color: #fff;\n  text-align: center;\n  padding: var(--space-2);\n  border-radius: var(--radius);\n}\n`
          ),
          insertIntoMain(`  <p class="seasonal">Maple flat white is back for November.</p>`),
        ],
      };
    case 20:
      return {
        summary: 'Spacing rhythm pass — consistent gaps lift scan-reading.',
        edits: [
          appendCss(
            `section { margin-block: var(--space-3); }\nsection + section { margin-top: 0; }\nh2 { margin-bottom: var(--space-2); }\n`
          ),
        ],
      };
    default:
      return sonnetLatePlan(ctx, r, a);
  }
}

function sonnetLatePlan(ctx, r, a) {
  // Round 21: deliberate regression drill — first attempt drops the footer
  // (a previously-green check), the retry keeps landmarks intact.
  if (r === 21 && a === 1) {
    return {
      summary: 'Simplify page: remove footer chrome.',
      edits: [
        editFile('index.html', (html) => html.replace(/<footer[\s\S]*?<\/footer>/, '<!-- footer removed -->')),
      ],
    };
  }
  if (r === 21) {
    return {
      summary: 'Tighten the footer into two columns, landmarks intact.',
      edits: [
        editFile('index.html', (html) => html.replace('<footer>', '<footer class="footer-tight">')),
        appendCss(`.footer-tight { display: flex; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }\n`),
      ],
    };
  }

  const pool = [
    ['Highlight the best-seller in the menu.', appendCss(`.menu-card:nth-child(2) { border: 2px solid var(--accent); position: relative; }\n.menu-card:nth-child(2)::after { content: "Popular"; position: absolute; top: -10px; right: 12px; background: var(--accent); color: #fff; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; }\n`)],
    ['Add a delivery banner above the fold.', insertIntoMain(`  <p class="seasonal">Order before 9am for same-day delivery.</p>`)],
    ['Trust badges near the order form.', insertIntoMain(`  <ul class="badges"><li>Locally roasted</li><li>Carbon-neutral delivery</li><li>4.9★ from 1,200 reviews</li></ul>`)],
    ['Contrast pass for AA compliance.', appendCss(`body { color: #241a12; }\nnav a { color: #3d2b1f; }\n.form-status.error { color: #8f1d1d; }\n.form-status.ok { color: #1d5c2f; }\n`)],
    ['Tip-jar line on the confirmation status.', editFile('index.html', (html) => html.replace('Order now</button>', 'Order now</button>\n  <p class="badges">Tips keep the lights (and the grinder) on.</p>'))],
    ['Newsletter teaser in the footer.', editFile('index.html', (html) => html.replace('</footer>', '  <p class="seasonal">Get the weekly bean letter.</p>\n</footer>'))],
    ['Back-to-top link styles.', appendCss(`.to-top { position: fixed; right: 1rem; bottom: 1rem; border-radius: 999px; padding: 0.5rem 0.9rem; }\n`)],
    ['Gift-card callout.', insertIntoMain(`  <section class="giftcard"><h2>Gift cards</h2><p>Any amount, never expires.</p></section>`)],
    ['Student discount strip.', insertIntoMain(`  <p class="seasonal">Students get 10% off with ID.</p>`)],
    ['Mobile nav simplification.', appendCss(`@media (max-width: 600px) { nav a { display: block; text-align: center; } }\n`)],
    ['Review stars under the hero.', insertIntoMain(`  <p class="badges">★★★★★ “Best flat white in town.” — Dana</p>`)],
    ['Order-status microcopy polish.', appendCss(`.form-status { min-height: 1.4em; font-weight: 600; margin-top: var(--space-1); }\n`)],
    ['Print-friendly menu stylesheet.', appendCss(`@media print { nav, .hero, .teaser { display: none; } .menu-cards { grid-template-columns: 1fr 1fr; } }\n`)],
    ['Skip-to-order link hint.', editFile('index.html', (html) => html.replace('Skip to order form</a>', 'Skip to order form ↓</a>'))],
    ['Catering teaser section.', insertIntoMain(`  <section class="giftcard"><h2>Catering</h2><p>Office drops of 10+ cups, same week.</p></section>`)],
    ['Currency clarity on prices.', appendCss(`.prices td { font-variant-numeric: tabular-nums; }\n`)],
    ['Holiday hours banner.', insertIntoMain(`  <p class="seasonal">Thanksgiving: open 8–13.</p>`)],
    ['Cookie-free analytics note.', insertIntoMain(`  <p class="badges">We count visits without cookies.</p>`)],
    ['Empty-state for the form status.', appendCss(`.form-status:empty { border: none; }\n.form-status { border: 1px dashed rgba(0,0,0,0.15); padding: var(--space-1); border-radius: var(--radius); }\n`)],
    ['Merch teaser.', insertIntoMain(`  <section class="giftcard"><h2>Beans to go</h2><p>250g bags of the house roast.</p></section>`)],
    ['Multilingual welcome strip (static, honest).', insertIntoMain(`  <p class="badges">Café · Kaffe · 커피 · コーヒー — however you say it, it’s ready.</p>`)],
    ['Final typography scale.', appendCss(`h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); }\nh2 { font-size: clamp(1.2rem, 2.5vw, 1.6rem); }\np, li { max-width: 65ch; }\n`)],
    ['Social links in the footer.', editFile('index.html', (html) => html.replace('</footer>', '  <nav aria-label="Social"><a href="#top">Instagram</a> · <a href="#top">Newsletter</a></nav>\n</footer>'))],
    ['Focus style for form inputs.', appendCss(`.order-form input:focus { outline: 3px solid var(--accent); }\n`)],
    ['Upsell size hint.', editFile('index.html', (html) => html.replace('<option selected>Medium</option>', '<option selected>Medium</option><!-- large is only $0.50 more -->'))],
  ];
  const [summary, edit] = pool[(((r - 23) % pool.length) + pool.length) % pool.length];
  return { summary, edits: [edit] };
}

// ------------------------------------------------------------------- opus ---

function opusPlan(ctx) {
  const r = ctx.round;
  const a = ctx.attemptNo;

  switch (r) {
    case 1:
      return { summary: 'Full visual redesign: design language, shadows, spacing, type.', edits: [appendCss(featureCss('redesign', 8))] };
    case 2:
      return {
        summary: 'Restructure the page into semantic sections and go responsive.',
        edits: [
          editFile('index.html', (html) => html.replace('<main>', '<main>\n  <div class="page-shell" data-layout="v2">').replace('</main>', '</div>\n</main>')),
          appendCss(featureCss('layout', 4)),
          appendCss(
            `@media (max-width: 768px) {\n  .page-shell { display: block; }\n  nav ul { display: grid; grid-template-columns: 1fr 1fr; }\n  .hero-img { width: 100%; }\n}\n\n@media (max-width: 480px) {\n  body { font-size: 15px; }\n  .page-shell { padding: 0 0.5rem; }\n}\n`
          ),
        ],
      };
    case 3:
      return {
        summary: 'Rebuild the order form on a validation framework with inline errors.',
        edits: [
          (ctx) =>
            W(
              'js/form.js',
              `(function () {\n  'use strict';\n\n  var form = document.getElementById('order-form');\n  var status = document.getElementById('order-status');\n  if (!form) return;\n\n  var validators = {\n    drink: function (v) { return v ? '' : 'Pick a drink'; },\n    size: function (v) { return v ? '' : 'Pick a size'; },\n    name: function (v) { return v ? '' : 'Name is required for the cup'; }\n  };\n\n  form.addEventListener('submit', function (event) {\n    event.preventDefault();\n    var errors = [];\n    Object.keys(validators).forEach(function (field) {\n      var value = form.elements[field] ? form.elements[field].value : '';\n      var message = validators[field](value);\n      if (message) errors.push(message);\n    });\n    if (errors.length) {\n      status.textContent = errors.join(' · ');\n      status.className = 'form-status error';\n      return;\n    }\n    status.textContent = 'Order placed — ' + form.elements['size'].value + ' ' + form.elements['drink'].value + ' for ' + form.elements['name'].value + '.';\n    status.className = 'form-status ok';\n  });\n})();\n`
            ),
        ],
      };
    case 4:
      return {
        summary: 'Cinematic hero image with gradient overlay.',
        edits: [
          writeAsset(
            'assets/hero.svg',
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b2118"/><stop offset="1" stop-color="#6f4e37"/></linearGradient></defs><rect width="1200" height="600" fill="url(#g)"/><circle cx="600" cy="300" r="180" fill="#fdf6ec" opacity="0.9"/></svg>\n'
          ),
          heroWithImage('assets/hero.svg', 'Hero visual'),
        ],
      };
    case 5:
      return {
        summary: 'Motion framework: scroll reveals, hover states, transitions.',
        edits: [
          appendCss(featureCss('motion', 6)),
          insertIntoMain(featureSection('motion', 'Motion', 2)),
          addScript('motion.js', featureJs('motion', 10)),
        ],
      };
    case 6:
      return { summary: 'Ship a UI component library (buttons, cards, chips, modals).', edits: big('component-library', 14, 4) };
    case 7:
      return { summary: 'A tiny state manager so widgets share one source of truth.', edits: big('state-manager', 16) };
    case 8:
      return { summary: 'Theming system with runtime theme switching.', edits: big('theming', 12, 3) };
    case 9:
      return {
        summary: 'Full-bleed video hero with sound-off poster frame.',
        edits: [
          insertIntoMain(`  <section class="teaser"><video controls poster="assets/teaser.svg" width="960" preload="metadata"><source src="assets/brand-film.mp4" type="video/mp4" /></video></section>`),
          writeAsset('assets/teaser.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#1d140e"/><polygon points="420,200 560,270 420,340" fill="#fdf6ec"/></svg>\n'),
        ],
      };
    case 10:
      return { summary: 'Micro-interactions everywhere: magnetic buttons, ripples, toasts.', edits: big('micro-interactions', 15, 3) };
    case 11:
      return {
        summary: 'PWA: manifest + service worker for offline menu browsing.',
        edits: [
          (ctx) => W('manifest.webmanifest', JSON.stringify({ name: 'Bean Street Coffee', short_name: 'Bean', start_url: '.', display: 'standalone', background_color: '#fdf6ec', theme_color: '#6f4e37', icons: [] }, null, 2) + '\n'),
          addScript('sw-register.js', `if ('serviceWorker' in navigator) {\n  navigator.serviceWorker.register('sw.js').catch(function () {});\n}\n`),
          (ctx) =>
            W(
              'sw.js',
              `var CACHE = 'bean-v1';\nvar ASSETS = ['/', '/index.html', '/css/style.css'];\n\nself.addEventListener('install', function (event) {\n  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(ASSETS); }));\n});\n\nself.addEventListener('fetch', function (event) {\n  event.respondWith(caches.match(event.request).then(function (hit) { return hit || fetch(event.request); }));\n});\n`
            ),
        ],
      };
    case 12:
      return { summary: 'First-party analytics module with funnel events.', edits: big('analytics', 13, 2) };
    case 13:
      return {
        summary: 'Bold differentiator: an interactive pumpkin-carving configurator for the season.',
        edits: [
          insertIntoMain(
            `  <section class="pumpkin-lab" aria-label="Pumpkin carving lab">\n    <h2>Pumpkin-Carving Configurator</h2>\n    <p>Pick a stencil, preview the carve, add it to your order.</p>\n    <div id="pumpkin-lab-slot-0" class="pumpkin-lab__row-0"></div>\n  </section>`
          ),
          addScript('pumpkin.js', featureJs('pumpkin-lab', 12)),
        ],
      };
    case 14:
      return { summary: 'Design tokens extracted to their own layer.', edits: big('design-tokens', 14) };
    case 15:
      return { summary: 'i18n scaffold with message catalogs.', edits: big('i18n', 15, 2) };
    case 16:
      return {
        summary: 'Canvas-based order visualiser.',
        edits: [
          insertIntoMain(`  <section class="order-viz"><canvas id="order-viz-canvas" width="480" height="260"></canvas><span id="order-viz-slot-0" hidden></span></section>`),
          addScript('order-viz.js', featureJs('order-viz', 11)),
        ],
      };
    case 17:
      return { summary: 'Live order board (websocket stub with graceful fallback).', edits: big('live-orders', 16, 4) };
    case 18:
      return { summary: 'ML-style drink recommender (rules-based stand-in).', edits: big('recommender', 14, 3) };
    case 19:
      return { summary: 'Blog engine with markdown-ish parsing.', edits: big('blog-engine', 17, 4) };
    case 20:
      return {
        summary: 'Admin dashboard page for staff.',
        edits: [
          (ctx) =>
            W(
              'admin.html',
              `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8" /><title>Bean Street Admin</title><link rel="stylesheet" href="css/style.css" /></head>\n<body>\n<main>\n  <h1>Admin</h1>\n  <section id="admin-panel">Staff only.</section>\n</main>\n</body>\n</html>\n`
            ),
          ...big('admin-dashboard', 13, 3),
        ],
      };
    case 21:
      return { summary: 'Dark mode.', edits: big('dark-mode', 10, 2) };
    case 22:
      return { summary: 'Print stylesheet for the menu.', edits: big('print-styles', 8, 2) };
    case 23:
      return { summary: 'In-repo test harness for the form validators.', edits: big('test-harness', 18, 2) };
    case 24:
      return {
        summary: 'Content layer: menu data in JSON with a loader.',
        edits: [
          (ctx) => {
            fs.mkdirSync(path.join(ctx.root, 'content'), { recursive: true });
            return W('content/menu.json', JSON.stringify({ drinks: [{ id: 'espresso', price: 3.5 }, { id: 'flat-white', price: 4.25 }] }, null, 2) + '\n');
          },
          ...big('content-loader', 12, 2),
        ],
      };
    case 25:
      return { summary: 'Account UI stub with sign-in sheet.', edits: big('auth-ui', 14, 3) };
    case 26:
      return {
        summary: 'Charts on canvas for weekly orders.',
        edits: [
          insertIntoMain(`  <section class="charts"><canvas id="charts-canvas" width="520" height="280"></canvas><span id="charts-slot-0" hidden></span></section>`),
          addScript('charts.js', featureJs('charts', 12)),
        ],
      };
    case 27:
      return { summary: 'Notification center with toasts.', edits: big('notifications', 13, 2) };
    case 28:
      return { summary: 'Review aggregator widget.', edits: big('review-aggregator', 12, 3) };
    case 29:
      return { summary: 'Gift card purchase flow.', edits: big('gift-cards', 14, 3) };
    case 30:
      if (a === 1) {
        // The "language toggle that didn't work": the toggle JS references ids
        // that never exist in the DOM.
        return {
          summary: 'Language toggle with EN/ES/KO catalogs.',
          edits: [
            addScript(
              'lang.js',
              `(function () {\n  'use strict';\n  var toggle = document.getElementById('lang-select');\n  var panel = document.getElementById('i18n-panel');\n  if (!toggle) return;\n  toggle.addEventListener('change', function () {\n    panel.textContent = 'Language: ' + toggle.value;\n  });\n})();\n`
            ),
            ...big('i18n-catalog', 10, 2),
          ],
        };
      }
      return {
        summary: 'Language toggle, now wired to a real control in the nav.',
        edits: [
          editFile('index.html', (html) =>
            html.replace(
              '</nav>',
              '  <select id="lang-select" aria-label="Language"><option>EN</option><option>ES</option><option>KO</option></select>\n  <span id="i18n-panel" role="status"></span>\n</nav>'
            )
          ),
        ],
      };
    case 31:
      return { summary: 'Booking system for the tasting room.', edits: big('booking', 15, 4) };
    case 32:
      return { summary: 'Events calendar.', edits: big('events', 13, 4) };
    case 33:
      return { summary: 'Merch store with cart.', edits: big('merch-store', 16, 4) };
    case 34:
      return { summary: 'Loyalty plus: tiers and stamps.', edits: big('loyalty-plus', 14, 3) };
    case 35:
      return { summary: 'Gift registry.', edits: big('gift-registry', 12, 3) };
    case 36:
      return { summary: 'Catering quote builder.', edits: big('catering-quotes', 15, 4) };
    case 37:
      return { summary: 'Blog comments with moderation queue stub.', edits: big('comments', 12, 3) };
    case 38:
      if (a === 1) {
        // Regression drill: refactor renames the order-form id out from under
        // the critical selector and the form script.
        return {
          summary: 'Rename order-form to orderForm for consistency.',
          edits: [editFile('index.html', (html) => html.replace(/id="order-form"/g, 'id="orderForm"'))],
        };
      }
      return {
        summary: 'Keep the stable order-form id; alias it in JS instead.',
        edits: [addScript('form-alias.js', `window.orderFormAlias = document.getElementById('order-form');\n`)],
      };
    case 39:
      return { summary: 'Search index over menu + blog.', edits: big('search-index', 14, 3) };
    case 40:
      return { summary: 'Responsive images with srcset scaffolding.', edits: big('responsive-images', 10, 2) };
    case 41:
      return { summary: 'Cookie banner module.', edits: big('cookie-banner', 11, 2) };
    case 42:
      return { summary: 'Waitlist for limited roasts.', edits: big('waitlist', 12, 3) };
    case 43:
      return { summary: 'Subscription coffee plan.', edits: big('subscriptions', 15, 4) };
    case 44:
      return { summary: 'A11y audit page with findings.', edits: big('a11y-audit', 13, 3) };
    case 45:
      return { summary: 'Perf budget tracker.', edits: big('perf-budget', 12, 2) };
    case 46:
      return { summary: 'Order status page with timeline.', edits: big('order-status', 14, 4) };
    case 47:
      return { summary: 'Staff tips split calculator.', edits: big('tips-split', 10, 2) };
    case 48:
      return { summary: 'Seasonal campaign scheduler.', edits: big('campaigns', 13, 3) };
    case 49:
      return { summary: 'Barista leaderboard.', edits: big('leaderboard', 12, 3) };
    case 50:
      return { summary: 'Grand unification stylesheet pass.', edits: [appendCss(featureCss('unification', 10))] };
    default:
      return { summary: 'Additional polish.', edits: big(`feature-${r}`, 10, 2) };
  }
}
