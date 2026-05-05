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
    shiftId: null,
    shiftOpenedAt: null,
    uiBound: false,
    eventsAvailable: true,
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

  async function loadProducts() {
    const { data, error } = await sb()
      .from('inventory_products')
      .select('id, name, emoji, bottle_weight_grams, stock_grams')
      .eq('club_id', state.ctx.club.id)
      .order('name', { ascending: true });
    if (error) throw error;
    state.products = data || [];
    renderManualTable();
    toggleStockControls();
  }

  function renderManualTable() {
    const tbody = $('stock-manual-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    state.products.forEach((p) => {
      const tr = document.createElement('tr');
      const em = (p.emoji || '').trim();
      const tare = Number(p.bottle_weight_grams) || 0;
      const tareLine =
        tare > 0
          ? `<div class="hint hint--small stock-tara-hint">${escapeHtml(`Bote ${formatNum(tare)} g — se resta del peso que indiques`)}</div>`
          : '';
      const placeholder =
        tare > 0 ? 'Total báscula (g)' : 'Ej. 10,5';
      tr.innerHTML = `
        <td>${escapeHtml(em ? em + ' ' : '')}${escapeHtml(p.name)}${tareLine}</td>
        <td>${escapeHtml(formatNum(p.stock_grams))}</td>
        <td>
          <input type="text" class="input stk-net-input" inputmode="decimal" data-product-id="${p.id}" placeholder="${escapeHtml(placeholder)}" style="max-width: 9rem" autocomplete="off" />
        </td>
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
      tbody.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;
      return;
    }

    const rows = data || [];
    const prodMap = Object.fromEntries(state.products.map((p) => [p.id, p]));

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
      let deltaTxt = '—';
      if (ev.delta_grams != null && ev.delta_grams !== '') {
        const d = Number(ev.delta_grams);
        if (!Number.isNaN(d)) {
          deltaTxt = (d > 0 ? '+' : '') + formatNum(d);
        }
      }
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(ev.created_at).toLocaleString())}</td>
        <td>${escapeHtml(turnoLabel)}</td>
        <td>${escapeHtml(label)}</td>
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

    setStockMsg('Guardando…', false);
    const { error: uerr } = await sb().rpc('club_register_manual_stock_count', {
      p_product_id: productId,
      p_new_stock_grams: net,
    });
    if (uerr) {
      setStockMsg(uerr.message || 'No se pudo actualizar.', true);
      return;
    }
    if (input) input.value = '';
    if (tare > 0) {
      setStockMsg(
        `Stock neto guardado: ${formatNum(net)} g (peso indicado ${formatNum(parsed)} g − bote ${formatNum(tare)} g).`,
        false,
      );
    } else {
      setStockMsg('Stock actualizado.', false);
    }
    await loadProducts();
    await loadShiftEvents();
    if (typeof window.scClubReloadInventoryProducts === 'function') {
      await window.scClubReloadInventoryProducts();
    }
  }

  function bindStockUi() {
    if (state.uiBound) return;
    state.uiBound = true;
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.stk-save-row');
      if (!btn) return;
      const id = btn.getAttribute('data-product-id');
      if (id) void saveManualRow(id);
    });
  }

  window.scInitClubStock = async function (ctx) {
    state.ctx = ctx;
    state.eventsAvailable = true;
    bindStockUi();
    try {
      await refreshShift();
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
      await loadProducts();
      await loadShiftEvents();
    } catch (e) {
      /* ignore */
    }
  };
})();
