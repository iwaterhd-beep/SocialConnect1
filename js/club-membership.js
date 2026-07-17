/**
 * Membresía — configuración de niveles, umbrales VIP y regalos/objetivos (admin).
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const DEFAULT_TIERS = [
    {
      tier_key: 'standard',
      display_name: 'Estándar',
      color_hex: '#64748b',
      description: 'Nivel base de socio del club.',
      benefits_text: 'Acceso al club y consumo según normas internas.',
      auto_upgrade_enabled: false,
      spend_threshold_eur: 0,
      spend_window_days: 7,
      default_valid_days: null,
      is_enabled: true,
      sort_order: 0,
    },
    {
      tier_key: 'premium',
      display_name: 'Premium',
      color_hex: '#0d9488',
      description: 'Nivel intermedio con ventajas adicionales.',
      benefits_text: 'Prioridad en atención y ventajas definidas por el club.',
      auto_upgrade_enabled: false,
      spend_threshold_eur: 50,
      spend_window_days: 7,
      default_valid_days: null,
      is_enabled: true,
      sort_order: 1,
    },
    {
      tier_key: 'vip',
      display_name: 'VIP',
      color_hex: '#ca8a04',
      description: 'Nivel alto. Puede activarse automáticamente por gasto en POS.',
      benefits_text: 'Ventajas VIP definidas por el club.',
      auto_upgrade_enabled: true,
      spend_threshold_eur: 100,
      spend_window_days: 7,
      default_valid_days: null,
      is_enabled: true,
      sort_order: 2,
    },
  ];

  let ctx = null;
  let uiBound = false;
  let tiersCache = [];
  let rewardsCache = [];

  function sb() {
    return window.supabaseClient;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setMsg(text, isError) {
    const el = $('membership-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (text ? (isError ? ' msg--error' : ' msg--ok') : '');
  }

  function isAdmin() {
    return ctx?.profile?.role === 'admin_club';
  }

  function normalizeHex(raw, fallback) {
    const t = String(raw || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(t)) return t.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toLowerCase()}`;
    return fallback || '#64748b';
  }

  function triggerLabel(t) {
    if (t === 'on_upgrade') return 'Al subir de nivel';
    if (t === 'spend_threshold') return 'Por gasto';
    if (t === 'birthday') return 'Cumpleaños';
    return 'Manual';
  }

  function publishTierGlobal() {
    window.scClubMembershipTiers = tiersCache.slice();
    window.scClubMembershipTierLabel = function (key) {
      const k = key || 'standard';
      const row = tiersCache.find((x) => x.tier_key === k);
      if (row?.display_name) return row.display_name;
      if (k === 'premium') return 'Premium';
      if (k === 'vip') return 'VIP';
      return 'Estándar';
    };
    window.scClubMembershipTierColor = function (key) {
      const k = key || 'standard';
      const row = tiersCache.find((x) => x.tier_key === k);
      if (row?.color_hex) return normalizeHex(row.color_hex, '#64748b');
      if (k === 'premium') return '#0d9488';
      if (k === 'vip') return '#ca8a04';
      return '#64748b';
    };
    document.documentElement.style.setProperty(
      '--member-tier-premium',
      window.scClubMembershipTierColor('premium'),
    );
    document.documentElement.style.setProperty(
      '--member-tier-vip',
      window.scClubMembershipTierColor('vip'),
    );
    document.documentElement.style.setProperty(
      '--member-tier-standard',
      window.scClubMembershipTierColor('standard'),
    );
  }

  async function ensureDefaults() {
    if (!ctx?.club?.id) return;
    try {
      await sb().rpc('ensure_club_membership_defaults', { p_club_id: ctx.club.id });
    } catch (_) {
      /* RPC puede no existir hasta aplicar 046 */
    }
  }

  async function loadTiers() {
    if (!ctx?.club?.id) return [];
    await ensureDefaults();
    const { data, error } = await sb()
      .from('club_membership_tiers')
      .select('*')
      .eq('club_id', ctx.club.id)
      .order('sort_order', { ascending: true });

    if (error) {
      if (
        error.code === '42P01' ||
        error.code === '42703' ||
        String(error.message || '').toLowerCase().includes('club_membership_tiers')
      ) {
        tiersCache = DEFAULT_TIERS.map((t) => ({ ...t, id: null, club_id: ctx.club.id }));
        publishTierGlobal();
        return tiersCache;
      }
      throw error;
    }

    const byKey = Object.fromEntries((data || []).map((r) => [r.tier_key, r]));
    tiersCache = DEFAULT_TIERS.map((def) => {
      const row = byKey[def.tier_key];
      return row
        ? {
            ...def,
            ...row,
            color_hex: normalizeHex(row.color_hex, def.color_hex),
          }
        : { ...def, id: null, club_id: ctx.club.id };
    });
    publishTierGlobal();
    return tiersCache;
  }

  function renderTiers() {
    const grid = $('membership-tiers-grid');
    if (!grid) return;
    grid.innerHTML = '';

    tiersCache.forEach((t) => {
      const card = document.createElement('article');
      card.className = 'sc-membership-tier';
      card.style.setProperty('--tier-color', normalizeHex(t.color_hex));
      card.dataset.tierKey = t.tier_key;

      const autoHint =
        t.tier_key === 'vip'
          ? 'Si está activo, el socio sube a VIP al superar el umbral en la ventana de días (y puede bajar si no lo mantiene). El VIP asignado a mano en Socios no se baja.'
          : t.tier_key === 'premium'
            ? 'El auto-upgrade Premium es informativo por ahora: úsalo como objetivo del equipo. La regla automática en POS aplica a VIP.'
            : 'El nivel base no tiene auto-upgrade.';

      card.innerHTML = `
        <div class="sc-membership-tier__head">
          <span class="sc-membership-tier__badge">
            <span class="sc-membership-tier__dot" aria-hidden="true"></span>
            <span data-tier-preview-name>${escapeHtml(t.display_name)}</span>
          </span>
          <span class="sc-membership-tier__key">${escapeHtml(t.tier_key)}</span>
        </div>
        <div class="sc-membership-tier__grid">
          <div class="form__row">
            <label>Nombre visible</label>
            <input class="input" data-field="display_name" type="text" value="${escapeHtml(t.display_name)}" />
          </div>
          <div class="form__row">
            <label>Color</label>
            <input class="input" data-field="color_hex" type="color" value="${escapeHtml(normalizeHex(t.color_hex))}" />
          </div>
          <div class="form__row" style="grid-column:1/-1">
            <label>Descripción corta</label>
            <input class="input" data-field="description" type="text" value="${escapeHtml(t.description || '')}" />
          </div>
          <div class="form__row" style="grid-column:1/-1">
            <label>Beneficios / ventajas</label>
            <textarea class="input" data-field="benefits_text" rows="3">${escapeHtml(t.benefits_text || '')}</textarea>
          </div>
          <div class="form__row">
            <label>Vigencia por defecto (días)</label>
            <input class="input" data-field="default_valid_days" type="number" min="1" step="1"
              placeholder="Vacío = sin caducidad"
              value="${t.default_valid_days != null ? escapeHtml(String(t.default_valid_days)) : ''}" />
          </div>
          <div class="form__row">
            <label class="sc-membership-tier__toggle" style="margin-top:1.4rem">
              <input type="checkbox" data-field="is_enabled" ${t.is_enabled !== false ? 'checked' : ''} />
              Nivel activo
            </label>
          </div>
        </div>
        <div class="sc-membership-tier__auto">
          <p class="sc-membership-tier__auto-title">Regla por gasto en POS</p>
          <label class="sc-membership-tier__toggle">
            <input type="checkbox" data-field="auto_upgrade_enabled" ${t.auto_upgrade_enabled ? 'checked' : ''}
              ${t.tier_key === 'standard' ? 'disabled' : ''} />
            Activación automática
          </label>
          <div class="sc-membership-tier__auto-grid">
            <div class="form__row">
              <label>Umbral (€)</label>
              <input class="input" data-field="spend_threshold_eur" type="number" min="0" step="0.01"
                value="${escapeHtml(String(t.spend_threshold_eur ?? 0))}"
                ${t.tier_key === 'standard' ? 'disabled' : ''} />
            </div>
            <div class="form__row">
              <label>Ventana (días)</label>
              <input class="input" data-field="spend_window_days" type="number" min="1" max="365" step="1"
                value="${escapeHtml(String(t.spend_window_days ?? 7))}"
                ${t.tier_key === 'standard' ? 'disabled' : ''} />
            </div>
          </div>
          <p class="hint hint--small">${escapeHtml(autoHint)}</p>
        </div>
      `;

      const nameInput = card.querySelector('[data-field="display_name"]');
      const colorInput = card.querySelector('[data-field="color_hex"]');
      const preview = card.querySelector('[data-tier-preview-name]');
      nameInput?.addEventListener('input', () => {
        if (preview) preview.textContent = nameInput.value || t.tier_key;
      });
      colorInput?.addEventListener('input', () => {
        card.style.setProperty('--tier-color', normalizeHex(colorInput.value, t.color_hex));
      });

      grid.appendChild(card);
    });

    syncRewardTierOptions();
  }

  function readTiersFromDom() {
    const cards = document.querySelectorAll('#membership-tiers-grid [data-tier-key]');
    const out = [];
    cards.forEach((card) => {
      const key = card.getAttribute('data-tier-key');
      const prev = tiersCache.find((x) => x.tier_key === key) || {};
      const val = (field) => card.querySelector(`[data-field="${field}"]`);
      const validRaw = (val('default_valid_days')?.value || '').trim();
      let default_valid_days = null;
      if (validRaw !== '') {
        const n = Number(validRaw);
        if (!Number.isNaN(n) && n >= 1) default_valid_days = Math.trunc(n);
      }
      out.push({
        id: prev.id || null,
        club_id: ctx.club.id,
        tier_key: key,
        display_name: (val('display_name')?.value || '').trim() || key,
        color_hex: normalizeHex(val('color_hex')?.value, prev.color_hex),
        description: (val('description')?.value || '').trim(),
        benefits_text: (val('benefits_text')?.value || '').trim(),
        auto_upgrade_enabled: key === 'standard' ? false : Boolean(val('auto_upgrade_enabled')?.checked),
        spend_threshold_eur: Number(val('spend_threshold_eur')?.value || 0) || 0,
        spend_window_days: Math.max(1, Math.trunc(Number(val('spend_window_days')?.value || 7) || 7)),
        default_valid_days,
        is_enabled: Boolean(val('is_enabled')?.checked),
        sort_order: prev.sort_order ?? 0,
      });
    });
    return out;
  }

  async function saveTiers() {
    if (!isAdmin()) {
      setMsg('Solo el administrador puede guardar membresías.', true);
      return;
    }
    const rows = readTiersFromDom();
    for (const r of rows) {
      if (!r.display_name) {
        setMsg('Cada nivel necesita un nombre.', true);
        return;
      }
      if (r.spend_threshold_eur < 0 || r.spend_window_days < 1) {
        setMsg('Revisa umbral (€) y ventana (días).', true);
        return;
      }
    }

    setMsg('Guardando niveles…', false);
    const payload = rows.map((r) => {
      const { id, ...rest } = r;
      return { ...rest, updated_at: new Date().toISOString() };
    });

    const { error } = await sb().from('club_membership_tiers').upsert(payload, {
      onConflict: 'club_id,tier_key',
    });

    if (error) {
      if (
        error.code === '42P01' ||
        String(error.message || '').toLowerCase().includes('club_membership_tiers')
      ) {
        setMsg(
          'Ejecuta en Supabase la migración 046_club_membership_tiers.sql para activar Membresía.',
          true,
        );
        return;
      }
      setMsg(error.message || 'No se pudieron guardar los niveles.', true);
      return;
    }

    await loadTiers();
    renderTiers();
    setMsg('Niveles de membresía guardados.', false);
    if (typeof window.scClubOnMembershipUpdated === 'function') {
      window.scClubOnMembershipUpdated();
    }
  }

  function syncRewardTierOptions() {
    const sel = $('reward-tier');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">Cualquiera</option>';
    tiersCache.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.tier_key;
      opt.textContent = t.display_name;
      sel.appendChild(opt);
    });
    sel.value = current;
  }

  function syncRewardSpendVisibility() {
    const wrap = $('reward-spend-wrap');
    const trigger = $('reward-trigger')?.value;
    if (!wrap) return;
    const show = trigger === 'spend_threshold';
    wrap.hidden = !show;
    wrap.classList.toggle('is-hidden', !show);
  }

  async function loadRewards() {
    if (!ctx?.club?.id) return [];
    const { data, error } = await sb()
      .from('club_membership_rewards')
      .select('*')
      .eq('club_id', ctx.club.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      if (
        error.code === '42P01' ||
        String(error.message || '').toLowerCase().includes('club_membership_rewards')
      ) {
        rewardsCache = [];
        return rewardsCache;
      }
      throw error;
    }
    rewardsCache = data || [];
    return rewardsCache;
  }

  function renderRewards() {
    const tbody = $('membership-rewards-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!rewardsCache.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="hint">Aún no hay regalos. Añade el primero arriba.</td></tr>';
      return;
    }
    rewardsCache.forEach((r) => {
      const tr = document.createElement('tr');
      if (!r.is_active) tr.classList.add('sc-membership-reward-inactive');
      const tierName = r.tier_key
        ? window.scClubMembershipTierLabel?.(r.tier_key) || r.tier_key
        : 'Cualquiera';
      const triggerExtra =
        r.trigger_type === 'spend_threshold' && r.trigger_spend_eur != null
          ? ` (≥ ${Number(r.trigger_spend_eur).toLocaleString('es-ES')} €)`
          : '';
      tr.innerHTML = `
        <td>
          <strong>${escapeHtml(r.title)}</strong>
          ${r.description ? `<div class="hint">${escapeHtml(r.description)}</div>` : ''}
        </td>
        <td>${escapeHtml(tierName)}</td>
        <td>${escapeHtml(triggerLabel(r.trigger_type))}${escapeHtml(triggerExtra)}</td>
        <td>${r.is_active ? 'Activo' : 'Pausado'}</td>
        <td class="actions">
          <button type="button" class="btn btn--ghost btn--small" data-reward-toggle="${r.id}">
            ${r.is_active ? 'Pausar' : 'Activar'}
          </button>
          <button type="button" class="btn btn--ghost btn--small btn--danger" data-reward-del="${r.id}">
            Borrar
          </button>
        </td>
      `;
      tr.querySelector('[data-reward-toggle]')?.addEventListener('click', () => {
        void toggleReward(r.id, !r.is_active);
      });
      tr.querySelector('[data-reward-del]')?.addEventListener('click', () => {
        void deleteReward(r.id);
      });
      tbody.appendChild(tr);
    });
  }

  async function addReward() {
    if (!isAdmin()) {
      setMsg('Solo el administrador puede añadir regalos.', true);
      return;
    }
    const title = ($('reward-title')?.value || '').trim();
    if (!title) {
      setMsg('Indica un título para el regalo.', true);
      return;
    }
    const trigger = $('reward-trigger')?.value || 'manual';
    const tier = ($('reward-tier')?.value || '').trim() || null;
    const desc = ($('reward-desc')?.value || '').trim();
    let spend = null;
    if (trigger === 'spend_threshold') {
      const raw = ($('reward-spend')?.value || '').trim();
      spend = raw === '' ? null : Number(raw);
      if (spend == null || Number.isNaN(spend) || spend < 0) {
        setMsg('Indica un gasto objetivo válido.', true);
        return;
      }
    }

    setMsg('Guardando regalo…', false);
    const { error } = await sb().from('club_membership_rewards').insert([
      {
        club_id: ctx.club.id,
        title,
        description: desc,
        tier_key: tier,
        trigger_type: trigger,
        trigger_spend_eur: spend,
        is_active: true,
        sort_order: rewardsCache.length,
      },
    ]);

    if (error) {
      if (
        error.code === '42P01' ||
        String(error.message || '').toLowerCase().includes('club_membership_rewards')
      ) {
        setMsg(
          'Ejecuta en Supabase la migración 046_club_membership_tiers.sql para activar regalos.',
          true,
        );
        return;
      }
      setMsg(error.message || 'No se pudo añadir el regalo.', true);
      return;
    }

    if ($('reward-title')) $('reward-title').value = '';
    if ($('reward-desc')) $('reward-desc').value = '';
    if ($('reward-spend')) $('reward-spend').value = '';
    await loadRewards();
    renderRewards();
    setMsg('Regalo añadido.', false);
  }

  async function toggleReward(id, nextActive) {
    const { error } = await sb()
      .from('club_membership_rewards')
      .update({ is_active: nextActive })
      .eq('id', id)
      .eq('club_id', ctx.club.id);
    if (error) {
      setMsg(error.message || 'No se pudo actualizar el regalo.', true);
      return;
    }
    await loadRewards();
    renderRewards();
    setMsg(nextActive ? 'Regalo activado.' : 'Regalo pausado.', false);
  }

  async function deleteReward(id) {
    if (!window.confirm('¿Eliminar este regalo?')) return;
    const { error } = await sb()
      .from('club_membership_rewards')
      .delete()
      .eq('id', id)
      .eq('club_id', ctx.club.id);
    if (error) {
      setMsg(error.message || 'No se pudo borrar.', true);
      return;
    }
    await loadRewards();
    renderRewards();
    setMsg('Regalo eliminado.', false);
  }

  function applyAdminGate() {
    const admin = isAdmin();
    const gate = $('membership-gate');
    const panel = $('membership-admin');
    const navBtn = document.querySelector('.club-tab[data-view="membership"]');
    if (navBtn) {
      navBtn.hidden = !admin;
      navBtn.classList.toggle('is-hidden', !admin);
    }
    document.querySelectorAll('[data-admin-only="1"]').forEach((el) => {
      el.hidden = !admin;
      el.classList.toggle('is-hidden', !admin);
    });
    if (gate) {
      gate.hidden = admin;
      gate.classList.toggle('is-hidden', admin);
    }
    if (panel) {
      panel.hidden = !admin;
      panel.classList.toggle('is-hidden', !admin);
    }
  }

  function bindUiOnce() {
    if (uiBound) return;
    uiBound = true;
    $('membership-tiers-save')?.addEventListener('click', () => void saveTiers());
    $('reward-add')?.addEventListener('click', () => void addReward());
    $('reward-trigger')?.addEventListener('change', syncRewardSpendVisibility);
    syncRewardSpendVisibility();
  }

  async function refreshMembershipUi() {
    if (!ctx) return;
    applyAdminGate();
    if (!isAdmin()) return;
    try {
      await loadTiers();
      renderTiers();
      await loadRewards();
      renderRewards();
    } catch (e) {
      setMsg(e.message || 'Error cargando membresía.', true);
    }
  }

  window.scInitClubMembership = async function (context) {
    ctx = context;
    bindUiOnce();
    applyAdminGate();
    try {
      await loadTiers();
      if (typeof window.scClubOnMembershipUpdated === 'function') {
        window.scClubOnMembershipUpdated();
      }
      if (isAdmin()) {
        renderTiers();
        await loadRewards();
        renderRewards();
      }
    } catch (e) {
      console.error(e);
      publishTierGlobal();
    }
  };

  window.scClubRefreshMembership = function () {
    return refreshMembershipUi();
  };
})();
