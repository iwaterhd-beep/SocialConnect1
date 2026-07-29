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

  const BUILTIN_TIER_KEYS = new Set(['standard', 'premium', 'vip']);
  const CUSTOM_TIER_COLORS = ['#7c3aed', '#db2777', '#ea580c', '#0284c7', '#16a34a', '#4f46e5'];

  let ctx = null;
  let uiBound = false;
  let tiersCache = [];
  let rewardsCache = [];
  let rewardProductsCache = [];
  let migrationMissing = false;
  let hasRewardProductColumn = true;
  let hasRewardGrantsTable = true;
  let customTiersAllowed = true;

  function sb() {
    return window.scSupabase || window.supabaseClient || null;
  }

  function tierRank(key) {
    const k = key || 'standard';
    const row = tiersCache.find((x) => x.tier_key === k);
    if (row && row.sort_order != null) return Number(row.sort_order) || 0;
    if (k === 'vip') return 2;
    if (k === 'premium') return 1;
    return 0;
  }

  function isBuiltinTier(key) {
    return BUILTIN_TIER_KEYS.has(String(key || ''));
  }

  function slugifyTierKey(name) {
    const base = String(name || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_')
      .slice(0, 28);
    let key = base || 'nivel';
    if (!/^[a-z]/.test(key)) key = `n_${key}`.slice(0, 32);
    if (BUILTIN_TIER_KEYS.has(key) || key === 'expired' || key === 'archived') {
      key = `custom_${key}`.slice(0, 32);
    }
    const used = new Set(tiersCache.map((t) => t.tier_key));
    if (!used.has(key)) return key;
    for (let i = 2; i < 100; i++) {
      const candidate = `${key.slice(0, 28)}_${i}`.slice(0, 32);
      if (!used.has(candidate)) return candidate;
    }
    return `nivel_${Date.now().toString(36)}`.slice(0, 32);
  }

  function nextCustomColor() {
    const used = new Set(tiersCache.map((t) => normalizeHex(t.color_hex)));
    const free = CUSTOM_TIER_COLORS.find((c) => !used.has(c));
    return free || CUSTOM_TIER_COLORS[tiersCache.length % CUSTOM_TIER_COLORS.length];
  }

  function nextSortOrder() {
    let max = -1;
    tiersCache.forEach((t) => {
      const n = Number(t.sort_order);
      if (Number.isFinite(n) && n > max) max = n;
    });
    return max + 1;
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

  function isMissingTableErr(error) {
    if (!error) return false;
    const msg = String(error.message || '').toLowerCase();
    return (
      error.code === '42P01' ||
      error.code === 'PGRST205' ||
      error.code === '42703' ||
      error.code === 'PGRST204' ||
      msg.includes('club_membership_tiers') ||
      msg.includes('club_membership_rewards') ||
      msg.includes('club_membership_reward_grants') ||
      msg.includes('does not exist') ||
      msg.includes('schema cache')
    );
  }

  async function loadRewardProducts() {
    rewardProductsCache = [];
    if (!ctx?.club?.id || !sb()) return [];
    let { data, error } = await sb()
      .from('inventory_products')
      .select('id, name, emoji, sale_unit, default_sale_grams')
      .eq('club_id', ctx.club.id)
      .order('name', { ascending: true });
    if (
      error &&
      (error.code === '42703' || String(error.message || '').toLowerCase().includes('default_sale_grams'))
    ) {
      ({ data, error } = await sb()
        .from('inventory_products')
        .select('id, name, emoji, sale_unit')
        .eq('club_id', ctx.club.id)
        .order('name', { ascending: true }));
    }
    if (
      error &&
      (error.code === '42703' || String(error.message || '').toLowerCase().includes('sale_unit'))
    ) {
      ({ data, error } = await sb()
        .from('inventory_products')
        .select('id, name, emoji')
        .eq('club_id', ctx.club.id)
        .order('name', { ascending: true }));
    }
    if (error) {
      console.warn('loadRewardProducts', error);
      return [];
    }
    rewardProductsCache = data || [];
    return rewardProductsCache;
  }

  function fillRewardProductSelect(sel, emptyLabel) {
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = emptyLabel || '— Elige un producto del inventario —';
    sel.appendChild(empty);
    rewardProductsCache.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      const emoji = (p.emoji || '').trim();
      const unit = p.sale_unit === 'unit' ? 'ud' : 'g';
      opt.textContent = `${emoji ? emoji + ' ' : ''}${p.name || 'Producto'} · ${unit}`;
      opt.dataset.saleUnit = unit;
      sel.appendChild(opt);
    });
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  function syncRewardQtyUnitLabel(sel, unitEl, qtyInput) {
    const productId = (sel?.value || '').trim();
    const product = rewardProductsCache.find((p) => String(p.id) === productId);
    const isUnit = product ? product.sale_unit === 'unit' : true;
    if (unitEl) unitEl.textContent = isUnit ? '(ud)' : '(g)';
    if (qtyInput) {
      qtyInput.step = isUnit ? '1' : 'any';
      qtyInput.min = isUnit ? '1' : '0.001';
    }
  }

  function fillAllRewardProductSelects() {
    document.querySelectorAll('[data-reward-product]').forEach((sel) => {
      fillRewardProductSelect(sel);
      const root = sel.closest('[data-tier-gifts], [data-create-gift-form]') || sel.parentElement;
      syncRewardQtyUnitLabel(
        sel,
        root?.querySelector('[data-reward-qty-unit]'),
        root?.querySelector('[data-reward-qty]'),
      );
    });
    fillRewardProductSelect($('tier-create-gift-product'), '— Sin regalo por ahora —');
    syncRewardQtyUnitLabel(
      $('tier-create-gift-product'),
      $('tier-create-gift-qty-unit'),
      $('tier-create-gift-qty'),
    );
  }

  function rewardsForTier(tierKey) {
    return (rewardsCache || []).filter((r) => r.tier_key === tierKey);
  }

  function syncCreateGiftSpendVisibility() {
    const wrap = $('tier-create-gift-spend-wrap');
    const trigger = $('tier-create-gift-trigger')?.value;
    if (!wrap) return;
    const show = trigger === 'spend_threshold';
    wrap.hidden = !show;
    wrap.classList.toggle('is-hidden', !show);
  }

  function readRewardFieldsFromRoot(root) {
    if (!root) return null;
    const productId = (root.querySelector('[data-reward-product]')?.value || '').trim();
    const qtyRaw = (root.querySelector('[data-reward-qty]')?.value || '').trim();
    const trigger = root.querySelector('[data-reward-trigger]')?.value || 'on_upgrade';
    const desc = (root.querySelector('[data-reward-desc]')?.value || '').trim();
    const spendRaw = (root.querySelector('[data-reward-spend]')?.value || '').trim();
    return { productId, qtyRaw, trigger, desc, spendRaw };
  }

  function clearRewardFields(root) {
    if (!root) return;
    const product = root.querySelector('[data-reward-product]');
    const qty = root.querySelector('[data-reward-qty]');
    const desc = root.querySelector('[data-reward-desc]');
    const spend = root.querySelector('[data-reward-spend]');
    const trigger = root.querySelector('[data-reward-trigger]');
    if (product) product.value = '';
    if (qty) qty.value = '1';
    if (desc) desc.value = '';
    if (spend) spend.value = '';
    if (trigger) trigger.value = 'on_upgrade';
    const spendWrap = root.querySelector('[data-reward-spend-wrap]');
    if (spendWrap) {
      spendWrap.hidden = true;
      spendWrap.classList.add('is-hidden');
    }
    syncRewardQtyUnitLabel(product, root.querySelector('[data-reward-qty-unit]'), qty);
  }

  function readCreateGiftDraft() {
    const productId = ($('tier-create-gift-product')?.value || '').trim();
    if (!productId) return null;
    return {
      productId,
      qtyRaw: ($('tier-create-gift-qty')?.value || '').trim(),
      trigger: $('tier-create-gift-trigger')?.value || 'on_upgrade',
      desc: ($('tier-create-gift-desc')?.value || '').trim(),
      spendRaw: ($('tier-create-gift-spend')?.value || '').trim(),
    };
  }

  function clearCreateGiftFields() {
    if ($('tier-create-gift-product')) $('tier-create-gift-product').value = '';
    if ($('tier-create-gift-qty')) $('tier-create-gift-qty').value = '1';
    if ($('tier-create-gift-desc')) $('tier-create-gift-desc').value = '';
    if ($('tier-create-gift-spend')) $('tier-create-gift-spend').value = '';
    if ($('tier-create-gift-trigger')) $('tier-create-gift-trigger').value = 'on_upgrade';
    syncCreateGiftSpendVisibility();
    syncRewardQtyUnitLabel(
      $('tier-create-gift-product'),
      $('tier-create-gift-qty-unit'),
      $('tier-create-gift-qty'),
    );
  }

  function useDefaultTiers() {
    tiersCache = DEFAULT_TIERS.map((t) => ({ ...t, id: null, club_id: ctx?.club?.id || null }));
    publishTierGlobal();
    return tiersCache;
  }

  function publishTierGlobal() {
    if (!tiersCache.length) useDefaultTiers();
    window.scClubMembershipTiers = tiersCache.slice();
    window.scClubMembershipTierLabel = function (key) {
      const k = key || 'standard';
      const row = tiersCache.find((x) => x.tier_key === k);
      if (row?.display_name) return row.display_name;
      if (k === 'premium') return 'Premium';
      if (k === 'vip') return 'VIP';
      if (k === 'standard') return 'Estándar';
      return k;
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

  function notifyLabelsUpdated() {
    try {
      if (typeof window.scClubOnMembershipUpdated === 'function') {
        window.scClubOnMembershipUpdated();
      }
    } catch (e) {
      console.warn('scClubOnMembershipUpdated', e);
    }
  }

  async function ensureDefaults() {
    if (!ctx?.club?.id || !sb()) return;
    try {
      const { error } = await sb().rpc('ensure_club_membership_defaults', {
        p_club_id: ctx.club.id,
      });
      if (error && isMissingTableErr(error)) migrationMissing = true;
    } catch (_) {
      /* RPC puede no existir hasta aplicar 046 */
    }
  }

  async function loadTiers() {
    if (!ctx?.club?.id) return useDefaultTiers();
    if (!sb()) return useDefaultTiers();

    await ensureDefaults();

    const { data, error } = await sb()
      .from('club_membership_tiers')
      .select('*')
      .eq('club_id', ctx.club.id)
      .order('sort_order', { ascending: true });

    if (error) {
      if (isMissingTableErr(error)) {
        migrationMissing = true;
        return useDefaultTiers();
      }
      console.warn('loadTiers', error);
      setMsg(error.message || 'No se pudieron cargar los niveles.', true);
      return useDefaultTiers();
    }

    migrationMissing = false;
    const rows = data || [];
    const byKey = Object.fromEntries(rows.map((r) => [r.tier_key, r]));
    const merged = DEFAULT_TIERS.map((def) => {
      const row = byKey[def.tier_key];
      return row
        ? {
            ...def,
            ...row,
            color_hex: normalizeHex(row.color_hex, def.color_hex),
            display_name: (row.display_name || def.display_name).trim() || def.display_name,
          }
        : { ...def, id: null, club_id: ctx.club.id };
    });
    rows.forEach((row) => {
      if (BUILTIN_TIER_KEYS.has(row.tier_key)) return;
      merged.push({
        id: row.id,
        club_id: row.club_id,
        tier_key: row.tier_key,
        display_name: (row.display_name || row.tier_key).trim() || row.tier_key,
        color_hex: normalizeHex(row.color_hex, '#7c3aed'),
        description: row.description || '',
        benefits_text: row.benefits_text || '',
        auto_upgrade_enabled: Boolean(row.auto_upgrade_enabled),
        spend_threshold_eur: Number(row.spend_threshold_eur) || 0,
        spend_window_days: Math.max(1, Number(row.spend_window_days) || 7),
        default_valid_days: row.default_valid_days,
        is_enabled: row.is_enabled !== false,
        sort_order: Number(row.sort_order) || merged.length,
      });
    });
    merged.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
    tiersCache = merged;
    publishTierGlobal();
    return tiersCache;
  }

  function autoHintFor(key) {
    if (key === 'vip') {
      return 'Si está activo, el socio sube a VIP al superar el umbral en la ventana de días. El VIP asignado a mano en Socios no se baja.';
    }
    if (key === 'premium') {
      return 'Solo referencia para el equipo. La regla automática del POS aplica únicamente al nivel VIP.';
    }
    if (!isBuiltinTier(key)) {
      return 'Nivel personalizado. Asígnarlo a mano en Socios. La auto-subida por gasto del POS sigue aplicando solo a VIP.';
    }
    return '';
  }

  function renderTiers() {
    const grid = $('membership-tiers-grid');
    if (!grid) return;

    if (!tiersCache.length) useDefaultTiers();

    grid.innerHTML = '';

    if (migrationMissing) {
      const note = document.createElement('p');
      note.className = 'sc-membership-empty';
      note.innerHTML =
        'Para guardar en la nube, ejecuta en Supabase <code>046_club_membership_tiers.sql</code>. Mientras tanto puedes editar y ver la vista previa en esta sesión.';
      grid.appendChild(note);
    }

    tiersCache.forEach((t) => {
      const card = document.createElement('article');
      const enabled = t.is_enabled !== false;
      card.className = 'sc-membership-tier' + (enabled ? '' : ' is-disabled');
      card.style.setProperty('--tier-color', normalizeHex(t.color_hex));
      card.setAttribute('data-tier-key', t.tier_key);

      const color = normalizeHex(t.color_hex);
      const name = t.display_name || t.tier_key;
      const key = t.tier_key;

      let autoBlock = '';
      if (key === 'standard') {
        autoBlock = `
          <p class="sc-membership-tier__note">
            Nivel base · sin auto-upgrade. Renómbralo si quieres (ej. “Socio”).
          </p>
        `;
      } else if (key === 'vip') {
        autoBlock = `
          <div class="sc-membership-tier__auto sc-membership-tier__auto--live">
            <p class="sc-membership-tier__auto-title">
              Activación por gasto en POS
              <span class="sc-membership-tier__auto-badge">Activo en POS</span>
            </p>
            <label class="sc-membership-tier__toggle">
              <input type="checkbox" data-field="auto_upgrade_enabled" ${t.auto_upgrade_enabled ? 'checked' : ''} />
              Activación automática
            </label>
            <div class="sc-membership-tier__auto-grid">
              <div class="form__row">
                <label data-currency-label="Umbral ({s})">Umbral (€)</label>
                <input class="input" data-field="spend_threshold_eur" type="number" min="0" step="0.01"
                  value="${escapeHtml(String(t.spend_threshold_eur ?? 0))}" />
              </div>
              <div class="form__row">
                <label>Ventana (días)</label>
                <input class="input" data-field="spend_window_days" type="number" min="1" max="365" step="1"
                  value="${escapeHtml(String(t.spend_window_days ?? 7))}" />
              </div>
            </div>
            <p class="sc-membership-tier__hint">${escapeHtml(autoHintFor(key))}</p>
          </div>
        `;
      } else {
        autoBlock = `
          <div class="sc-membership-tier__auto sc-membership-tier__auto--ref">
            <p class="sc-membership-tier__auto-title">
              Gasto POS
              <span class="sc-membership-tier__auto-badge">Referencia</span>
            </p>
            <label class="sc-membership-tier__toggle">
              <input type="checkbox" data-field="auto_upgrade_enabled" ${t.auto_upgrade_enabled ? 'checked' : ''} />
              Mostrar como objetivo interno
            </label>
            <div class="sc-membership-tier__auto-grid">
              <div class="form__row">
                <label data-currency-label="Umbral ({s})">Umbral (€)</label>
                <input class="input" data-field="spend_threshold_eur" type="number" min="0" step="0.01"
                  value="${escapeHtml(String(t.spend_threshold_eur ?? 0))}" />
              </div>
              <div class="form__row">
                <label>Ventana (días)</label>
                <input class="input" data-field="spend_window_days" type="number" min="1" max="365" step="1"
                  value="${escapeHtml(String(t.spend_window_days ?? 7))}" />
              </div>
            </div>
            <p class="sc-membership-tier__hint">${escapeHtml(autoHintFor(key))}</p>
          </div>
        `;
      }

      const giftCount = rewardsForTier(key).length;
      const giftBadge =
        giftCount > 0
          ? `<span class="sc-membership-tier__gift-count">${giftCount} regalo${giftCount === 1 ? '' : 's'}</span>`
          : '';

      const deleteBtn = !isBuiltinTier(key)
        ? `<div class="sc-membership-tier__actions">
            <button type="button" class="btn btn--ghost btn--small btn--danger" data-tier-delete>
              Eliminar nivel
            </button>
          </div>`
        : '';

      card.innerHTML = `
        <button type="button" class="sc-membership-tier__summary" data-tier-toggle aria-expanded="false">
          <span class="sc-membership-tier__preview" data-tier-preview>${escapeHtml(name)}</span>
          <span class="sc-membership-tier__summary-meta">
            ${giftBadge}
            <span class="sc-membership-tier__key">${escapeHtml(key)}</span>
            <span class="sc-membership-tier__chevron" aria-hidden="true"></span>
          </span>
        </button>
        <div class="sc-membership-tier__body" hidden>
          <div class="sc-membership-tier__name-row">
            <div class="form__row">
              <label for="tier-name-${escapeHtml(key)}">Nombre visible</label>
              <input
                class="input"
                id="tier-name-${escapeHtml(key)}"
                data-field="display_name"
                type="text"
                maxlength="40"
                autocomplete="off"
                value="${escapeHtml(name)}"
                placeholder="Ej. Oro, Platino…"
              />
            </div>
            <div class="form__row">
              <label for="tier-color-${escapeHtml(key)}">Color</label>
              <input
                class="input sc-membership-tier__color"
                id="tier-color-${escapeHtml(key)}"
                data-field="color_hex"
                type="color"
                value="${escapeHtml(color)}"
                title="Color del nivel"
              />
            </div>
          </div>
          <div class="sc-membership-tier__grid">
            <div class="form__row form__row--full">
              <label>Descripción corta</label>
              <input class="input" data-field="description" type="text" value="${escapeHtml(t.description || '')}" placeholder="Qué es este nivel" />
            </div>
            <div class="form__row form__row--full">
              <label>Beneficios</label>
              <textarea class="input" data-field="benefits_text" rows="3" placeholder="Qué ofrece este nivel al socio">${escapeHtml(t.benefits_text || '')}</textarea>
            </div>
            <div class="form__row">
              <label>Vigencia por defecto (días)</label>
              <input class="input" data-field="default_valid_days" type="number" min="1" step="1"
                placeholder="Vacío = sin caducidad"
                value="${t.default_valid_days != null ? escapeHtml(String(t.default_valid_days)) : ''}" />
            </div>
            <div class="form__row">
              <label class="sc-membership-tier__toggle" style="margin-top:1.35rem">
                <input type="checkbox" data-field="is_enabled" ${enabled ? 'checked' : ''} />
                Nivel activo
              </label>
            </div>
          </div>
          ${autoBlock}
          <section class="sc-membership-tier-gifts" data-tier-gifts="${escapeHtml(key)}" aria-label="Regalos de ${escapeHtml(name)}">
            <div class="sc-membership-tier-gifts__head">
              <h4>Regalos de este nivel</h4>
              <p class="hint">Producto del POS · se entrega <strong>gratis</strong> según la regla</p>
            </div>
            <div class="sc-membership-tier-gifts__list" data-tier-gifts-list></div>
            <div class="sc-membership-tier-gifts__form" data-tier-gifts-form>
              <div class="sc-membership-reward-form__grid">
                <div class="form__row">
                  <label>Producto del POS</label>
                  <select class="input" data-reward-product>
                    <option value="">— Elige un producto —</option>
                  </select>
                </div>
                <div class="form__row">
                  <label>Cantidad <span class="hint" data-reward-qty-unit>(ud)</span></label>
                  <input class="input" data-reward-qty type="number" min="0.001" step="any" value="1" />
                </div>
                <div class="form__row">
                  <label>Cuándo se aplica</label>
                  <select class="input" data-reward-trigger>
                    <option value="on_upgrade">Al subir a este nivel</option>
                    <option value="spend_threshold">Por gasto acumulado</option>
                    <option value="birthday">Cumpleaños</option>
                    <option value="manual">Manual / nota interna</option>
                  </select>
                </div>
                <div class="form__row is-hidden" data-reward-spend-wrap hidden>
                  <label data-currency-label="Gasto objetivo ({s})">Gasto objetivo (€)</label>
                  <input class="input" data-reward-spend type="number" min="0" step="0.01" placeholder="Ej. 200" />
                </div>
                <div class="form__row form__row--full">
                  <label>Instrucciones para el equipo</label>
                  <input class="input" data-reward-desc type="text" placeholder="Qué entregar y cómo anotarlo" autocomplete="off" />
                </div>
              </div>
              <div class="row-actions" style="margin-top:0.55rem">
                <button type="button" class="btn btn--small" data-reward-add>Añadir regalo</button>
              </div>
            </div>
          </section>
          ${deleteBtn}
        </div>
      `;

      // Campos ocultos para que readTiersFromDom siga leyendo standard sin inputs de gasto
      if (key === 'standard') {
        const hidden = document.createElement('div');
        hidden.hidden = true;
        hidden.innerHTML = `
          <input type="checkbox" data-field="auto_upgrade_enabled" disabled />
          <input data-field="spend_threshold_eur" type="hidden" value="0" />
          <input data-field="spend_window_days" type="hidden" value="7" />
        `;
        card.querySelector('.sc-membership-tier__body')?.appendChild(hidden);
      }

      const nameInput = card.querySelector('[data-field="display_name"]');
      const colorInput = card.querySelector('[data-field="color_hex"]');
      const preview = card.querySelector('[data-tier-preview]');
      const enabledInput = card.querySelector('[data-field="is_enabled"]');
      const toggleBtn = card.querySelector('[data-tier-toggle]');
      const body = card.querySelector('.sc-membership-tier__body');

      const syncPreview = () => {
        const n = (nameInput?.value || '').trim() || key;
        const c = normalizeHex(colorInput?.value, t.color_hex);
        card.style.setProperty('--tier-color', c);
        if (preview) preview.textContent = n;
      };

      const setOpen = (open) => {
        card.classList.toggle('is-open', open);
        if (body) {
          body.hidden = !open;
        }
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      };

      toggleBtn?.addEventListener('click', () => {
        const willOpen = !card.classList.contains('is-open');
        grid.querySelectorAll('.sc-membership-tier.is-open').forEach((other) => {
          if (other === card) return;
          other.classList.remove('is-open');
          const ob = other.querySelector('.sc-membership-tier__body');
          const ot = other.querySelector('[data-tier-toggle]');
          if (ob) ob.hidden = true;
          if (ot) ot.setAttribute('aria-expanded', 'false');
        });
        setOpen(willOpen);
      });

      nameInput?.addEventListener('input', syncPreview);
      colorInput?.addEventListener('input', syncPreview);
      enabledInput?.addEventListener('change', () => {
        card.classList.toggle('is-disabled', !enabledInput.checked);
      });
      card.querySelector('[data-tier-delete]')?.addEventListener('click', () => {
        void removeCustomTier(key);
      });

      bindTierGiftForm(card, key);
      renderTierGiftList(card, key);

      setOpen(false);
      grid.appendChild(card);
    });

    if (typeof window.scRefreshCurrencyDom === 'function') {
      window.scRefreshCurrencyDom();
    }
    renderOrphanRewardsNote(grid);
  }

  function renderOrphanRewardsNote(grid) {
    if (!grid) return;
    grid.querySelector('[data-orphan-rewards]')?.remove();
    const orphans = (rewardsCache || []).filter((r) => !r.tier_key);
    if (!orphans.length) return;
    const note = document.createElement('div');
    note.className = 'sc-membership-orphan-rewards';
    note.setAttribute('data-orphan-rewards', '1');
    note.innerHTML = `
      <p class="hint" style="margin:0 0 0.45rem">
        <strong>${orphans.length}</strong> regalo(s) antiguos sin nivel concreto.
        Ábrelo aquí para pausarlo o borrarlo; los nuevos van dentro de cada nivel.
      </p>
      <div class="sc-membership-tier-gifts__list" data-orphan-list></div>
    `;
    const list = note.querySelector('[data-orphan-list]');
    orphans.forEach((r) => {
      const item = document.createElement('article');
      item.className =
        'sc-membership-tier-gift' + (r.is_active ? '' : ' sc-membership-tier-gift--paused');
      item.innerHTML = `
        <div class="sc-membership-tier-gift__main">
          <strong>${escapeHtml(r.title)}</strong>
          <span class="sc-membership-tier-gift__meta">
            ${escapeHtml(triggerLabel(r.trigger_type))} · ${r.is_active ? 'Activo' : 'Pausado'}
          </span>
        </div>
        <div class="sc-membership-tier-gift__actions">
          <button type="button" class="btn btn--ghost btn--small" data-reward-toggle="${r.id}">
            ${r.is_active ? 'Pausar' : 'Activar'}
          </button>
          <button type="button" class="btn btn--ghost btn--small btn--danger" data-reward-del="${r.id}">
            Borrar
          </button>
        </div>
      `;
      item.querySelector('[data-reward-toggle]')?.addEventListener('click', () => {
        void toggleReward(r.id, !r.is_active);
      });
      item.querySelector('[data-reward-del]')?.addEventListener('click', () => {
        void deleteReward(r.id);
      });
      list.appendChild(item);
    });
    grid.appendChild(note);
  }

  function setCreateTierMsg(text, isError) {
    const el = $('membership-tier-create-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (text ? (isError ? ' msg--error' : ' msg--ok') : '');
  }

  function syncCreateTierPreview() {
    const name = ($('tier-create-name')?.value || '').trim() || 'Nuevo nivel';
    const color = normalizeHex($('tier-create-color')?.value, '#7c3aed');
    const preview = $('tier-create-preview');
    if (preview) {
      preview.textContent = name;
      preview.style.setProperty('--tier-color', color);
    }
  }

  function openCreateTierModal() {
    if (!isAdmin()) {
      setMsg('Solo el administrador puede crear niveles.', true);
      return;
    }
    if (!customTiersAllowed && !migrationMissing) {
      setMsg(
        'Para crear más niveles ejecuta 054_custom_membership_tiers.sql en Supabase.',
        true,
      );
      return;
    }
    const fromDom = document.querySelectorAll('#membership-tiers-grid [data-tier-key]').length
      ? readTiersFromDom()
      : tiersCache.slice();
    tiersCache = fromDom;

    const suggested = `Nivel ${tiersCache.length + 1}`;
    if ($('tier-create-name')) $('tier-create-name').value = suggested;
    if ($('tier-create-color')) $('tier-create-color').value = nextCustomColor();
    if ($('tier-create-description')) $('tier-create-description').value = '';
    if ($('tier-create-benefits')) $('tier-create-benefits').value = '';
    if ($('tier-create-valid-days')) $('tier-create-valid-days').value = '';
    if ($('tier-create-threshold')) $('tier-create-threshold').value = '0';
    if ($('tier-create-window')) $('tier-create-window').value = '7';
    if ($('tier-create-enabled')) $('tier-create-enabled').checked = true;
    clearCreateGiftFields();
    fillRewardProductSelect($('tier-create-gift-product'), '— Sin regalo por ahora —');
    setCreateTierMsg('', false);
    syncCreateTierPreview();
    syncCreateGiftSpendVisibility();

    const modal = $('membership-tier-create-modal');
    if (!modal) return;
    modal.hidden = false;
    modal.classList.remove('is-hidden', 'is-leaving');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      $('tier-create-name')?.focus?.();
      $('tier-create-name')?.select?.();
    });
  }

  function closeCreateTierModal() {
    const modal = $('membership-tier-create-modal');
    if (!modal || modal.classList.contains('is-hidden')) return;
    modal.classList.add('is-leaving');
    window.setTimeout(() => {
      modal.classList.add('is-hidden');
      modal.classList.remove('is-leaving');
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      setCreateTierMsg('', false);
    }, 180);
  }

  function submitCreateTierModal() {
    if (!isAdmin()) {
      setCreateTierMsg('Solo el administrador puede crear niveles.', true);
      return;
    }
    const fromDom = document.querySelectorAll('#membership-tiers-grid [data-tier-key]').length
      ? readTiersFromDom()
      : tiersCache.slice();
    tiersCache = fromDom;

    const display_name = ($('tier-create-name')?.value || '').trim().slice(0, 40);
    if (!display_name) {
      setCreateTierMsg('Indica un nombre para el nivel.', true);
      $('tier-create-name')?.focus?.();
      return;
    }

    const color_hex = normalizeHex($('tier-create-color')?.value, nextCustomColor());
    const description = ($('tier-create-description')?.value || '').trim().slice(0, 160);
    const benefits_text = ($('tier-create-benefits')?.value || '').trim().slice(0, 500);
    const validRaw = ($('tier-create-valid-days')?.value || '').trim();
    let default_valid_days = null;
    if (validRaw !== '') {
      const n = Number(validRaw);
      if (!Number.isFinite(n) || n < 1) {
        setCreateTierMsg('La vigencia debe ser un número de días ≥ 1, o déjala vacía.', true);
        $('tier-create-valid-days')?.focus?.();
        return;
      }
      default_valid_days = Math.trunc(n);
    }
    const spend_threshold_eur = Number($('tier-create-threshold')?.value || 0);
    if (!Number.isFinite(spend_threshold_eur) || spend_threshold_eur < 0) {
      setCreateTierMsg('El umbral de gasto no es válido.', true);
      $('tier-create-threshold')?.focus?.();
      return;
    }
    const spend_window_days = Math.max(
      1,
      Math.min(365, Math.trunc(Number($('tier-create-window')?.value || 7) || 7)),
    );
    const is_enabled = $('tier-create-enabled')?.checked !== false;
    const tier_key = slugifyTierKey(display_name);

    const row = {
      id: null,
      club_id: ctx?.club?.id || null,
      tier_key,
      display_name,
      color_hex,
      description,
      benefits_text,
      auto_upgrade_enabled: false,
      spend_threshold_eur,
      spend_window_days,
      default_valid_days,
      is_enabled,
      sort_order: nextSortOrder(),
    };

    const giftDraft = readCreateGiftDraft();

    tiersCache = [...fromDom.filter((t) => t.tier_key !== tier_key), row];
    publishTierGlobal();
    renderTiers();
    closeCreateTierModal();

    const card = document.querySelector(
      `#membership-tiers-grid [data-tier-key="${CSS.escape(tier_key)}"]`,
    );
    if (card) {
      card.querySelector('[data-tier-toggle]')?.click();
    }

    if (giftDraft) {
      setMsg(
        migrationMissing
          ? 'Nivel añadido en esta sesión. Guardando regalo…'
          : 'Nivel creado. Guardando regalo… Pulsa «Guardar cambios» para fijar el nivel en la nube.',
        false,
      );
      void addRewardForTier(tier_key, giftDraft, {
        quietOk: true,
        openCard: false,
      }).then((ok) => {
        if (ok) {
          setMsg(
            migrationMissing
              ? 'Nivel y regalo añadidos en esta sesión. Ejecuta las migraciones para guardarlos.'
              : 'Nivel creado con regalo. Pulsa «Guardar cambios» para fijar el nivel en la nube.',
            false,
          );
        }
      });
    } else {
      setMsg(
        migrationMissing
          ? 'Nivel añadido en esta sesión. Ejecuta las migraciones de membresía para guardarlo.'
          : 'Nivel creado. Pulsa «Guardar cambios» para fijarlo en la nube.',
        false,
      );
    }
    notifyLabelsUpdated();
  }

  function addCustomTier() {
    openCreateTierModal();
  }

  async function removeCustomTier(tierKey) {
    if (!isAdmin() || isBuiltinTier(tierKey)) return;
    const name = window.scClubMembershipTierLabel?.(tierKey) || tierKey;
    if (!window.confirm(`¿Eliminar el nivel «${name}»? Los socios con este tipo deberán reasignarse.`)) {
      return;
    }

    const fromDom = document.querySelectorAll('#membership-tiers-grid [data-tier-key]').length
      ? readTiersFromDom()
      : tiersCache.slice();
    const prev = fromDom.find((t) => t.tier_key === tierKey) || tiersCache.find((t) => t.tier_key === tierKey);

    if (prev?.id && sb() && ctx?.club?.id && !migrationMissing) {
      let memberCount = 0;
      let { count, error: countErr } = await sb()
        .from('club_members')
        .select('id', { count: 'exact', head: true })
        .eq('club_id', ctx.club.id)
        .eq('member_type', tierKey)
        .eq('is_archived', false);
      if (countErr) {
        ({ count, error: countErr } = await sb()
          .from('club_members')
          .select('id', { count: 'exact', head: true })
          .eq('club_id', ctx.club.id)
          .eq('member_type', tierKey));
      }
      if (!countErr) memberCount = count || 0;
      if (memberCount > 0) {
        setMsg(
          `Hay ${memberCount} socio(s) con este nivel. Cámbiales el tipo en Socios antes de eliminarlo.`,
          true,
        );
        return;
      }
      const { error } = await sb()
        .from('club_membership_tiers')
        .delete()
        .eq('id', prev.id)
        .eq('club_id', ctx.club.id);
      if (error) {
        setMsg(error.message || 'No se pudo eliminar el nivel.', true);
        return;
      }
    }

    tiersCache = fromDom.filter((t) => t.tier_key !== tierKey);
    publishTierGlobal();
    renderTiers();
    notifyLabelsUpdated();
    setMsg(`Nivel «${name}» eliminado.`, false);
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
    if (!rows.length) {
      setMsg('No hay niveles para guardar. Recarga la página.', true);
      return;
    }
    for (const r of rows) {
      if (!r.display_name) {
        setMsg('Cada nivel necesita un nombre.', true);
        return;
      }
      if (r.spend_threshold_eur < 0 || r.spend_window_days < 1) {
        setMsg(
          `Revisa umbral (${typeof window.scGetCurrencySymbol === 'function' ? window.scGetCurrencySymbol() : '€'}) y ventana (días).`,
          true,
        );
        return;
      }
    }

    // Actualiza cache local ya (nombres visibles al instante)
    tiersCache = rows.map((r) => ({ ...r }));
    publishTierGlobal();
    notifyLabelsUpdated();

    if (migrationMissing) {
      setMsg(
        'Nombres actualizados en esta sesión. Ejecuta 046_club_membership_tiers.sql en Supabase para guardarlos de forma permanente.',
        true,
      );
      renderTiers();
      return;
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
      if (isMissingTableErr(error)) {
        migrationMissing = true;
        setMsg(
          'Ejecuta en Supabase 046_club_membership_tiers.sql para guardar la membresía en la nube.',
          true,
        );
        return;
      }
      const msg = String(error.message || '');
      if (
        msg.includes('tier_key') ||
        msg.includes('club_membership_tiers_tier_key') ||
        error.code === '23514'
      ) {
        customTiersAllowed = false;
        setMsg(
          'Para guardar niveles nuevos ejecuta 054_custom_membership_tiers.sql en Supabase.',
          true,
        );
        return;
      }
      setMsg(error.message || 'No se pudieron guardar los niveles.', true);
      return;
    }

    customTiersAllowed = true;
    await loadTiers();
    renderTiers();
    notifyLabelsUpdated();
    setMsg('Niveles guardados. Los nombres se verán en Socios y POS.', false);
  }

  async function loadRewards() {
    if (!ctx?.club?.id || !sb()) {
      rewardsCache = [];
      return rewardsCache;
    }
    const { data, error } = await sb()
      .from('club_membership_rewards')
      .select('*')
      .eq('club_id', ctx.club.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      if (isMissingTableErr(error)) {
        migrationMissing = true;
        rewardsCache = [];
        return rewardsCache;
      }
      console.warn('loadRewards', error);
      rewardsCache = [];
      return rewardsCache;
    }
    rewardsCache = data || [];
    return rewardsCache;
  }

  function bindTierGiftForm(card, tierKey) {
    const form = card.querySelector('[data-tier-gifts-form]');
    if (!form) return;
    const productSel = form.querySelector('[data-reward-product]');
    fillRewardProductSelect(productSel);
    syncRewardQtyUnitLabel(
      productSel,
      form.querySelector('[data-reward-qty-unit]'),
      form.querySelector('[data-reward-qty]'),
    );

    productSel?.addEventListener('change', () => {
      syncRewardQtyUnitLabel(
        productSel,
        form.querySelector('[data-reward-qty-unit]'),
        form.querySelector('[data-reward-qty]'),
      );
    });

    const triggerSel = form.querySelector('[data-reward-trigger]');
    const spendWrap = form.querySelector('[data-reward-spend-wrap]');
    const syncSpend = () => {
      if (!spendWrap) return;
      const show = triggerSel?.value === 'spend_threshold';
      spendWrap.hidden = !show;
      spendWrap.classList.toggle('is-hidden', !show);
    };
    triggerSel?.addEventListener('change', syncSpend);
    syncSpend();

    form.querySelector('[data-reward-add]')?.addEventListener('click', () => {
      const fields = readRewardFieldsFromRoot(form);
      void addRewardForTier(tierKey, fields, { formRoot: form });
    });
  }

  function updateTierGiftBadge(card, tierKey) {
    const meta = card?.querySelector('.sc-membership-tier__summary-meta');
    if (!meta) return;
    const count = rewardsForTier(tierKey).length;
    let badge = meta.querySelector('.sc-membership-tier__gift-count');
    if (count <= 0) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'sc-membership-tier__gift-count';
      const keyEl = meta.querySelector('.sc-membership-tier__key');
      meta.insertBefore(badge, keyEl || meta.firstChild);
    }
    badge.textContent = `${count} regalo${count === 1 ? '' : 's'}`;
  }

  function renderTierGiftList(card, tierKey) {
    const list = card?.querySelector('[data-tier-gifts-list]');
    if (!list) return;
    const rows = rewardsForTier(tierKey);
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML =
        '<p class="sc-membership-tier-gifts__empty">Sin regalos en este nivel. Añade uno abajo.</p>';
      updateTierGiftBadge(card, tierKey);
      return;
    }
    rows.forEach((r) => {
      const item = document.createElement('article');
      item.className =
        'sc-membership-tier-gift' + (r.is_active ? '' : ' sc-membership-tier-gift--paused');
      const product = rewardProductsCache.find((p) => String(p.id) === String(r.product_id || ''));
      const unitLabel = product?.sale_unit === 'unit' ? 'ud' : product ? 'g' : '';
      const qtyNum = Number(r.quantity);
      const qtyText =
        Number.isFinite(qtyNum) && qtyNum > 0
          ? `${qtyNum.toLocaleString('es-ES', { maximumFractionDigits: 3 })}${unitLabel ? ` ${unitLabel}` : ''}`
          : '1';
      const triggerExtra =
        r.trigger_type === 'spend_threshold' && r.trigger_spend_eur != null
          ? ` · ≥ ${typeof window.scFormatMoney === 'function' ? window.scFormatMoney(r.trigger_spend_eur) : `${Number(r.trigger_spend_eur).toLocaleString('es-ES')} €`}`
          : '';
      item.innerHTML = `
        <div class="sc-membership-tier-gift__main">
          <strong>${escapeHtml(r.title)}</strong>
          <span class="sc-membership-tier-gift__meta">
            ${escapeHtml(qtyText)} · ${escapeHtml(triggerLabel(r.trigger_type))}${escapeHtml(triggerExtra)}
            · ${r.is_active ? 'Activo' : 'Pausado'}
          </span>
          ${r.description ? `<span class="hint">${escapeHtml(r.description)}</span>` : ''}
        </div>
        <div class="sc-membership-tier-gift__actions">
          <button type="button" class="btn btn--ghost btn--small" data-reward-toggle="${r.id}">
            ${r.is_active ? 'Pausar' : 'Activar'}
          </button>
          <button type="button" class="btn btn--ghost btn--small btn--danger" data-reward-del="${r.id}">
            Borrar
          </button>
        </div>
      `;
      item.querySelector('[data-reward-toggle]')?.addEventListener('click', () => {
        void toggleReward(r.id, !r.is_active);
      });
      item.querySelector('[data-reward-del]')?.addEventListener('click', () => {
        void deleteReward(r.id);
      });
      list.appendChild(item);
    });
    updateTierGiftBadge(card, tierKey);
  }

  function renderRewards() {
    const grid = $('membership-tiers-grid');
    document.querySelectorAll('#membership-tiers-grid [data-tier-key]').forEach((card) => {
      const key = card.getAttribute('data-tier-key');
      if (key) renderTierGiftList(card, key);
    });
    renderOrphanRewardsNote(grid);
  }

  async function addRewardForTier(tierKey, fields, opts = {}) {
    if (!isAdmin()) {
      setMsg('Solo el administrador puede añadir regalos.', true);
      return false;
    }
    if (migrationMissing) {
      setMsg('Ejecuta 046_club_membership_tiers.sql en Supabase para poder guardar regalos.', true);
      return false;
    }
    if (!tierKey) {
      setMsg('Falta el nivel del regalo.', true);
      return false;
    }
    const productId = (fields?.productId || '').trim();
    if (!productId) {
      setMsg('Elige un producto del POS para el regalo.', true);
      return false;
    }
    const product = rewardProductsCache.find((p) => String(p.id) === productId);
    const title = String(product?.name || '').trim();
    if (!title) {
      setMsg('El producto elegido no es válido.', true);
      return false;
    }
    const isUnitProduct = product?.sale_unit === 'unit';
    const qtyRaw = (fields?.qtyRaw || '').trim();
    let quantity = qtyRaw === '' ? 1 : Number(qtyRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setMsg('Indica una cantidad válida mayor que 0.', true);
      return false;
    }
    if (isUnitProduct) {
      quantity = Math.round(quantity);
      if (quantity < 1) {
        setMsg('Para productos por unidad la cantidad debe ser al menos 1.', true);
        return false;
      }
    }
    const trigger = fields?.trigger || 'on_upgrade';
    const desc = (fields?.desc || '').trim();
    let spend = null;
    if (trigger === 'spend_threshold') {
      const raw = (fields?.spendRaw || '').trim();
      spend = raw === '' ? null : Number(raw);
      if (spend == null || Number.isNaN(spend) || spend < 0) {
        setMsg('Indica un gasto objetivo válido.', true);
        return false;
      }
    }

    if (!opts.quietOk) setMsg('Guardando regalo…', false);
    const payload = {
      club_id: ctx.club.id,
      title,
      description: desc,
      tier_key: tierKey,
      trigger_type: trigger,
      trigger_spend_eur: spend,
      is_active: true,
      sort_order: rewardsCache.length,
      product_id: productId,
      quantity,
    };
    let { error } = await sb().from('club_membership_rewards').insert([payload]);
    if (
      error &&
      (error.code === '42703' ||
        error.code === 'PGRST204' ||
        String(error.message || '').toLowerCase().includes('quantity'))
    ) {
      const withoutQty = { ...payload };
      delete withoutQty.quantity;
      ({ error } = await sb().from('club_membership_rewards').insert([withoutQty]));
      if (!error) {
        setMsg(
          'Regalo guardado sin cantidad. Ejecuta 053_membership_reward_quantity.sql en Supabase.',
          true,
        );
        if (opts.formRoot) clearRewardFields(opts.formRoot);
        await loadRewards();
        renderRewards();
        return true;
      }
    }
    if (
      error &&
      (error.code === '42703' ||
        error.code === 'PGRST204' ||
        String(error.message || '').toLowerCase().includes('product_id'))
    ) {
      hasRewardProductColumn = false;
      const withoutProduct = { ...payload };
      delete withoutProduct.product_id;
      delete withoutProduct.quantity;
      ({ error } = await sb().from('club_membership_rewards').insert([withoutProduct]));
      if (!error) {
        setMsg(
          'Regalo guardado sin enlace al POS. Ejecuta 052_membership_reward_products.sql en Supabase para la entrega automática.',
          true,
        );
        if (opts.formRoot) clearRewardFields(opts.formRoot);
        await loadRewards();
        renderRewards();
        return true;
      }
    }

    if (error) {
      if (isMissingTableErr(error)) {
        migrationMissing = true;
        setMsg('Ejecuta 046_club_membership_tiers.sql en Supabase para activar regalos.', true);
        return false;
      }
      setMsg(error.message || 'No se pudo añadir el regalo.', true);
      return false;
    }

    if (opts.formRoot) clearRewardFields(opts.formRoot);
    await loadRewards();
    renderRewards();
    if (!opts.quietOk) {
      setMsg('Regalo añadido a este nivel. En el POS se entregará gratis (una vez).', false);
    }
    return true;
  }

  /**
   * Inserta grants pendientes (ignora duplicados unique member_id+reward_id).
   */
  async function insertRewardGrants(memberId, rewards) {
    if (!ctx?.club?.id || !sb() || !memberId || !rewards?.length) {
      return { ok: false, created: 0 };
    }
    if (!hasRewardGrantsTable) return { ok: false, created: 0 };

    let created = 0;
    for (const r of rewards) {
      if (!r?.id || !r.product_id) continue;
      const qtyRaw = Number(r.quantity);
      const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
      const row = {
        club_id: ctx.club.id,
        member_id: memberId,
        reward_id: r.id,
        product_id: r.product_id,
        quantity,
        status: 'pending',
      };
      let { error } = await sb().from('club_membership_reward_grants').insert([row]);
      if (
        error &&
        (error.code === '42703' ||
          error.code === 'PGRST204' ||
          String(error.message || '').toLowerCase().includes('quantity'))
      ) {
        const withoutQty = { ...row };
        delete withoutQty.quantity;
        ({ error } = await sb().from('club_membership_reward_grants').insert([withoutQty]));
      }
      if (error) {
        const msg = String(error.message || '').toLowerCase();
        if (
          error.code === '42P01' ||
          error.code === 'PGRST205' ||
          msg.includes('club_membership_reward_grants')
        ) {
          hasRewardGrantsTable = false;
          return { ok: false, created, needMigration: true };
        }
        // unique = ya concedido (pending o fulfilled)
        if (error.code === '23505') continue;
        console.warn('insertRewardGrants', error);
        continue;
      }
      created += 1;
    }
    return { ok: true, created };
  }

  async function ensureRewardsLoaded() {
    if (rewardsCache.length) return rewardsCache;
    try {
      await loadRewards();
    } catch (_) {
      /* ignore */
    }
    return rewardsCache;
  }

  function isMemberBirthdayToday(member) {
    const iso = member?.birth_date;
    if (!iso) return false;
    const raw = String(iso).slice(0, 10);
    const parts = raw.split('-');
    if (parts.length !== 3) return false;
    const mo = Number(parts[1]);
    const d = Number(parts[2]);
    if (!Number.isFinite(mo) || !Number.isFinite(d)) return false;
    const today = new Date();
    return today.getMonth() + 1 === mo && today.getDate() === d;
  }

  /**
   * Crea grants pendientes cuando un socio sube de nivel (manual o auto-VIP).
   * Solo para regalos on_upgrade con product_id del nivel destino (o cualquiera).
   */
  async function grantUpgradeRewards(memberId, fromTier, toTier) {
    if (!memberId || !toTier) return { ok: false, created: 0 };
    if (tierRank(toTier) <= tierRank(fromTier || 'standard')) {
      return { ok: true, created: 0 };
    }
    const rewards = await ensureRewardsLoaded();
    const matching = (rewards || []).filter((r) => {
      if (!r?.is_active) return false;
      if (r.trigger_type !== 'on_upgrade') return false;
      if (!r.product_id) return false;
      if (r.tier_key && r.tier_key !== toTier) return false;
      return true;
    });
    return insertRewardGrants(memberId, matching);
  }

  /**
   * Al seleccionar socio en TPV: crea grants pendientes que le correspondan ya
   * (nivel actual o cumpleaños), para que el regalo aparezca aunque el upgrade
   * fuera anterior a configurar el regalo.
   */
  async function syncEligibleGrantsForMember(member) {
    if (!member?.id || !ctx?.club?.id) return { ok: false, created: 0 };
    const rewards = await ensureRewardsLoaded();
    const tier = member.member_type || 'standard';
    const birthday = isMemberBirthdayToday(member);

    const matching = (rewards || []).filter((r) => {
      if (!r?.is_active || !r.product_id) return false;
      if (r.tier_key && r.tier_key !== tier) return false;

      if (r.trigger_type === 'on_upgrade') {
        // Nivel concreto → socios de ese nivel. Sin nivel (cualquiera) → no Estándar.
        if (r.tier_key) return r.tier_key === tier;
        return tier !== 'standard';
      }
      if (r.trigger_type === 'birthday') {
        return birthday;
      }
      return false;
    });

    return insertRewardGrants(member.id, matching);
  }

  window.scMembershipGrantOnTierUpgrade = async function (memberId, fromTier, toTier) {
    return grantUpgradeRewards(memberId, fromTier, toTier);
  };

  window.scMembershipSyncEligibleGrants = async function (member) {
    return syncEligibleGrantsForMember(member);
  };

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
    const saveBtn = $('membership-tiers-save');
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
    if (saveBtn) {
      saveBtn.hidden = !admin;
      saveBtn.classList.toggle('is-hidden', !admin);
    }
  }

  function bindUiOnce() {
    if (uiBound) return;
    uiBound = true;
    $('membership-tiers-save')?.addEventListener('click', () => void saveTiers());
    $('membership-tier-add')?.addEventListener('click', () => addCustomTier());
    $('membership-tier-create-submit')?.addEventListener('click', () => submitCreateTierModal());
    document.querySelectorAll('[data-tier-create-close]').forEach((el) => {
      el.addEventListener('click', () => closeCreateTierModal());
    });
    $('tier-create-name')?.addEventListener('input', syncCreateTierPreview);
    $('tier-create-color')?.addEventListener('input', syncCreateTierPreview);
    $('tier-create-gift-product')?.addEventListener('change', () => {
      syncRewardQtyUnitLabel(
        $('tier-create-gift-product'),
        $('tier-create-gift-qty-unit'),
        $('tier-create-gift-qty'),
      );
    });
    $('tier-create-gift-trigger')?.addEventListener('change', syncCreateGiftSpendVisibility);
    $('tier-create-name')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitCreateTierModal();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const modal = $('membership-tier-create-modal');
      if (!modal || modal.classList.contains('is-hidden')) return;
      closeCreateTierModal();
    });
    syncCreateGiftSpendVisibility();
  }

  async function refreshMembershipUi() {
    if (!ctx) return;
    applyAdminGate();
    bindUiOnce();
    if (!isAdmin()) return;
    try {
      await loadTiers();
      renderTiers();
      await loadRewardProducts();
      fillAllRewardProductSelects();
      await loadRewards();
      renderRewards();
      notifyLabelsUpdated();
      if (migrationMissing) {
        setMsg(
          'Vista lista. Para guardar en la nube ejecuta 046_club_membership_tiers.sql en Supabase.',
          true,
        );
      } else if (!hasRewardProductColumn) {
        setMsg(
          'Para enlazar regalos al POS ejecuta 052_membership_reward_products.sql en Supabase.',
          true,
        );
      }
    } catch (e) {
      console.error(e);
      useDefaultTiers();
      renderTiers();
      renderRewards();
      setMsg(e.message || 'Error cargando membresía.', true);
    }
  }

  window.scInitClubMembership = async function (context) {
    ctx = context;
    bindUiOnce();
    applyAdminGate();
    useDefaultTiers();
    try {
      if (isAdmin()) {
        // Pintar ya los 3 niveles por defecto; luego hidratar desde BD
        renderTiers();
        renderRewards();
      }
      await loadTiers();
      // Cargar regalos también para no-admin (TPV necesita sync de grants)
      await loadRewards();
      if (isAdmin()) {
        renderTiers();
        await loadRewardProducts();
        fillAllRewardProductSelects();
        renderRewards();
      }
      notifyLabelsUpdated();
    } catch (e) {
      console.error(e);
      useDefaultTiers();
      if (isAdmin()) {
        renderTiers();
        renderRewards();
      }
    }
  };

  window.scClubRefreshMembership = function () {
    return refreshMembershipUi();
  };
})();
