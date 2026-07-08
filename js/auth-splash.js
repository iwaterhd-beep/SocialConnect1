/**
 * Pantalla de entrada — logo grande parpadeante; al pulsar, animación y acceso al login.
 */
(function () {
  const splash = document.getElementById('auth-splash');
  const trigger = document.getElementById('auth-splash-trigger');
  const hint = document.getElementById('auth-splash-hint');
  const authPage = document.getElementById('auth-page');
  if (!splash || !trigger || !authPage) return;

  const LEAVE_MS = 950;
  let leaving = false;

  function revealLogin() {
    splash.hidden = true;
    splash.classList.remove('is-leaving', 'is-blinking');
    authPage.classList.remove('auth-page--splash-hidden');
    document.body.classList.remove('auth-splash-open');
    window.dispatchEvent(new CustomEvent('socialconnect:landing-ready'));
  }

  function enterWithAnimation() {
    if (leaving) return;
    leaving = true;
    splash.classList.remove('is-blinking');
    splash.classList.add('is-leaving');
    if (hint) hint.textContent = 'Entrando…';
    window.setTimeout(revealLogin, LEAVE_MS);
  }

  trigger.addEventListener('click', enterWithAnimation);

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      enterWithAnimation();
    }
  });
})();
