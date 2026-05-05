/**
 * Formulario "Ajustes: cambiar contraseña" (dashboard-club y dashboard-superadmin).
 * Verifica la contraseña actual con signInWithPassword y luego updateUser.
 */
(function () {
  function showMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('msg--error', 'msg--success');
    if (kind === 'error') el.classList.add('msg--error');
    else if (kind === 'success') el.classList.add('msg--success');
  }

  let passwordFormBound = false;

  async function init() {
    const form = document.getElementById('password-settings-form');
    const msg = document.getElementById('password-settings-msg');
    if (!form || !msg || !window.scSupabase) return;
    if (passwordFormBound) return;
    passwordFormBound = true;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cur = document.getElementById('password-current').value;
      const nw = document.getElementById('password-new').value;
      const cf = document.getElementById('password-confirm').value;

      if (nw.length < 6) {
        showMsg(
          msg,
          'La nueva contraseña debe tener al menos 6 caracteres.',
          'error',
        );
        return;
      }
      if (nw !== cf) {
        showMsg(msg, 'Las nuevas contraseñas no coinciden.', 'error');
        return;
      }
      if (nw === cur) {
        showMsg(
          msg,
          'La nueva contraseña debe ser distinta de la actual.',
          'error',
        );
        return;
      }

      const sb = window.scSupabase;
      const {
        data: { user },
        error: uerr,
      } = await sb.auth.getUser();
      if (uerr || !user || !user.email) {
        showMsg(msg, 'No hay sesión válida. Vuelve a entrar.', 'error');
        return;
      }

      showMsg(msg, 'Comprobando…', null);

      const { error: verErr } = await sb.auth.signInWithPassword({
        email: user.email,
        password: cur,
      });
      if (verErr) {
        showMsg(msg, 'La contraseña actual no es correcta.', 'error');
        return;
      }

      const { error: upErr } = await sb.auth.updateUser({ password: nw });
      if (upErr) {
        showMsg(
          msg,
          upErr.message || 'No se pudo actualizar la contraseña.',
          'error',
        );
        return;
      }

      showMsg(msg, 'Contraseña actualizada correctamente.', 'success');
      form.reset();
    });
  }

  function scheduleInit() {
    const form = document.getElementById('password-settings-form');
    if (form) {
      void init();
      return;
    }
    document.addEventListener(
      'sc-club-shell-ready',
      () => {
        void init();
      },
      { once: true },
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInit);
  } else {
    scheduleInit();
  }
})();
