/**
 * Panel superadmin: clubes y generación de credenciales (signUp + metadata).
 */
(function () {
  const sb = () => window.scSupabase;

  function $(id) {
    return document.getElementById(id);
  }

  function randomPassword(length) {
    const n = length || 14;
    const chars =
      'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@%&*-';
    let out = '';
    const buf = new Uint32Array(n);
    crypto.getRandomValues(buf);
    for (let i = 0; i < n; i++) {
      out += chars[buf[i] % chars.length];
    }
    return out;
  }

  function setStatus(text, isError) {
    const el = $('dash-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  async function ensureSuperadmin() {
    const gate = await window.SCAuth.requireSuperadminSession();
    if (gate.reason === 'is_club_user') {
      window.location.href = 'dashboard-club.html';
      return null;
    }
    if (!gate.ok) {
      window.location.href = 'index.html';
      return null;
    }
    const emailEl = $('superadmin-email');
    if (emailEl) emailEl.textContent = gate.profile.email || '';
    return gate;
  }

  async function loadClubs() {
    const { data, error } = await sb()
      .from('clubs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  function renderClubRow(club) {
    const tr = document.createElement('tr');
    tr.dataset.id = club.id;
    const active = club.is_active ? 'Activo' : 'Inactivo';
    tr.innerHTML = `
      <td>${escapeHtml(club.name)}</td>
      <td>${escapeHtml(club.cif || '')}</td>
      <td>${escapeHtml(club.email || '')}</td>
      <td><span class="badge ${club.is_active ? 'badge--on' : 'badge--off'}">${active}</span></td>
      <td class="actions">
        <button type="button" class="btn btn--small btn--toggle" data-active="${club.is_active}">
          ${club.is_active ? 'Desactivar' : 'Activar'}
        </button>
      </td>
    `;

    tr.querySelector('.btn--toggle').addEventListener('click', async () => {
      try {
        setStatus('Guardando estado…', false);
        const next = !club.is_active;
        const { error } = await sb()
          .from('clubs')
          .update({ is_active: next })
          .eq('id', club.id);
        if (error) throw error;
        await refreshTable();
        setStatus(next ? 'Club activado.' : 'Club desactivado.', false);
      } catch (e) {
        setStatus(e.message || 'Error al actualizar.', true);
      }
    });

    return tr;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function refreshTable() {
    const tbody = $('clubs-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const clubs = await loadClubs();
    clubs.forEach((c) => tbody.appendChild(renderClubRow(c)));
    fillClubSelects(clubs);
  }

  function fillClubSelects(clubs) {
    const sel = $('cred-club');
    const filter = $('filter-club');
    if (sel) {
      sel.innerHTML = '<option value="">— Elige club —</option>';
      clubs.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        sel.appendChild(opt);
      });
    }
    if (filter) {
      const cur = filter.value;
      filter.innerHTML = '<option value="">Todos los clubes</option>';
      clubs.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        filter.appendChild(opt);
      });
      filter.value = cur;
    }
  }

  async function loadClubAccess(clubId) {
    let q = sb().from('club_access').select('*').order('created_at', { ascending: false });
    if (clubId) q = q.eq('club_id', clubId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async function refreshAccessTable() {
    const tbody = $('access-tbody');
    const filter = $('filter-club');
    if (!tbody) return;
    tbody.innerHTML = '';
    const clubId = filter && filter.value ? filter.value : null;
    const rows = await loadClubAccess(clubId);
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(row.email)}</td>
        <td>${escapeHtml(row.role)}</td>
        <td>${escapeHtml(String(row.auth_user_id || '—'))}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  async function init() {
    const gate = await ensureSuperadmin();
    if (!gate) return;

    try {
      await refreshTable();
      await refreshAccessTable();
    } catch (e) {
      setStatus(e.message || 'Error cargando datos.', true);
    }

    $('logout-btn')?.addEventListener('click', async () => {
      await sb().auth.signOut();
      window.location.href = 'index.html';
    });

    $('club-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('club-name').value.trim();
      if (!name) {
        setStatus('El nombre del club es obligatorio.', true);
        return;
      }
      try {
        setStatus('Creando club…', false);
        const payload = {
          name,
          cif: $('club-cif').value.trim(),
          address: $('club-address').value.trim(),
          phone: $('club-phone').value.trim(),
          email: $('club-email').value.trim(),
          is_active: true,
        };
        const { error } = await sb().from('clubs').insert([payload]);
        if (error) throw error;
        e.target.reset();
        await refreshTable();
        setStatus('Club creado correctamente.', false);
      } catch (err) {
        setStatus(err.message || 'No se pudo crear el club.', true);
      }
    });

    $('filter-club')?.addEventListener('change', async () => {
      try {
        await refreshAccessTable();
      } catch (err) {
        setStatus(err.message, true);
      }
    });

    $('cred-generate')?.addEventListener('click', async () => {
      const clubId = $('cred-club').value;
      const email = $('cred-email').value.trim().toLowerCase();
      const role = $('cred-role').value;
      if (!clubId || !email || !email.includes('@')) {
        setStatus('Selecciona club e introduce un email válido.', true);
        return;
      }
      const pwd = randomPassword(16);
      $('cred-password').value = pwd;

      try {
        setStatus('Creando usuario en Auth (puede cerrar tu sesión actual)…', false);

        const { data, error } = await sb().auth.signUp({
          email,
          password: pwd,
          options: {
            data: {
              role,
              club_id: clubId,
            },
          },
        });

        if (error) throw error;

        /* Si el trigger no insertó en public.*, completamos con la sesión del nuevo usuario */
        if (data.user && data.session) {
          const uid = data.user.id;
          const { data: uRow } = await sb()
            .from('users')
            .select('id')
            .eq('id', uid)
            .maybeSingle();
          if (!uRow) {
            const insU = await sb()
              .from('users')
              .insert({
                id: uid,
                email,
                role,
                club_id: clubId,
              });
            if (insU.error) console.warn('Sync users:', insU.error);
          }
          const { data: caRow } = await sb()
            .from('club_access')
            .select('id')
            .eq('email', email)
            .maybeSingle();
          if (!caRow) {
            const insCa = await sb().from('club_access').insert({
              club_id: clubId,
              email,
              role,
              auth_user_id: uid,
            });
            if (insCa.error) console.warn('Sync club_access:', insCa.error);
          }
        }

        let copied = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(pwd);
            copied = true;
          }
        } catch (e) {
          /* ignorar */
        }
        await sb().auth.signOut();
        alert(
          `Usuario del club creado.\n\nEmail: ${email}\nContraseña: ${pwd}\n${
            copied
              ? '(Se intentó copiar al portapapeles.)\n\n'
              : ''
          }Guárdala: no se puede recuperar luego. Si la pierdes, en Supabase → Users → restablece contraseña.\n\n` +
            'La sesión se cerró. Vuelve a entrar como superadmin.',
        );
        window.location.href = 'index.html';
      } catch (err) {
        setStatus(err.message || 'Error al generar credenciales.', true);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
