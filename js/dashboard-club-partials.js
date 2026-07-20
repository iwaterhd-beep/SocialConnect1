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

  function hoistViewModals() {
    document.querySelectorAll('.club-view .shift-modal').forEach((modal) => {
      document.body.appendChild(modal);
    });
  }

  function syncClubModalOpenClass() {
    const hasOpen = Boolean(document.querySelector('.shift-modal:not(.is-hidden)'));
    document.body.classList.toggle('club-modal-open', hasOpen);
  }

  function watchClubModals() {
    if (watchClubModals.ready) return;
    watchClubModals.ready = true;
    const observer = new MutationObserver(() => syncClubModalOpenClass());
    document.querySelectorAll('.shift-modal').forEach((modal) => {
      observer.observe(modal, { attributes: true, attributeFilter: ['class', 'hidden'] });
    });
  }

  window.scOpenShiftModal = function scOpenShiftModal(modal) {
    if (!modal) return;
    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
    modal.classList.remove('is-hidden', 'is-leaving');
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    modal.scrollTop = 0;
    const panel = modal.querySelector('.shift-modal__panel');
    if (panel) panel.scrollTop = 0;
    modal.querySelectorAll('.shift-modal__body--scroll').forEach((el) => {
      el.scrollTop = 0;
    });
    syncClubModalOpenClass();
    requestAnimationFrame(() => {
      modal.scrollTop = 0;
      if (panel) panel.scrollTop = 0;
    });
  };

  window.scSyncClubModalOpenClass = syncClubModalOpenClass;

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
    hoistViewModals();
    watchClubModals();
  };
})();
