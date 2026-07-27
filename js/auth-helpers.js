/**
 * Helpers de login, roles y guards por pantalla.
 */
(function () {
  const sb = () => window.scSupabase;

  /**
   * admin → admin@{loginEmailDomain} (por defecto example.com).
   * Si lleva @ se respeta el email tal cual.
   */
  function loginIdentifierToEmail(identifier) {
    const trimmed = String(identifier || '').trim();
    if (!trimmed) return '';
    if (trimmed.includes('@')) return trimmed.toLowerCase();
    const dom =
      (window.SC_CONFIG && window.SC_CONFIG.loginEmailDomain) || 'example.com';
    return `${trimmed.toLowerCase()}@${dom}`;
  }

  async function fetchProfileUser(userId) {
    const { data, error } = await sb()
      .from('users')
      .select('id, email, role, club_id')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  /**
   * Si el trigger handle_new_user no creó la fila en public.users, pero Auth tiene
   * role + club_id en metadata (alta desde admin club / superadmin), el usuario puede
   * insertar su propia fila (RLS users_insert_own_signup / club_access_insert_own_signup).
   */
  async function syncMissingClubProfileFromAuth(authUser) {
    if (!authUser?.id) return null;

    let profile = await fetchProfileUser(authUser.id);
    if (profile) return profile;

    const meta = {
      ...(authUser.user_metadata || {}),
      ...(authUser.app_metadata || {}),
    };
    let role = meta.role;
    if (role !== 'admin_club' && role !== 'empleado') {
      return null;
    }
    const clubRaw = meta.club_id;
    if (!clubRaw) return null;
    const clubId = String(clubRaw).trim();
    if (!clubId) return null;

    const email = String(authUser.email || '').trim().toLowerCase();
    if (!email) return null;

    const { error: uErr } = await sb().from('users').insert({
      id: authUser.id,
      email,
      role,
      club_id: clubId,
    });

    if (uErr) {
      if (uErr.code === '23505') {
        return fetchProfileUser(authUser.id);
      }
      console.warn('[SCAuth] sync users row:', uErr.message || uErr);
      return null;
    }

    const { error: caErr } = await sb().from('club_access').insert({
      club_id: clubId,
      email,
      role,
      auth_user_id: authUser.id,
    });
    if (caErr && caErr.code !== '23505') {
      console.warn('[SCAuth] sync club_access:', caErr.message || caErr);
    }

    return fetchProfileUser(authUser.id);
  }

  async function requireSuperadminSession() {
    const {
      data: { session },
      error: sessErr,
    } = await sb().auth.getSession();
    if (sessErr) throw sessErr;
    if (!session) return { ok: false, reason: 'no_session' };

    let profile = await fetchProfileUser(session.user.id);
    if (!profile) {
      profile = await syncMissingClubProfileFromAuth(session.user);
    }
    if (!profile) {
      await sb().auth.signOut();
      return { ok: false, reason: 'no_profile' };
    }

    if (profile.role === 'admin_club' || profile.role === 'empleado') {
      return { ok: false, reason: 'is_club_user', session, profile };
    }

    if (profile.role !== 'superadmin') {
      await sb().auth.signOut();
      return { ok: false, reason: 'not_superadmin' };
    }

    return { ok: true, session, profile };
  }

  /** Login genérico; el caller redirige según profile.role */
  async function signIn(identifier, password) {
    const finalEmail = loginIdentifierToEmail(identifier);
    if (!finalEmail) {
      return { ok: false, error: new Error('Introduce usuario o email.') };
    }

    const { data, error } = await sb().auth.signInWithPassword({
      email: finalEmail,
      password,
    });

    if (error) return { ok: false, error };

    const {
      data: { user: freshUser },
    } = await sb().auth.getUser();
    const authUser = freshUser || data.user;

    let profile = await fetchProfileUser(authUser.id);
    if (!profile) {
      profile = await syncMissingClubProfileFromAuth(authUser);
    }
    if (!profile) {
      await sb().auth.signOut();
      return {
        ok: false,
        error: new Error(
          'No existe perfil en la base de datos para este usuario. Comprueba en Supabase → Authentication → Users que este usuario tenga en user_metadata: role (empleado o admin_club) y club_id (UUID del club).',
        ),
      };
    }

    return { ok: true, session: data.session, profile };
  }

  function dashboardPathForProfile(profile) {
    if (!profile) return 'index.html';
    if (profile.role === 'superadmin') return 'dashboard-superadmin.html';
    if (profile.role === 'admin_club' || profile.role === 'empleado') {
      return 'dashboard-club.html';
    }
    return 'index.html';
  }

  const SUPERADMIN_CLUB_KEY = 'sc_superadmin_club_id';
  const SUPERADMIN_CLUB_NAME_KEY = 'sc_superadmin_club_name';
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function getSuperadminClubContext() {
    try {
      const id = String(sessionStorage.getItem(SUPERADMIN_CLUB_KEY) || '').trim();
      if (!id || !UUID_RE.test(id)) return null;
      const name = String(sessionStorage.getItem(SUPERADMIN_CLUB_NAME_KEY) || '').trim();
      return { clubId: id, clubName: name || '' };
    } catch (e) {
      return null;
    }
  }

  function setSuperadminClubContext(clubId, clubName) {
    const id = String(clubId || '').trim();
    if (!UUID_RE.test(id)) {
      throw new Error('Identificador de club no válido.');
    }
    sessionStorage.setItem(SUPERADMIN_CLUB_KEY, id);
    if (clubName) {
      sessionStorage.setItem(SUPERADMIN_CLUB_NAME_KEY, String(clubName));
    } else {
      sessionStorage.removeItem(SUPERADMIN_CLUB_NAME_KEY);
    }
  }

  function clearSuperadminClubContext() {
    try {
      sessionStorage.removeItem(SUPERADMIN_CLUB_KEY);
      sessionStorage.removeItem(SUPERADMIN_CLUB_NAME_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Mapa user_id → email del personal del club (RPC security definer).
   * Superadmin: pasar clubId; si el RPC aún no acepta p_club_id, cae a public.users.
   */
  async function loadClubStaffEmailMap(clubId, extraUserIds) {
    const map = {};
    const fill = (rows) => {
      (rows || []).forEach((row) => {
        const id = row.user_id ?? row.userId ?? row.id;
        const email = row.email;
        if (id && email) map[id] = email;
      });
    };

    const club = clubId ? String(clubId).trim() : '';

    try {
      if (club) {
        let res = await sb().rpc('club_staff_directory', { p_club_id: club });
        if (res.error) {
          res = await sb().rpc('club_staff_directory');
        }
        if (!res.error) fill(res.data);
      } else {
        const res = await sb().rpc('club_staff_directory');
        if (!res.error) fill(res.data);
      }
    } catch (e) {
      /* ignore */
    }

    // Fallback: superadmin (y políticas que permitan) leen users del club
    if (club && Object.keys(map).length === 0) {
      try {
        const { data, error } = await sb()
          .from('users')
          .select('id, email')
          .eq('club_id', club);
        if (!error) fill(data);
      } catch (e) {
        /* ignore */
      }
    }

    const missing = [...new Set((extraUserIds || []).filter(Boolean))]
      .map(String)
      .filter((id) => !map[id]);
    if (missing.length) {
      try {
        const { data, error } = await sb()
          .from('users')
          .select('id, email')
          .in('id', missing);
        if (!error) fill(data);
      } catch (e) {
        /* ignore */
      }
    }

    return map;
  }

  /**
   * Sesión válida para panel de club (admin_club / empleado).
   * El superadmin puede entrar si hay contexto de club en sessionStorage.
   */
  async function requireClubSession() {
    const {
      data: { session },
      error: sessErr,
    } = await sb().auth.getSession();
    if (sessErr) throw sessErr;
    if (!session) return { ok: false, reason: 'no_session' };

    let profile = await fetchProfileUser(session.user.id);
    if (!profile) {
      profile = await syncMissingClubProfileFromAuth(session.user);
    }
    if (!profile) {
      await sb().auth.signOut();
      return { ok: false, reason: 'no_profile' };
    }

    if (profile.role === 'superadmin') {
      const ctx = getSuperadminClubContext();
      if (!ctx) {
        return { ok: false, reason: 'is_superadmin', session, profile };
      }
      return {
        ok: true,
        session,
        profile: {
          ...profile,
          club_id: ctx.clubId,
          // Permisos de UI de admin de club; la auth real sigue siendo superadmin (RLS).
          role: 'admin_club',
          original_role: 'superadmin',
        },
        asSuperadmin: true,
        clubNameHint: ctx.clubName || '',
      };
    }

    if (profile.role !== 'admin_club' && profile.role !== 'empleado') {
      await sb().auth.signOut();
      return { ok: false, reason: 'invalid_role' };
    }

    if (!profile.club_id) {
      await sb().auth.signOut();
      return { ok: false, reason: 'no_club' };
    }

    return { ok: true, session, profile, asSuperadmin: false };
  }

  window.SCAuth = {
    loginIdentifierToEmail,
    fetchProfileUser,
    syncMissingClubProfileFromAuth,
    requireSuperadminSession,
    signIn,
    dashboardPathForProfile,
    requireClubSession,
    getSuperadminClubContext,
    setSuperadminClubContext,
    clearSuperadminClubContext,
    loadClubStaffEmailMap,
  };
})();
