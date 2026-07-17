/**
 * Carga el HTML de cada vista del panel desde partials/ (separado de dashboard-club.html).
 * Requiere servir la carpeta por HTTP (p. ej. python -m http.server); file:// puede fallar por CORS.
 */
(function () {
  function baseUrl() {
    const fromConfig = window.SC_CONFIG && window.SC_CONFIG.partialsBase;
    if (fromConfig) return String(fromConfig).replace(/\/?$/, '/');
    return 'partials/';
  }

  async function fetchPartial(path) {
    const url = baseUrl() + path;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} al cargar ${url}`);
    }
    return res.text();
  }

  /**
   * Inserta el HTML en el contenedor y devuelve una promesa.
   */
  async function inject(selector, filename) {
    const el = document.querySelector(selector);
    if (!el) return;
    const html = await fetchPartial(filename);
    el.innerHTML = html;
  }

  window.SCClubLoadPartials = async function () {
    await Promise.all([
      inject('#club-view-home', 'club-view-home.html'),
      inject('#club-view-tpv', 'club-view-tpv.html'),
      inject('#club-view-inventory', 'club-view-inventory.html'),
      inject('#club-view-stock', 'club-view-stock.html'),
      inject('#club-view-members', 'club-view-members.html'),
      inject('#club-view-finance', 'club-view-finance.html'),
      inject('#club-view-membership', 'club-view-membership.html'),
      inject('#club-view-settings', 'club-view-settings.html'),
    ]);
  };
})();
