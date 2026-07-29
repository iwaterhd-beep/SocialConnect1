/**
 * Carga el HTML de cada vista del panel desde partials/ (separado de dashboard-club.html).
 * Requiere servir la carpeta por HTTP (p. ej. python -m http.server); file:// puede fallar por CORS.
 * Incluye helper de modales: foco, Escape y trampa de Tab.
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

  function isModalOpen(modal) {
    return Boolean(modal && !modal.classList.contains('is-hidden') && modal.getAttribute('aria-hidden') !== 'true');
  }

  function openModalsTopFirst() {
    return Array.from(document.querySelectorAll('.shift-modal')).filter(isModalOpen).reverse();
  }

  function syncClubModalOpenClass() {
    const hasOpen = openModalsTopFirst().length > 0;
    document.body.classList.toggle('club-modal-open', hasOpen);
  }

  function getFocusable(root) {
    if (!root) return [];
    const sel =
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(root.querySelectorAll(sel)).filter((el) => {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (el.closest('[hidden]')) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    });
  }

  function restoreModalFocus(modal) {
    if (!modal) return;
    const prev = modal.__scPrevFocus;
    modal.__scPrevFocus = null;
    if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
      try {
        prev.focus({ preventScroll: true });
      } catch (_) {
        try {
          prev.focus();
        } catch (__) {
          /* ignore */
        }
      }
    }
  }

  function ensureDialogA11y(modal) {
    const panel =
      modal.querySelector('.shift-modal__panel[role="dialog"]') ||
      modal.querySelector('.shift-modal__panel');
    if (!panel) return panel;
    if (!panel.hasAttribute('role')) panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    return panel;
  }

  function focusModalPanel(modal) {
    const panel = ensureDialogA11y(modal);
    const focusables = getFocusable(panel || modal);
    const target = focusables[0] || panel;
    if (!target || typeof target.focus !== 'function') return;
    try {
      target.focus({ preventScroll: true });
    } catch (_) {
      try {
        target.focus();
      } catch (__) {
        /* ignore */
      }
    }
  }

  function requestCloseModal(modal) {
    if (!modal || !isModalOpen(modal)) return;
    if (modal.getAttribute('data-sc-no-escape') === '1') return;
    if (typeof modal.__scOnEscape === 'function') {
      modal.__scOnEscape();
      return;
    }
    const explicit = modal.querySelector('[data-sc-modal-close]');
    if (explicit) {
      explicit.click();
      return;
    }
    const backdrop = modal.querySelector('.shift-modal__backdrop');
    if (backdrop) {
      backdrop.click();
      return;
    }
    window.scCloseShiftModal(modal);
  }

  function onModalKeydown(e) {
    const open = openModalsTopFirst();
    if (!open.length) return;
    const modal = open[0];

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestCloseModal(modal);
      return;
    }

    if (e.key !== 'Tab') return;
    const panel =
      modal.querySelector('.shift-modal__panel') || modal;
    const focusables = getFocusable(panel);
    if (!focusables.length) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function watchClubModals() {
    if (watchClubModals.ready) return;
    watchClubModals.ready = true;
    const observer = new MutationObserver((mutations) => {
      syncClubModalOpenClass();
      mutations.forEach((m) => {
        const modal = m.target;
        if (!modal || !modal.classList || !modal.classList.contains('shift-modal')) return;
        if (!isModalOpen(modal) && modal.__scPrevFocus) {
          restoreModalFocus(modal);
        }
      });
    });
    document.querySelectorAll('.shift-modal').forEach((modal) => {
      observer.observe(modal, { attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden'] });
    });
    document.addEventListener('keydown', onModalKeydown, true);
  }

  window.scOpenShiftModal = function scOpenShiftModal(modal) {
    if (!modal) return;
    document.body.appendChild(modal);
    if (!modal.__scPrevFocus) {
      modal.__scPrevFocus = document.activeElement;
    }
    modal.classList.remove('is-hidden', 'is-leaving');
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    modal.scrollTop = 0;
    const panel = ensureDialogA11y(modal);
    if (panel) panel.scrollTop = 0;
    modal.querySelectorAll('.shift-modal__body--scroll').forEach((el) => {
      el.scrollTop = 0;
    });
    syncClubModalOpenClass();
    requestAnimationFrame(() => {
      modal.scrollTop = 0;
      if (panel) panel.scrollTop = 0;
      focusModalPanel(modal);
    });
  };

  window.scCloseShiftModal = function scCloseShiftModal(modal) {
    if (!modal) return;
    modal.classList.add('is-hidden');
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    syncClubModalOpenClass();
    restoreModalFocus(modal);
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
    if (typeof window.scRefreshCurrencyDom === 'function') {
      window.scRefreshCurrencyDom();
    }
  };
})();
