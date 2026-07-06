/**
 * Pantalla de login — superadmin, admin de club o empleado (redirección automática).
 */
(function () {
  /** Mensajes Supabase Auth → español + qué hacer */
  function mapLoginError(err) {
    if (!err || !err.message) return 'No se pudo iniciar sesión.';
    const m = String(err.message);
    if (/invalid login credentials/i.test(m)) {
      return 'Email o contraseña incorrectos. Comprueba tus datos e inténtalo de nuevo.';
    }
    if (/email not confirmed/i.test(m)) {
      return 'Confirma tu email antes de entrar o contacta con el administrador del club.';
    }
    if (/signup_disabled|Email rate limit/i.test(m)) {
      return 'No se pudo iniciar sesión en este momento. Inténtalo de nuevo en unos minutos.';
    }
    return m;
  }

  function showMessage(el, text, type) {
    el.textContent = text || '';
    el.classList.remove('msg--error', 'msg--success');
    if (type) el.classList.add(type === 'error' ? 'msg--error' : 'msg--success');
  }

  async function init() {
    const form = document.getElementById('login-form');
    const msg = document.getElementById('login-message');
    if (!form || !msg) return;

    const {
      data: { session },
    } = await window.scSupabase.auth.getSession();
    if (session) {
      let profile = await window.SCAuth.fetchProfileUser(session.user.id);
      if (!profile && typeof window.SCAuth.syncMissingClubProfileFromAuth === 'function') {
        profile = await window.SCAuth.syncMissingClubProfileFromAuth(session.user);
      }
      if (profile) {
        window.location.href = window.SCAuth.dashboardPathForProfile(profile);
        return;
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      showMessage(msg, 'Entrando…', null);

      try {
        const result = await window.SCAuth.signIn(username, password);
        if (!result.ok) {
          showMessage(
            msg,
            mapLoginError(result.error),
            'error',
          );
          return;
        }
        showMessage(msg, '¡Hola! Redirigiendo…', 'success');
        window.location.href = window.SCAuth.dashboardPathForProfile(result.profile);
      } catch (err) {
        showMessage(msg, err.message || 'Error inesperado.', 'error');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
