/**
 * Stock por turno: contaje manual + historial (shift_stock_events).
 */
(function () {
  const sb = () => window.scSupabase;

  function $(id) {
    return document.getElementById(id);
  }

  const state = {
    ctx: null,
    products: [],
    categories: [],
    filterCategoryId: '',
    sortBy: 'name_asc',
    shiftId: null,
    shiftOpenedAt: null,
    uiBound: false,
    eventsAvailable: true,
    lastCountByProduct: {},
  };

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

  function getShiftStockDelta(ev) {
    if (!ev) return null;
    if (ev.delta_grams != null && ev.delta_grams !== '') {
      const d = Number(ev.delta_grams);
      if (!Number.isNaN(d)) return d;
    }
    if (ev.previous_stock_grams != null && ev.stock_net_grams != null) {
      const prev = Number(ev.previous_stock_grams);
      const net = Number(ev.stock_net_grams);
      if (!Number.isNaN(prev) && !Number.isNaN(net)) return net - prev;
    }
    return null;
  }

  function formatStockDiscrepancy(prod, delta) {
    if (delta === null || Number.isNaN(delta)) return '—';
    const sign = delta > 0 ? '+' : '';
    if (prod && prod.sale_unit === 'unit') {
      return `${sign}${delta.toLocaleString('es-ES', { maximumFractionDigits: 0 })} ud`;
    }
    let txt = `${sign}${delta.toLocaleString('es-ES', { maximumFractionDigits: 3 })} g`;
    const dsg = Number(prod && prod.default_sale_grams);
    if (dsg > 0) {
      const units = delta / dsg;
      const uSign = units > 0 ? '+' : '';
      txt += ` · ${uSign}${units.toLocaleString('es-ES', { maximumFractionDigits: 2 })} ud`;
    }
    return txt;
  }

  function buildLatestCountByProduct(events) {
    const map = {};
    (events || []).forEach((ev) => {
      const cur = map[ev.product_id];
      if (!cur || new Date(ev.created_at) >= new Date(cur.created_at)) {
        map[ev.product_id] = ev;
      }
    });
    return map;
  }

  function previewManualDelta(prod, rawValue) {
    const parsed = parseDecimal(rawValue);
    if (Number.isNaN(parsed) || parsed < 0) return null;
    const tare = prod ? Number(prod.bottle_weight_grams) || 0 : 0;
    const net = tare > 0 ? Math.max(0, parsed - tare) : parsed;
    const prev = prod ? Number(prod.stock_grams) || 0 : 0;
    return net - prev;
  }

  function formatTsShort(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (e) {
      return String(iso);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStockMsg(text, isError) {
    const el = $('stock-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  async function refreshShift() {
    const { data, error } = await sb()
      .from('shifts')
      .select('id, opened_at')
      .eq('club_id', state.ctx.club.id)
      .is('closed_at', null)
      .maybeSingle();
    if (error) throw error;
    state.shiftId = data ? data.id : null;
    state.shiftOpenedAt = data ? data.opened_at : null;

    const banner = $('stock-shift-banner');
    if (banner) {
      banner.classList.remove('stock-shift-banner--warn');
      if (state.shiftId) {
        banner.textContent = `Turno abierto — puedes registrar stock (${new Date(data.opened_at).toLocaleString()})`;
      } else {
        banner.textContent =
          'No hay turno abierto. Ve a Inicio y abre un turno para registrar stock en esta sección.';
        banner.classList.add('stock-shift-banner--warn');
      }
    }
    toggleStockControls();
  }

  function toggleStockControls() {
    const on = Boolean(state.shiftId);
    document.querySelectorAll('.stk-save-row').forEach((b) => {
      b.disabled = !on;
    });
    document.querySelectorAll('.stk-net-input').forEach((i) => {
      i.disabled = !on;
    });
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
    renderCategoryControls();
  }

  function renderCategoryControls() {
    const select = $('stk-filter-category');
    if (select) {
      const current = state.filterCategoryId || '';
      select.innerHTML = '<option value="">Todas las categorías</option>';
      state.categories.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        select.appendChild(opt);
      });
      select.value = current;
      if (select.value !== current) {
        state.filterCategoryId = '';
        select.value = '';
      }
    }

    const sort = $('stk-sort-by');
    if (sort) sort.value = state.sortBy || 'name_asc';

    const row = $('stk-cat-chips');
    if (!row) return;
    row.innerHTML = '';
    const mk = (label, val, active) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (active ? ' is-active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        state.filterCategoryId = val;
        if ($('stk-filter-category')) $('stk-filter-category').value = val;
        renderCategoryControls();
        renderManualTable();
      });
      row.appendChild(b);
    };
    mk('Todas', '', state.filterCategoryId === '');
    state.categories.forEach((c) => mk(c.name, c.id, state.filterCategoryId === c.id));
  }

  function getCategorySortMeta(categoryId) {
    if (!categoryId) return { order: 9999, name: 'zzz' };
    const c = state.categories.find((x) => x.id === categoryId);
    return c
      ? { order: Number(c.sort_order) || 0, name: String(c.name || '') }
      : { order: 9998, name: 'zzz' };
  }

  function getDisplayedProducts() {
    let list = state.products.slice();
    if (state.filterCategoryId) {
      list = list.filter((p) => p.category_id === state.filterCategoryId);
    }

    const sortBy = state.sortBy || 'name_asc';
    list.sort((a, b) => {
      if (sortBy === 'stock_asc' || sortBy === 'stock_desc') {
        const diff = (Number(a.stock_grams) || 0) - (Number(b.stock_grams) || 0);
        if (diff !== 0) return sortBy === 'stock_asc' ? diff : -diff;
        return String(a.name || '').localeCompare(String(b.name || ''), 'es', {
          sensitivity: 'base',
        });
      }
      if (sortBy === 'category') {
        const ca = getCategorySortMeta(a.category_id);
        const cb = getCategorySortMeta(b.category_id);
        if (ca.order !== cb.order) return ca.order - cb.order;
        const byCat = ca.name.localeCompare(cb.name, 'es', { sensitivity: 'base' });
        if (byCat !== 0) return byCat;
        return String(a.name || '').localeCompare(String(b.name || ''), 'es', {
          sensitivity: 'base',
        });
      }
      const cmp = String(a.name || '').localeCompare(String(b.name || ''), 'es', {
        sensitivity: 'base',
      });
      return sortBy === 'name_desc' ? -cmp : cmp;
    });
    return list;
  }

  function capturePendingInputs() {
    const map = {};
    document.querySelectorAll('.stk-net-input').forEach((input) => {
      const id = input.getAttribute('data-product-id');
      const value = (input.value || '').trim();
      if (id && value) map[id] = value;
    });
    return map;
  }

  async function loadProducts() {
    let q = sb()
      .from('inventory_products')
      .select('id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit, default_sale_grams')
      .eq('club_id', state.ctx.club.id)
      .eq('is_archived', false)
      .order('name', { ascending: true });
    let { data, error } = await q;
    if (
      error &&
      (error.code === '42703' ||
        (error.message && String(error.message).toLowerCase().includes('column'))) &&
      String(error.message || '')
        .toLowerCase()
        .includes('is_archived')
    ) {
      ({ data, error } = await sb()
        .from('inventory_products')
        .select('id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit, default_sale_grams')
        .eq('club_id', state.ctx.club.id)
        .order('name', { ascending: true }));
    }
    if (
      error &&
      (error.code === '42703' ||
        (error.message && String(error.message).toLowerCase().includes('column')))
    ) {
      ({ data, error } = await sb()
        .from('inventory_products')
        .select('id, name, emoji, bottle_weight_grams, stock_grams, category_id')
        .eq('club_id', state.ctx.club.id)
        .eq('is_archived', false)
        .order('name', { ascending: true }));
    }
    if (error) throw error;
    state.products = data || [];
    renderManualTable();
    toggleStockControls();
  }

  function renderManualTable() {
    const tbody = $('stock-manual-tbody');
    if (!tbody) return;
    const pending = capturePendingInputs();
    const list = getDisplayedProducts();
    tbody.innerHTML = '';
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5">No hay productos con este filtro.</td></tr>';
      return;
    }
    list.forEach((p) => {
      const tr = document.createElement('tr');
      const em = (p.emoji || '').trim();
      const tare = Number(p.bottle_weight_grams) || 0;
      const tareLine =
        tare > 0
          ? `<div class="hint hint--small stock-tara-hint">${escapeHtml(`Bote ${formatNum(tare)} g — se resta del peso que indiques`)}</div>`
          : '';
      const placeholder = tare > 0 ? 'Total báscula (g)' : 'Ej. 10,5';
      const pendingValue = pending[p.id] ? ` value="${escapeHtml(pending[p.id])}"` : '';
      const savedEv = state.lastCountByProduct[p.id];
      const savedDelta = getShiftStockDelta(savedEv);
      const previewDelta = pending[p.id] ? previewManualDelta(p, pending[p.id]) : null;
      const descSaved =
        savedDelta !== null ? formatStockDiscrepancy(p, savedDelta) : '—';
      const descPreview =
        previewDelta !== null ? formatStockDiscrepancy(p, previewDelta) : '';
      const descCell = descPreview
        ? `<span class="hint">${escapeHtml(descPreview)}</span>`
        : escapeHtml(descSaved);
      tr.innerHTML = `
        <td>${escapeHtml(em ? em + ' ' : '')}${escapeHtml(p.name)}${tareLine}</td>
        <td>${escapeHtml(formatNum(p.stock_grams))}</td>
        <td>
          <input type="text" class="input stk-net-input" inputmode="decimal" data-product-id="${p.id}" placeholder="${escapeHtml(placeholder)}" style="max-width: 9rem" autocomplete="off"${pendingValue} />
        </td>
        <td class="stk-desc-cell" data-product-id="${p.id}">${descCell}</td>
        <td class="actions">
          <button type="button" class="btn btn--ghost btn--small stk-save-row" data-product-id="${p.id}">Guardar</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    toggleStockControls();
  }

  async function loadShiftEvents() {
    const tbody = $('stock-events-tbody');
    const emptyEl = $('stock-events-empty');
    if (!tbody) return;

    if (!state.shiftId) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.textContent = 'Sin turno abierto.';
      return;
    }

    if (!state.eventsAvailable) {
      tbody.innerHTML = '';
      if (emptyEl) {
        emptyEl.textContent =
          'Ejecuta en Supabase la migración 013_shift_stock_events.sql para guardar el historial por turno.';
      }
      return;
    }

    const { data, error } = await sb()
      .from('shift_stock_events')
      .select(
        'id, created_at, product_id, stock_net_grams, source, previous_stock_grams, delta_grams, shift_id',
      )
      .eq('shift_id', state.shiftId)
      .order('created_at', { ascending: false })
      .limit(80);

    if (error) {
      if (error.code === '42P01' || (error.message && error.message.includes('shift_stock'))) {
        state.eventsAvailable = false;
        tbody.innerHTML = '';
        if (emptyEl) {
          emptyEl.textContent =
            'Ejecuta en Supabase la migración 013_shift_stock_events.sql para guardar el historial por turno.';
        }
        return;
      }
      tbody.innerHTML = `<tr><td colspan="7">${escapeHtml(error.message)}</td></tr>`;
      return;
    }

    const rows = data || [];
    const prodMap = Object.fromEntries(state.products.map((p) => [p.id, p]));
    state.lastCountByProduct = buildLatestCountByProduct(rows);

    tbody.innerHTML = '';
    if (!rows.length) {
      if (emptyEl) emptyEl.textContent = 'Aún no hay registros en este turno.';
      return;
    }
    if (emptyEl) emptyEl.textContent = '';

    const turnoLabel = state.shiftOpenedAt
      ? formatTsShort(state.shiftOpenedAt)
      : '—';

    rows.forEach((ev) => {
      const pr = prodMap[ev.product_id] || {};
      const em = (pr.emoji || '').trim();
      const label = `${em ? em + ' ' : ''}${pr.name || '—'}`;
      const origin = ev.source === 'scale' ? 'Báscula' : 'Manual';
      const d = getShiftStockDelta(ev);
      const deltaTxt = formatStockDiscrepancy(pr, d);
      const prevTxt =
        ev.previous_stock_grams != null && ev.previous_stock_grams !== ''
          ? formatNum(ev.previous_stock_grams)
          : '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(ev.created_at).toLocaleString())}</td>
        <td>${escapeHtml(turnoLabel)}</td>
        <td>${escapeHtml(label)}</td>
        <td>${escapeHtml(prevTxt)}</td>
        <td>${escapeHtml(formatNum(ev.stock_net_grams))}</td>
        <td>${escapeHtml(deltaTxt)}</td>
        <td>${escapeHtml(origin)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  async function saveManualRow(productId) {
    if (!state.shiftId) {
      setStockMsg('Abre un turno desde Inicio.', true);
      return;
    }
    const p = state.products.find((x) => x.id === productId);
    const input = document.querySelector(
      `input.stk-net-input[data-product-id="${productId}"]`,
    );
    const raw = (input?.value || '').trim();
    const parsed = parseDecimal(raw);
    if (Number.isNaN(parsed) || parsed < 0) {
      setStockMsg('Indica un valor válido (≥ 0).', true);
      return;
    }
    const tare = p ? Number(p.bottle_weight_grams) || 0 : 0;
    const net = tare > 0 ? Math.max(0, parsed - tare) : parsed;
    const prevStock = p ? Number(p.stock_grams) || 0 : 0;
    const deltaPreview = net - prevStock;

    setStockMsg('Guardando…', false);
    const { data: rpcData, error: uerr } = await sb().rpc('club_register_manual_stock_count', {
      p_product_id: productId,
      p_new_stock_grams: net,
    });
    if (uerr) {
      setStockMsg(uerr.message || 'No se pudo actualizar.', true);
      return;
    }
    let delta = deltaPreview;
    let rpcPayload = rpcData;
    if (typeof rpcPayload === 'string') {
      try {
        rpcPayload = JSON.parse(rpcPayload);
      } catch (e) {
        rpcPayload = null;
      }
    }
    if (rpcPayload && typeof rpcPayload === 'object' && rpcPayload.delta_grams != null) {
      const d = Number(rpcPayload.delta_grams);
      if (!Number.isNaN(d)) delta = d;
    } else if (typeof rpcData === 'number' && !Number.isNaN(rpcData)) {
      delta = deltaPreview;
    }
    const descTxt = formatStockDiscrepancy(p, delta);
    if (input) input.value = '';
    if (tare > 0) {
      setStockMsg(
        `Stock neto guardado: ${formatNum(net)} g (peso ${formatNum(parsed)} g − bote ${formatNum(tare)} g). Descuadre: ${descTxt}.`,
        false,
      );
    } else {
      setStockMsg(`Stock actualizado. Descuadre: ${descTxt}.`, false);
    }
    await loadProducts();
    await loadShiftEvents();
    renderManualTable();
    if (typeof window.scClubReloadInventoryProducts === 'function') {
      await window.scClubReloadInventoryProducts();
    }
  }

  function bindStockUi() {
    if (state.uiBound) return;
    state.uiBound = true;
    $('stk-filter-category')?.addEventListener('change', () => {
      state.filterCategoryId = ($('stk-filter-category')?.value || '').trim();
      renderCategoryControls();
      renderManualTable();
    });
    $('stk-sort-by')?.addEventListener('change', () => {
      state.sortBy = ($('stk-sort-by')?.value || 'name_asc').trim() || 'name_asc';
      renderManualTable();
    });
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.stk-save-row');
      if (!btn) return;
      const id = btn.getAttribute('data-product-id');
      if (id) void saveManualRow(id);
    });
    document.addEventListener('input', (e) => {
      const input = e.target.closest('.stk-net-input');
      if (!input) return;
      const id = input.getAttribute('data-product-id');
      const prod = state.products.find((x) => x.id === id);
      const cell = document.querySelector(`.stk-desc-cell[data-product-id="${id}"]`);
      if (!cell || !prod) return;
      const raw = (input.value || '').trim();
      if (!raw) {
        const savedEv = state.lastCountByProduct[id];
        const savedDelta = getShiftStockDelta(savedEv);
        cell.textContent = savedDelta !== null ? formatStockDiscrepancy(prod, savedDelta) : '—';
        return;
      }
      const d = previewManualDelta(prod, raw);
      cell.innerHTML = d !== null ? `<span class="hint">${escapeHtml(formatStockDiscrepancy(prod, d))}</span>` : '—';
    });
  }

  window.scInitClubStock = async function (ctx) {
    state.ctx = ctx;
    state.eventsAvailable = true;
    bindStockUi();
    try {
      await refreshShift();
      await loadCategories();
      await loadProducts();
      await loadShiftEvents();
      setStockMsg('', false);
    } catch (e) {
      setStockMsg(e.message || 'Error cargando stock.', true);
    }
  };

  window.scClubRefreshStockUi = async function () {
    if (!state.ctx) return;
    try {
      await refreshShift();
      await loadCategories();
      await loadProducts();
      await loadShiftEvents();
    } catch (e) {
      /* ignore */
    }
  };
})();
