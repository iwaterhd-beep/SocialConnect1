/**
 * Pantalla de entrada — logo; se puede saltar, auto-cierra y respeta reduced-motion.
 */
(function () {
  const splash = document.getElementById('auth-splash');
  const trigger = document.getElementById('auth-splash-trigger');
  const hint = document.getElementById('auth-splash-hint');
  const authPage = document.getElementById('auth-page');
  if (!splash || !trigger || !authPage) return;

  const LEAVE_MS = 520;
  const AUTO_MS = 2200;
  const SKIP_KEY = 'sc-skip-auth-splash';
  let leaving = false;
  let autoTimer = null;

  function shouldSkipSplash() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has('skipSplash') || params.get('splash') === '0') return true;
    } catch (_) {
      /* ignore */
    }
    if (window.location.hash === '#acceso') return true;
    try {
      if (localStorage.getItem(SKIP_KEY) === '1') return true;
    } catch (_) {
      /* ignore */
    }
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  function rememberSkip() {
    try {
      localStorage.setItem(SKIP_KEY, '1');
    } catch (_) {
      /* ignore */
    }
  }

  function revealLogin() {
    if (autoTimer) {
      window.clearTimeout(autoTimer);
      autoTimer = null;
    }
    splash.hidden = true;
    splash.classList.remove('is-leaving', 'is-blinking');
    authPage.classList.remove('auth-page--splash-hidden');
    document.body.classList.remove('auth-splash-open');
    window.dispatchEvent(new CustomEvent('socialconnect:landing-ready'));
  }

  function enterWithAnimation(persistSkip) {
    if (leaving) return;
    leaving = true;
    if (persistSkip) rememberSkip();
    splash.classList.remove('is-blinking');
    splash.classList.add('is-leaving');
    if (hint) hint.textContent = 'Entrando…';
    window.setTimeout(revealLogin, LEAVE_MS);
  }

  if (shouldSkipSplash()) {
    revealLogin();
    return;
  }

  if (hint) {
    hint.textContent = 'Pulsa el logo o espera un momento…';
  }

  trigger.addEventListener('click', () => enterWithAnimation(true));

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      enterWithAnimation(true);
    }
  });

  autoTimer = window.setTimeout(() => enterWithAnimation(true), AUTO_MS);
})();
