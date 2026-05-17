/**
 * Panel de club: datos del club y turnos (abrir / cerrar).
 */
(function () {
  const sb = () => window.scSupabase;

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text, isError) {
    const el = $('club-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  async function ensureClubGate() {
    const gate = await window.SCAuth.requireClubSession();
    if (gate.reason === 'is_superadmin') {
      window.location.href = 'dashboard-superadmin.html';
      return null;
    }
    if (!gate.ok) {
      window.location.href = 'index.html';
      return null;
    }

    const { data: club, error } = await sb()
      .from('clubs')
      .select('id, name, is_active')
      .eq('id', gate.profile.club_id)
      .maybeSingle();

    if (error) throw error;
    if (!club || !club.is_active) {
      setStatus('Este club está desactivado. Consulta con el superadmin.', true);
      await sb().auth.signOut();
      setTimeout(() => {
        window.location.href = 'index.html';
      }, 2500);
      return null;
    }

    $('club-name-display').textContent = club.name;
    const topClub = $('club-topnav-club');
    if (topClub) topClub.textContent = club.name;
    $('club-role-display').textContent = gate.profile.role;
    $('club-user-email').textContent = gate.profile.email || '';

    return { ...gate, club };
  }

  async function fetchRecentShifts(clubId) {
    const { data, error } = await sb()
      .from('shifts')
      .select('*')
      .eq('club_id', clubId)
      .order('opened_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return data || [];
  }

  async function getOpenShift(clubId) {
    const { data, error } = await sb()
      .from('shifts')
      .select('*')
      .eq('club_id', clubId)
      .is('closed_at', null)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  function formatTs(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadStaffEmailMap() {
    const map = {};
    const { data, error } = await sb().rpc('club_staff_directory');
    if (error || !data) return map;
    (data || []).forEach((row) => {
      const id = row.user_id ?? row.userId;
      if (id && row.email) map[id] = row.email;
    });
    return map;
  }

  function staffEmailLabel(map, userId) {
    if (!userId) return '—';
    return map[userId] || '—';
  }

  async function refreshShiftsUI(ctx) {
    const open = await getOpenShift(ctx.club.id);
    const recent = await fetchRecentShifts(ctx.club.id);
    let staffMap = {};
    try {
      staffMap = await loadStaffEmailMap();
    } catch (e) {
      /* ignore */
    }

    const bar = $('shift-state');
    const btnOpen = $('btn-open-shift');
    const btnClose = $('btn-close-shift');
    if (open) {
      const whoOpen = staffEmailLabel(staffMap, open.opened_by);
      bar.textContent = `Turno abierto desde ${formatTs(open.opened_at)} · Abierto por ${whoOpen}`;
      bar.classList.remove('hint');
      bar.classList.add('shift-state--open');
      btnOpen.disabled = true;
      btnClose.disabled = false;
      btnClose.dataset.shiftId = open.id;
    } else {
      bar.textContent = 'No hay turno abierto.';
      bar.classList.add('hint');
      bar.classList.remove('shift-state--open');
      btnOpen.disabled = false;
      btnClose.disabled = true;
      delete btnClose.dataset.shiftId;
    }

    const tbody = $('shifts-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      recent.forEach((row) => {
        const tr = document.createElement('tr');
        const state = row.closed_at ? 'Cerrado' : 'Abierto';
        const openedBy = staffEmailLabel(staffMap, row.opened_by);
        const closedBy = row.closed_at ? staffEmailLabel(staffMap, row.closed_by) : '—';
        tr.innerHTML = `
          <td>${escapeHtml(formatTs(row.opened_at))}</td>
          <td>${escapeHtml(formatTs(row.closed_at))}</td>
          <td>${escapeHtml(openedBy)}</td>
          <td>${escapeHtml(closedBy)}</td>
          <td>${escapeHtml(state)}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    if (typeof window.scClubRefreshStockUi === 'function') {
      try {
        await window.scClubRefreshStockUi();
      } catch (e) {
        /* ignore */
      }
    }
    if (typeof window.scClubRefreshTpvUi === 'function') {
      try {
        await window.scClubRefreshTpvUi();
      } catch (e) {
        /* ignore */
      }
    }
    try {
      await refreshOpeningFloatHint(ctx.club.id);
    } catch (e) {
      /* ignore */
    }
  }

  function parseDecimalLoose(str) {
    if (str === null || str === undefined) return NaN;
    const t = String(str).trim().replace(',', '.');
    if (t === '') return NaN;
    return parseFloat(t);
  }

  async function refreshOpeningFloatHint(clubId) {
    const input = $('opening-float-eur');
    const hint = $('opening-float-hint');
    if (!input || !hint) return;
    const { data, error } = await sb()
      .from('shifts')
      .select('closing_float_forward_eur, closing_cash_total_eur')
      .eq('club_id', clubId)
      .not('closed_at', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      hint.textContent =
        'Sugerencia: indica el efectivo de cambio con el que empiezas (p. ej. lo dejado en el cierre anterior).';
      return;
    }
    const v = data.closing_float_forward_eur;
    if (v != null && v !== '') {
      hint.textContent = `Último cierre dejó ${Number(v).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })} de cambio para el siguiente turno. Puedes usar ese importe como referencia.`;
      if (!input.value.trim()) {
        input.placeholder = String(v).replace('.', ',');
      }
    } else {
      hint.textContent =
        'Indica el efectivo de cambio inicial si aplica (billetes y monedas que deja el turno anterior).';
    }
  }

  function randomTeamPassword(length) {
    const n = length || 16;
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

  function setClubTeamMsg(text, isError) {
    const el = $('club-team-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  async function refreshClubTeamTable(clubId) {
    const tbody = $('club-team-tbody');
    if (!tbody) return;
    const { data, error } = await sb()
      .from('club_access')
      .select('id, email, role, created_at, can_edit_inventory')
      .eq('club_id', clubId)
      .order('created_at', { ascending: false });
    if (error) {
      const cols = error.code === '42703' ? 2 : 3;
      tbody.innerHTML = `<tr><td colspan="${cols}">${escapeHtml(error.message)}</td></tr>`;
      return;
    }
    tbody.innerHTML = '';
    (data || []).forEach((row) => {
      const tr = document.createElement('tr');
      const invCell =
        row.role === 'admin_club'
          ? '<span class="hint">Siempre</span>'
          : `<label class="team-inv-edit"><input type="checkbox" data-team-inv-edit="${escapeHtml(row.id)}"${
              row.can_edit_inventory ? ' checked' : ''
            } /> Permitir</label>`;
      tr.innerHTML = `
        <td>${escapeHtml(row.email)}</td>
        <td>${escapeHtml(row.role)}</td>
        <td>${invCell}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function initClubTeamSection(ctx) {
    const sec = $('club-team-section');
    if (!sec || ctx.profile.role !== 'admin_club') return;
    sec.hidden = false;

    if (sec.dataset.bound === '1') {
      void refreshClubTeamTable(ctx.club.id);
      return;
    }
    sec.dataset.bound = '1';

    $('club-team-tbody')?.addEventListener('change', async (e) => {
      const cb = e.target.closest('[data-team-inv-edit]');
      if (!cb) return;
      const accessId = cb.getAttribute('data-team-inv-edit');
      if (!accessId) return;
      const checked = Boolean(cb.checked);
      setClubTeamMsg('Guardando permiso…', false);
      const { error } = await sb()
        .from('club_access')
        .update({ can_edit_inventory: checked })
        .eq('id', accessId);
      if (error) {
        cb.checked = !checked;
        const msg =
          error.code === '42703'
            ? 'Ejecuta en Supabase la migración 020_inventory_adjustments.sql para gestionar permisos de inventario.'
            : error.message || 'No se pudo guardar el permiso.';
        setClubTeamMsg(msg, true);
        return;
      }
      setClubTeamMsg(checked ? 'Permiso de edición de inventario concedido.' : 'Permiso de edición de inventario retirado.', false);
    });

    $('team-gen-pwd')?.addEventListener('click', () => {
      const el = $('team-worker-password');
      if (el) el.value = randomTeamPassword(16);
      setClubTeamMsg('', false);
    });

    $('team-create-worker')?.addEventListener('click', async () => {
      const emailRaw = ($('team-worker-email')?.value || '').trim().toLowerCase();
      let pwd = ($('team-worker-password')?.value || '').trim();
      if (!emailRaw || !emailRaw.includes('@')) {
        setClubTeamMsg('Introduce un email válido.', true);
        return;
      }
      if (pwd.length > 0 && pwd.length < 6) {
        setClubTeamMsg(
          'La contraseña debe tener al menos 6 caracteres (o déjala vacía para generar una).',
          true,
        );
        return;
      }
      if (!pwd) {
        pwd = randomTeamPassword(16);
        const pwEl = $('team-worker-password');
        if (pwEl) pwEl.value = pwd;
      }

      const adminId = ctx.profile.id;
      const clubId = ctx.club.id;

      try {
        setClubTeamMsg('Creando trabajador…', false);
        const { error } = await sb().auth.signUp({
          email: emailRaw,
          password: pwd,
          options: {
            data: {
              role: 'empleado',
              club_id: clubId,
            },
          },
        });
        if (error) throw error;

        const {
          data: { user: afterUser },
        } = await sb().auth.getUser();

        let copied = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(pwd);
            copied = true;
          }
        } catch (e) {
          /* ignore */
        }

        if (afterUser && afterUser.id !== adminId) {
          await sb().auth.signOut();
          alert(
            `Trabajador creado.\n\nEmail: ${emailRaw}\nContraseña: ${pwd}\n${
              copied ? '(Contraseña copiada al portapapeles.)\n\n' : ''
            }Tu sesión cambió al crear la cuenta. Vuelve a entrar como administrador del club.`,
          );
          window.location.href = 'index.html';
          return;
        }

        if ($('team-worker-email')) $('team-worker-email').value = '';
        if ($('team-worker-password')) $('team-worker-password').value = '';
        setClubTeamMsg(
          copied
            ? 'Trabajador creado. Contraseña copiada al portapapeles; comunícala con seguridad.'
            : 'Trabajador creado. Ya puede iniciar sesión con ese email y contraseña.',
          false,
        );
        await refreshClubTeamTable(clubId);
      } catch (e) {
        setClubTeamMsg(e.message || 'No se pudo crear el trabajador.', true);
      }
    });

    void refreshClubTeamTable(ctx.club.id);
  }

  const shiftWizard = {
    shiftId: null,
    ctx: null,
    logoutAfter: false,
    pendingLogout: false,
  };

  function formatMoneyEUR(n) {
    const x = Number(n);
    if (Number.isNaN(x)) return '—';
    return x.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
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

  function formatGramsDelta(d) {
    if (d === null || Number.isNaN(d)) return '—';
    return `${d > 0 ? '+' : ''}${d.toLocaleString('es-ES', { maximumFractionDigits: 3 })}`;
  }

  function openShiftWizardModal() {
    const el = $('shift-wizard-modal');
    if (!el) return;
    el.classList.remove('is-hidden');
    el.setAttribute('aria-hidden', 'false');
  }

  function closeShiftWizardModal() {
    const el = $('shift-wizard-modal');
    if (!el) return;
    el.classList.add('is-hidden');
    el.setAttribute('aria-hidden', 'true');
  }

  function openSummaryModal(html) {
    const modal = $('shift-summary-modal');
    const body = $('shift-summary-body');
    if (body) body.innerHTML = html;
    if (!modal) return;
    modal.classList.remove('is-hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeSummaryModal() {
    const modal = $('shift-summary-modal');
    if (!modal) return;
    modal.classList.add('is-hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  function denomFieldsHtml() {
    const rows = [
      ['50', '50 €'],
      ['20', '20 €'],
      ['10', '10 €'],
      ['5', '5 €'],
      ['2', '2 €'],
      ['1', '1 €'],
      ['0.5', '0,50 €'],
      ['0.2', '0,20 €'],
      ['0.1', '0,10 €'],
      ['0.05', '0,05 €'],
    ];
    return rows
      .map(
        ([key, lab]) => `
      <div class="form__row">
        <label for="wiz-d-${key.replace('.', '_')}">${lab} (cantidad)</label>
        <input class="input" id="wiz-d-${key.replace('.', '_')}" type="number" min="0" step="1" inputmode="numeric" placeholder="0" />
      </div>`,
      )
      .join('');
  }

  function collectDenomJson() {
    const keys = [
      ['50', 'wiz-d-50'],
      ['20', 'wiz-d-20'],
      ['10', 'wiz-d-10'],
      ['5', 'wiz-d-5'],
      ['2', 'wiz-d-2'],
      ['1', 'wiz-d-1'],
      ['0.5', 'wiz-d-0_5'],
      ['0.2', 'wiz-d-0_2'],
      ['0.1', 'wiz-d-0_1'],
      ['0.05', 'wiz-d-0_05'],
    ];
    const out = {};
    keys.forEach(([k, id]) => {
      const raw = $(id)?.value;
      const n = raw === '' || raw === undefined ? NaN : parseInt(String(raw), 10);
      if (!Number.isNaN(n) && n > 0) out[k] = n;
    });
    return Object.keys(out).length ? out : null;
  }

  function isDispenseWallet(d) {
    return String(d?.payment_method || 'cash').toLowerCase() === 'wallet';
  }

  function summarizeShiftDispenseSales(dispenses) {
    let cashSales = 0;
    let walletSales = 0;
    (dispenses || []).forEach((d) => {
      const p = Number(d.price_charged_eur) || 0;
      if (isDispenseWallet(d)) walletSales += p;
      else cashSales += p;
    });
    return {
      cashSales,
      walletSales,
      salesTotal: cashSales + walletSales,
    };
  }

  async function fetchShiftDispenses(shiftId) {
    let hasPaymentMethod = true;
    let { data, error } = await sb()
      .from('tpv_dispenses')
      .select('product_id, grams_dispensed, price_charged_eur, payment_method')
      .eq('shift_id', shiftId);
    if (
      error &&
      (error.code === '42703' ||
        String(error.message || '')
          .toLowerCase()
          .includes('payment_method'))
    ) {
      hasPaymentMethod = false;
      const retry = await sb()
        .from('tpv_dispenses')
        .select('product_id, grams_dispensed, price_charged_eur')
        .eq('shift_id', shiftId);
      data = retry.data;
      error = retry.error;
    }
    if (error) throw error;
    return { dispenses: data || [], hasPaymentMethod };
  }

  async function fetchShiftWalletCashNet(shiftId) {
    if (!shiftId) return 0;
    const { data, error } = await sb()
      .from('club_member_wallet_ledger')
      .select('cash_eur')
      .eq('shift_id', shiftId);
    if (
      error &&
      (error.code === '42703' ||
        String(error.message || '')
          .toLowerCase()
          .includes('cash_eur'))
    ) {
      return 0;
    }
    if (error) throw error;
    return (data || []).reduce((acc, r) => acc + (Number(r.cash_eur) || 0), 0);
  }

  async function fetchShiftCashExpected(shiftId) {
    const [shiftRes, dispRes, walletCashNet] = await Promise.all([
      sb().from('shifts').select('opening_float_eur').eq('id', shiftId).maybeSingle(),
      fetchShiftDispenses(shiftId),
      fetchShiftWalletCashNet(shiftId),
    ]);
    const opening =
      shiftRes.data && shiftRes.data.opening_float_eur != null
        ? Number(shiftRes.data.opening_float_eur)
        : 0;
    const { cashSales, walletSales } = summarizeShiftDispenseSales(dispRes.dispenses);
    return {
      opening,
      cashSales,
      walletSales,
      walletCashNet,
      expectedCash: opening + cashSales + walletCashNet,
      hasPaymentMethod: dispRes.hasPaymentMethod,
    };
  }

  async function buildShiftSummaryHtml(clubId, shiftId) {
    const [shiftRes, dispRes, walletCashNet, evRes, prodRes] = await Promise.all([
      sb().from('shifts').select('*').eq('id', shiftId).maybeSingle(),
      fetchShiftDispenses(shiftId),
      fetchShiftWalletCashNet(shiftId),
      sb()
        .from('shift_stock_events')
        .select('product_id, stock_net_grams, previous_stock_grams, delta_grams, source, created_at')
        .eq('shift_id', shiftId)
        .order('created_at', { ascending: true }),
      sb()
        .from('inventory_products')
        .select('id, name, emoji, stock_grams')
        .eq('club_id', clubId),
    ]);

    const shift = shiftRes.data;
    const dispenses = dispRes.dispenses || [];
    const events = evRes.data || [];
    const products = prodRes.data || [];
    const prodMap = Object.fromEntries(products.map((p) => [p.id, p]));
    const countByProduct = {};
    events.forEach((ev) => {
      countByProduct[ev.product_id] = ev;
    });

    const { cashSales, walletSales, salesTotal } = summarizeShiftDispenseSales(dispenses);
    const gramsByProduct = {};
    dispenses.forEach((d) => {
      const pid = d.product_id;
      const g = Number(d.grams_dispensed) || 0;
      gramsByProduct[pid] = (gramsByProduct[pid] || 0) + g;
    });

    const topList = Object.entries(gramsByProduct)
      .map(([pid, g]) => ({
        pid,
        g,
        name: prodMap[pid] ? prodMap[pid].name : '—',
        emoji: prodMap[pid] ? prodMap[pid].emoji || '' : '',
      }))
      .sort((a, b) => b.g - a.g)
      .slice(0, 12);

    const stockRows = events
      .map((ev) => {
        const pr = prodMap[ev.product_id] || {};
        const em = (pr.emoji || '').trim();
        const d = getShiftStockDelta(ev);
        const dTxt = formatGramsDelta(d);
        return `<tr>
          <td>${escapeHtml(em ? em + ' ' : '')}${escapeHtml(pr.name || '—')}</td>
          <td>${escapeHtml(ev.source === 'scale' ? 'Báscula' : 'Manual')}</td>
          <td>${escapeHtml(Number(ev.stock_net_grams).toLocaleString('es-ES', { maximumFractionDigits: 3 }))}</td>
          <td>${escapeHtml(dTxt)}</td>
        </tr>`;
      })
      .join('');

    const opening = shift && shift.opening_float_eur != null ? Number(shift.opening_float_eur) : 0;
    const walletCash = Number(walletCashNet) || 0;
    const expectedCash = opening + cashSales + walletCash;
    const closingCash =
      shift && shift.closing_cash_total_eur != null ? Number(shift.closing_cash_total_eur) : null;
    const floatFwd =
      shift && shift.closing_float_forward_eur != null
        ? Number(shift.closing_float_forward_eur)
        : null;
    const cashDiff =
      closingCash !== null && !Number.isNaN(closingCash) ? closingCash - expectedCash : null;
    const cashDiffClass =
      cashDiff === null
        ? ''
        : Math.abs(cashDiff) < 0.005
          ? 'shift-cash-diff--ok'
          : 'shift-cash-diff--warn';

    let denHtml = '';
    if (shift && shift.closing_denominations && typeof shift.closing_denominations === 'object') {
      denHtml = `<pre class="hint" style="white-space:pre-wrap;margin:0.5rem 0 0">${escapeHtml(JSON.stringify(shift.closing_denominations, null, 2))}</pre>`;
    }

    const stockSnapshot = products
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((p) => {
        const em = (p.emoji || '').trim();
        const countEv = countByProduct[p.id];
        const descTxt = formatGramsDelta(getShiftStockDelta(countEv));
        return `<tr>
        <td>${escapeHtml(em ? em + ' ' : '')}${escapeHtml(p.name)}</td>
        <td>${escapeHtml(Number(p.stock_grams).toLocaleString('es-ES', { maximumFractionDigits: 3 }))}</td>
        <td>${escapeHtml(descTxt)}</td>
      </tr>`;
      })
      .join('');

    const { data: staffDir } = await sb().rpc('club_staff_directory');
    const smap = {};
    (staffDir || []).forEach((row) => {
      const id = row.user_id ?? row.userId;
      if (id && row.email) smap[id] = row.email;
    });
    const labStaff = (uid) => (uid && smap[uid] ? smap[uid] : '—');
    const headPeople = shift
      ? `<p style="margin:0 0 0.75rem">Abierto por <strong>${escapeHtml(labStaff(shift.opened_by))}</strong> · Cerrado por <strong>${escapeHtml(labStaff(shift.closed_by))}</strong></p>`
      : '';

    return `
      ${headPeople}
      <div class="shift-summary-section">
        <h4 class="hint" style="margin:0 0 0.5rem;font-weight:700">Caja</h4>
        <p style="margin:0">Cambio al abrir: <strong>${escapeHtml(formatMoneyEUR(opening))}</strong></p>
        <p style="margin:0.35rem 0 0">Ventas en efectivo (TPV): <strong>${escapeHtml(formatMoneyEUR(cashSales))}</strong></p>
        ${
          walletSales > 0.005
            ? `<p style="margin:0.35rem 0 0">Ventas con monedero (no entran en caja): <strong>${escapeHtml(formatMoneyEUR(walletSales))}</strong></p>`
            : ''
        }
        ${
          Math.abs(walletCash) > 0.005
            ? `<p style="margin:0.35rem 0 0">Recargas / retiradas monedero en efectivo: <strong>${escapeHtml(walletCash >= 0 ? `+${formatMoneyEUR(walletCash)}` : formatMoneyEUR(walletCash))}</strong></p>`
            : ''
        }
        <p style="margin:0.35rem 0 0">Efectivo esperado en caja (cambio + ventas efectivo + monedero en efectivo): <strong>${escapeHtml(formatMoneyEUR(expectedCash))}</strong></p>
        <p style="margin:0.35rem 0 0">Efectivo contado al cerrar: <strong>${closingCash !== null ? escapeHtml(formatMoneyEUR(closingCash)) : '—'}</strong></p>
        ${
          cashDiff !== null
            ? `<p style="margin:0.35rem 0 0" class="shift-cash-diff ${cashDiffClass}">Diferencia (contado − esperado): <strong>${escapeHtml(cashDiff >= 0 ? `+${formatMoneyEUR(cashDiff)}` : formatMoneyEUR(cashDiff))}</strong></p>`
            : ''
        }
        <p style="margin:0.35rem 0 0">Total ventas TPV (efectivo + monedero): <strong>${escapeHtml(formatMoneyEUR(salesTotal))}</strong></p>
        <p style="margin:0.35rem 0 0">Cambio dejado para el siguiente turno: <strong>${floatFwd !== null ? escapeHtml(formatMoneyEUR(floatFwd)) : '—'}</strong></p>
        ${denHtml ? `<p class="hint" style="margin:0.5rem 0 0">Desglose anotado:</p>${denHtml}` : ''}
      </div>
      <div class="shift-summary-section">
        <h4 class="hint" style="margin:0 0 0.5rem;font-weight:700">Lo más dispensado (por gramos)</h4>
        ${
          topList.length
            ? `<ol style="margin:0;padding-left:1.2rem">${topList
                .map(
                  (x) =>
                    `<li>${escapeHtml(x.emoji ? x.emoji + ' ' : '')}${escapeHtml(x.name)} — ${escapeHtml(x.g.toLocaleString('es-ES', { maximumFractionDigits: 3 }))} g</li>`,
                )
                .join('')}</ol>`
            : '<p class="hint" style="margin:0">Sin dispensaciones en este turno.</p>'
        }
      </div>
      <div class="shift-summary-section">
        <h4 class="hint" style="margin:0 0 0.5rem;font-weight:700">Contajes de stock en el turno</h4>
        ${
          events.length
            ? `<div class="table-wrap"><table class="table-compact"><thead><tr><th>Producto</th><th>Origen</th><th>Stock anotado (g)</th><th>Δ (g)</th></tr></thead><tbody>${stockRows}</tbody></table></div>`
            : '<p class="hint" style="margin:0">Sin registros de stock en este turno.</p>'
        }
      </div>
      <div class="shift-summary-section">
        <h4 class="hint" style="margin:0 0 0.5rem;font-weight:700">Stock actual tras cerrar (inventario)</h4>
        <div class="table-wrap"><table class="table-compact"><thead><tr><th>Producto</th><th>Stock (g)</th><th>Descuadre (g)</th></tr></thead><tbody>${stockSnapshot}</tbody></table></div>
      </div>
    `;
  }

  window.scClubGetShiftSummaryHtml = async function (clubId, shiftId) {
    return buildShiftSummaryHtml(clubId, shiftId);
  };
  window.scClubShowShiftSummaryModal = function (html) {
    openSummaryModal(html);
  };
  window.scClubCloseShiftSummaryModal = closeSummaryModal;

  function renderWizardStockQuestion() {
    $('shift-wizard-title').textContent = 'Antes de cerrar';
    $('shift-wizard-body').innerHTML =
      '<p>¿Has completado el contaje de stock de este turno (contaje manual)?</p>';
    $('shift-wizard-actions').innerHTML = `
      <button type="button" class="btn" id="wiz-stock-yes">Sí</button>
      <button type="button" class="btn btn--ghost" id="wiz-stock-no">No</button>
      <button type="button" class="btn btn--ghost" id="wiz-cancel">Cancelar</button>
    `;
    $('wiz-stock-yes')?.addEventListener('click', () => renderWizardDoubleConfirm(true));
    $('wiz-stock-no')?.addEventListener('click', () => renderWizardDoubleConfirm(false));
    $('wiz-cancel')?.addEventListener('click', () => closeShiftWizardModal());
  }

  function renderWizardDoubleConfirm(hadStockYes) {
    $('shift-wizard-title').textContent = 'Confirmar cierre';
    const msg = hadStockYes
      ? '<p>¿Seguro que quieres <strong>cerrar este turno</strong>? No podrás registrar ventas ni stock hasta abrir otro.</p><p class="hint" style="margin-top:0.75rem">Si compartes el dispositivo, el siguiente empleado puede iniciar sesión con su cuenta.</p>'
      : '<p>Has indicado que el stock podría no estar contado. ¿Cerrar el turno de todas formas?</p>';
    $('shift-wizard-body').innerHTML = `
      ${msg}
      <label class="tpv-link-toggle" style="display:block;margin-top:1rem">
        <input type="checkbox" id="wiz-logout-after" />
        Cerrar sesión al terminar (volver al login)
      </label>
    `;
    $('shift-wizard-actions').innerHTML = `
      <button type="button" class="btn" id="wiz-go-arqueo">Continuar</button>
      <button type="button" class="btn btn--ghost" id="wiz-back">Volver</button>
    `;
    $('wiz-back')?.addEventListener('click', () => renderWizardStockQuestion());
    $('wiz-go-arqueo')?.addEventListener('click', () => {
      shiftWizard.logoutAfter = $('wiz-logout-after')?.checked === true;
      renderWizardArqueo();
    });
  }

  function updateWizardArqueoDiff(expectedCash) {
    const diffEl = $('wiz-cash-diff');
    const counted = parseDecimalLoose($('wiz-close-cash')?.value);
    if (!diffEl) return;
    if (Number.isNaN(counted)) {
      diffEl.textContent = '';
      diffEl.className = 'hint shift-arqueo-diff';
      return;
    }
    const diff = counted - expectedCash;
    const ok = Math.abs(diff) < 0.005;
    diffEl.className = ok
      ? 'hint shift-arqueo-diff shift-arqueo-diff--ok'
      : 'hint shift-arqueo-diff shift-arqueo-diff--warn';
    diffEl.textContent = ok
      ? 'Cuadra con el efectivo esperado según el TPV.'
      : `Diferencia: ${diff >= 0 ? '+' : ''}${formatMoneyEUR(diff)} (contado − esperado).`;
  }

  function renderWizardArqueo() {
    $('shift-wizard-title').textContent = 'Arqueo y cambio';
    $('shift-wizard-body').innerHTML = `
      <p class="hint" style="margin-top:0">Indica el efectivo contado y el cambio que dejas para el siguiente turno. Las ventas con <strong>monedero</strong> no suman al efectivo esperado. Opcionalmente desglosa billetes y monedas.</p>
      <p id="wiz-cash-expected" class="hint shift-arqueo-hint">Calculando efectivo esperado…</p>
      <div class="form__row">
        <label for="wiz-close-cash">Total efectivo contado en caja (€)</label>
        <input class="input" id="wiz-close-cash" inputmode="decimal" placeholder="Ej. 240,50" autocomplete="off" />
      </div>
      <p id="wiz-cash-diff" class="hint shift-arqueo-diff" role="status"></p>
      <div class="form__row">
        <label for="wiz-close-float">Cambio para el siguiente turno (€)</label>
        <input class="input" id="wiz-close-float" inputmode="decimal" placeholder="Ej. 80" autocomplete="off" />
      </div>
      <p class="hint" style="margin-top:0.5rem">Desglose (opcional — cantidad de cada tipo)</p>
      <div class="grid grid--2" style="margin-top:0.5rem">
        ${denomFieldsHtml()}
      </div>
    `;
    $('shift-wizard-actions').innerHTML = `
      <button type="button" class="btn" id="wiz-final-close">Cerrar turno</button>
      <button type="button" class="btn btn--ghost" id="wiz-arqueo-back">Volver</button>
    `;
    $('wiz-arqueo-back')?.addEventListener('click', () => renderWizardStockQuestion());
    $('wiz-final-close')?.addEventListener('click', () => void finalizeShiftClose());

    const shiftId = shiftWizard.shiftId;
    void (async () => {
      let expectedCash = 0;
      let cashSales = 0;
      let opening = 0;
      let walletSales = 0;
      let walletCashNet = 0;
      try {
        if (shiftId) {
          const info = await fetchShiftCashExpected(shiftId);
          opening = info.opening;
          cashSales = info.cashSales;
          expectedCash = info.expectedCash;
          walletSales = info.walletSales || 0;
          walletCashNet = info.walletCashNet || 0;
        }
      } catch (e) {
        const hintEl = $('wiz-cash-expected');
        if (hintEl) {
          hintEl.textContent = 'No se pudo calcular el efectivo esperado.';
          hintEl.classList.add('shift-arqueo-hint--warn');
        }
        return;
      }
      const hintEl = $('wiz-cash-expected');
      if (hintEl) {
        const walletLine =
          walletSales > 0.005
            ? ` Ventas con monedero: ${formatMoneyEUR(walletSales)} (no en caja).`
            : '';
        const walletCashLine =
          Math.abs(walletCashNet) > 0.005
            ? ` Recargas/retiradas en efectivo: ${walletCashNet >= 0 ? '+' : ''}${formatMoneyEUR(walletCashNet)}.`
            : '';
        hintEl.textContent = `Efectivo esperado: ${formatMoneyEUR(expectedCash)} (cambio ${formatMoneyEUR(opening)} + ventas efectivo ${formatMoneyEUR(cashSales)}${walletCashLine}).${walletLine}`;
      }
      const onCashInput = () => updateWizardArqueoDiff(expectedCash);
      $('wiz-close-cash')?.addEventListener('input', onCashInput);
      $('wiz-close-cash')?.addEventListener('change', onCashInput);
    })();
  }

  async function finalizeShiftClose() {
    const id = shiftWizard.shiftId;
    const ctx = shiftWizard.ctx;
    if (!id || !ctx) return;
    const note = ($('note-close')?.value || '').trim();
    const cash = parseDecimalLoose($('wiz-close-cash')?.value);
    const fl = parseDecimalLoose($('wiz-close-float')?.value);
    const denoms = collectDenomJson();

    try {
      setStatus('Cerrando turno…', false);
      const {
        data: { user },
      } = await sb().auth.getUser();
      if (!user) throw new Error('Sesión no válida.');

      const patch = {
        closed_at: new Date().toISOString(),
        closed_by: user.id,
        note_close: note,
      };
      if (!Number.isNaN(cash)) patch.closing_cash_total_eur = cash;
      if (!Number.isNaN(fl)) patch.closing_float_forward_eur = fl;
      if (denoms) patch.closing_denominations = denoms;

      const { error } = await sb().from('shifts').update(patch).eq('id', id).is('closed_at', null);

      if (error) throw error;
      $('note-close').value = '';
      closeShiftWizardModal();

      let summaryInner = '';
      try {
        summaryInner = await buildShiftSummaryHtml(ctx.club.id, id);
      } catch (e) {
        summaryInner = `<p class="msg msg--error">${escapeHtml(e.message || 'No se pudo cargar el resumen.')}</p>`;
      }
      shiftWizard.pendingLogout = shiftWizard.logoutAfter === true;
      shiftWizard.logoutAfter = false;
      openSummaryModal(summaryInner);
      await refreshShiftsUI(ctx);
      setStatus('Turno cerrado.', false);
    } catch (e) {
      setStatus(e.message || 'No se pudo cerrar el turno.', true);
    }
  }

  function startCloseShiftFlow(shiftId, ctx) {
    shiftWizard.shiftId = shiftId;
    shiftWizard.ctx = ctx;
    shiftWizard.logoutAfter = false;
    renderWizardStockQuestion();
    openShiftWizardModal();
  }

  function initClubDarkMode() {
    const cb = document.getElementById('club-dark-toggle');
    if (!cb) return;
    const key = 'sc-club-dark';
    try {
      cb.checked = localStorage.getItem(key) === '1';
      document.body.classList.toggle('club-dark', cb.checked);
    } catch (e) {
      /* ignore */
    }
    cb.addEventListener('change', () => {
      const on = cb.checked;
      try {
        localStorage.setItem(key, on ? '1' : '0');
      } catch (e) {
        /* ignore */
      }
      document.body.classList.toggle('club-dark', on);
    });
  }

  function refreshClubView(viewName) {
    if (viewName === 'stock') {
      if (typeof window.scClubRefreshStockUi === 'function') {
        void window.scClubRefreshStockUi();
      }
      return;
    }
    if (viewName === 'inventory') {
      if (typeof window.scClubRefreshInventoryUi === 'function') {
        void window.scClubRefreshInventoryUi();
      }
      return;
    }
    if (viewName === 'tpv') {
      if (typeof window.scClubReloadInventoryProducts === 'function') {
        void window.scClubReloadInventoryProducts();
      }
      if (typeof window.scClubRefreshTpvUi === 'function') {
        void window.scClubRefreshTpvUi();
      }
      return;
    }
    if (viewName === 'finance' && typeof window.scClubRefreshFinance === 'function') {
      void window.scClubRefreshFinance();
    }
  }

  function initNav() {
    const tabs = document.querySelectorAll('.club-tab');
    const views = document.querySelectorAll('.club-view');
    function show(viewName) {
      views.forEach((v) => {
        const match = v.dataset.view === viewName;
        v.classList.toggle('is-hidden', !match);
        if (match) {
          v.removeAttribute('hidden');
        } else {
          v.setAttribute('hidden', '');
        }
      });
      tabs.forEach((t) => {
        const active = t.dataset.view === viewName;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      refreshClubView(viewName);
    }
    tabs.forEach((t) => {
      t.addEventListener('click', () => show(t.dataset.view));
    });
    show('home');
  }

  async function init() {
    let ctx;
    try {
      ctx = await ensureClubGate();
    } catch (e) {
      setStatus(e.message || 'Error de acceso.', true);
      return;
    }
    if (!ctx) return;

    if (typeof window.SCClubLoadPartials === 'function') {
      try {
        await window.SCClubLoadPartials();
      } catch (e) {
        setStatus(
          'No se pudieron cargar las plantillas (partials/). Usa un servidor HTTP en la carpeta del proyecto, p. ej. python -m http.server 5500.',
          true,
        );
        console.error(e);
        return;
      }
    }

    document.dispatchEvent(new CustomEvent('sc-club-shell-ready'));

    initNav();
    initClubDarkMode();

    try {
      await refreshShiftsUI(ctx);
    } catch (e) {
      if (
        e.message &&
        (e.message.includes('shifts') ||
          e.code === '42P01' ||
          e.message.includes('does not exist'))
      ) {
        setStatus(
          'Ejecuta en Supabase el SQL 003_shifts_turnos.sql para activar turnos.',
          true,
        );
      } else {
        setStatus(e.message || 'Error cargando turnos.', true);
      }
    }

    if (ctx.profile.role === 'admin_club') {
      initClubTeamSection(ctx);
    }

    if (typeof window.scInitClubInventoryTpv === 'function') {
      try {
        await window.scInitClubInventoryTpv(ctx);
      } catch (e) {
        console.error(e);
      }
    }

    if (typeof window.scInitClubStock === 'function') {
      try {
        await window.scInitClubStock(ctx);
      } catch (e) {
        console.error(e);
      }
    }

    if (typeof window.scInitClubSociosFinance === 'function') {
      try {
        await window.scInitClubSociosFinance(ctx);
      } catch (e) {
        console.error(e);
      }
    }

    $('logout-btn')?.addEventListener('click', async () => {
      await sb().auth.signOut();
      window.location.href = 'index.html';
    });

    $('btn-open-shift')?.addEventListener('click', async () => {
      const note = ($('note-open')?.value || '').trim();
      const floatRaw = ($('opening-float-eur')?.value || '').trim();
      let opening_float_eur = 0;
      if (floatRaw) {
        const p = parseDecimalLoose(floatRaw);
        if (!Number.isNaN(p) && p >= 0) opening_float_eur = p;
      }
      try {
        setStatus('Abriendo turno…', false);
        const {
          data: { user },
        } = await sb().auth.getUser();
        if (!user) throw new Error('Sesión no válida.');

        const row = {
          club_id: ctx.club.id,
          opened_by: user.id,
          note_open: note,
          opening_float_eur,
        };

        const { error } = await sb().from('shifts').insert([row]);
        if (error) throw error;
        $('note-open').value = '';
        if ($('opening-float-eur')) $('opening-float-eur').value = '';
        await refreshShiftsUI(ctx);
        setStatus('Turno abierto.', false);
      } catch (e) {
        setStatus(e.message || 'No se pudo abrir el turno.', true);
      }
    });

    $('btn-close-shift')?.addEventListener('click', async () => {
      const id = $('btn-close-shift').dataset.shiftId;
      if (!id) return;
      startCloseShiftFlow(id, ctx);
    });

    $('shift-summary-ok')?.addEventListener('click', async () => {
      closeSummaryModal();
      if (shiftWizard.pendingLogout) {
        shiftWizard.pendingLogout = false;
        await sb().auth.signOut();
        window.location.href = 'index.html';
      }
    });

    document.querySelector('#shift-summary-modal .shift-modal__backdrop')?.addEventListener('click', () => closeSummaryModal());
    document.querySelector('#shift-wizard-modal .shift-modal__backdrop')?.addEventListener('click', () => closeShiftWizardModal());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
