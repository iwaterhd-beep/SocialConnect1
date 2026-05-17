/**
 * Menú público para tablet — /menu/?club=slug
 */
(function () {
  const sb = () => window.scSupabase;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function strainLabel(strain) {
    if (strain === 'sativa') return 'Sativa';
    if (strain === 'indica') return 'Indica';
    return '';
  }

  function splitPriceLabel(label) {
    const t = (label || '').trim();
    if (!t || t === '—') return { main: '—', sub: '' };
    if (/€\/g\s*$/i.test(t)) {
      return { main: t.replace(/\s*€\/g\s*$/i, '').trim(), sub: '€/g' };
    }
    if (/€\s*$/i.test(t)) {
      return { main: t.replace(/\s*€\s*$/i, '').trim(), sub: '€' };
    }
    return { main: t, sub: '' };
  }

  /** Valor numérico para ordenar (sin precio → al final). */
  function menuPriceSortValue(p) {
    if (p.price_sort != null && p.price_sort !== '') {
      const n = Number(p.price_sort);
      if (!Number.isNaN(n)) return n;
    }
    const label = (p.price_label || '').trim();
    if (!label || label === '—') return Number.POSITIVE_INFINITY;
    const m = label.replace(',', '.').match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : Number.POSITIVE_INFINITY;
  }

  function sortMenuProductsByPrice(products) {
    return (products || []).slice().sort((a, b) => {
      const pa = menuPriceSortValue(a);
      const pb = menuPriceSortValue(b);
      if (pa !== pb) return pa - pb;
      return String(a.name || '').localeCompare(String(b.name || ''), 'es', {
        sensitivity: 'base',
      });
    });
  }

  function resolveMenuSlug() {
    const params = new URLSearchParams(window.location.search);
    const q = (params.get('club') || params.get('slug') || '').trim().toLowerCase();
    if (q) return q;
    const parts = window.location.pathname.replace(/\/+$/, '').split('/');
    const menuIdx = parts.indexOf('menu');
    if (menuIdx >= 0 && parts[menuIdx + 1] && parts[menuIdx + 1] !== 'index.html') {
      return parts[menuIdx + 1].toLowerCase();
    }
    return '';
  }

  function renderMenu(data) {
    const main = $('menu-main');
    const nav = $('menu-cat-nav');
    const status = $('menu-status');
    const title = $('menu-club-name');
    if (!main) return;

    if (!data || !data.ok) {
      if (title) title.textContent = 'Menú';
      if (status) status.textContent = '';
      main.innerHTML =
        '<p class="menu-error">No encontramos este menú. Comprueba el enlace con el club.</p>';
      if (nav) nav.hidden = true;
      return;
    }

    if (title) title.textContent = data.club_name || 'Menú';
    const categories = data.categories || [];
    const withProducts = categories.filter((c) => (c.products || []).length > 0);

    if (status) {
      status.textContent = withProducts.length
        ? `${withProducts.length} categoría(s) con stock`
        : 'Sin productos disponibles ahora';
    }

    if (!withProducts.length) {
      main.innerHTML = '<p class="menu-empty">No hay productos con stock en este momento.</p>';
      if (nav) nav.hidden = true;
      return;
    }

    if (nav) {
      nav.hidden = false;
      nav.innerHTML = '';
      withProducts.forEach((cat, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-cat-nav__btn' + (i === 0 ? ' is-active' : '');
        btn.textContent = cat.name;
        btn.setAttribute('data-cat-target', 'menu-cat-' + i);
        btn.addEventListener('click', () => {
          nav.querySelectorAll('.menu-cat-nav__btn').forEach((b) => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          const el = document.getElementById(btn.getAttribute('data-cat-target'));
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        nav.appendChild(btn);
      });
    }

    main.innerHTML = '';
    withProducts.forEach((cat, i) => {
      const section = document.createElement('section');
      section.className = 'menu-section';
      section.id = 'menu-cat-' + i;

      const head = document.createElement('div');
      head.className = 'menu-section__head';
      const h = document.createElement('h2');
      h.className = 'menu-section__title';
      h.textContent = cat.name;
      const line = document.createElement('div');
      line.className = 'menu-section__line';
      head.appendChild(h);
      head.appendChild(line);
      section.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'menu-grid';

      sortMenuProductsByPrice(cat.products).forEach((p, pi) => {
        const card = document.createElement('article');
        card.className = 'menu-card menu-card--t' + (pi % 6);

        const glow = document.createElement('div');
        glow.className = 'menu-card__glow';
        card.appendChild(glow);

        const emojiWrap = document.createElement('div');
        emojiWrap.className = 'menu-card__emoji-wrap';
        const em = document.createElement('span');
        em.className = 'menu-card__emoji';
        em.textContent = (p.emoji || '').trim() || '🌿';
        emojiWrap.appendChild(em);
        card.appendChild(emojiWrap);

        const body = document.createElement('div');
        body.className = 'menu-card__body';
        const nm = document.createElement('h3');
        nm.className = 'menu-card__name';
        nm.textContent = p.name;
        body.appendChild(nm);

        if (p.strain) {
          const st = document.createElement('span');
          st.className = 'menu-card__strain menu-card__strain--' + p.strain;
          st.textContent = strainLabel(p.strain);
          body.appendChild(st);
        }
        card.appendChild(body);

        const priceParts = splitPriceLabel(p.price_label);
        const price = document.createElement('p');
        price.className = 'menu-card__price';
        if (priceParts.sub) {
          price.innerHTML = `<small>Precio</small>${escapeHtml(priceParts.main)} <span>${escapeHtml(priceParts.sub)}</span>`;
        } else {
          price.innerHTML = `<small>Precio</small>${escapeHtml(priceParts.main)}`;
        }
        card.appendChild(price);

        grid.appendChild(card);
      });

      section.appendChild(grid);
      main.appendChild(section);
    });
  }

  async function init() {
    const slug = resolveMenuSlug();
    const main = $('menu-main');
    if (!slug) {
      if (main) {
        main.innerHTML =
          '<p class="menu-error">Indica el club en la URL: <code>/menu/?club=tu-club</code></p>';
      }
      return;
    }

    if (!sb()) {
      if (main) main.innerHTML = '<p class="menu-error">Error de configuración (Supabase).</p>';
      return;
    }

    const { data, error } = await sb().rpc('club_public_menu', { p_slug: slug });
    if (error) {
      if (main) {
        main.innerHTML = `<p class="menu-error">${escapeHtml(error.message || 'No se pudo cargar el menú.')}</p>`;
      }
      return;
    }
    renderMenu(data);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    void init();
  }
})();
