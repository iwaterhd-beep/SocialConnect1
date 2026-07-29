/** Configuración pública del proyecto (Supabase + dominio). */
window.SC_CONFIG = {
  url: 'https://lkpyybmqvyhevcifezws.supabase.co',
  anonKey: 'sb_publishable_Qwso1wNWAMe0AYxXer97wg_XkGR_P0b',
  anonKeyLegacy: '',
  /** Si el usuario escribe solo "nombre" sin @, se usa nombre@{loginEmailDomain} */
  loginEmailDomain: 'socialconnectcs.com',
  partialsBase: 'partials/',
  publicSiteOrigin: 'https://socialconnectcs.com',
};

/** Moneda de visualización del club (€, Crd, …). Los importes en BD siguen en *_eur. */
(function initScCurrency() {
  const DEFAULT_SYMBOL = '€';
  let symbol = DEFAULT_SYMBOL;

  function normalizeCurrencySymbol(raw) {
    const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
    if (!s) return DEFAULT_SYMBOL;
    return s.slice(0, 8);
  }

  window.scGetCurrencySymbol = function scGetCurrencySymbol() {
    return symbol || DEFAULT_SYMBOL;
  };

  window.scSetCurrencySymbol = function scSetCurrencySymbol(raw) {
    symbol = normalizeCurrencySymbol(raw);
    try {
      if (typeof window.scRefreshCurrencyDom === 'function') window.scRefreshCurrencyDom();
    } catch (_) {
      /* ignore */
    }
    return symbol;
  };

  window.scFormatMoney = function scFormatMoney(n, opts) {
    const x = Number(n);
    if (Number.isNaN(x)) return '—';
    const min = opts && opts.minimumFractionDigits != null ? opts.minimumFractionDigits : 2;
    const max = opts && opts.maximumFractionDigits != null ? opts.maximumFractionDigits : 2;
    const num = x.toLocaleString('es-ES', {
      minimumFractionDigits: min,
      maximumFractionDigits: max,
    });
    return `${num}\u00a0${window.scGetCurrencySymbol()}`;
  };

  window.scFormatMoneyPer = function scFormatMoneyPer(n, unit) {
    const base = window.scFormatMoney(n);
    if (!unit) return base;
    return `${base}/${unit}`;
  };

  window.scRefreshCurrencyDom = function scRefreshCurrencyDom() {
    const sym = window.scGetCurrencySymbol();
    document.querySelectorAll('.sc-currency-sym').forEach((el) => {
      el.textContent = sym;
    });
    document.querySelectorAll('[data-currency-label]').forEach((el) => {
      const tpl = el.getAttribute('data-currency-label') || '';
      el.textContent = tpl.split('{s}').join(sym);
    });
    document.querySelectorAll('[data-currency-placeholder]').forEach((el) => {
      const tpl = el.getAttribute('data-currency-placeholder') || '{s}';
      el.setAttribute('placeholder', tpl.split('{s}').join(sym));
    });
  };
})();
