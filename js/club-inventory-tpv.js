/**
 * Inventario + TPV (estilo rejilla / ticket, alertas, búsqueda, chips).
 */
(function () {
  const sb = () => window.scSupabase;
  const MEMBER_AVATAR_BUCKET = 'club_member_docs';

  const PRODUCT_SELECT_FULL =
    'id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit, stock_alert_grams, default_sale_grams, default_price_eur, default_price_per_gram_eur, purchase_cost_eur, retail_price_eur';
  const PRODUCT_SELECT_FULL_NO_PURCHASE_COST =
    'id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit, stock_alert_grams, default_sale_grams, default_price_eur, default_price_per_gram_eur, retail_price_eur';
  const PRODUCT_SELECT_FULL_NO_RETAIL_PRICE =
    'id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit, stock_alert_grams, default_sale_grams, default_price_eur, default_price_per_gram_eur, purchase_cost_eur';
  const PRODUCT_SELECT_FULL_NO_OPTIONAL_PRICES =
    'id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit, stock_alert_grams, default_sale_grams, default_price_eur, default_price_per_gram_eur';
  /** Sin 015: extras de TPV sí, pero sin columna €/g. */
  const PRODUCT_SELECT_EXTRAS_NO_PER_GRAM =
    'id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit, stock_alert_grams, default_sale_grams, default_price_eur';
  const PRODUCT_SELECT_BASE =
    'id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit';

  function $(id) {
    return document.getElementById(id);
  }

  /** Comparación robusta de ids de producto (Supabase / UUID como string). */
  function tpvIdsEqual(a, b) {
    if (a == null || b == null) return false;
    return String(a).trim() === String(b).trim();
  }

  const state = {
    ctx: null,
    categories: [],
    products: [],
    filterCategoryId: '',
    invSearch: '',
    tpvSearch: '',
    tpvCatFilter: '',
    tpvSelectedId: '',
    tpvMembers: [],
    tpvCart: [],
    tpvCartSeq: 0,
    tpvPendingCartRowId: null,
    uiBound: false,
    hasProductExtras: true,
    /** Turno abierto actual (TPV); null si no hay. */
    tpvOpenShiftId: null,
    /** Mapa auth user id → email (mismo club). */
    staffById: {},
    emojiPickerReady: false,
    emojiPickerLoading: false,
    hasPurchaseCostColumn: true,
    hasRetailPriceColumn: true,
    /** Listados activos: false si la BD no tiene columna is_archived (migración 024). */
    hasArchivedColumn: true,
    canEditInventory: false,
    adjustProductId: null,
    adjustDirection: 'add',
  };
  const EMOJI_RECENT_KEY = 'sc_inv_recent_emojis';

  function inventoryProductListQuery(selectColumns) {
    let q = sb()
      .from('inventory_products')
      .select(selectColumns)
      .eq('club_id', state.ctx.club.id);
    if (state.hasArchivedColumn) q = q.eq('is_archived', false);
    return q.order('name', { ascending: true });
  }

  function readRecentEmojis() {
    try {
      const raw = localStorage.getItem(EMOJI_RECENT_KEY) || '[]';
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter((x) => typeof x === 'string' && x.trim()).slice(0, 18);
    } catch (e) {
      return [];
    }
  }

  function writeRecentEmojis(list) {
    try {
      localStorage.setItem(EMOJI_RECENT_KEY, JSON.stringify((list || []).slice(0, 18)));
    } catch (e) {
      /* ignore quota/private-mode errors */
    }
  }

  function pushRecentEmoji(emoji) {
    const em = String(emoji || '').trim();
    if (!em) return;
    const list = readRecentEmojis().filter((x) => x !== em);
    list.unshift(em);
    writeRecentEmojis(list);
  }

  function setProductEmojiAndClose(emoji) {
    const em = String(emoji || '').trim();
    if (!em) return;
    if ($('inv-product-emoji')) $('inv-product-emoji').value = em;
    pushRecentEmoji(em);
    renderRecentEmojis();
    closeInvEmojiModal();
  }

  function renderRecentEmojis() {
    const wrap = $('inv-emoji-recent');
    if (!wrap) return;
    const list = readRecentEmojis();
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<span class="hint">Aún no has usado emojis aquí.</span>';
      return;
    }
    list.slice(0, 12).forEach((emoji) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = emoji;
      b.style.minWidth = '2.1rem';
      b.style.textAlign = 'center';
      b.addEventListener('click', () => setProductEmojiAndClose(emoji));
      wrap.appendChild(b);
    });
  }

  function openInvCatModal() {
    const modal = $('inv-cat-modal');
    if (!modal) return;
    modal.classList.remove('is-hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeInvCatModal() {
    const modal = $('inv-cat-modal');
    if (!modal) return;
    modal.classList.add('is-hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  function applyAdminInventoryPriceRows() {
    const show = state.ctx?.profile?.role === 'admin_club';
    const rowPc = $('inv-row-purchase-cost');
    if (rowPc) {
      const showPc = show && state.hasPurchaseCostColumn;
      rowPc.hidden = !showPc;
      rowPc.classList.toggle('is-hidden', !showPc);
    }
    const rowRp = $('inv-row-retail-price');
    if (rowRp) {
      const showRp = show && state.hasRetailPriceColumn;
      rowRp.hidden = !showRp;
      rowRp.classList.toggle('is-hidden', !showRp);
    }
  }

  function openInvProductModal() {
    const modal = $('inv-product-modal');
    if (!modal) return;
    applyAdminInventoryPriceRows();
    modal.classList.remove('is-hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeInvProductModal() {
    const modal = $('inv-product-modal');
    if (!modal) return;
    modal.classList.add('is-hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  async function ensureEmojiPickerLoaded() {
    if (state.emojiPickerReady) return true;
    if (window.customElements && window.customElements.get('emoji-picker')) {
      state.emojiPickerReady = true;
      return true;
    }
    if (state.emojiPickerLoading) return false;
    state.emojiPickerLoading = true;
    try {
      await import('https://cdn.jsdelivr.net/npm/emoji-picker-element@^1/index.js');
      state.emojiPickerReady = true;
      return true;
    } catch (e) {
      setMsg('inv-status', 'No se pudo cargar el selector de emojis.', true);
      return false;
    } finally {
      state.emojiPickerLoading = false;
    }
  }

  async function openInvEmojiModal() {
    const ok = await ensureEmojiPickerLoaded();
    if (!ok) return;
    renderRecentEmojis();
    const modal = $('inv-emoji-modal');
    if (!modal) return;
    modal.classList.remove('is-hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeInvEmojiModal() {
    const modal = $('inv-emoji-modal');
    if (!modal) return;
    modal.classList.add('is-hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  function setMsg(id, text, isError) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
    el.classList.toggle('msg--success', Boolean(text) && !isError);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseDecimal(str) {
    if (str === null || str === undefined) return NaN;
    const t = String(str).trim().replace(',', '.');
    if (t === '') return NaN;
    return parseFloat(t);
  }

  function formatNum(n) {
    if (n === null || n === undefined || n === '') return '—';
    const x = Number(n);
    if (Number.isNaN(x)) return String(n);
    return x.toLocaleString('es-ES', { maximumFractionDigits: 3 });
  }

  function formatMoney(n) {
    const x = Number(n);
    if (Number.isNaN(x)) return '—';
    return x.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
  }

  function canManageInventoryEdits() {
    return Boolean(state.canEditInventory);
  }

  async function loadInventoryAccessFlags(ctx) {
    if (!ctx?.profile) {
      state.canEditInventory = false;
      return;
    }
    if (ctx.profile.role === 'admin_club') {
      state.canEditInventory = true;
      return;
    }
    state.canEditInventory = false;
    try {
      const { data, error } = await sb()
        .from('club_access')
        .select('can_edit_inventory')
        .eq('club_id', ctx.club.id)
        .eq('auth_user_id', ctx.profile.id)
        .maybeSingle();
      if (!error && data) {
        state.canEditInventory = Boolean(data.can_edit_inventory);
      }
    } catch (e) {
      state.canEditInventory = false;
    }
  }

  function applyInventoryEditAccess() {
    const canEdit = canManageInventoryEdits();
    ['inv-open-cat-modal', 'inv-open-product-modal'].forEach((id) => {
      const el = $(id);
      if (el) el.hidden = !canEdit;
    });
    applyAdminInventoryPriceRows();
  }

  async function refreshStockUi() {
    if (typeof window.scClubRefreshStockUi !== 'function') return;
    try {
      await window.scClubRefreshStockUi();
    } catch (e) {
      /* ignore */
    }
  }

  function openInvAdjustModal(product) {
    if (!product) return;
    state.adjustProductId = product.id;
    state.adjustDirection = 'add';
    const modal = $('inv-adjust-modal');
    const title = $('inv-adjust-product');
    const unit = $('inv-adjust-unit');
    const stock = $('inv-adjust-current');
    const qty = $('inv-adjust-qty');
    const note = $('inv-adjust-note');
    const dirAdd = $('inv-adjust-dir-add');
    const dirRemove = $('inv-adjust-dir-remove');
    const em = (product.emoji || '').trim();
    if (title) title.textContent = `${em ? em + ' ' : ''}${product.name || '—'}`;
    if (unit) unit.textContent = unitShort(product);
    if (stock) stock.textContent = formatNum(product.stock_grams);
    if (qty) qty.value = '';
    if (note) note.value = '';
    dirAdd?.classList.add('is-active');
    dirRemove?.classList.remove('is-active');
    if (modal) {
      modal.classList.remove('is-hidden');
      modal.setAttribute('aria-hidden', 'false');
    }
    qty?.focus();
  }

  function closeInvAdjustModal() {
    const modal = $('inv-adjust-modal');
    if (!modal) return;
    modal.classList.add('is-hidden');
    modal.setAttribute('aria-hidden', 'true');
    state.adjustProductId = null;
  }

  function setInvAdjustDirection(direction) {
    state.adjustDirection = direction === 'remove' ? 'remove' : 'add';
    $('inv-adjust-dir-add')?.classList.toggle('is-active', state.adjustDirection === 'add');
    $('inv-adjust-dir-remove')?.classList.toggle('is-active', state.adjustDirection === 'remove');
  }

  async function submitInvAdjust() {
    const productId = state.adjustProductId;
    const product = state.products.find((x) => x.id === productId);
    if (!product) {
      setMsg('inv-status', 'Producto no encontrado.', true);
      return;
    }
    const raw = ($('inv-adjust-qty')?.value || '').trim();
    const amount = parseDecimal(raw);
    if (Number.isNaN(amount) || amount <= 0) {
      setMsg('inv-status', 'Indica una cantidad mayor que cero.', true);
      return;
    }
    let delta = amount;
    if (unitKey(product) === 'unit') {
      if (Math.abs(amount - Math.round(amount)) > 0.0001) {
        setMsg('inv-status', 'En productos por unidad, la cantidad debe ser entera.', true);
        return;
      }
      delta = Math.round(amount);
    }
    if (state.adjustDirection === 'remove') delta = -delta;
    const notes = ($('inv-adjust-note')?.value || '').trim();
    setMsg('inv-status', 'Guardando ajuste…', false);
    const { data, error } = await sb().rpc('club_apply_inventory_stock_adjustment', {
      p_product_id: productId,
      p_delta_grams: delta,
      p_notes: notes,
    });
    if (error) {
      const msg = error.message || 'No se pudo guardar el ajuste.';
      if (error.code === '42883' || msg.includes('club_apply_inventory_stock_adjustment')) {
        setMsg(
          'inv-status',
          'Ejecuta en Supabase la migración 020_inventory_adjustments.sql para activar los ajustes +/-.',
          true,
        );
      } else {
        setMsg('inv-status', msg, true);
      }
      return;
    }
    closeInvAdjustModal();
    setMsg(
      'inv-status',
      `Stock actualizado: ${formatNum(data)} ${unitShort(product)}.`,
      false,
    );
    await loadProducts();
    await refreshStockUi();
    if (typeof window.scClubRefreshFinance === 'function') {
      await window.scClubRefreshFinance();
    }
  }

  function normalizeProduct(p) {
    return {
      ...p,
      sale_unit: p.sale_unit === 'unit' ? 'unit' : 'grams',
      stock_alert_grams:
        p.stock_alert_grams != null && p.stock_alert_grams !== '' ? Number(p.stock_alert_grams) : 0,
      default_sale_grams:
        p.default_sale_grams != null && p.default_sale_grams !== ''
          ? Number(p.default_sale_grams)
          : null,
      default_price_eur:
        p.default_price_eur != null && p.default_price_eur !== ''
          ? Number(p.default_price_eur)
          : null,
      default_price_per_gram_eur:
        p.default_price_per_gram_eur != null && p.default_price_per_gram_eur !== ''
          ? Number(p.default_price_per_gram_eur)
          : null,
      purchase_cost_eur:
        p.purchase_cost_eur != null && p.purchase_cost_eur !== ''
          ? Number(p.purchase_cost_eur)
          : null,
      retail_price_eur:
        p.retail_price_eur != null && p.retail_price_eur !== ''
          ? Number(p.retail_price_eur)
          : null,
    };
  }

  function stockLevel(p) {
    const stock = Number(p.stock_grams) || 0;
    const min = Number(p.stock_alert_grams) || 0;
    if (stock <= 0) return 'out';
    if (min > 0 && stock <= min) return 'low';
    return 'ok';
  }

  function unitKey(p) {
    return p && p.sale_unit === 'unit' ? 'unit' : 'grams';
  }

  function unitShort(p) {
    return unitKey(p) === 'unit' ? 'ud' : 'g';
  }

  function applyInventoryUnitLabels(unit) {
    const isUnit = unit === 'unit';
    if ($('inv-label-bottle'))
      $('inv-label-bottle').textContent = isUnit ? 'Peso del bote (solo gramos)' : 'Peso del bote (g)';
    if ($('inv-label-stock')) $('inv-label-stock').textContent = isUnit ? 'Stock (ud)' : 'Stock neto (g)';
    if ($('inv-label-alert')) $('inv-label-alert').textContent = isUnit ? 'Alerta stock mín. (ud)' : 'Alerta stock mín. (g)';
    if ($('inv-label-default-qty'))
      $('inv-label-default-qty').textContent = isUnit ? 'Unidades sugeridas TPV' : 'Gramos sugeridos TPV';
    if ($('inv-label-rate'))
      $('inv-label-rate').textContent = isUnit ? 'Precio por unidad (€/u)' : 'Precio por gramo (€/g)';
    if ($('inv-label-purchase-cost'))
      $('inv-label-purchase-cost').textContent = isUnit
        ? 'Coste de compra (€/ud)'
        : 'Coste de compra (€/g)';
    if ($('inv-label-retail-price'))
      $('inv-label-retail-price').textContent = isUnit
        ? 'Precio de venta ref. (€/ud)'
        : 'Precio de venta ref. (€/g)';
    const bottle = $('inv-product-bottle');
    if (bottle) bottle.disabled = isUnit;
    const rowBottle = $('inv-row-bottle');
    if (rowBottle) rowBottle.style.opacity = isUnit ? '0.55' : '';
  }

  function setInvSaleUnitUi(unit) {
    const v = unit === 'unit' ? 'unit' : 'grams';
    if ($('inv-product-sale-unit')) $('inv-product-sale-unit').value = v;
    document.querySelectorAll('[data-inv-sale-unit]').forEach((btn) => {
      const on = btn.getAttribute('data-inv-sale-unit') === v;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    applyInventoryUnitLabels(v);
    if (v === 'unit' && $('inv-product-bottle')) $('inv-product-bottle').value = '0';
  }

  function updateTpvUnitLabels(p) {
    const u = unitShort(p);
    const title = $('tpv-lbl-grams');
    if (title) title.textContent = unitKey(p) === 'unit' ? 'Unidades' : 'Gramos';
    const a = $('tpv-label-charged');
    if (a) a.textContent = `En ticket (${u})`;
    const b = $('tpv-label-real');
    if (b) b.textContent = `Reales (${u})`;
  }

  function applyTpvStepPreset(p) {
    const isUnit = unitKey(p) === 'unit';
    const steps = isUnit ? [-1, -1, 1, 1] : [-0.1, -0.05, 0.05, 0.1];
    const labels = isUnit ? ['-1', '-1', '+1', '+1'] : ['-0,1', '-0,05', '+0,05', '+0,1'];
    const wrap = $('tpv-stepper');
    if (wrap) {
      wrap.setAttribute(
        'aria-label',
        isUnit ? 'Ajuste rápido de unidades (ticket)' : 'Ajuste rápido de gramos (ticket)',
      );
    }
    const buttons = Array.from(document.querySelectorAll('[data-tpv-step]'));
    buttons.forEach((btn, i) => {
      const d = steps[i] ?? 0;
      btn.setAttribute('data-tpv-step', String(d));
      btn.textContent = labels[i] || String(d).replace('.', ',');
    });
  }

  let toastTimer;
  function showToast(message) {
    const el = $('club-toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('is-visible');
    }, 2600);
  }

  async function getOpenShiftId(clubId) {
    const { data, error } = await sb()
      .from('shifts')
      .select('id')
      .eq('club_id', clubId)
      .is('closed_at', null)
      .maybeSingle();
    if (error) throw error;
    return data ? data.id : null;
  }

  async function loadStaffDirectory() {
    state.staffById = {};
    const { data, error } = await sb().rpc('club_staff_directory');
    if (error || !data) return;
    (data || []).forEach((row) => {
      const id = row.user_id ?? row.userId;
      const mail = row.email;
      if (id) state.staffById[id] = mail || '—';
    });
  }

  function shiftBannerLabel(open) {
    return open
      ? 'Turno abierto — puedes registrar ventas.'
      : 'No hay turno abierto. Ve a Inicio y abre un turno para usar el TPV.';
  }

  async function refreshTpvShiftState() {
    if (!state.ctx) return;
    try {
      state.tpvOpenShiftId = await getOpenShiftId(state.ctx.club.id);
    } catch (e) {
      state.tpvOpenShiftId = null;
    }
    const banner = $('tpv-shift-banner');
    if (banner) {
      banner.textContent = shiftBannerLabel(Boolean(state.tpvOpenShiftId));
      banner.classList.toggle('tpv-shift-banner--warn', !state.tpvOpenShiftId);
    }
    toggleTpvShiftControls(Boolean(state.tpvOpenShiftId));
  }

  function toggleTpvShiftControls(on) {
    const ids = [
      'tpv-submit',
      'tpv-clear-cart',
      'tpv-price',
      'tpv-grams-charged',
      'tpv-grams-dispensed',
      'tpv-notes',
      'tpv-search',
      'tpv-member-search',
      'tpv-member-clear',
      'tpv-link-grams',
    ];
    ids.forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !on;
    });
    document.querySelectorAll('[data-tpv-step]').forEach((b) => {
      b.disabled = !on;
    });
    document.querySelectorAll('#tpv-cat-chips .chip').forEach((b) => {
      b.disabled = !on;
    });
    const grid = $('tpv-product-grid');
    if (grid) grid.classList.toggle('tpv-grid--disabled', !on);
    document.querySelectorAll('#tpv-cart-list [data-tpv-cart-del]').forEach((b) => {
      b.disabled = !on;
    });
  }

  /** Precio €/g: explícito, o precio ÷ gramos sugeridos; si no hay gramos de referencia, el precio sugerido cuenta como €/g (TPV por peso). */
  function getPricePerGramForProduct(p) {
    if (!p || !state.hasProductExtras) return null;
    const perG =
      p.default_price_per_gram_eur != null && p.default_price_per_gram_eur !== ''
        ? Number(p.default_price_per_gram_eur)
        : NaN;
    if (!Number.isNaN(perG) && perG >= 0) {
      return perG;
    }
    const baseG = Number(p.default_sale_grams);
    const basePrice = Number(p.default_price_eur);
    if (Number.isNaN(basePrice) || basePrice < 0) {
      return null;
    }
    if (Number.isNaN(baseG) || baseG <= 0) {
      return basePrice;
    }
    return basePrice / baseG;
  }

  /** Recalcula precio al cliente según gramos en ticket y tarifa del producto. */
  function updatePriceFromTicketGrams() {
    const p = state.tpvSelectedId
      ? state.products.find((x) => tpvIdsEqual(x.id, state.tpvSelectedId))
      : null;
    const rate = getPricePerGramForProduct(p);
    if (rate == null) return;
    const g = parseDecimal($('tpv-grams-charged')?.value);
    if (Number.isNaN(g) || g < 0) return;
    const total = Math.round(g * rate * 100) / 100;
    const priceEl = $('tpv-price');
    if (priceEl) {
      priceEl.value = total.toLocaleString('es-ES', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
    }
    scheduleAutoTpvLine();
  }

  function formatTpvQuantityInput(qty, p) {
    if (unitKey(p) === 'unit') {
      return String(Math.max(0, Math.round(qty))).replace('.', ',');
    }
    const rounded = Math.max(0, Math.round(qty * 1000) / 1000);
    return String(rounded).replace('.', ',');
  }

  /** Recalcula cantidad en ticket según precio y tarifa del producto. */
  function updateTicketGramsFromPrice() {
    const p = state.tpvSelectedId
      ? state.products.find((x) => tpvIdsEqual(x.id, state.tpvSelectedId))
      : null;
    const rate = getPricePerGramForProduct(p);
    if (rate == null || rate <= 0) return;
    const price = parseDecimal($('tpv-price')?.value);
    if (Number.isNaN(price) || price < 0) return;
    const qty = price / rate;
    const chargedEl = $('tpv-grams-charged');
    const qtyStr = formatTpvQuantityInput(qty, p);
    if (chargedEl) chargedEl.value = qtyStr;
    if ($('tpv-link-grams')?.checked !== false) {
      const dispensedEl = $('tpv-grams-dispensed');
      if (dispensedEl) dispensedEl.value = qtyStr;
    }
    updateTpvMarginHint();
    scheduleAutoTpvLine();
  }

  async function loadCategories() {
    const { data, error } = await sb()
      .from('inventory_categories')
      .select('id, name, sort_order')
      .eq('club_id', state.ctx.club.id)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    state.categories = data || [];
    renderCategoryList();
    fillCategorySelects();
    renderTpvCategoryChips();
    renderInvCategoryChips();
  }

  function fillCategorySelects() {
    const productCat = $('inv-product-category');
    const filter = $('inv-filter-category');
    const opts = (sel) => {
      if (!sel) return;
      const keep =
        sel.id === 'inv-filter-category' || sel.id === 'inv-product-category' ? 1 : 0;
      while (sel.options.length > keep) sel.remove(keep);
      state.categories.forEach((c) => {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        sel.appendChild(o);
      });
    };
    opts(filter);
    opts(productCat);
  }

  function renderCategoryList() {
    const ul = $('inv-cat-list');
    if (!ul) return;
    ul.innerHTML = '';
    state.categories.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'inv-cat-list__item';
      li.innerHTML = `
        <span>${escapeHtml(c.name)}</span>
        <button type="button" class="btn btn--ghost btn--small" data-cat-id="${c.id}">Eliminar</button>
      `;
      li.querySelector('button').addEventListener('click', async () => {
        if (!confirm('¿Eliminar esta categoría? Los productos quedarán sin categoría.')) return;
        setMsg('inv-status', 'Eliminando…', false);
        const { error } = await sb().from('inventory_categories').delete().eq('id', c.id);
        if (error) {
          setMsg('inv-status', error.message || 'No se pudo eliminar.', true);
          return;
        }
        setMsg('inv-status', 'Categoría eliminada.', false);
        await loadCategories();
        await loadProducts();
        await refreshStockUi();
      });
      ul.appendChild(li);
    });
  }

  async function loadProducts() {
    state.hasPurchaseCostColumn = true;
    state.hasRetailPriceColumn = true;
    let query = inventoryProductListQuery(
      state.hasProductExtras ? PRODUCT_SELECT_FULL : PRODUCT_SELECT_BASE,
    );

    let { data, error } = await query;

    const colErr =
      error &&
      (error.code === '42703' ||
        (error.message && error.message.toLowerCase().includes('column')));

    if (colErr && state.hasProductExtras) {
      let msg = (error.message || '').toLowerCase();
      if (msg.includes('purchase_cost_eur')) {
        state.hasPurchaseCostColumn = false;
        const rPc = await inventoryProductListQuery(PRODUCT_SELECT_FULL_NO_PURCHASE_COST);
        if (!rPc.error) {
          data = rPc.data;
          error = null;
        } else {
          error = rPc.error;
          msg = (error.message || '').toLowerCase();
        }
      }
      if (
        error &&
        (error.code === '42703' ||
          (error.message && error.message.toLowerCase().includes('column')))
      ) {
        msg = (error.message || '').toLowerCase();
        if (msg.includes('retail_price_eur')) {
          state.hasRetailPriceColumn = false;
          const sel = state.hasPurchaseCostColumn
            ? PRODUCT_SELECT_FULL_NO_RETAIL_PRICE
            : PRODUCT_SELECT_FULL_NO_OPTIONAL_PRICES;
          const rR = await inventoryProductListQuery(sel);
          if (!rR.error) {
            data = rR.data;
            error = null;
          } else {
            error = rR.error;
            msg = (error.message || '').toLowerCase();
          }
        }
      }
      if (
        error &&
        (error.code === '42703' ||
          (error.message && error.message.toLowerCase().includes('column')))
      ) {
        msg = (error.message || '').toLowerCase();
        if (msg.includes('purchase_cost_eur')) {
          state.hasPurchaseCostColumn = false;
          const sel = state.hasRetailPriceColumn
            ? PRODUCT_SELECT_FULL_NO_PURCHASE_COST
            : PRODUCT_SELECT_FULL_NO_OPTIONAL_PRICES;
          const rP2 = await inventoryProductListQuery(sel);
          if (!rP2.error) {
            data = rP2.data;
            error = null;
          } else {
            error = rP2.error;
          }
        } else if (msg.includes('default_price_per_gram')) {
          const rPg = await inventoryProductListQuery(PRODUCT_SELECT_EXTRAS_NO_PER_GRAM);
          if (!rPg.error) {
            data = rPg.data;
            error = null;
          } else {
            error = rPg.error;
          }
        }
      }
    }

    if (
      error &&
      (error.code === '42703' ||
        (error.message && error.message.toLowerCase().includes('column')))
    ) {
      state.hasProductExtras = false;
      const r2 = await inventoryProductListQuery(PRODUCT_SELECT_BASE);
      data = r2.data;
      error = r2.error;
    }

    if (
      error &&
      state.hasArchivedColumn &&
      (error.code === '42703' ||
        (error.message && String(error.message).toLowerCase().includes('column'))) &&
      String(error.message || '')
        .toLowerCase()
        .includes('is_archived')
    ) {
      state.hasArchivedColumn = false;
      return loadProducts();
    }

    if (error) throw error;

    state.products = (data || []).map((row) =>
      normalizeProduct(
        state.hasProductExtras
          ? row
          : {
              ...row,
              stock_alert_grams: 0,
              default_sale_grams: null,
              default_price_eur: null,
              default_price_per_gram_eur: null,
              sale_unit: 'grams',
              purchase_cost_eur: null,
              retail_price_eur: null,
            },
      ),
    );

    const extraHint = $('inv-extra-hint');
    const extraWrap = document.querySelector('.inv-extra-fields');
    if (extraHint) extraHint.hidden = state.hasProductExtras;
    if (extraWrap) {
      extraWrap.style.opacity = state.hasProductExtras ? '' : '0.55';
    }

    renderProductsTable();
    renderInvCards();
    updateInvSummary();
    renderTpvGrid();
    syncTpvSelectionAfterReload();
    applyAdminInventoryPriceRows();
  }

  function getFilteredByCategory(list) {
    if (!state.filterCategoryId) return list;
    return list.filter((p) => p.category_id === state.filterCategoryId);
  }

  function getInvFilteredProducts() {
    let list = getFilteredByCategory(state.products);
    const q = (state.invSearch || '').trim().toLowerCase();
    if (q) {
      list = list.filter((p) => (p.name || '').toLowerCase().includes(q));
    }
    return list;
  }

  function getTpvFilteredProducts() {
    let list = state.products;
    if (state.tpvCatFilter) {
      list = list.filter((p) => p.category_id === state.tpvCatFilter);
    }
    const q = (state.tpvSearch || '').trim().toLowerCase();
    if (q) {
      list = list.filter((p) => (p.name || '').toLowerCase().includes(q));
    }
    return list;
  }

  function categoryName(id) {
    if (!id) return '—';
    const c = state.categories.find((x) => x.id === id);
    return c ? c.name : '—';
  }

  function renderTpvCategoryChips() {
    const row = $('tpv-cat-chips');
    if (!row) return;
    row.innerHTML = '';
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip' + (state.tpvCatFilter === '' ? ' is-active' : '');
    all.textContent = 'Todas';
    all.addEventListener('click', () => {
      state.tpvCatFilter = '';
      renderTpvCategoryChips();
      renderTpvGrid();
    });
    row.appendChild(all);
    state.categories.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (state.tpvCatFilter === c.id ? ' is-active' : '');
      b.textContent = c.name;
      b.addEventListener('click', () => {
        state.tpvCatFilter = c.id;
        renderTpvCategoryChips();
        renderTpvGrid();
      });
      row.appendChild(b);
    });
    toggleTpvShiftControls(Boolean(state.tpvOpenShiftId));
  }

  function renderInvCategoryChips() {
    const row = $('inv-cat-chips');
    if (!row) return;
    row.innerHTML = '';
    const mk = (label, val, active) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (active ? ' is-active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        state.filterCategoryId = val;
        if ($('inv-filter-category')) $('inv-filter-category').value = val;
        renderInvCategoryChips();
        renderProductsTable();
        renderInvCards();
        updateInvSummary();
      });
      row.appendChild(b);
    };
    mk('Todas', '', state.filterCategoryId === '');
    state.categories.forEach((c) => mk(c.name, c.id, state.filterCategoryId === c.id));
  }

  function renderTpvGrid() {
    const grid = $('tpv-product-grid');
    if (!grid) return;
    const list = getTpvFilteredProducts();
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = '<p class="hint" style="grid-column:1/-1">No hay productos con este filtro.</p>';
      return;
    }
    list.forEach((p) => {
      const stock = Number(p.stock_grams) || 0;
      const empty = stock <= 0;
      const card = document.createElement('button');
      card.type = 'button';
      card.className =
        'tpv-card' +
        (tpvIdsEqual(state.tpvSelectedId, p.id) ? ' is-selected' : '') +
        (empty ? ' is-empty-stock' : '');
      card.setAttribute('role', 'listitem');
      const em = (p.emoji || '').trim();
      const rate = state.hasProductExtras ? getPricePerGramForProduct(p) : null;
      const rateLabel = unitShort(p);
      const priceHint =
        rate != null && !Number.isNaN(rate)
          ? `<div class="tpv-card__price">${escapeHtml(formatMoney(rate))}/${escapeHtml(rateLabel)}</div>`
          : p.default_price_eur != null && !Number.isNaN(p.default_price_eur)
            ? `<div class="tpv-card__price">${escapeHtml(formatMoney(p.default_price_eur))}</div>`
            : '';
      card.innerHTML = `
        <span class="tpv-card__body">
          <span class="tpv-card__emoji-wrap"><span class="tpv-card__emoji">${escapeHtml(em || '📦')}</span></span>
          <span class="tpv-card__info">
            <span class="tpv-card__name">${escapeHtml(p.name)}</span>
            <span class="tpv-card__meta">Stock ${escapeHtml(formatNum(stock))} ${escapeHtml(unitShort(p))}</span>
            ${priceHint}
          </span>
        </span>
      `;
      card.addEventListener('click', () => {
        if (tpvIdsEqual(state.tpvSelectedId, p.id)) {
          clearTpvProductSelection();
          return;
        }
        if (!state.tpvOpenShiftId) {
          showToast('Abre un turno en Inicio para cobrar');
          return;
        }
        if (empty) {
          showToast('Sin stock — repón antes de cobrar');
        }
        selectTpvProduct(p.id);
      });
      grid.appendChild(card);
    });
  }

  function clearTpvProductSelection() {
    cancelScheduledAutoTpvLine();
    state.tpvPendingCartRowId = null;
    state.tpvSelectedId = '';
    if ($('tpv-selected-product')) $('tpv-selected-product').value = '';
    if ($('tpv-selected-label')) $('tpv-selected-label').textContent = 'Toca un producto a la izquierda';
    if ($('tpv-stock-hint')) $('tpv-stock-hint').textContent = '';
    syncTpvStockWrapVisibility();
    updateTpvUnitLabels({ sale_unit: 'grams' });
    applyTpvStepPreset({ sale_unit: 'grams' });
    updateTpvMarginHint();
    renderTpvGrid();
    const ae = document.activeElement;
    if (ae && typeof ae.closest === 'function' && ae.closest('#tpv-product-grid') && typeof ae.blur === 'function') {
      ae.blur();
    }
  }

  function selectTpvProduct(id) {
    const p = state.products.find((x) => tpvIdsEqual(x.id, id));
    if (!p) return;
    cancelScheduledAutoTpvLine();
    if (state.tpvSelectedId) {
      syncAutoTpvLine({ silent: true });
      state.tpvPendingCartRowId = null;
    }
    const idNorm = String(id).trim();
    state.tpvSelectedId = idNorm;
    if ($('tpv-selected-product')) $('tpv-selected-product').value = idNorm;

    const em = (p.emoji || '').trim();
    $('tpv-selected-label').textContent = `${em ? em + ' ' : ''}${p.name}`;

    const defG = p.default_sale_grams;
    const baseDef =
      defG != null && !Number.isNaN(Number(defG))
        ? Number(defG)
        : unitKey(p) === 'unit'
          ? 1
          : 0.5;
    const safeDef = unitKey(p) === 'unit' ? Math.max(1, Math.round(baseDef)) : baseDef;
    const defGx = String(safeDef).replace('.', ',');
    $('tpv-grams-charged').value = defGx;
    const link = $('tpv-link-grams')?.checked !== false;
    $('tpv-grams-dispensed').value = link ? defGx : defGx;

    const defP = p.default_price_eur;
    if (defP != null && !Number.isNaN(Number(defP))) {
      $('tpv-price').value = String(defP).replace('.', ',');
    } else {
      $('tpv-price').value = '';
    }

    const hint = $('tpv-stock-hint');
    if (hint) {
      hint.textContent = `Stock disponible: ${formatNum(p.stock_grams)} ${unitShort(p)}`;
    }
    syncTpvStockWrapVisibility();
    updateTpvUnitLabels(p);
    applyTpvStepPreset(p);
    updateTpvMarginHint();
    updatePriceFromTicketGrams();
    ensureTpvPriceForCurrentLine();
    syncAutoTpvLine({ silent: true });
    renderTpvGrid();
  }

  function syncTpvSelectionAfterReload() {
    if (!state.tpvSelectedId) return;
    const still = state.products.some((x) => tpvIdsEqual(x.id, state.tpvSelectedId));
    if (!still) {
      clearTpvProductSelection();
      return;
    }
    const p = state.products.find((x) => tpvIdsEqual(x.id, state.tpvSelectedId));
    if ($('tpv-stock-hint') && p) {
      $('tpv-stock-hint').textContent = `Stock disponible: ${formatNum(p.stock_grams)} ${unitShort(p)}`;
    }
    syncTpvStockWrapVisibility();
    if (p) {
      updateTpvUnitLabels(p);
      applyTpvStepPreset(p);
    }
    renderTpvGrid();
  }

  function renderProductsTable() {
    const tbody = $('inv-products-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    getInvFilteredProducts().forEach((p) => {
      const tr = document.createElement('tr');
      const em = (p.emoji || '').trim();
      const lvl = stockLevel(p);
      const alertTxt =
        state.hasProductExtras && Number(p.stock_alert_grams) > 0
          ? formatNum(p.stock_alert_grams)
          : '—';
      const canEdit = canManageInventoryEdits();
      const editBtns = canEdit
        ? `<button type="button" class="btn btn--ghost btn--small" data-edit="${p.id}">Editar</button>
          <button type="button" class="btn btn--ghost btn--small" data-del="${p.id}">Borrar</button>`
        : '';
      tr.innerHTML = `
        <td class="inv-emoji-cell">${escapeHtml(em || '—')}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(categoryName(p.category_id))}</td>
        <td>${escapeHtml(formatNum(p.bottle_weight_grams))}</td>
        <td>${escapeHtml(formatNum(p.stock_grams))}</td>
        <td>${escapeHtml(alertTxt)}</td>
        <td class="actions">
          ${editBtns}
          <button type="button" class="btn btn--ghost btn--small btn--adjust" data-adjust="${p.id}" title="Añadir o retirar stock">+/-</button>
        </td>
      `;
      if (lvl === 'out') tr.style.background = 'rgba(254, 226, 226, 0.35)';
      else if (lvl === 'low') tr.style.background = 'rgba(254, 243, 199, 0.35)';
      if (canEdit) {
        tr.querySelector('[data-edit]').addEventListener('click', () => editProduct(p));
        tr.querySelector('[data-del]').addEventListener('click', async () => {
          if (
            !confirm(
              `¿Eliminar el producto «${p.name}»? Si tiene ventas TPV o movimientos +/- de stock, se archivará y dejará de mostrarse; el histórico se conserva.`,
            )
          )
            return;
          setMsg('inv-status', 'Eliminando…', false);
          const { error } = await sb().from('inventory_products').delete().eq('id', p.id);
          if (!error) {
            setMsg('inv-status', 'Producto eliminado.', false);
            clearProductForm();
            await loadProducts();
            await refreshStockUi();
            if (typeof window.scClubRefreshFinance === 'function') {
              await window.scClubRefreshFinance();
            }
            return;
          }
          const msg = String(error.message || '').toLowerCase();
          const fk =
            error.code === '23503' ||
            msg.includes('foreign key') ||
            msg.includes('tpv_dispenses') ||
            msg.includes('inventory_stock_adjustments');
          if (fk && state.hasArchivedColumn) {
            const { error: uerr } = await sb()
              .from('inventory_products')
              .update({ is_archived: true, stock_grams: 0 })
              .eq('id', p.id);
            if (uerr) {
              setMsg('inv-status', uerr.message || 'No se pudo archivar.', true);
              return;
            }
            setMsg(
              'inv-status',
              'Producto archivado (tenía ventas o ajustes; ya no aparece en inventario ni TPV).',
              false,
            );
            clearProductForm();
            await loadProducts();
            await refreshStockUi();
            if (typeof window.scClubRefreshFinance === 'function') {
              await window.scClubRefreshFinance();
            }
            return;
          }
          setMsg(
            'inv-status',
            error.message ||
              'No se pudo borrar. Si hay ventas o ajustes, ejecuta en Supabase la migración 024_inventory_product_archived.sql y vuelve a intentar.',
            true,
          );
        });
      }
      tr.querySelector('[data-adjust]').addEventListener('click', () => openInvAdjustModal(p));
      tbody.appendChild(tr);
    });
  }

  function renderInvCards() {
    const wrap = $('inv-product-cards');
    if (!wrap) return;
    const list = getInvFilteredProducts();
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<p class="hint">No hay productos con este filtro.</p>';
      return;
    }
    list.forEach((p) => {
      const lvl = stockLevel(p);
      const card = document.createElement('article');
      card.className =
        'inv-card' +
        (lvl === 'out' ? ' inv-card--crit' : lvl === 'low' ? ' inv-card--warn' : '');
      const em = (p.emoji || '').trim();
      const badge =
        lvl === 'out'
          ? '<span class="badge-stock badge-stock--out">Sin stock</span>'
          : lvl === 'low'
            ? '<span class="badge-stock badge-stock--low">Stock bajo</span>'
            : '<span class="badge-stock badge-stock--ok">OK</span>';
      const canEdit = canManageInventoryEdits();
      const editBtn = canEdit
        ? `<button type="button" class="btn btn--ghost btn--small" data-edit="${p.id}">Editar</button>`
        : '';
      card.innerHTML = `
        <div class="inv-card__top">
          <span class="inv-card__emoji">${escapeHtml(em || '📦')}</span>
          ${badge}
        </div>
        <div class="inv-card__name">${escapeHtml(p.name)}</div>
        <div class="inv-card__stock">${escapeHtml(categoryName(p.category_id))} · ${escapeHtml(formatNum(p.stock_grams))} ${escapeHtml(unitShort(p))}</div>
        <div class="inv-card__actions">
          ${editBtn}
          <button type="button" class="btn btn--ghost btn--small btn--adjust" data-adjust="${p.id}" title="Añadir o retirar stock">+/-</button>
        </div>
      `;
      if (canEdit) {
        card.querySelector('[data-edit]').addEventListener('click', () => editProduct(p));
      }
      card.querySelector('[data-adjust]').addEventListener('click', () => openInvAdjustModal(p));
      wrap.appendChild(card);
    });
  }

  function updateInvSummary() {
    const el = $('inv-products-summary');
    if (!el) return;
    const list = state.products;
    let low = 0;
    let out = 0;
    list.forEach((p) => {
      const l = stockLevel(p);
      if (l === 'out') out += 1;
      else if (l === 'low') low += 1;
    });
    el.textContent = `${list.length} producto(s) · ${out} sin stock · ${low} con alerta de mínimo`;
  }

  function clearProductForm() {
    $('inv-product-id').value = '';
    $('inv-product-emoji').value = '';
    $('inv-product-name').value = '';
    $('inv-product-category').value = '';
    $('inv-product-bottle').value = '0';
    $('inv-product-stock').value = '0';
    $('inv-product-alert').value = '0';
    $('inv-product-default-grams').value = '';
    $('inv-product-default-price').value = '';
    if ($('inv-product-price-per-g')) $('inv-product-price-per-g').value = '';
    if ($('inv-product-purchase-cost')) $('inv-product-purchase-cost').value = '';
    if ($('inv-product-retail-price')) $('inv-product-retail-price').value = '';
    setInvSaleUnitUi('grams');
    if ($('inv-product-save')) $('inv-product-save').textContent = 'Crear producto';
  }

  function editProduct(p) {
    openInvProductModal();
    $('inv-product-id').value = p.id;
    $('inv-product-emoji').value = p.emoji || '';
    $('inv-product-name').value = p.name || '';
    $('inv-product-category').value = p.category_id || '';
    setInvSaleUnitUi(unitKey(p));
    $('inv-product-bottle').value = String(p.bottle_weight_grams ?? 0);
    $('inv-product-stock').value = String(p.stock_grams ?? 0);
    $('inv-product-alert').value = String(p.stock_alert_grams ?? 0);
    if (p.default_sale_grams != null && !Number.isNaN(Number(p.default_sale_grams))) {
      $('inv-product-default-grams').value = String(p.default_sale_grams).replace('.', ',');
    } else {
      $('inv-product-default-grams').value = '';
    }
    if (p.default_price_eur != null && !Number.isNaN(Number(p.default_price_eur))) {
      $('inv-product-default-price').value = String(p.default_price_eur).replace('.', ',');
    } else {
      $('inv-product-default-price').value = '';
    }
    const ppg = $('inv-product-price-per-g');
    if (ppg) {
      if (
        p.default_price_per_gram_eur != null &&
        !Number.isNaN(Number(p.default_price_per_gram_eur))
      ) {
        ppg.value = String(p.default_price_per_gram_eur).replace('.', ',');
      } else {
        ppg.value = '';
      }
    }
    const pc = $('inv-product-purchase-cost');
    if (pc) {
      if (p.purchase_cost_eur != null && !Number.isNaN(Number(p.purchase_cost_eur))) {
        pc.value = String(p.purchase_cost_eur).replace('.', ',');
      } else {
        pc.value = '';
      }
    }
    const rp = $('inv-product-retail-price');
    if (rp) {
      if (p.retail_price_eur != null && !Number.isNaN(Number(p.retail_price_eur))) {
        rp.value = String(p.retail_price_eur).replace('.', ',');
      } else {
        rp.value = '';
      }
    }
    if ($('inv-product-save')) $('inv-product-save').textContent = 'Actualizar producto';
    setMsg('inv-status', 'Editando producto. Guarda para aplicar cambios.', false);
    $('inv-product-name')?.focus();
  }

  async function saveProduct() {
    if (!canManageInventoryEdits()) {
      setMsg('inv-status', 'No tienes permiso para editar productos.', true);
      return;
    }
    const id = ($('inv-product-id')?.value || '').trim();
    const emoji = ($('inv-product-emoji')?.value || '').trim().slice(0, 8);
    const name = ($('inv-product-name')?.value || '').trim();
    const categoryId = ($('inv-product-category')?.value || '').trim() || null;
    const saleUnit = ($('inv-product-sale-unit')?.value || 'grams').trim() === 'unit' ? 'unit' : 'grams';
    const bottle = parseDecimal($('inv-product-bottle')?.value);
    const stock = parseDecimal($('inv-product-stock')?.value);
    const alertG = parseDecimal($('inv-product-alert')?.value);
    const defSaleRaw = ($('inv-product-default-grams')?.value || '').trim();
    const defPriceRaw = ($('inv-product-default-price')?.value || '').trim();
    const defPerGramRaw = ($('inv-product-price-per-g')?.value || '').trim();
    const defSale = defSaleRaw === '' ? null : parseDecimal(defSaleRaw);
    const defPrice = defPriceRaw === '' ? null : parseDecimal(defPriceRaw);
    const defPerGram = defPerGramRaw === '' ? null : parseDecimal(defPerGramRaw);

    if (!name) {
      setMsg('inv-status', 'Indica un nombre de producto.', true);
      return;
    }
    if (Number.isNaN(bottle) || bottle < 0 || Number.isNaN(stock) || stock < 0) {
      setMsg('inv-status', 'Peso de bote y stock deben ser números ≥ 0.', true);
      return;
    }
    if (Number.isNaN(alertG) || alertG < 0) {
      setMsg('inv-status', 'Alerta de stock mínimo no válida.', true);
      return;
    }
    if (defSale !== null && (Number.isNaN(defSale) || defSale < 0)) {
      setMsg('inv-status', 'Gramos sugeridos TPV no válidos.', true);
      return;
    }
    if (defPrice !== null && (Number.isNaN(defPrice) || defPrice < 0)) {
      setMsg('inv-status', 'Precio sugerido no válido.', true);
      return;
    }
    if (defPerGram !== null && (Number.isNaN(defPerGram) || defPerGram < 0)) {
      setMsg('inv-status', 'Precio por gramo no válido.', true);
      return;
    }

    const isClubAdmin = state.ctx?.profile?.role === 'admin_club';
    let purchaseCostField = null;
    let retailPriceField = null;
    if (isClubAdmin && state.hasProductExtras) {
      const pr = ($('inv-product-purchase-cost')?.value || '').trim();
      if (pr !== '') {
        const pv = parseDecimal($('inv-product-purchase-cost')?.value);
        if (Number.isNaN(pv) || pv < 0) {
          setMsg('inv-status', 'Coste de compra no válido.', true);
          return;
        }
        purchaseCostField = pv;
      } else {
        purchaseCostField = null;
      }
      const rr = ($('inv-product-retail-price')?.value || '').trim();
      if (rr !== '') {
        const rv = parseDecimal($('inv-product-retail-price')?.value);
        if (Number.isNaN(rv) || rv < 0) {
          setMsg('inv-status', 'Precio de venta de referencia no válido.', true);
          return;
        }
        retailPriceField = rv;
      } else {
        retailPriceField = null;
      }
    }

    setMsg('inv-status', 'Guardando…', false);
    const baseRow = {
      club_id: state.ctx.club.id,
      name,
      emoji,
      category_id: categoryId,
      sale_unit: saleUnit,
      bottle_weight_grams: saleUnit === 'unit' ? 0 : bottle,
      stock_grams: stock,
    };
    const extraRow = state.hasProductExtras
      ? {
          stock_alert_grams: alertG,
          default_sale_grams: defSale,
          default_price_eur: defPrice,
          default_price_per_gram_eur: defPerGram,
          ...(isClubAdmin && state.hasPurchaseCostColumn
            ? { purchase_cost_eur: purchaseCostField }
            : {}),
          ...(isClubAdmin && state.hasRetailPriceColumn ? { retail_price_eur: retailPriceField } : {}),
        }
      : {};

    const row = { ...baseRow, ...extraRow };

    async function trySave(insert) {
      if (insert) {
        return sb().from('inventory_products').insert([row]);
      }
      return sb().from('inventory_products').update(row).eq('id', id);
    }

    let res = await trySave(!id);
    const saveColErr =
      res.error &&
      state.hasProductExtras &&
      (res.error.code === '42703' || (res.error.message && res.error.message.includes('column')));
    if (saveColErr) {
      let msg = (res.error.message || '').toLowerCase();
      if (msg.includes('purchase_cost_eur') && 'purchase_cost_eur' in row) {
        delete row.purchase_cost_eur;
        state.hasPurchaseCostColumn = false;
        res = await trySave(!id);
        msg = (res.error?.message || '').toLowerCase();
      }
      if (msg.includes('retail_price_eur') && 'retail_price_eur' in row) {
        delete row.retail_price_eur;
        state.hasRetailPriceColumn = false;
        res = await trySave(!id);
        msg = (res.error?.message || '').toLowerCase();
      }
      if (msg.includes('default_price_per_gram') && 'default_price_per_gram_eur' in row) {
        delete row.default_price_per_gram_eur;
        res = await trySave(!id);
      }
    }
    if (
      res.error &&
      state.hasProductExtras &&
      (res.error.code === '42703' || (res.error.message && res.error.message.includes('column')))
    ) {
      state.hasProductExtras = false;
      delete row.stock_alert_grams;
      delete row.default_sale_grams;
      delete row.default_price_eur;
      delete row.default_price_per_gram_eur;
      delete row.purchase_cost_eur;
      delete row.retail_price_eur;
      res = await trySave(!id);
    }

    if (res.error) {
      setMsg('inv-status', res.error.message || 'Error al guardar.', true);
      return;
    }

    setMsg('inv-status', id ? 'Producto actualizado.' : 'Producto creado.', false);
    if (!id) clearProductForm();
    showToast(id ? 'Producto guardado' : 'Producto creado');
    closeInvProductModal();
    await loadProducts();
    await refreshStockUi();
    if (typeof window.scClubRefreshFinance === 'function') {
      await window.scClubRefreshFinance();
    }
  }

  async function addCategory() {
    if (!canManageInventoryEdits()) {
      setMsg('inv-status', 'No tienes permiso para crear categorías.', true);
      return;
    }
    const name = ($('inv-cat-name')?.value || '').trim();
    if (!name) {
      setMsg('inv-status', 'Escribe el nombre de la categoría.', true);
      return;
    }
    setMsg('inv-status', 'Añadiendo categoría…', false);
    const { error } = await sb().from('inventory_categories').insert([
      { club_id: state.ctx.club.id, name, sort_order: state.categories.length },
    ]);
    if (error) {
      setMsg('inv-status', error.message || 'No se pudo crear.', true);
      return;
    }
    $('inv-cat-name').value = '';
    setMsg('inv-status', 'Categoría añadida.', false);
    showToast('Categoría añadida');
    closeInvCatModal();
    await loadCategories();
    await loadProducts();
    await refreshStockUi();
  }

  function applyTpvStep(delta) {
    const chargedEl = $('tpv-grams-charged');
    if (!chargedEl) return;
    let v = parseDecimal(chargedEl.value);
    if (Number.isNaN(v)) v = 0;
    const p = state.tpvSelectedId ? state.products.find((x) => tpvIdsEqual(x.id, state.tpvSelectedId)) : null;
    if (unitKey(p) === 'unit') {
      v = Math.max(0, Math.round(v + delta));
    } else {
      v = Math.max(0, Math.round((v + delta) * 1000) / 1000);
    }
    const s = String(v).replace('.', ',');
    chargedEl.value = s;
    if ($('tpv-link-grams')?.checked !== false) {
      $('tpv-grams-dispensed').value = s;
    }
    updateTpvMarginHint();
    updatePriceFromTicketGrams();
    scheduleAutoTpvLine();
  }

  function syncDispensedFromCharged() {
    if ($('tpv-link-grams')?.checked !== false) {
      const s = ($('tpv-grams-charged')?.value || '').trim();
      $('tpv-grams-dispensed').value = s;
    }
    updateTpvMarginHint();
    scheduleAutoTpvLine();
  }

  function updateTpvMarginHint() {
    const el = $('tpv-margin-hint');
    if (!el) return;
    const a = parseDecimal($('tpv-grams-charged')?.value);
    const b = parseDecimal($('tpv-grams-dispensed')?.value);
    const p = state.tpvSelectedId ? state.products.find((x) => tpvIdsEqual(x.id, state.tpvSelectedId)) : null;
    if (unitKey(p) === 'unit') {
      if (!Number.isNaN(a) && Math.abs(a - Math.round(a)) > 0.0001) {
        el.textContent = 'En productos por unidad, la cantidad en ticket debe ser entera.';
        return;
      }
      if (!Number.isNaN(b) && Math.abs(b - Math.round(b)) > 0.0001) {
        el.textContent = 'En productos por unidad, la cantidad real debe ser entera.';
        return;
      }
    }
    if (Number.isNaN(a) || Number.isNaN(b)) {
      el.textContent = '';
      return;
    }
    const d = b - a;
    if (Math.abs(d) < 0.0001) {
      el.textContent = 'Sin margen: ticket y stock coinciden.';
      return;
    }
    el.textContent =
      d > 0
        ? `Margen físico: +${formatNum(d)} ${unitShort(state.products.find((x) => tpvIdsEqual(x.id, state.tpvSelectedId)))} salen del inventario respecto al ticket.`
        : `Ajuste: ${formatNum(Math.abs(d))} ${unitShort(state.products.find((x) => tpvIdsEqual(x.id, state.tpvSelectedId)))} menos dispensados que en ticket.`;
  }

  async function loadMembersForTpv() {
    if (!state.ctx) return;
    try {
      const { error: tickErr } = await sb().rpc('club_members_vip_rule_tick_club', {
        p_club_id: state.ctx.club.id,
      });
      if (
        tickErr &&
        tickErr.code !== 'PGRST202' &&
        tickErr.code !== '42883' &&
        !String(tickErr.message || '').toLowerCase().includes('club_members_vip_rule_tick_club')
      ) {
        void tickErr;
      }
    } catch (_) {
      /* RPC opcional hasta migración 027 */
    }
    let query = sb()
      .from('club_members')
      .select('id, display_name, member_code, member_type, member_type_valid_until, avatar_path')
      .eq('club_id', state.ctx.club.id)
      .eq('is_active', true)
      .order('display_name', { ascending: true });
    let { data, error } = await query;
    if (
      error &&
      (error.code === '42703' || String(error.message || '').toLowerCase().includes('avatar_path'))
    ) {
      const r0 = await sb()
        .from('club_members')
        .select('id, display_name, member_code, member_type, member_type_valid_until')
        .eq('club_id', state.ctx.club.id)
        .eq('is_active', true)
        .order('display_name', { ascending: true });
      data = r0.data;
      error = r0.error;
    }
    if (
      error &&
      (error.code === '42703' || String(error.message || '').toLowerCase().includes('member_type_valid_until'))
    ) {
      const r2 = await sb()
        .from('club_members')
        .select('id, display_name, member_code, member_type, avatar_path')
        .eq('club_id', state.ctx.club.id)
        .eq('is_active', true)
        .order('display_name', { ascending: true });
      data = r2.data;
      error = r2.error;
    }
    if (
      error &&
      (error.code === '42703' || String(error.message || '').toLowerCase().includes('member_type'))
    ) {
      const r3 = await sb()
        .from('club_members')
        .select('id, display_name, member_code')
        .eq('club_id', state.ctx.club.id)
        .eq('is_active', true)
        .order('display_name', { ascending: true });
      data = r3.data;
      error = r3.error;
    }
    if (error) {
      state.tpvMembers = [];
      return;
    }
    state.tpvMembers = data || [];
    syncTpvMemberFieldVipFromSelection();
  }

  window.scClubInventoryReloadMembers = async function () {
    await loadMembersForTpv();
  };

  function filterTpvMembers(query) {
    const t = (query || '').trim().toLowerCase();
    if (!t) return state.tpvMembers || [];
    return (state.tpvMembers || []).filter((m) => {
      const n = (m.display_name || '').toLowerCase();
      const c = (m.member_code || '').toLowerCase();
      return n.includes(t) || c.includes(t);
    });
  }

  function tpvMemberTierExpired(m) {
    const t = m?.member_type || 'standard';
    if (t !== 'premium' && t !== 'vip') return false;
    const vu = m?.member_type_valid_until;
    if (vu == null || String(vu).trim() === '') return false;
    const raw = String(vu).slice(0, 10);
    const parts = raw.split('-');
    if (parts.length !== 3) return false;
    const y = Number(parts[0]);
    const mo = Number(parts[1]) - 1;
    const d = Number(parts[2]);
    const end = new Date(y, mo, d, 23, 59, 59, 999);
    if (Number.isNaN(end.getTime())) return false;
    return Date.now() > end.getTime();
  }

  function isTpvActiveVipMember(m) {
    if (!m || (m.member_type || 'standard') !== 'vip') return false;
    return !tpvMemberTierExpired(m);
  }

  function syncTpvTicketPaperVipClass() {
    const paper = $('tpv-ticket-paper');
    if (!paper) return;
    const id = ($('tpv-selected-member')?.value || '').trim();
    if (!id) {
      paper.classList.remove('tpv-ticket-paper--vip');
      return;
    }
    const m = (state.tpvMembers || []).find((x) => x.id === id);
    paper.classList.toggle('tpv-ticket-paper--vip', isTpvActiveVipMember(m));
  }

  function syncTpvMemberFieldVipFromSelection() {
    const field = document.querySelector('.tpv-member-field');
    if (!field) return;
    const id = ($('tpv-selected-member')?.value || '').trim();
    if (!id) {
      field.classList.remove('tpv-member-field--vip');
      syncTpvTicketPaperVipClass();
      return;
    }
    const m = (state.tpvMembers || []).find((x) => x.id === id);
    field.classList.toggle('tpv-member-field--vip', isTpvActiveVipMember(m));
    syncTpvTicketPaperVipClass();
  }

  function tpvMemberTierSuffix(m) {
    const t = m?.member_type || 'standard';
    if (t === 'vip') return tpvMemberTierExpired(m) ? ' · VIP cad.' : ' · VIP';
    if (t === 'premium') return tpvMemberTierExpired(m) ? ' · Prem. cad.' : ' · Premium';
    return '';
  }

  function tpvChipMemberInitials(m) {
    const parts = String(m?.display_name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return '?';
    const a = parts[0]?.[0] || '';
    const b = parts.length > 1 ? parts[1]?.[0] || '' : '';
    return (a + b).toUpperCase();
  }

  async function renderTpvMemberChipDisplay(m) {
    const wrap = $('tpv-member-chip-wrap');
    const chip = $('tpv-member-chip');
    const img = $('tpv-member-chip-img');
    const initials = $('tpv-member-chip-initials');
    if (!m || !m.id) {
      if (wrap) {
        wrap.classList.add('is-hidden');
        wrap.hidden = true;
      }
      if (chip) chip.textContent = '';
      if (img) {
        img.onload = null;
        img.onerror = null;
        img.classList.add('is-hidden');
        img.removeAttribute('src');
        img.alt = '';
      }
      if (initials) initials.textContent = '?';
      return;
    }
    if (wrap) {
      wrap.classList.remove('is-hidden');
      wrap.hidden = false;
    }
    if (chip) {
      const code = m.member_code ? ` (${m.member_code})` : '';
      chip.textContent = `Socio: ${m.display_name || '—'}${code}${tpvMemberTierSuffix(m)}`;
    }
    if (initials) initials.textContent = tpvChipMemberInitials(m);
    if (!img) return;
    img.onload = null;
    img.onerror = null;
    img.classList.add('is-hidden');
    img.removeAttribute('src');
    img.alt = '';
    const path = m.avatar_path != null ? String(m.avatar_path).trim() : '';
    if (!path) return;
    const { data, error } = await sb().storage.from(MEMBER_AVATAR_BUCKET).createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) return;
    img.alt = m.display_name ? `Foto de ${String(m.display_name)}` : '';
    img.onload = () => {
      img.classList.remove('is-hidden');
    };
    img.onerror = () => {
      img.classList.add('is-hidden');
      img.removeAttribute('src');
    };
    img.src = data.signedUrl;
    if (img.complete && img.naturalWidth > 0) {
      img.classList.remove('is-hidden');
    }
  }

  function renderTpvMemberDropdown(items) {
    const dd = $('tpv-member-dropdown');
    if (!dd) return;
    dd.innerHTML = '';
    if (!items.length) {
      dd.classList.add('is-hidden');
      dd.hidden = true;
      return;
    }
    items.slice(0, 14).forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      const code = m.member_code ? ` · ${m.member_code}` : '';
      const tier = tpvMemberTierSuffix(m);
      b.textContent = `${m.display_name}${code}${tier}`;
      if (isTpvActiveVipMember(m)) b.classList.add('tpv-member-dropdown__item--vip');
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        selectTpvMember(m);
      });
      dd.appendChild(b);
    });
    dd.classList.remove('is-hidden');
    dd.hidden = false;
  }

  async function selectTpvMember(m) {
    if (!m || !m.id) return;
    if ($('tpv-selected-member')) $('tpv-selected-member').value = m.id;
    if ($('tpv-member-search')) $('tpv-member-search').value = '';
    const dd = $('tpv-member-dropdown');
    if (dd) {
      dd.classList.add('is-hidden');
      dd.hidden = true;
    }
    await renderTpvMemberChipDisplay(m);
    syncTpvMemberFieldVipFromSelection();
  }

  async function clearTpvMember() {
    if ($('tpv-selected-member')) $('tpv-selected-member').value = '';
    if ($('tpv-member-search')) $('tpv-member-search').value = '';
    const dd = $('tpv-member-dropdown');
    if (dd) {
      dd.classList.add('is-hidden');
      dd.hidden = true;
    }
    await renderTpvMemberChipDisplay(null);
    syncTpvMemberFieldVipFromSelection();
  }

  function makeTpvCartRowId() {
    state.tpvCartSeq += 1;
    return `line-${Date.now()}-${state.tpvCartSeq}`;
  }

  let tpvAutoLineTimer = null;

  function scheduleAutoTpvLine() {
    clearTimeout(tpvAutoLineTimer);
    tpvAutoLineTimer = setTimeout(() => {
      syncAutoTpvLine({ silent: true });
    }, 250);
  }

  function cancelScheduledAutoTpvLine() {
    if (tpvAutoLineTimer) {
      clearTimeout(tpvAutoLineTimer);
      tpvAutoLineTimer = null;
    }
  }

  /** Si no hay tarifa calculable, el precio puede quedar vacío y falla buildCurrentTpvLine (no se añade línea al ticket). */
  function ensureTpvPriceForCurrentLine() {
    const pe = $('tpv-price');
    if (!pe) return;
    if (String(pe.value || '').trim()) return;
    updatePriceFromTicketGrams();
    if (String(pe.value || '').trim()) return;
    pe.value = '0';
  }

  function syncTpvStockWrapVisibility() {
    const h = $('tpv-stock-hint');
    const w = h?.closest?.('.tpv-ticket-stock-wrap');
    if (!w) return;
    w.classList.toggle('is-empty', !(h.textContent && h.textContent.trim()));
  }

  function syncAutoTpvLine(options = {}) {
    const silent = Boolean(options.silent);
    const forceNew = Boolean(options.forceNew);
    const pid = ($('tpv-selected-product')?.value || '').trim() || state.tpvSelectedId;
    if (!pid) return false;

    const built = buildCurrentTpvLine();
    if (built.error) {
      if (!silent) setMsg('tpv-status', built.error, true);
      return false;
    }

    if (forceNew) state.tpvPendingCartRowId = null;

    const pendingId = state.tpvPendingCartRowId;
    const idx = pendingId ? state.tpvCart.findIndex((x) => x.cart_row_id === pendingId) : -1;
    if (idx >= 0) {
      state.tpvCart[idx] = { ...built.line, cart_row_id: pendingId };
    } else {
      state.tpvPendingCartRowId = built.line.cart_row_id;
      state.tpvCart.push(built.line);
    }
    renderTpvCart();
    if (!silent) {
      setMsg(
        'tpv-status',
        `Línea añadida: ${built.line.product_name} · ${formatMoney(built.line.price_charged_eur)}.`,
        false,
      );
    }
    return true;
  }

  function buildCurrentTpvLine() {
    const pid = ($('tpv-selected-product')?.value || '').trim() || state.tpvSelectedId;
    const gramsCharged = parseDecimal($('tpv-grams-charged')?.value);
    const gramsDispensed = parseDecimal($('tpv-grams-dispensed')?.value);
    const price = parseDecimal($('tpv-price')?.value);
    const notes = ($('tpv-notes')?.value || '').trim();
    const selected = state.products.find((x) => tpvIdsEqual(x.id, pid));

    if (!pid || !selected) return { error: 'Elige un producto en la rejilla.' };
    if (Number.isNaN(gramsCharged) || gramsCharged < 0) {
      return { error: 'Cantidad en ticket no válida.' };
    }
    if (Number.isNaN(gramsDispensed) || gramsDispensed < 0) {
      return { error: 'Cantidad real no válida.' };
    }
    if (unitKey(selected) === 'unit') {
      if (Math.abs(gramsCharged - Math.round(gramsCharged)) > 0.0001) {
        return { error: 'En productos por unidad, la cantidad en ticket debe ser entera.' };
      }
      if (Math.abs(gramsDispensed - Math.round(gramsDispensed)) > 0.0001) {
        return { error: 'En productos por unidad, la cantidad real debe ser entera.' };
      }
    }
    if (Number.isNaN(price) || price < 0) {
      return { error: 'Precio al cliente no válido.' };
    }

    return {
      line: {
        cart_row_id: makeTpvCartRowId(),
        product_id: pid,
        product_name: selected.name || '—',
        product_emoji: (selected.emoji || '').trim(),
        sale_unit: unitKey(selected),
        grams_charged: gramsCharged,
        grams_dispensed: gramsDispensed,
        price_charged_eur: price,
        notes,
      },
    };
  }

  function renderTpvCart() {
    const wrap = $('tpv-cart-list');
    const totalEl = $('tpv-cart-total');
    if (!wrap || !totalEl) return;
    const lines = state.tpvCart || [];
    const total = lines.reduce((acc, x) => acc + (Number(x.price_charged_eur) || 0), 0);
    totalEl.textContent = `Total: ${formatMoney(total)}`;
    wrap.innerHTML = '';
    if (!lines.length) {
      wrap.innerHTML = '<p class="hint tpv-cart-empty-hint">Aún no hay líneas en el ticket.</p>';
      return;
    }
    lines.forEach((line) => {
      const row = document.createElement('div');
      row.className = 'tpv-cart-line';
      const us = line.sale_unit === 'unit' ? 'ud' : 'g';
      row.innerHTML = `
        <div class="tpv-cart-line__main">
          <div class="tpv-cart-line__title">${escapeHtml(line.product_emoji ? line.product_emoji + ' ' : '')}${escapeHtml(line.product_name)}</div>
          <div class="tpv-cart-line__meta">Ticket ${escapeHtml(formatNum(line.grams_charged))} ${escapeHtml(us)} · Real ${escapeHtml(formatNum(line.grams_dispensed))} ${escapeHtml(us)}</div>
        </div>
        <div class="tpv-cart-line__side">
          <strong>${escapeHtml(formatMoney(line.price_charged_eur))}</strong>
          <button type="button" class="btn btn--ghost btn--small" data-tpv-cart-del="${line.cart_row_id}">Quitar</button>
        </div>
      `;
      wrap.appendChild(row);
    });
    toggleTpvShiftControls(Boolean(state.tpvOpenShiftId));
  }

  function addCurrentLineToCart() {
    return syncAutoTpvLine({ silent: false, forceNew: true });
  }

  async function registerTpvDispenseLine(line, shiftId, memberId) {
    const payloadWithMember = {
      p_product_id: line.product_id,
      p_grams_charged: line.grams_charged,
      p_grams_dispensed: line.grams_dispensed,
      p_price_charged_eur: line.price_charged_eur,
      p_shift_id: shiftId,
      p_notes: line.notes || '',
      p_member_id: memberId || null,
    };
    let rpcRes = await sb().rpc('club_register_tpv_dispense', payloadWithMember);
    let { error } = rpcRes;
    const maybeLegacyRpc =
      error &&
      (error.code === 'PGRST202' ||
        error.code === '42883' ||
        /p_member_id|function\s+public\.club_register_tpv_dispense/i.test(error.message || ''));
    if (maybeLegacyRpc) {
      const payloadLegacy = {
        p_product_id: line.product_id,
        p_grams_charged: line.grams_charged,
        p_grams_dispensed: line.grams_dispensed,
        p_price_charged_eur: line.price_charged_eur,
        p_shift_id: shiftId,
        p_notes: line.notes || '',
      };
      rpcRes = await sb().rpc('club_register_tpv_dispense', payloadLegacy);
      error = rpcRes.error;
    }
    return { error, rpcRes };
  }

  async function ensureDispensePersisted(line, shiftId, memberId, rpcRes) {
    const directId = rpcRes?.data || null;
    if (directId) {
      const { data: exists, error: existsErr } = await sb()
        .from('tpv_dispenses')
        .select('id')
        .eq('id', directId)
        .maybeSingle();
      if (!existsErr && exists?.id) return { id: exists.id, error: null };
    }

    const { data: matchRows, error: matchErr } = await sb()
      .from('tpv_dispenses')
      .select('id, created_at')
      .eq('club_id', state.ctx.club.id)
      .eq('product_id', line.product_id)
      .eq('shift_id', shiftId)
      .eq('grams_charged', line.grams_charged)
      .eq('grams_dispensed', line.grams_dispensed)
      .eq('price_charged_eur', line.price_charged_eur)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!matchErr && Array.isArray(matchRows) && matchRows.length) {
      return { id: matchRows[0].id, error: null };
    }

    const { data: au } = await sb().auth.getUser();
    const userId = au?.user?.id || null;
    if (!userId) {
      return { id: null, error: { message: 'No se pudo identificar el usuario actual para registrar la dispensación.' } };
    }

    const baseInsert = {
      club_id: state.ctx.club.id,
      product_id: line.product_id,
      shift_id: shiftId,
      grams_charged: line.grams_charged,
      grams_dispensed: line.grams_dispensed,
      price_charged_eur: line.price_charged_eur,
      notes: line.notes || '',
      created_by: userId,
      member_id: memberId || null,
    };

    let ins = await sb().from('tpv_dispenses').insert([baseInsert]).select('id').single();
    if (
      ins.error &&
      (ins.error.code === '42703' ||
        (ins.error.message && ins.error.message.toLowerCase().includes('member_id')))
    ) {
      const noMember = { ...baseInsert };
      delete noMember.member_id;
      ins = await sb().from('tpv_dispenses').insert([noMember]).select('id').single();
    }
    if (ins.error) return { id: null, error: ins.error };
    return { id: ins.data?.id || null, error: null };
  }

  async function submitTpv() {
    syncAutoTpvLine({ silent: true });
    const memberRaw = ($('tpv-selected-member')?.value || '').trim();
    let lines = (state.tpvCart || []).slice();
    if (!lines.length) {
      const built = buildCurrentTpvLine();
      if (built.error) {
        setMsg('tpv-status', built.error, true);
        return;
      }
      lines = [built.line];
    }

    const shiftId = state.tpvOpenShiftId || (await getOpenShiftId(state.ctx.club.id));
    if (!shiftId) {
      setMsg('tpv-status', 'Abre un turno desde Inicio para cobrar.', true);
      return;
    }

    const registeredIds = [];
    let lastRpcRes = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      setMsg('tpv-status', `Registrando ticket… línea ${i + 1}/${lines.length}`, false);
      const out = await registerTpvDispenseLine(line, shiftId, memberRaw || null);
      lastRpcRes = out.rpcRes;
      if (out.error) {
        const partial = registeredIds.length
          ? ` Se guardaron ${registeredIds.length} línea(s) antes del error.`
          : '';
        setMsg('tpv-status', `${line.product_name}: ${out.error.message || 'No se pudo registrar.'}.${partial}`, true);
        return;
      }
      const ensured = await ensureDispensePersisted(line, shiftId, memberRaw || null, out.rpcRes);
      if (ensured.error) {
        setMsg(
          'tpv-status',
          `Stock actualizado pero no se pudo guardar la dispensación (${line.product_name}): ${ensured.error.message || 'error desconocido'}.`,
          true,
        );
        return;
      }
      if (ensured.id) registeredIds.push(ensured.id);
    }

    const totalPrice = lines.reduce((acc, x) => acc + (Number(x.price_charged_eur) || 0), 0);
    setMsg(
      'tpv-status',
      `Listo: ${lines.length} línea(s) cobradas · total ${formatMoney(totalPrice)}.`,
      false,
    );
    showToast(`Venta guardada · ${lines.length} línea(s) · ${formatMoney(totalPrice)}`);

    const overlay = $('tpv-success-overlay');
    const detail = $('tpv-overlay-detail');
    if (overlay && detail) {
      detail.textContent = `${lines.length} línea(s) · ${formatMoney(totalPrice)}`;
      overlay.classList.remove('is-hidden');
      overlay.setAttribute('aria-hidden', 'false');
      setTimeout(() => {
        overlay.classList.add('is-hidden');
        overlay.setAttribute('aria-hidden', 'true');
      }, 1400);
    }

    state.tpvCart = [];
    state.tpvPendingCartRowId = null;
    renderTpvCart();
    $('tpv-notes').value = '';
    updateTpvMarginHint();
    await loadProducts();
    await refreshStockUi();
    const visibleRows = await loadRecentDispenses(
      registeredIds.length ? registeredIds : lastRpcRes?.data || null,
    );
    if (registeredIds.length) {
      const visibleIds = new Set((visibleRows || []).map((r) => r.id));
      const missing = registeredIds.filter((id) => !visibleIds.has(id));
      if (missing.length) {
        setMsg(
          'tpv-status',
          `Venta guardada, pero ${missing.length} dispensación(es) no se pueden leer en el listado (revisa RLS en tpv_dispenses).`,
          true,
        );
      }
    }
    if (typeof window.scClubRefreshFinance === 'function') {
      await window.scClubRefreshFinance();
    }
    if (memberRaw && typeof window.scClubInventoryReloadMembers === 'function') {
      await window.scClubInventoryReloadMembers();
    }
  }

  async function deleteRecentDispense(row) {
    if (!row || !row.id) return;
    const ok = confirm(
      '¿Seguro que quieres eliminar esta venta? Se devolverá el stock dispensado y se restará el importe de la caja.',
    );
    if (!ok) return;

    setMsg('tpv-status', 'Eliminando venta…', false);
    const { error } = await sb().rpc('club_delete_tpv_dispense', {
      p_dispense_id: row.id,
    });
    if (error) {
      setMsg('tpv-status', error.message || 'No se pudo eliminar la venta.', true);
      return;
    }

    setMsg(
      'tpv-status',
      `Venta eliminada. Repuestos ${formatNum(row.grams_dispensed)} y descontados ${formatMoney(row.price_charged_eur)}.`,
      false,
    );
    showToast('Venta eliminada');
    await loadProducts();
    await refreshStockUi();
    await loadRecentDispenses();
    if (typeof window.scClubRefreshFinance === 'function') {
      await window.scClubRefreshFinance();
    }
  }

  async function loadRecentDispenses(forceDispenseId) {
    const tbody = $('tpv-recent-tbody');
    if (!tbody) return;

    let sel =
      'id, created_at, grams_charged, grams_dispensed, price_charged_eur, notes, product_id, member_id, created_by';
    let { data, error } = await sb()
      .from('tpv_dispenses')
      .select(sel)
      .eq('club_id', state.ctx.club.id)
      .order('created_at', { ascending: false })
      .limit(5);

    if (
      error &&
      (error.message?.includes('member_id') ||
        error.message?.includes('created_by') ||
        error.code === '42703')
    ) {
      sel =
        'id, created_at, grams_charged, grams_dispensed, price_charged_eur, notes, product_id, member_id';
      let r2 = await sb()
        .from('tpv_dispenses')
        .select(sel)
        .eq('club_id', state.ctx.club.id)
        .order('created_at', { ascending: false })
        .limit(5);
      if (
        r2.error &&
        (r2.error.message?.includes('member_id') || r2.error.code === '42703')
      ) {
        sel =
          'id, created_at, grams_charged, grams_dispensed, price_charged_eur, notes, product_id';
        r2 = await sb()
          .from('tpv_dispenses')
          .select(sel)
          .eq('club_id', state.ctx.club.id)
          .order('created_at', { ascending: false })
          .limit(5);
      }
      data = r2.data;
      error = r2.error;
    }

    if (error) {
      tbody.innerHTML = `<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`;
      return [];
    }
    let rows = data || [];
    const forcedIds = Array.isArray(forceDispenseId)
      ? forceDispenseId.filter(Boolean)
      : forceDispenseId
        ? [forceDispenseId]
        : [];
    for (const forcedId of forcedIds) {
      if (rows.some((r) => r.id === forcedId)) continue;
      const { data: forcedRow, error: forceErr } = await sb()
        .from('tpv_dispenses')
        .select(sel)
        .eq('id', forcedId)
        .maybeSingle();
      if (!forceErr && forcedRow) {
        rows = [forcedRow, ...rows].slice(0, 5);
      }
    }
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8">Aún no hay ventas registradas.</td></tr>';
      return [];
    }
    const ids = [...new Set(rows.map((r) => r.product_id).filter(Boolean))];
    const mids = [...new Set(rows.map((r) => r.member_id).filter(Boolean))];
    let prodMap = {};
    let memMap = {};
    if (ids.length) {
      const { data: prods, error: pe } = await sb()
        .from('inventory_products')
        .select('id, name, emoji, sale_unit')
        .in('id', ids);
      if (!pe && prods) {
        prodMap = Object.fromEntries(prods.map((p) => [p.id, p]));
      }
    }
    if (mids.length) {
      const { data: mm, error: me } = await sb()
        .from('club_members')
        .select('id, display_name')
        .in('id', mids);
      if (!me && mm) {
        memMap = Object.fromEntries(mm.map((m) => [m.id, m]));
      }
    }
    tbody.innerHTML = '';
    rows.forEach((row) => {
      const pr = prodMap[row.product_id] || {};
      const em = (pr.emoji || '').trim();
      const label = `${em ? em + ' ' : ''}${pr.name || '—'}`;
      const mb = row.member_id ? memMap[row.member_id] : null;
      const socio = mb ? mb.display_name : '—';
      const dispenserId = row.created_by;
      const dispenser =
        dispenserId && state.staffById[dispenserId]
          ? state.staffById[dispenserId]
          : dispenserId
            ? '—'
            : '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(row.created_at).toLocaleString())}</td>
        <td>${escapeHtml(dispenser)}</td>
        <td>${escapeHtml(label)}</td>
        <td>${escapeHtml(socio)}</td>
        <td>${escapeHtml(formatNum(row.grams_charged))} / ${escapeHtml(formatNum(row.grams_dispensed))}</td>
        <td>${escapeHtml(formatMoney(row.price_charged_eur))}</td>
        <td>${escapeHtml((row.notes || '').slice(0, 40))}</td>
        <td>
          <button type="button" class="btn btn--ghost btn--small" data-del-dispense="${row.id}" title="Eliminar venta" aria-label="Eliminar venta">Eliminar</button>
        </td>
      `;
      tr.querySelector('[data-del-dispense]')?.addEventListener('click', () => {
        deleteRecentDispense(row);
      });
      tbody.appendChild(tr);
    });
    return rows;
  }

  function bindInventory() {
    $('inv-filter-category')?.addEventListener('change', async () => {
      state.filterCategoryId = ($('inv-filter-category')?.value || '').trim();
      renderInvCategoryChips();
      renderProductsTable();
      renderInvCards();
    });
    $('inv-search')?.addEventListener('input', () => {
      state.invSearch = $('inv-search')?.value || '';
      renderProductsTable();
      renderInvCards();
    });
    $('inv-cat-add')?.addEventListener('click', () => addCategory());
    $('inv-product-save')?.addEventListener('click', () => saveProduct());
    $('inv-product-emoji-open')?.addEventListener('click', () => void openInvEmojiModal());
    $('inv-product-emoji')?.addEventListener('click', () => void openInvEmojiModal());
    $('inv-product-emoji')?.addEventListener('focus', () => void openInvEmojiModal());
    $('inv-open-cat-modal')?.addEventListener('click', () => openInvCatModal());
    $('inv-open-product-modal')?.addEventListener('click', () => {
      clearProductForm();
      openInvProductModal();
    });
    document.querySelectorAll('[data-inv-sale-unit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-inv-sale-unit') || 'grams';
        setInvSaleUnitUi(v);
      });
    });
    document.querySelectorAll('[data-inv-close-cat-modal]').forEach((el) => {
      el.addEventListener('click', () => closeInvCatModal());
    });
    document.querySelectorAll('[data-inv-close-product-modal]').forEach((el) => {
      el.addEventListener('click', () => closeInvProductModal());
    });
    document.querySelectorAll('[data-inv-close-emoji-modal]').forEach((el) => {
      el.addEventListener('click', () => closeInvEmojiModal());
    });
    $('inv-emoji-picker')?.addEventListener('emoji-click', (ev) => {
      const emoji = ev?.detail?.unicode || '';
      setProductEmojiAndClose(emoji);
    });
    $('inv-adjust-save')?.addEventListener('click', () => void submitInvAdjust());
    $('inv-adjust-dir-add')?.addEventListener('click', () => setInvAdjustDirection('add'));
    $('inv-adjust-dir-remove')?.addEventListener('click', () => setInvAdjustDirection('remove'));
    document.querySelectorAll('[data-inv-close-adjust-modal]').forEach((el) => {
      el.addEventListener('click', () => closeInvAdjustModal());
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('inv-cat-modal') && !$('inv-cat-modal').classList.contains('is-hidden')) closeInvCatModal();
      if ($('inv-product-modal') && !$('inv-product-modal').classList.contains('is-hidden')) closeInvProductModal();
      if ($('inv-emoji-modal') && !$('inv-emoji-modal').classList.contains('is-hidden')) closeInvEmojiModal();
      if ($('inv-adjust-modal') && !$('inv-adjust-modal').classList.contains('is-hidden')) closeInvAdjustModal();
    });
    $('inv-product-new')?.addEventListener('click', () => {
      clearProductForm();
      setMsg('inv-status', 'Formulario limpio para nuevo producto.', false);
    });
  }

  function bindTpv() {
    $('tpv-search')?.addEventListener('input', () => {
      state.tpvSearch = $('tpv-search')?.value || '';
      renderTpvGrid();
    });
    $('tpv-link-grams')?.addEventListener('change', () => {
      syncDispensedFromCharged();
      scheduleAutoTpvLine();
    });
    $('tpv-grams-charged')?.addEventListener('input', () => {
      syncDispensedFromCharged();
      updatePriceFromTicketGrams();
      scheduleAutoTpvLine();
    });
    $('tpv-grams-dispensed')?.addEventListener('input', () => {
      updateTpvMarginHint();
      scheduleAutoTpvLine();
    });
    $('tpv-price')?.addEventListener('input', () => updateTicketGramsFromPrice());
    $('tpv-notes')?.addEventListener('input', () => scheduleAutoTpvLine());
    $('tpv-submit')?.addEventListener('click', () => submitTpv());
    $('tpv-clear-cart')?.addEventListener('click', () => {
      state.tpvCart = [];
      state.tpvPendingCartRowId = null;
      renderTpvCart();
      setMsg('tpv-status', 'Ticket vaciado.', false);
    });
    $('tpv-cart-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tpv-cart-del]');
      if (!btn) return;
      const id = btn.getAttribute('data-tpv-cart-del');
      if (!id) return;
      if (id === state.tpvPendingCartRowId) state.tpvPendingCartRowId = null;
      state.tpvCart = state.tpvCart.filter((line) => line.cart_row_id !== id);
      renderTpvCart();
    });

    document.querySelectorAll('[data-tpv-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = parseFloat(btn.getAttribute('data-tpv-step'));
        if (!Number.isNaN(d)) applyTpvStep(d);
      });
    });

    $('tpv-member-search')?.addEventListener('input', () => {
      const q = $('tpv-member-search')?.value || '';
      renderTpvMemberDropdown(filterTpvMembers(q));
    });
    $('tpv-member-clear')?.addEventListener('click', () => clearTpvMember());

    document.addEventListener('click', (e) => {
      const wrap = document.querySelector('.tpv-member-field');
      const dd = $('tpv-member-dropdown');
      if (!wrap || !dd || dd.classList.contains('is-hidden')) return;
      if (!wrap.contains(e.target)) {
        dd.classList.add('is-hidden');
        dd.hidden = true;
      }
    });
  }

  window.scInitClubInventoryTpv = async function (ctx) {
    state.ctx = ctx;
    if (!state.uiBound) {
      state.uiBound = true;
      bindInventory();
      bindTpv();
    }

    try {
      await loadCategories();
      await loadInventoryAccessFlags(ctx);
      applyInventoryEditAccess();
      state.filterCategoryId = '';
      state.invSearch = '';
      state.tpvSearch = '';
      state.tpvCatFilter = '';
      state.tpvCart = [];
      state.tpvPendingCartRowId = null;
      if ($('inv-filter-category')) $('inv-filter-category').value = '';
      if ($('inv-search')) $('inv-search').value = '';
      if ($('tpv-search')) $('tpv-search').value = '';
      renderTpvCart();
      syncTpvStockWrapVisibility();
      await loadStaffDirectory();
      await loadProducts();
      await loadMembersForTpv();
      await refreshTpvShiftState();
      await loadRecentDispenses();
      setMsg('inv-status', '', false);
      setMsg('tpv-status', '', false);
    } catch (e) {
      const msg =
        e.message && (e.message.includes('inventory_') || e.message.includes('tpv_') || e.code === '42P01')
          ? 'Ejecuta en Supabase 008, opcional 009, y 010_club_members_finance.sql si usas socios / RPC actualizado.'
          : e.message || 'Error cargando inventario.';
      setMsg('inv-status', msg, true);
      setMsg('tpv-status', msg, true);
    }
  };

  /** Recarga grillas inventario/TPV tras cambios en la pestaña Stock. */
  window.scClubReloadInventoryProducts = async function () {
    if (!state.ctx) return;
    try {
      await loadProducts();
    } catch (e) {
      /* ignore */
    }
  };

  /** Recarga inventario al volver a la pestaña (productos, categorías y permisos). */
  window.scClubRefreshInventoryUi = async function () {
    if (!state.ctx) return;
    try {
      await loadInventoryAccessFlags(state.ctx);
      applyInventoryEditAccess();
      await loadCategories();
      await loadProducts();
    } catch (e) {
      /* ignore */
    }
  };

  /** Tras abrir/cerrar turno desde Inicio. */
  window.scClubRefreshTpvUi = async function () {
    if (!state.ctx) return;
    try {
      await loadStaffDirectory();
      await refreshTpvShiftState();
      await loadRecentDispenses();
    } catch (e) {
      /* ignore */
    }
  };
})();
