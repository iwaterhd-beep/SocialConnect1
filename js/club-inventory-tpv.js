/**
 * Inventario + TPV (estilo rejilla / ticket, alertas, búsqueda, chips).
 */
(function () {
  const sb = () => window.scSupabase;

  const PRODUCT_SELECT_FULL =
    'id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit, stock_alert_grams, default_sale_grams, default_price_eur, default_price_per_gram_eur';
  /** Sin 015: extras de TPV sí, pero sin columna €/g. */
  const PRODUCT_SELECT_EXTRAS_NO_PER_GRAM =
    'id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit, stock_alert_grams, default_sale_grams, default_price_eur';
  const PRODUCT_SELECT_BASE =
    'id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit';

  function $(id) {
    return document.getElementById(id);
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
    uiBound: false,
    hasProductExtras: true,
    /** Turno abierto actual (TPV); null si no hay. */
    tpvOpenShiftId: null,
    /** Mapa auth user id → email (mismo club). */
    staffById: {},
    emojiPickerReady: false,
    emojiPickerLoading: false,
  };
  const EMOJI_RECENT_KEY = 'sc_inv_recent_emojis';

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

  function openInvProductModal() {
    const modal = $('inv-product-modal');
    if (!modal) return;
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
      ? state.products.find((x) => x.id === state.tpvSelectedId)
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
      });
      ul.appendChild(li);
    });
  }

  async function loadProducts() {
    let query = sb()
      .from('inventory_products')
      .select(state.hasProductExtras ? PRODUCT_SELECT_FULL : PRODUCT_SELECT_BASE)
      .eq('club_id', state.ctx.club.id)
      .order('name', { ascending: true });

    let { data, error } = await query;

    const colErr =
      error &&
      (error.code === '42703' ||
        (error.message && error.message.toLowerCase().includes('column')));

    if (colErr && state.hasProductExtras) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('default_price_per_gram')) {
        const rPg = await sb()
          .from('inventory_products')
          .select(PRODUCT_SELECT_EXTRAS_NO_PER_GRAM)
          .eq('club_id', state.ctx.club.id)
          .order('name', { ascending: true });
        if (!rPg.error) {
          data = rPg.data;
          error = null;
        } else {
          error = rPg.error;
        }
      }
    }

    if (
      error &&
      (error.code === '42703' ||
        (error.message && error.message.toLowerCase().includes('column')))
    ) {
      state.hasProductExtras = false;
      const r2 = await sb()
        .from('inventory_products')
        .select(PRODUCT_SELECT_BASE)
        .eq('club_id', state.ctx.club.id)
        .order('name', { ascending: true });
      data = r2.data;
      error = r2.error;
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
        (state.tpvSelectedId === p.id ? ' is-selected' : '') +
        (empty ? ' is-empty-stock' : '');
      card.setAttribute('role', 'listitem');
      const em = (p.emoji || '').trim();
      const rate = state.hasProductExtras ? getPricePerGramForProduct(p) : null;
      const priceHint =
        rate != null && !Number.isNaN(rate)
          ? `<div class="tpv-card__price">${escapeHtml(formatMoney(rate))}/g</div>`
          : p.default_price_eur != null && !Number.isNaN(p.default_price_eur)
            ? `<div class="tpv-card__price">${escapeHtml(formatMoney(p.default_price_eur))}</div>`
            : '';
      card.innerHTML = `
        <span class="tpv-card__emoji">${escapeHtml(em || '📦')}</span>
        <span class="tpv-card__name">${escapeHtml(p.name)}</span>
        <span class="tpv-card__meta">Stock ${escapeHtml(formatNum(stock))} ${escapeHtml(unitShort(p))}</span>
        ${priceHint}
      `;
      card.addEventListener('click', () => {
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

  function selectTpvProduct(id) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    state.tpvSelectedId = id;
    if ($('tpv-selected-product')) $('tpv-selected-product').value = id;

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
    updateTpvUnitLabels(p);
    applyTpvStepPreset(p);
    updateTpvMarginHint();
    updatePriceFromTicketGrams();
    renderTpvGrid();
  }

  function syncTpvSelectionAfterReload() {
    if (!state.tpvSelectedId) return;
    const still = state.products.some((x) => x.id === state.tpvSelectedId);
    if (!still) {
      state.tpvSelectedId = '';
      if ($('tpv-selected-product')) $('tpv-selected-product').value = '';
      $('tpv-selected-label').textContent = 'Toca un producto a la izquierda';
      if ($('tpv-stock-hint')) $('tpv-stock-hint').textContent = '';
      updateTpvUnitLabels({ sale_unit: 'grams' });
      applyTpvStepPreset({ sale_unit: 'grams' });
      renderTpvGrid();
      return;
    }
    const p = state.products.find((x) => x.id === state.tpvSelectedId);
    if ($('tpv-stock-hint') && p) {
      $('tpv-stock-hint').textContent = `Stock disponible: ${formatNum(p.stock_grams)} ${unitShort(p)}`;
    }
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
      tr.innerHTML = `
        <td class="inv-emoji-cell">${escapeHtml(em || '—')}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(categoryName(p.category_id))}</td>
        <td>${escapeHtml(formatNum(p.bottle_weight_grams))}</td>
        <td>${escapeHtml(formatNum(p.stock_grams))}</td>
        <td>${escapeHtml(alertTxt)}</td>
        <td class="actions">
          <button type="button" class="btn btn--ghost btn--small" data-edit="${p.id}">Editar</button>
          <button type="button" class="btn btn--ghost btn--small" data-del="${p.id}">Borrar</button>
        </td>
      `;
      if (lvl === 'out') tr.style.background = 'rgba(254, 226, 226, 0.35)';
      else if (lvl === 'low') tr.style.background = 'rgba(254, 243, 199, 0.35)';
      tr.querySelector('[data-edit]').addEventListener('click', () => editProduct(p));
      tr.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm(`¿Eliminar el producto «${p.name}»?`)) return;
        setMsg('inv-status', 'Eliminando…', false);
        const { error } = await sb().from('inventory_products').delete().eq('id', p.id);
        if (error) {
          setMsg('inv-status', error.message || 'No se pudo borrar (¿hay ventas registradas?).', true);
          return;
        }
        setMsg('inv-status', 'Producto eliminado.', false);
        clearProductForm();
        await loadProducts();
      });
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
      card.innerHTML = `
        <div class="inv-card__top">
          <span class="inv-card__emoji">${escapeHtml(em || '📦')}</span>
          ${badge}
        </div>
        <div class="inv-card__name">${escapeHtml(p.name)}</div>
        <div class="inv-card__stock">${escapeHtml(categoryName(p.category_id))} · ${escapeHtml(formatNum(p.stock_grams))} ${escapeHtml(unitShort(p))}</div>
        <div class="inv-card__actions">
          <button type="button" class="btn btn--ghost btn--small" data-edit="${p.id}">Editar</button>
        </div>
      `;
      card.querySelector('[data-edit]').addEventListener('click', () => editProduct(p));
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
    if ($('inv-product-save')) $('inv-product-save').textContent = 'Actualizar producto';
    setMsg('inv-status', 'Editando producto. Guarda para aplicar cambios.', false);
    $('inv-product-name')?.focus();
  }

  async function saveProduct() {
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
      const msg = (res.error.message || '').toLowerCase();
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
  }

  async function addCategory() {
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
  }

  function applyTpvStep(delta) {
    const chargedEl = $('tpv-grams-charged');
    if (!chargedEl) return;
    let v = parseDecimal(chargedEl.value);
    if (Number.isNaN(v)) v = 0;
    const p = state.tpvSelectedId ? state.products.find((x) => x.id === state.tpvSelectedId) : null;
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
  }

  function syncDispensedFromCharged() {
    if ($('tpv-link-grams')?.checked !== false) {
      const s = ($('tpv-grams-charged')?.value || '').trim();
      $('tpv-grams-dispensed').value = s;
    }
    updateTpvMarginHint();
  }

  function updateTpvMarginHint() {
    const el = $('tpv-margin-hint');
    if (!el) return;
    const a = parseDecimal($('tpv-grams-charged')?.value);
    const b = parseDecimal($('tpv-grams-dispensed')?.value);
    const p = state.tpvSelectedId ? state.products.find((x) => x.id === state.tpvSelectedId) : null;
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
        ? `Margen físico: +${formatNum(d)} ${unitShort(state.products.find((x) => x.id === state.tpvSelectedId))} salen del inventario respecto al ticket.`
        : `Ajuste: ${formatNum(Math.abs(d))} ${unitShort(state.products.find((x) => x.id === state.tpvSelectedId))} menos dispensados que en ticket.`;
  }

  async function loadMembersForTpv() {
    if (!state.ctx) return;
    const { data, error } = await sb()
      .from('club_members')
      .select('id, display_name, member_code')
      .eq('club_id', state.ctx.club.id)
      .eq('is_active', true)
      .order('display_name', { ascending: true });
    if (error) {
      state.tpvMembers = [];
      return;
    }
    state.tpvMembers = data || [];
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
      b.textContent = `${m.display_name}${code}`;
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        selectTpvMember(m.id, m.display_name, m.member_code);
      });
      dd.appendChild(b);
    });
    dd.classList.remove('is-hidden');
    dd.hidden = false;
  }

  function selectTpvMember(id, displayName, memberCode) {
    if ($('tpv-selected-member')) $('tpv-selected-member').value = id;
    const chip = $('tpv-member-chip');
    if (chip) {
      chip.textContent = `Socio: ${displayName}${memberCode ? ' (' + memberCode + ')' : ''}`;
    }
    if ($('tpv-member-search')) $('tpv-member-search').value = '';
    const dd = $('tpv-member-dropdown');
    if (dd) {
      dd.classList.add('is-hidden');
      dd.hidden = true;
    }
  }

  function clearTpvMember() {
    if ($('tpv-selected-member')) $('tpv-selected-member').value = '';
    if ($('tpv-member-search')) $('tpv-member-search').value = '';
    const chip = $('tpv-member-chip');
    if (chip) chip.textContent = '';
    const dd = $('tpv-member-dropdown');
    if (dd) {
      dd.classList.add('is-hidden');
      dd.hidden = true;
    }
  }

  async function submitTpv() {
    const pid = ($('tpv-selected-product')?.value || '').trim() || state.tpvSelectedId;
    const memberRaw = ($('tpv-selected-member')?.value || '').trim();
    const gramsCharged = parseDecimal($('tpv-grams-charged')?.value);
    const gramsDispensed = parseDecimal($('tpv-grams-dispensed')?.value);
    const price = parseDecimal($('tpv-price')?.value);
    const notes = ($('tpv-notes')?.value || '').trim();

    if (!pid) {
      setMsg('tpv-status', 'Elige un producto en la rejilla.', true);
      return;
    }
    if (Number.isNaN(gramsCharged) || gramsCharged < 0) {
      setMsg('tpv-status', 'Gramos en ticket no válidos.', true);
      return;
    }
    if (Number.isNaN(gramsDispensed) || gramsDispensed < 0) {
      setMsg('tpv-status', 'Gramos dispensados reales no válidos.', true);
      return;
    }
    const selected = state.products.find((x) => x.id === pid);
    if (unitKey(selected) === 'unit') {
      if (Math.abs(gramsCharged - Math.round(gramsCharged)) > 0.0001) {
        setMsg('tpv-status', 'En productos por unidad, la cantidad en ticket debe ser 1, 2, 3…', true);
        return;
      }
      if (Math.abs(gramsDispensed - Math.round(gramsDispensed)) > 0.0001) {
        setMsg('tpv-status', 'En productos por unidad, la cantidad real debe ser 1, 2, 3…', true);
        return;
      }
    }
    if (Number.isNaN(price) || price < 0) {
      setMsg('tpv-status', 'Precio al cliente no válido.', true);
      return;
    }

    const shiftId = state.tpvOpenShiftId || (await getOpenShiftId(state.ctx.club.id));
    if (!shiftId) {
      setMsg('tpv-status', 'Abre un turno desde Inicio para cobrar.', true);
      return;
    }

    setMsg('tpv-status', 'Registrando venta…', false);
    const payloadWithMember = {
      p_product_id: pid,
      p_grams_charged: gramsCharged,
      p_grams_dispensed: gramsDispensed,
      p_price_charged_eur: price,
      p_shift_id: shiftId,
      p_notes: notes,
      p_member_id: memberRaw || null,
    };

    let { error } = await sb().rpc('club_register_tpv_dispense', payloadWithMember);

    const maybeLegacyRpc =
      error &&
      (error.code === 'PGRST202' ||
        error.code === '42883' ||
        /p_member_id|function\s+public\.club_register_tpv_dispense/i.test(error.message || ''));
    if (maybeLegacyRpc) {
      const payloadLegacy = {
        p_product_id: pid,
        p_grams_charged: gramsCharged,
        p_grams_dispensed: gramsDispensed,
        p_price_charged_eur: price,
        p_shift_id: shiftId,
        p_notes: notes,
      };
      const retry = await sb().rpc('club_register_tpv_dispense', payloadLegacy);
      error = retry.error;
    }

    if (error) {
      setMsg('tpv-status', error.message || 'No se pudo registrar.', true);
      return;
    }

    setMsg(
      'tpv-status',
      `Listo: −${formatNum(gramsDispensed)} ${unitShort(state.products.find((x) => x.id === pid))} de stock · cobrado ${formatMoney(price)}.`,
      false,
    );
    showToast(`Venta · −${formatNum(gramsDispensed)} ${unitShort(state.products.find((x) => x.id === pid))} stock`);

    const overlay = $('tpv-success-overlay');
    const detail = $('tpv-overlay-detail');
    if (overlay && detail) {
      const us = unitShort(state.products.find((x) => x.id === pid));
      detail.textContent = `${formatMoney(price)} · ticket ${formatNum(gramsCharged)} ${us} · real ${formatNum(gramsDispensed)} ${us}`;
      overlay.classList.remove('is-hidden');
      overlay.setAttribute('aria-hidden', 'false');
      setTimeout(() => {
        overlay.classList.add('is-hidden');
        overlay.setAttribute('aria-hidden', 'true');
      }, 1400);
    }

    $('tpv-notes').value = '';
    updateTpvMarginHint();
    await loadProducts();
    await loadRecentDispenses();
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
    await loadRecentDispenses();
  }

  async function loadRecentDispenses() {
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
      return;
    }
    const rows = data || [];
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
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('inv-cat-modal') && !$('inv-cat-modal').classList.contains('is-hidden')) closeInvCatModal();
      if ($('inv-product-modal') && !$('inv-product-modal').classList.contains('is-hidden')) closeInvProductModal();
      if ($('inv-emoji-modal') && !$('inv-emoji-modal').classList.contains('is-hidden')) closeInvEmojiModal();
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
    $('tpv-link-grams')?.addEventListener('change', () => syncDispensedFromCharged());
    $('tpv-grams-charged')?.addEventListener('input', () => {
      syncDispensedFromCharged();
      updatePriceFromTicketGrams();
    });
    $('tpv-grams-dispensed')?.addEventListener('input', () => updateTpvMarginHint());
    $('tpv-submit')?.addEventListener('click', () => submitTpv());

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
      state.filterCategoryId = '';
      state.invSearch = '';
      state.tpvSearch = '';
      state.tpvCatFilter = '';
      if ($('inv-filter-category')) $('inv-filter-category').value = '';
      if ($('inv-search')) $('inv-search').value = '';
      if ($('tpv-search')) $('tpv-search').value = '';
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
