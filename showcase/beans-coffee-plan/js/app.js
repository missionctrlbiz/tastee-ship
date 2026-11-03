/* app.js — cart + order ticket for the Bean Street pumpkin patch.
   Listens for additions from the menu and the carving studio, keeps the
   order form in sync, validates, and persists the ticket in localStorage. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const itemsEl = $('order-items');
  const totalEl = $('order-total');
  const countEl = $('cart-count');
  const statusEl = $('order-status');
  const form = $('order-form');

  let items = [];
  try {
    items = JSON.parse(localStorage.getItem('beanstreet-ticket') || '[]');
    if (!Array.isArray(items)) items = [];
  } catch {
    items = [];
  }

  const money = (n) => `$${n.toFixed(2)}`;

  function render() {
    itemsEl.innerHTML = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'order-empty';
      li.dataset.testid = 'order-empty';
      li.textContent = 'Nothing yet — add a drink or a carved pumpkin above.';
      itemsEl.appendChild(li);
    } else {
      for (const it of items) {
        const li = document.createElement('li');
        const left = document.createElement('span');
        left.textContent = it.qty > 1 ? `${it.name} × ${it.qty}` : it.name;
        if (it.dim) {
          const dim = document.createElement('span');
          dim.className = 'item-dim';
          dim.textContent = it.dim;
          left.appendChild(dim);
        }
        const right = document.createElement('span');
        right.className = 'item-price tabular';
        right.textContent = money(it.price * it.qty);
        li.append(left, right);
        itemsEl.appendChild(li);
      }
    }
    const total = items.reduce((a, it) => a + it.price * it.qty, 0);
    totalEl.textContent = money(total);
    totalEl.dataset.price = total.toFixed(2);
    const count = items.reduce((a, it) => a + it.qty, 0);
    countEl.textContent = count;
    try { localStorage.setItem('beanstreet-ticket', JSON.stringify(items)); } catch { /* private mode */ }
  }

  function add(detail) {
    const twin = items.find((it) => it.name === detail.name && it.dim === detail.dim);
    if (twin) twin.qty += 1;
    else items.push({ name: detail.name, price: detail.price, dim: detail.dim || '', qty: 1 });
    render();
    countEl.animate?.(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.5)' }, { transform: 'scale(1)' }],
      { duration: 260, easing: 'ease-out' }
    );
  }

  document.addEventListener('bean:add', (e) => add(e.detail));
  document.querySelectorAll('.add-drink').forEach((b) =>
    b.addEventListener('click', () =>
      add({ name: b.dataset.drink, price: parseFloat(b.dataset.price), dim: 'patch menu' })
    )
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('o-name').value.trim();
    statusEl.className = 'form-status';
    if (!name) {
      statusEl.textContent = 'Who are we label the cup for? Add your name first.';
      statusEl.className = 'form-status err';
      $('o-name').focus();
      return;
    }
    if (!items.length) {
      statusEl.textContent = 'The ticket is empty — add something from the patch first.';
      statusEl.className = 'form-status err';
      return;
    }
    statusEl.innerHTML = `Thanks ${name} — ticket in. ${$('o-time').value.split('·').pop().trim()} at the counter. Your pumpkins keep 3 days; candle included.`;
    statusEl.className = 'form-status ok';
    items = [];
    render();
  });

  // reveal-on-scroll (honours reduced motion, fails safe: content can never
  // stay invisible — IO reveals on intersect, and a timer reveals the rest)
  const revealables = document.querySelectorAll('.card, .hero-copy, .hero-art');
  const reveal = (el) => {
    el.style.opacity = 1;
    el.style.transform = 'none';
  };
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => {
        if (en.isIntersecting) {
          reveal(en.target);
          io.unobserve(en.target);
        }
      }),
      { threshold: 0.08 }
    );
    revealables.forEach((el) => {
      if (el.getBoundingClientRect().top > innerHeight * 0.9) {
        el.style.opacity = 0;
        el.style.transform = 'translateY(22px)';
        el.style.transition = 'opacity 0.55s ease, transform 0.55s cubic-bezier(0.2, 0.8, 0.3, 1)';
      }
      io.observe(el);
    });
    setTimeout(() => revealables.forEach(reveal), 2500); // failsafe: never stay hidden
  }

  $('yr').textContent = new Date().getFullYear();
  render();
})();
