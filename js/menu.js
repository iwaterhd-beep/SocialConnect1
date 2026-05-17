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

      const h = document.createElement('h2');
      h.className = 'menu-section__title';
      h.textContent = cat.name;
      section.appendChild(h);

      const grid = document.createElement('div');
      grid.className = 'menu-grid';

      (cat.products || []).forEach((p) => {
        const row = document.createElement('article');
        row.className = 'menu-item';

        const nameWrap = document.createElement('div');
        nameWrap.className = 'menu-item__name';
        if (p.emoji) {
          const em = document.createElement('span');
          em.className = 'menu-item__emoji';
          em.textContent = p.emoji;
          nameWrap.appendChild(em);
        }
        const nm = document.createElement('span');
        nm.textContent = p.name;
        nameWrap.appendChild(nm);

        if (p.strain) {
          const st = document.createElement('span');
          st.className = 'menu-item__strain menu-item__strain--' + p.strain;
          st.textContent = strainLabel(p.strain);
          nameWrap.appendChild(st);
        }

        const price = document.createElement('span');
        price.className = 'menu-item__price';
        price.textContent = p.price_label || '—';

        row.appendChild(nameWrap);
        row.appendChild(price);
        grid.appendChild(row);
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
