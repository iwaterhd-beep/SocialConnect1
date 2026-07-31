/**
 * Panel de club: datos del club y turnos (abrir / cerrar).
 */
(function () {
  const sb = () => window.scSupabase;
  let ctxRef = null;

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

    const clubId = gate.profile.club_id;
    let { data: club, error } = await sb()
      .from('clubs')
      .select(
        'id, name, cif, email, address, member_min_age, currency_symbol, is_active, pay_cash_enabled, pay_card_enabled, pay_wallet_enabled, member_dues_amount_eur, member_dues_wallet_eur',
      )
      .eq('id', clubId)
      .maybeSingle();

    if (
      error &&
      (error.code === '42703' ||
        /currency_symbol|member_min_age|pay_(cash|card|wallet)_enabled|member_dues_/i.test(error.message || ''))
    ) {
      const msg = String(error.message || '');
      const missingDues = /member_dues_/i.test(msg);
      const missingPay = /pay_(cash|card|wallet)_enabled/i.test(msg);
      const missingCurrency = /currency_symbol/i.test(msg);
      const missingAge =
        /member_min_age/i.test(msg) ||
        (!missingCurrency && !missingPay && !missingDues && error.code === '42703');
      let cols = 'id, name, cif, email, address, is_active';
      if (!missingAge && !missingCurrency && !missingPay) {
        cols =
          'id, name, cif, email, address, member_min_age, currency_symbol, is_active, pay_cash_enabled, pay_card_enabled, pay_wallet_enabled';
      } else if (!missingAge && !missingCurrency) {
        cols = 'id, name, cif, email, address, member_min_age, currency_symbol, is_active';
      } else if (!missingAge) {
        cols = 'id, name, cif, email, address, member_min_age, is_active';
      } else if (!missingCurrency) {
        cols = 'id, name, cif, email, address, currency_symbol, is_active';
      }
      ({ data: club, error } = await sb().from('clubs').select(cols).eq('id', clubId).maybeSingle());
      if (club) {
        if (club.member_min_age == null || Number.isNaN(Number(club.member_min_age))) {
          club.member_min_age = 18;
        }
        if (!club.currency_symbol) club.currency_symbol = '€';
        if (club.pay_cash_enabled == null) club.pay_cash_enabled = true;
        if (club.pay_card_enabled == null) club.pay_card_enabled = true;
        if (club.pay_wallet_enabled == null) club.pay_wallet_enabled = true;
        if (club.member_dues_amount_eur == null) club.member_dues_amount_eur = 0;
        if (club.member_dues_wallet_eur == null) club.member_dues_wallet_eur = 0;
      }
    }

    if (error) throw error;
    if (!club) {
      if (gate.asSuperadmin) {
        window.SCAuth.clearSuperadminClubContext();
        setStatus('No se encontró el club.', true);
        setTimeout(() => {
          window.location.href = 'dashboard-superadmin.html';
        }, 1500);
        return null;
      }
      setStatus('Este club no existe. Consulta con el superadmin.', true);
      await sb().auth.signOut();
      setTimeout(() => {
        window.location.href = 'index.html';
      }, 2500);
      return null;
    }

    if (!club.is_active) {
      if (gate.asSuperadmin) {
        setStatus('Este club está desactivado. Puedes revisarlo, pero conviene reactivarlo.', true);
      } else {
        setStatus('Este club está desactivado. Consulta con el superadmin.', true);
        await sb().auth.signOut();
        setTimeout(() => {
          window.location.href = 'index.html';
        }, 2500);
        return null;
      }
    }

    if (club.member_min_age == null || Number.isNaN(Number(club.member_min_age))) {
      club.member_min_age = 18;
    }
    if (!club.currency_symbol) club.currency_symbol = '€';
    if (typeof window.scSetCurrencySymbol === 'function') {
      window.scSetCurrencySymbol(club.currency_symbol);
    }

    $('club-name-display').textContent = club.name;
    const topClub = $('club-topnav-club');
    if (topClub) topClub.textContent = club.name;
    $('club-user-email').textContent = gate.profile.email || '';

    const roleEl = $('club-role-display');
    if (gate.asSuperadmin) {
      if (roleEl) roleEl.textContent = 'superadmin';
      const banner = $('superadmin-club-banner');
      const bannerName = $('superadmin-club-banner-name');
      if (banner) banner.hidden = false;
      if (bannerName) bannerName.textContent = club.name;
      document.body.classList.add('is-superadmin-club-view');
    } else if (roleEl) {
      roleEl.textContent = gate.profile.role;
    }

    return { ...gate, club };
  }

  const homeShiftsFilter = { range: '7d', from: '', to: '' };
  let homeShiftsFilterBound = false;
  let homeShiftsCtxRef = null;

  function startOfLocalDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function endOfLocalDay(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }

  function parseHomeShiftDateInput(str, endOfDay) {
    if (!str) return null;
    const parts = String(str).split('-');
    if (parts.length !== 3) return null;
    const y = Number(parts[0]);
    const m = Number(parts[1]) - 1;
    const day = Number(parts[2]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) return null;
    const d = new Date(y, m, day);
    return endOfDay ? endOfLocalDay(d) : startOfLocalDay(d);
  }

  function getHomeShiftsDateBounds(range, fromStr, toStr) {
    const now = new Date();
    if (range === 'today') {
      return { from: startOfLocalDay(now), to: null };
    }
    if (range === '7d') {
      const from = startOfLocalDay(now);
      from.setDate(from.getDate() - 6);
      return { from, to: null };
    }
    if (range === '30d') {
      const from = startOfLocalDay(now);
      from.setDate(from.getDate() - 29);
      return { from, to: null };
    }
    if (range === 'custom') {
      return {
        from: parseHomeShiftDateInput(fromStr, false),
        to: parseHomeShiftDateInput(toStr, true),
      };
    }
    return { from: null, to: null };
  }

  function homeShiftsRangeLabel(range, fromStr, toStr) {
    if (range === 'today') return 'hoy';
    if (range === '7d') return 'los últimos 7 días';
    if (range === '30d') return 'los últimos 30 días';
    if (range === 'all') return 'todo el historial';
    if (fromStr && toStr) return `del ${fromStr} al ${toStr}`;
    if (fromStr) return `desde ${fromStr}`;
    if (toStr) return `hasta ${toStr}`;
    return 'el rango elegido';
  }

  async function fetchRecentShifts(clubId) {
    const bounds = getHomeShiftsDateBounds(
      homeShiftsFilter.range,
      homeShiftsFilter.from,
      homeShiftsFilter.to,
    );

    let query = sb()
      .from('shifts')
      .select('*')
      .eq('club_id', clubId)
      .order('opened_at', { ascending: false })
      .limit(homeShiftsFilter.range === 'all' ? 100 : 50);

    if (bounds.from) query = query.gte('opened_at', bounds.from.toISOString());
    if (bounds.to) query = query.lte('opened_at', bounds.to.toISOString());

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  function bindHomeShiftsFilter(ctx) {
    homeShiftsCtxRef = ctx;
    if (homeShiftsFilterBound) return;
    homeShiftsFilterBound = true;

    const customWrap = $('home-shifts-custom');
    document.querySelectorAll('[data-home-shifts-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const range = btn.getAttribute('data-home-shifts-range');
        if (!range) return;
        homeShiftsFilter.range = range;
        document.querySelectorAll('[data-home-shifts-range]').forEach((b) => {
          b.classList.toggle('is-active', b === btn);
        });
        if (customWrap) {
          const show = range === 'custom';
          customWrap.classList.toggle('is-hidden', !show);
          customWrap.hidden = !show;
        }
        if (range !== 'custom' && homeShiftsCtxRef) {
          void refreshShiftsUI(homeShiftsCtxRef);
        }
      });
    });

    $('home-shifts-apply')?.addEventListener('click', () => {
      homeShiftsFilter.from = ($('home-shifts-from')?.value || '').trim();
      homeShiftsFilter.to = ($('home-shifts-to')?.value || '').trim();
      if (homeShiftsCtxRef) void refreshShiftsUI(homeShiftsCtxRef);
    });
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

  async function loadStaffEmailMap(clubId, extraUserIds) {
    if (typeof window.SCAuth?.loadClubStaffEmailMap === 'function') {
      return window.SCAuth.loadClubStaffEmailMap(clubId, extraUserIds);
    }
    return {};
  }

  function staffEmailLabel(map, userId) {
    if (!userId) return '—';
    return map[userId] || '—';
  }

  function updateShellShiftIndicators(open) {
    const pill = $('app-shift-pill');
    if (pill) {
      pill.hidden = false;
      pill.classList.toggle('app-shift-pill--open', !!open);
      pill.classList.toggle('app-shift-pill--closed', !open);
      pill.textContent = open ? 'Turno abierto' : 'Sin turno';
    }
    const homeShift = $('home-kpi-shift');
    if (homeShift) {
      homeShift.textContent = open ? 'Abierto' : 'Cerrado';
      homeShift.classList.toggle('is-open', !!open);
      homeShift.classList.remove('is-alert');
    }
  }

  async function refreshShiftsUI(ctx) {
    bindHomeShiftsFilter(ctx);
    const open = await getOpenShift(ctx.club.id);
    let recent = await fetchRecentShifts(ctx.club.id);
    // Mantener el turno abierto visible aunque quede fuera del filtro de fechas
    if (open && !recent.some((r) => r.id === open.id)) {
      recent = [open, ...recent];
    }
    let staffMap = {};
    try {
      const ids = [];
      if (open) ids.push(open.opened_by);
      (recent || []).forEach((row) => {
        ids.push(row.opened_by, row.closed_by);
      });
      staffMap = await loadStaffEmailMap(ctx.club.id, ids);
    } catch (e) {
      /* ignore */
    }

    const bar = $('shift-state');
    const btnOpen = $('btn-open-shift');
    const btnClose = $('btn-close-shift');
    if (open) {
      const whoOpen = staffEmailLabel(staffMap, open.opened_by);
      if (bar) {
        bar.textContent = `Turno abierto desde ${formatTs(open.opened_at)} · Abierto por ${whoOpen}`;
        bar.classList.remove('hint');
        bar.classList.add('shift-state--open');
      }
      if (btnOpen) btnOpen.disabled = true;
      if (btnClose) {
        btnClose.disabled = false;
        btnClose.dataset.shiftId = open.id;
      }
    } else {
      if (bar) {
        bar.textContent = 'No hay turno abierto.';
        bar.classList.add('hint');
        bar.classList.remove('shift-state--open');
      }
      if (btnOpen) btnOpen.disabled = false;
      if (btnClose) {
        btnClose.disabled = true;
        delete btnClose.dataset.shiftId;
      }
    }

    updateShellShiftIndicators(!!open);

    const tbody = $('shifts-tbody');
    const emptyEl = $('home-shifts-empty');
    if (tbody) {
      tbody.innerHTML = '';
      if (!recent.length) {
        if (emptyEl) {
          emptyEl.hidden = false;
          emptyEl.textContent = `No hay turnos en ${homeShiftsRangeLabel(
            homeShiftsFilter.range,
            homeShiftsFilter.from,
            homeShiftsFilter.to,
          )}.`;
        }
      } else {
        if (emptyEl) emptyEl.hidden = true;
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
      hint.textContent = `Último cierre dejó ${formatMoneyEUR(v)} de cambio para el siguiente turno. Puedes usar ese importe como referencia.`;
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

  function setClubLegalMsg(text, isError) {
    const el = $('club-legal-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  function setClubCurrencyMsg(text, isError) {
    const el = $('club-currency-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  function fillClubLegalForm(club) {
    if ($('club-legal-name')) $('club-legal-name').value = club?.name || '';
    if ($('club-legal-cif')) $('club-legal-cif').value = club?.cif || '';
    if ($('club-legal-email')) $('club-legal-email').value = club?.email || '';
    if ($('club-legal-address')) $('club-legal-address').value = club?.address || '';
    if ($('club-legal-min-age')) {
      const age = club?.member_min_age != null ? Number(club.member_min_age) : 18;
      $('club-legal-min-age').value = Number.isFinite(age) && age >= 1 ? String(Math.trunc(age)) : '18';
    }
  }

  function updateClubCurrencyPreview(raw) {
    const prev = $('club-currency-preview');
    if (!prev) return;
    const sym = String(raw == null ? '' : raw).trim() || '€';
    prev.textContent = `1,00\u00a0${sym.slice(0, 8)}`;
  }

  function fillClubCurrencyForm(club) {
    const sym = club?.currency_symbol || (typeof window.scGetCurrencySymbol === 'function' ? window.scGetCurrencySymbol() : '€');
    if ($('club-currency-symbol')) $('club-currency-symbol').value = sym;
    updateClubCurrencyPreview(sym);
    document.querySelectorAll('[data-currency-preset]').forEach((btn) => {
      const active = btn.getAttribute('data-currency-preset') === sym;
      btn.classList.toggle('is-active', active);
    });
  }

  function setClubPayMethodsMsg(text, isError) {
    const el = $('club-pay-methods-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  function fillClubPayMethodsForm(club) {
    if ($('club-pay-cash')) $('club-pay-cash').checked = club?.pay_cash_enabled !== false;
    if ($('club-pay-card')) $('club-pay-card').checked = club?.pay_card_enabled !== false;
    if ($('club-pay-wallet')) $('club-pay-wallet').checked = club?.pay_wallet_enabled !== false;
  }

  function initClubPayMethodsSection(ctx) {
    const sec = $('club-pay-methods-section');
    if (!sec || ctx.profile.role !== 'admin_club') return;
    sec.hidden = false;
    fillClubPayMethodsForm(ctx.club);

    if (sec.dataset.bound === '1') return;
    sec.dataset.bound = '1';

    $('club-pay-methods-save')?.addEventListener('click', async () => {
      const pay_cash_enabled = Boolean($('club-pay-cash')?.checked);
      const pay_card_enabled = Boolean($('club-pay-card')?.checked);
      const pay_wallet_enabled = Boolean($('club-pay-wallet')?.checked);
      if (!pay_cash_enabled && !pay_card_enabled && !pay_wallet_enabled) {
        setClubPayMethodsMsg('Activa al menos un método de cobro.', true);
        return;
      }

      setClubPayMethodsMsg('Guardando…', false);
      const { data, error } = await sb()
        .from('clubs')
        .update({ pay_cash_enabled, pay_card_enabled, pay_wallet_enabled })
        .eq('id', ctx.club.id)
        .select('id, pay_cash_enabled, pay_card_enabled, pay_wallet_enabled')
        .single();

      if (error) {
        const msg =
          error.code === '42501' || /policy/i.test(error.message || '')
            ? 'Sin permiso para actualizar el club. Revisa las políticas RLS (migración 042).'
            : error.code === '42703' || /pay_(cash|card|wallet)_enabled/i.test(error.message || '')
              ? 'Ejecuta en Supabase la migración 058_tpv_card_payment_methods.sql.'
              : error.message || 'No se pudieron guardar los métodos.';
        setClubPayMethodsMsg(msg, true);
        return;
      }

      Object.assign(ctx.club, {
        pay_cash_enabled: data?.pay_cash_enabled !== false,
        pay_card_enabled: data?.pay_card_enabled !== false,
        pay_wallet_enabled: data?.pay_wallet_enabled !== false,
      });
      fillClubPayMethodsForm(ctx.club);
      if (typeof window.scClubApplyTpvPayMethods === 'function') {
        window.scClubApplyTpvPayMethods();
      }
      setClubPayMethodsMsg('Métodos de cobro guardados.', false);
    });
  }

  function setClubDuesMsg(text, isError) {
    const el = $('club-dues-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  function currencySymFromClub(club) {
    return (
      club?.currency_symbol ||
      (typeof window.scGetCurrencySymbol === 'function' ? window.scGetCurrencySymbol() : '€')
    );
  }

  function updateClubDuesPreview() {
    const sym = currencySymFromClub(ctxRef?.club);
    const total = Number(($('club-dues-amount')?.value || '').replace(',', '.'));
    const splitOn = $('club-dues-mode-split')?.checked === true;
    const splitFields = $('club-dues-split-fields');
    if (splitFields) {
      splitFields.hidden = !splitOn;
      splitFields.classList.toggle('is-hidden', !splitOn);
    }
    const preview = $('club-dues-club-preview');
    if (!preview) return;
    if (!splitOn || !Number.isFinite(total) || total < 0) {
      preview.textContent = `Para el club: —`;
      return;
    }
    let wallet = Number(($('club-dues-wallet')?.value || '').replace(',', '.'));
    if (!Number.isFinite(wallet) || wallet < 0) wallet = 0;
    if (wallet > total) wallet = total;
    const clubPart = Math.round((total - wallet) * 100) / 100;
    preview.textContent = `Para el club: ${clubPart.toLocaleString('es-ES', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}\u00a0${sym}`;
  }

  function fillClubDuesForm(club) {
    const amount = club?.member_dues_amount_eur != null ? Number(club.member_dues_amount_eur) : 0;
    const wallet = club?.member_dues_wallet_eur != null ? Number(club.member_dues_wallet_eur) : 0;
    if ($('club-dues-amount')) {
      $('club-dues-amount').value = Number.isFinite(amount) ? String(amount) : '0';
    }
    const isSplit = Number.isFinite(amount) && amount > 0 && Number.isFinite(wallet) && wallet < amount - 0.0005;
    if ($('club-dues-mode-wallet')) $('club-dues-mode-wallet').checked = !isSplit;
    if ($('club-dues-mode-split')) $('club-dues-mode-split').checked = isSplit;
    if ($('club-dues-wallet')) {
      $('club-dues-wallet').value = Number.isFinite(wallet) ? String(wallet) : '0';
    }
    const sym = currencySymFromClub(club);
    const amountLabel = $('club-dues-amount-label');
    if (amountLabel) amountLabel.textContent = `Importe de la cuota (${sym})`;
    const walletLabel = $('club-dues-wallet-label');
    if (walletLabel) walletLabel.textContent = `Al monedero (${sym})`;
    updateClubDuesPreview();
  }

  function initClubDuesSection(ctx) {
    const sec = $('club-dues-section');
    if (!sec || ctx.profile.role !== 'admin_club') return;
    sec.hidden = false;
    fillClubDuesForm(ctx.club);

    if (sec.dataset.bound === '1') return;
    sec.dataset.bound = '1';

    $('club-dues-amount')?.addEventListener('input', updateClubDuesPreview);
    $('club-dues-wallet')?.addEventListener('input', updateClubDuesPreview);
    sec.querySelectorAll('input[name="club-dues-mode"]').forEach((el) => {
      el.addEventListener('change', updateClubDuesPreview);
    });

    $('club-dues-save')?.addEventListener('click', async () => {
      const amountRaw = ($('club-dues-amount')?.value || '').trim().replace(',', '.');
      const amount = amountRaw === '' ? 0 : Number(amountRaw);
      if (!Number.isFinite(amount) || amount < 0) {
        setClubDuesMsg('Indica un importe de cuota válido (≥ 0).', true);
        return;
      }
      const splitOn = $('club-dues-mode-split')?.checked === true;
      let wallet = amount;
      if (splitOn) {
        const walletRaw = ($('club-dues-wallet')?.value || '').trim().replace(',', '.');
        wallet = walletRaw === '' ? 0 : Number(walletRaw);
        if (!Number.isFinite(wallet) || wallet < 0) {
          setClubDuesMsg('Indica cuánto va al monedero (≥ 0).', true);
          return;
        }
        if (wallet > amount) {
          setClubDuesMsg('El monedero no puede ser mayor que la cuota.', true);
          return;
        }
      }

      setClubDuesMsg('Guardando…', false);
      const { data, error } = await sb()
        .from('clubs')
        .update({
          member_dues_amount_eur: Math.round(amount * 100) / 100,
          member_dues_wallet_eur: Math.round(wallet * 100) / 100,
        })
        .eq('id', ctx.club.id)
        .select('id, member_dues_amount_eur, member_dues_wallet_eur')
        .single();

      if (error) {
        const msg =
          error.code === '42501' || /policy/i.test(error.message || '')
            ? 'Sin permiso para actualizar el club. Revisa las políticas RLS (migración 042).'
            : error.code === '42703' || /member_dues_/i.test(error.message || '')
              ? 'Ejecuta en Supabase la migración 059_club_member_dues.sql.'
              : error.message || 'No se pudo guardar la cuota.';
        setClubDuesMsg(msg, true);
        return;
      }

      Object.assign(ctx.club, {
        member_dues_amount_eur: data?.member_dues_amount_eur != null ? Number(data.member_dues_amount_eur) : amount,
        member_dues_wallet_eur: data?.member_dues_wallet_eur != null ? Number(data.member_dues_wallet_eur) : wallet,
      });
      fillClubDuesForm(ctx.club);
      if (typeof window.scClubRefreshMemberDuesUi === 'function') {
        window.scClubRefreshMemberDuesUi();
      }
      setClubDuesMsg('Cuota de socios guardada.', false);
    });
  }

  function initClubLegalSection(ctx) {
    const sec = $('club-legal-section');
    if (!sec || ctx.profile.role !== 'admin_club') return;
    sec.hidden = false;
    fillClubLegalForm(ctx.club);

    if (sec.dataset.bound === '1') return;
    sec.dataset.bound = '1';

    $('club-legal-save')?.addEventListener('click', async () => {
      const name = ($('club-legal-name')?.value || '').trim();
      const cif = ($('club-legal-cif')?.value || '').trim();
      const email = ($('club-legal-email')?.value || '').trim();
      const address = ($('club-legal-address')?.value || '').trim();
      const minAgeRaw = ($('club-legal-min-age')?.value || '').trim();
      const member_min_age = minAgeRaw === '' ? 18 : Number(minAgeRaw);

      if (!name) {
        setClubLegalMsg('Indica el nombre del club.', true);
        return;
      }
      if (email && !email.includes('@')) {
        setClubLegalMsg('El email no parece válido.', true);
        return;
      }
      if (!Number.isFinite(member_min_age) || member_min_age < 1 || member_min_age > 120) {
        setClubLegalMsg('La edad mínima debe ser un número entre 1 y 120.', true);
        return;
      }

      setClubLegalMsg('Guardando…', false);
      const { data, error } = await sb()
        .from('clubs')
        .update({ name, cif, email, address, member_min_age: Math.trunc(member_min_age) })
        .eq('id', ctx.club.id)
        .select('id, name, cif, email, address, member_min_age, is_active')
        .single();

      if (error) {
        const msg =
          error.code === '42501' || /policy/i.test(error.message || '')
            ? 'Ejecuta en Supabase las migraciones 042 y 043 en el SQL Editor.'
            : error.code === '42703' || String(error.message || '').includes('member_min_age')
              ? 'Ejecuta en Supabase la migración 043_club_member_min_age.sql.'
              : error.message || 'No se pudieron guardar los datos.';
        setClubLegalMsg(msg, true);
        return;
      }

      Object.assign(ctx.club, data);
      $('club-name-display').textContent = data.name;
      const topClub = $('club-topnav-club');
      if (topClub) topClub.textContent = data.name;
      setClubLegalMsg('Datos legales guardados.', false);
    });
  }

  function initClubCurrencySection(ctx) {
    const sec = $('club-currency-section');
    if (!sec || ctx.profile.role !== 'admin_club') return;
    sec.hidden = false;
    fillClubCurrencyForm(ctx.club);

    if (sec.dataset.bound === '1') return;
    sec.dataset.bound = '1';

    const input = $('club-currency-symbol');
    input?.addEventListener('input', () => {
      updateClubCurrencyPreview(input.value);
      const cur = String(input.value || '').trim();
      document.querySelectorAll('[data-currency-preset]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-currency-preset') === cur);
      });
    });

    sec.querySelectorAll('[data-currency-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-currency-preset') || '€';
        if (input) input.value = v;
        updateClubCurrencyPreview(v);
        sec.querySelectorAll('[data-currency-preset]').forEach((b) => {
          b.classList.toggle('is-active', b === btn);
        });
      });
    });

    $('club-currency-save')?.addEventListener('click', async () => {
      const raw = ($('club-currency-symbol')?.value || '').trim();
      const currency_symbol = raw.slice(0, 8) || '€';
      if (!currency_symbol) {
        setClubCurrencyMsg('Indica un símbolo o etiqueta.', true);
        return;
      }

      setClubCurrencyMsg('Guardando…', false);
      const { data, error } = await sb()
        .from('clubs')
        .update({ currency_symbol })
        .eq('id', ctx.club.id)
        .select('id, currency_symbol')
        .single();

      if (error) {
        const msg =
          error.code === '42501' || /policy/i.test(error.message || '')
            ? 'Sin permiso para actualizar el club. Revisa las políticas RLS (migración 042).'
            : error.code === '42703' || /currency_symbol/i.test(error.message || '')
              ? 'Ejecuta en Supabase la migración 055_club_currency_symbol.sql.'
              : error.message || 'No se pudo guardar la moneda.';
        setClubCurrencyMsg(msg, true);
        return;
      }

      ctx.club.currency_symbol = data.currency_symbol || currency_symbol;
      if (typeof window.scSetCurrencySymbol === 'function') {
        window.scSetCurrencySymbol(ctx.club.currency_symbol);
      }
      fillClubCurrencyForm(ctx.club);
      if (typeof window.scRefreshCurrencyDom === 'function') {
        window.scRefreshCurrencyDom();
      }
      if (typeof window.scClubRefreshInventoryUi === 'function') {
        void window.scClubRefreshInventoryUi();
      }
      if (typeof window.scClubRefreshTpvUi === 'function') {
        void window.scClubRefreshTpvUi();
      }
      if (typeof window.scClubRefreshFinance === 'function') {
        void window.scClubRefreshFinance();
      }
      if (typeof window.scClubRefreshMembership === 'function') {
        void window.scClubRefreshMembership();
      }
      if (typeof window.scClubRefreshHome === 'function') {
        void window.scClubRefreshHome();
      }
      setClubCurrencyMsg('Moneda guardada. Se aplica en precios y finanzas.', false);
    });
  }

  window.scClubGetLegalInfo = function () {
    const minAge = ctxRef?.club?.member_min_age != null ? Number(ctxRef.club.member_min_age) : 18;
    return {
      name: ctxRef?.club?.name || '',
      cif: ctxRef?.club?.cif || '',
      email: ctxRef?.club?.email || '',
      address: ctxRef?.club?.address || '',
      member_min_age: Number.isFinite(minAge) && minAge >= 1 ? Math.trunc(minAge) : 18,
      currency_symbol:
        ctxRef?.club?.currency_symbol ||
        (typeof window.scGetCurrencySymbol === 'function' ? window.scGetCurrencySymbol() : '€'),
    };
  };

  async function refreshClubTeamTable(clubId, adminUserId) {
    const tbody = $('club-team-tbody');
    if (!tbody) return;
    const { data, error } = await sb()
      .from('club_access')
      .select('id, email, role, created_at, can_edit_inventory, auth_user_id')
      .eq('club_id', clubId)
      .order('created_at', { ascending: false });
    if (error) {
      const cols = error.code === '42703' ? 3 : 4;
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
      const canRemove =
        row.role === 'empleado' &&
        (!row.auth_user_id || String(row.auth_user_id) !== String(adminUserId || ''));
      const actionCell = canRemove
        ? `<button type="button" class="btn btn--ghost btn--small btn--danger" data-team-remove="${escapeHtml(row.id)}" data-team-email="${escapeHtml(row.email)}">Eliminar</button>`
        : '<span class="hint">—</span>';
      tr.innerHTML = `
        <td>${escapeHtml(row.email)}</td>
        <td>${escapeHtml(row.role)}</td>
        <td>${invCell}</td>
        <td class="actions">${actionCell}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function initClubTeamSection(ctx) {
    const sec = $('club-team-section');
    if (!sec || ctx.profile.role !== 'admin_club') return;
    sec.hidden = false;

    if (sec.dataset.bound === '1') {
      void refreshClubTeamTable(ctx.club.id, ctx.profile.id);
      return;
    }
    sec.dataset.bound = '1';

    $('club-team-tbody')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-team-remove]');
      if (!btn) return;
      const accessId = btn.getAttribute('data-team-remove');
      const email = btn.getAttribute('data-team-email') || 'este trabajador';
      if (!accessId) return;
      if (!confirm(`¿Eliminar a ${email}?\n\nSe revocará su acceso al club y no podrá volver a entrar con esa cuenta.`)) {
        return;
      }
      setClubTeamMsg('Eliminando trabajador…', false);
      btn.disabled = true;
      const { error } = await sb().rpc('club_remove_worker', { p_access_id: accessId });
      if (error) {
        btn.disabled = false;
        const msg =
          error.code === 'PGRST202' || /club_remove_worker/i.test(error.message || '')
            ? 'Ejecuta en Supabase la migración 040_club_remove_worker.sql.'
            : error.message || 'No se pudo eliminar al trabajador.';
        setClubTeamMsg(msg, true);
        return;
      }
      setClubTeamMsg('Trabajador eliminado.', false);
      await refreshClubTeamTable(ctx.club.id, ctx.profile.id);
    });

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
        await refreshClubTeamTable(clubId, adminId);
      } catch (e) {
        setClubTeamMsg(e.message || 'No se pudo crear el trabajador.', true);
      }
    });

    void refreshClubTeamTable(ctx.club.id, ctx.profile.id);
  }

  const shiftWizard = {
    shiftId: null,
    ctx: null,
    logoutAfter: false,
    pendingLogout: false,
    closeCash: null,
    closeFloat: null,
    noteClose: '',
    closeExpectedCash: null,
  };

  function formatMoneyEUR(n) {
    if (typeof window.scFormatMoney === 'function') return window.scFormatMoney(n);
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

  function isMissingDbColumnError(err) {
    if (!err) return false;
    if (err.code === '42703') return true;
    const m = String(err.message || '').toLowerCase();
    return m.includes('column') && (m.includes('does not exist') || m.includes('no existe'));
  }

  function buildLatestCountByProduct(events) {
    const map = {};
    (events || []).forEach((ev) => {
      if (!ev || ev.product_id === undefined || ev.product_id === null) return;
      const pid = String(ev.product_id);
      const cur = map[pid];
      if (!cur || new Date(ev.created_at) >= new Date(cur.created_at)) {
        map[pid] = ev;
      }
    });
    return map;
  }

  function formatStockDiscrepancy(prod, delta) {
    if (delta === null || Number.isNaN(delta)) return '—';
    const sign = delta > 0 ? '+' : '';
    const isUnit = prod && prod.sale_unit === 'unit';
    if (isUnit) {
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

  async function fetchShiftStockEvents(shiftId) {
    const fullCols =
      'product_id, stock_net_grams, previous_stock_grams, delta_grams, source, created_at';
    let res = await sb()
      .from('shift_stock_events')
      .select(fullCols)
      .eq('shift_id', shiftId)
      .order('created_at', { ascending: true });
    if (res.error && isMissingDbColumnError(res.error)) {
      res = await sb()
        .from('shift_stock_events')
        .select('product_id, stock_net_grams, source, created_at')
        .eq('shift_id', shiftId)
        .order('created_at', { ascending: true });
    }
    return res;
  }

  function openShiftWizardModal() {
    window.scOpenShiftModal($('shift-wizard-modal'));
  }

  function closeShiftWizardModal() {
    const el = $('shift-wizard-modal');
    if (!el) return;
    el.classList.add('is-hidden');
    el.setAttribute('aria-hidden', 'true');
    setShiftWizardPanelWide(false);
  }

  function setShiftWizardPanelWide(wide) {
    const panel = document.querySelector('#shift-wizard-modal .shift-modal__panel');
    if (panel) panel.classList.toggle('shift-modal__panel--wide', wide);
  }

  function openSummaryModal(html) {
    const body = $('shift-summary-body');
    if (body) body.innerHTML = html;
    window.scOpenShiftModal($('shift-summary-modal'));
  }

  function closeSummaryModal() {
    const modal = $('shift-summary-modal');
    if (!modal) return;
    modal.classList.add('is-hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  function denomFieldsHtml() {
    const sym =
      typeof window.scGetCurrencySymbol === 'function' ? window.scGetCurrencySymbol() : '€';
    const rows = [
      ['50', `50 ${sym}`],
      ['20', `20 ${sym}`],
      ['10', `10 ${sym}`],
      ['5', `5 ${sym}`],
      ['2', `2 ${sym}`],
      ['1', `1 ${sym}`],
      ['0.5', `0,50 ${sym}`],
      ['0.2', `0,20 ${sym}`],
      ['0.1', `0,10 ${sym}`],
      ['0.05', `0,05 ${sym}`],
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

  function dispensePaymentMethod(d) {
    const m = String(d?.payment_method || 'cash').toLowerCase();
    if (m === 'wallet' || m === 'card') return m;
    return 'cash';
  }

  function summarizeShiftDispenseSales(dispenses) {
    let cashSales = 0;
    let cardSales = 0;
    let walletSales = 0;
    (dispenses || []).forEach((d) => {
      const p = Number(d.price_charged_eur) || 0;
      const method = dispensePaymentMethod(d);
      if (method === 'wallet') walletSales += p;
      else if (method === 'card') cardSales += p;
      else cashSales += p;
    });
    return {
      cashSales,
      cardSales,
      walletSales,
      salesTotal: cashSales + cardSales + walletSales,
    };
  }

  async function fetchShiftDispenses(shiftId) {
    let hasPaymentMethod = true;
    let { data, error } = await sb()
      .from('tpv_dispenses')
      .select('id, product_id, grams_dispensed, price_charged_eur, payment_method')
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
        .select('id, product_id, grams_dispensed, price_charged_eur')
        .eq('shift_id', shiftId);
      data = retry.data;
      error = retry.error;
    }
    if (error) throw error;
    return { dispenses: data || [], hasPaymentMethod };
  }

  function walletLedgerKindLabel(kind) {
    const k = String(kind || '').toLowerCase();
    if (k === 'tpv_sale') return 'Venta POS (monedero)';
    if (k === 'tpv_void') return 'Anulación POS';
    if (k === 'membership_dues') return 'Cuota de socio';
    return 'Ajuste monedero';
  }

  function formatWalletLedgerAmt(amt) {
    const n = Number(amt);
    if (Number.isNaN(n)) return '—';
    const abs = formatMoneyEUR(Math.abs(n));
    if (n > 0.0001) return `+${abs}`;
    if (n < -0.0001) return `−${abs}`;
    return formatMoneyEUR(0);
  }

  async function fetchShiftWalletLedger(shiftId, dispenseIds) {
    if (!shiftId) return [];
    const ids = (dispenseIds || []).filter(Boolean);
    let q = sb()
      .from('club_member_wallet_ledger')
      .select(
        'created_at, amount_eur, cash_eur, balance_after_eur, kind, notes, member_id, shift_id, tpv_dispense_id',
      )
      .order('created_at', { ascending: true });
    if (ids.length) {
      q = q.or(`shift_id.eq.${shiftId},tpv_dispense_id.in.(${ids.join(',')})`);
    } else {
      q = q.eq('shift_id', shiftId);
    }
    const { data, error } = await q;
    if (
      error &&
      (error.code === '42703' ||
        String(error.message || '').toLowerCase().includes('shift_id') ||
        String(error.message || '').toLowerCase().includes('cash_eur'))
    ) {
      const { data: d2, error: e2 } = await sb()
        .from('club_member_wallet_ledger')
        .select('created_at, amount_eur, balance_after_eur, kind, notes, member_id')
        .eq('shift_id', shiftId)
        .order('created_at', { ascending: true });
      if (e2) return [];
      return (d2 || []).map((r) => ({ ...r, cash_eur: 0 }));
    }
    if (error) throw error;
    const seen = new Set();
    return (data || []).filter((r) => {
      const key = `${r.created_at}|${r.amount_eur}|${r.kind}|${r.member_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function summarizeShiftWalletLedger(rows) {
    let cashNet = 0;
    let walletMovement = 0;
    let recargasCash = 0;
    let retiradasCash = 0;
    let ajustesSinCaja = 0;
    (rows || []).forEach((r) => {
      const amt = Number(r.amount_eur) || 0;
      const cash = Number(r.cash_eur) || 0;
      walletMovement += amt;
      cashNet += cash;
      if (r.kind === 'adjustment') {
        if (Math.abs(cash) > 0.005) {
          if (cash > 0) recargasCash += cash;
          else retiradasCash += cash;
        } else {
          ajustesSinCaja += amt;
        }
      }
    });
    return { cashNet, walletMovement, recargasCash, retiradasCash, ajustesSinCaja };
  }

  async function fetchShiftWalletCashNet(shiftId, dispenseIds) {
    const rows = await fetchShiftWalletLedger(shiftId, dispenseIds);
    return summarizeShiftWalletLedger(rows).cashNet;
  }

  async function fetchShiftDuesCashExtra(shiftId) {
    if (!shiftId) return 0;
    let { data, error } = await sb()
      .from('club_member_dues_payments')
      .select('total_eur, wallet_eur, payment_method')
      .eq('shift_id', shiftId)
      .eq('payment_method', 'cash');
    if (
      error &&
      (error.code === '42P01' ||
        error.code === '42703' ||
        /club_member_dues_payments|member_dues/i.test(error.message || ''))
    ) {
      return 0;
    }
    if (error) return 0;
    let extra = 0;
    (data || []).forEach((r) => {
      const wallet = Number(r.wallet_eur) || 0;
      const total = Number(r.total_eur) || 0;
      // Si hubo crédito a monedero, el total ya entró en caja vía cash_eur del ledger.
      if (wallet <= 0.005 && total > 0) extra += total;
    });
    return extra;
  }

  async function fetchShiftCashExpected(shiftId) {
    const [shiftRes, dispRes] = await Promise.all([
      sb().from('shifts').select('opening_float_eur').eq('id', shiftId).maybeSingle(),
      fetchShiftDispenses(shiftId),
    ]);
    const dispenseIds = (dispRes.dispenses || []).map((d) => d.id).filter(Boolean);
    const [walletCashNet, duesCashExtra] = await Promise.all([
      fetchShiftWalletCashNet(shiftId, dispenseIds),
      fetchShiftDuesCashExtra(shiftId),
    ]);
    const opening =
      shiftRes.data && shiftRes.data.opening_float_eur != null
        ? Number(shiftRes.data.opening_float_eur)
        : 0;
    const { cashSales, cardSales, walletSales } = summarizeShiftDispenseSales(dispRes.dispenses);
    return {
      opening,
      cashSales,
      cardSales,
      walletSales,
      walletCashNet,
      duesCashExtra,
      expectedCash: opening + cashSales + walletCashNet + duesCashExtra,
      hasPaymentMethod: dispRes.hasPaymentMethod,
      dispenseIds,
    };
  }

  async function buildShiftWalletSectionHtml(shiftId, dispenses) {
    const dispenseIds = (dispenses || []).map((d) => d.id).filter(Boolean);
    let rows = await fetchShiftWalletLedger(shiftId, dispenseIds);
    if (typeof window.scClubEnrichWalletLedgerRows === 'function') {
      rows = await window.scClubEnrichWalletLedgerRows(rows);
    }
    const sum = summarizeShiftWalletLedger(rows);
    if (!rows.length) {
      return `<p class="hint" style="margin:0">Sin movimientos de monedero en este turno.</p>`;
    }
    const mids = [...new Set(rows.map((r) => r.member_id).filter(Boolean))];
    let memMap = {};
    if (mids.length) {
      const { data: mm } = await sb().from('club_members').select('id, display_name').in('id', mids);
      if (mm) memMap = Object.fromEntries(mm.map((m) => [m.id, m.display_name]));
    }
    const tableRows = rows
      .map((r) => {
        const cash = Number(r.cash_eur) || 0;
        const cashTxt =
          Math.abs(cash) > 0.005 ? formatWalletLedgerAmt(cash) : '<span class="hint">—</span>';
        return `<tr>
          <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
          <td>${escapeHtml(memMap[r.member_id] || '—')}</td>
          <td>${escapeHtml(walletLedgerKindLabel(r.kind))}</td>
          <td>${escapeHtml(formatWalletLedgerAmt(r.amount_eur))}</td>
          <td>${cashTxt}</td>
          <td>${escapeHtml(
            (typeof window.scClubWalletLedgerNoteLabel === 'function'
              ? window.scClubWalletLedgerNoteLabel(r)
              : r.notes || '—'
            ).slice(0, 80),
          )}</td>
        </tr>`;
      })
      .join('');
    return `
      <p style="margin:0 0 0.5rem">Recargas en efectivo: <strong>${escapeHtml(formatMoneyEUR(sum.recargasCash))}</strong> · Retiradas en efectivo: <strong>${escapeHtml(formatMoneyEUR(Math.abs(sum.retiradasCash)))}</strong>${Math.abs(sum.ajustesSinCaja) > 0.005 ? ` · Ajustes sin caja: ${escapeHtml(formatWalletLedgerAmt(sum.ajustesSinCaja))}` : ''}</p>
      <div class="table-wrap" style="margin-top:0.5rem">
        <table class="table-compact shift-wallet-table">
          <thead><tr><th>Fecha</th><th>Socio</th><th>Tipo</th><th>Monedero</th><th>Caja</th><th>Nota</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    `;
  }

  async function buildShiftSummaryHtml(clubId, shiftId) {
    const dispRes = await fetchShiftDispenses(shiftId);
    const dispenseIds = (dispRes.dispenses || []).map((d) => d.id).filter(Boolean);
    const [shiftRes, walletCashNet, duesCashExtra, walletSectionHtml, evRes, prodRes] = await Promise.all([
      sb().from('shifts').select('*').eq('id', shiftId).maybeSingle(),
      fetchShiftWalletCashNet(shiftId, dispenseIds),
      fetchShiftDuesCashExtra(shiftId),
      buildShiftWalletSectionHtml(shiftId, dispRes.dispenses),
      fetchShiftStockEvents(shiftId),
      sb()
        .from('inventory_products')
        .select('id, name, emoji, stock_grams, sale_unit, default_sale_grams')
        .eq('club_id', clubId),
    ]);

    const shift = shiftRes.data;
    const dispenses = dispRes.dispenses || [];
    const walletSection = walletSectionHtml || '';
    const eventsFetchError = evRes.error ? evRes.error.message || 'Error desconocido' : '';
    const events = eventsFetchError ? [] : evRes.data || [];
    const products = prodRes.data || [];
    const prodMap = Object.fromEntries(products.map((p) => [p.id, p]));
    const countByProduct = buildLatestCountByProduct(events);

    const { cashSales, cardSales, walletSales, salesTotal } = summarizeShiftDispenseSales(dispenses);
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
        const dTxt = formatStockDiscrepancy(pr, d);
        const prevTxt =
          ev.previous_stock_grams != null && ev.previous_stock_grams !== ''
            ? Number(ev.previous_stock_grams).toLocaleString('es-ES', { maximumFractionDigits: 3 })
            : '—';
        return `<tr>
          <td>${escapeHtml(em ? em + ' ' : '')}${escapeHtml(pr.name || '—')}</td>
          <td>${escapeHtml(ev.source === 'scale' ? 'Báscula' : 'Manual')}</td>
          <td>${escapeHtml(prevTxt)}</td>
          <td>${escapeHtml(Number(ev.stock_net_grams).toLocaleString('es-ES', { maximumFractionDigits: 3 }))}</td>
          <td>${escapeHtml(dTxt)}</td>
        </tr>`;
      })
      .join('');

    const opening = shift && shift.opening_float_eur != null ? Number(shift.opening_float_eur) : 0;
    const walletCash = Number(walletCashNet) || 0;
    const duesCash = Number(duesCashExtra) || 0;
    const expectedCash = opening + cashSales + walletCash + duesCash;
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

    const snapshotProducts = products
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const stockSnapshotHint =
      '<p class="hint" style="margin:0 0 0.5rem">Descuadre: diferencia al guardar desde <strong>Contaje</strong> (contado − stock previo). <strong>0</strong> si coincidía; <strong>—</strong> si no hubo contaje en este turno.</p>';

    const stockSnapshot = snapshotProducts
      .map((p) => {
        const em = (p.emoji || '').trim();
        const countEv = countByProduct[String(p.id)];
        const delta = countEv ? getShiftStockDelta(countEv) : null;
        const descTxt = delta !== null ? formatStockDiscrepancy(p, delta) : '—';
        return `<tr>
        <td>${escapeHtml(em ? em + ' ' : '')}${escapeHtml(p.name)}</td>
        <td>${escapeHtml(Number(p.stock_grams).toLocaleString('es-ES', { maximumFractionDigits: 3 }))}</td>
        <td>${escapeHtml(descTxt)}</td>
      </tr>`;
      })
      .join('');

    const smap = await loadStaffEmailMap(clubId, shift ? [shift.opened_by, shift.closed_by] : []);
    const labStaff = (uid) => (uid && smap[uid] ? smap[uid] : '—');
    const headPeople = shift
      ? `<p style="margin:0 0 0.75rem">Abierto por <strong>${escapeHtml(labStaff(shift.opened_by))}</strong> · Cerrado por <strong>${escapeHtml(labStaff(shift.closed_by))}</strong></p>`
      : '';

    return `
      ${headPeople}
      <div class="shift-summary-section">
        <h4 class="hint" style="margin:0 0 0.5rem;font-weight:700">Caja</h4>
        <p style="margin:0">Cambio al abrir: <strong>${escapeHtml(formatMoneyEUR(opening))}</strong></p>
        <p style="margin:0.35rem 0 0">Ventas en efectivo (POS): <strong>${escapeHtml(formatMoneyEUR(cashSales))}</strong></p>
        ${
          cardSales > 0.005
            ? `<p style="margin:0.35rem 0 0">Ventas con tarjeta (no entran en caja): <strong>${escapeHtml(formatMoneyEUR(cardSales))}</strong></p>`
            : ''
        }
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
        ${
          duesCash > 0.005
            ? `<p style="margin:0.35rem 0 0">Cuotas en efectivo (solo club): <strong>${escapeHtml(formatMoneyEUR(duesCash))}</strong></p>`
            : ''
        }
        <p style="margin:0.35rem 0 0">Efectivo esperado en caja (cambio + ventas efectivo + monedero/cuotas en efectivo): <strong>${escapeHtml(formatMoneyEUR(expectedCash))}</strong></p>
        <p style="margin:0.35rem 0 0">Efectivo contado al cerrar: <strong>${closingCash !== null ? escapeHtml(formatMoneyEUR(closingCash)) : '—'}</strong></p>
        ${
          cashDiff !== null
            ? `<p style="margin:0.35rem 0 0" class="shift-cash-diff ${cashDiffClass}">Diferencia (contado − esperado): <strong>${escapeHtml(cashDiff >= 0 ? `+${formatMoneyEUR(cashDiff)}` : formatMoneyEUR(cashDiff))}</strong></p>`
            : ''
        }
        <p style="margin:0.35rem 0 0">Total ventas POS (efectivo + tarjeta + monedero): <strong>${escapeHtml(formatMoneyEUR(salesTotal))}</strong></p>
        <p style="margin:0.35rem 0 0">Cambio dejado para el siguiente turno: <strong>${floatFwd !== null ? escapeHtml(formatMoneyEUR(floatFwd)) : '—'}</strong></p>
        ${denHtml ? `<p class="hint" style="margin:0.5rem 0 0">Desglose anotado:</p>${denHtml}` : ''}
      </div>
      <div class="shift-summary-section">
        <h4 class="hint" style="margin:0 0 0.5rem;font-weight:700">Monedero (este turno)</h4>
        <p class="hint" style="margin:0 0 0.5rem">Ventas cobradas con monedero: <strong>${escapeHtml(formatMoneyEUR(walletSales))}</strong> (no suman a caja). Historial vinculado al turno:</p>
        ${walletSection}
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
          eventsFetchError
            ? `<p class="msg msg--error" style="margin:0">No se pudo cargar el historial de stock: ${escapeHtml(eventsFetchError)}</p>`
            : events.length
              ? `<div class="table-wrap"><table class="table-compact"><thead><tr><th>Producto</th><th>Origen</th><th>Stock antes</th><th>Stock contado</th><th>Descuadre (g / ud)</th></tr></thead><tbody>${stockRows}</tbody></table></div>`
              : `<p class="hint" style="margin:0">Sin registros de stock en este turno. El descuadre aparece cuando guardas desde <strong>Contaje</strong> (&quot;Guardar&quot;) con migraciones 013–031 aplicadas en Supabase. Si solo editas la cantidad desde la ficha de producto en Catálogo, no queda vínculo con el turno.</p>`
        }
      </div>
      <div class="shift-summary-section">
        <h4 class="hint" style="margin:0 0 0.5rem;font-weight:700">Stock actual tras cerrar (inventario)</h4>
        ${stockSnapshotHint}
        <div class="table-wrap"><table class="table-compact"><thead><tr><th>Producto</th><th>Stock (g)</th><th>Descuadre (del contaje)</th></tr></thead><tbody>${stockSnapshot || '<tr><td colspan="3" class="hint">—</td></tr>'}</tbody></table></div>
        ${
          eventsFetchError
            ? '<p class="hint" style="margin:0.5rem 0 0">No hay datos de historial de contaje (error al cargarlos). Cuando se cargue bien, esta columna mostrará el descuadre solo si hubo guardado desde Contaje.</p>'
            : ''
        }
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

  let memberDniWarnResolver = null;

  function memberHasDni(member) {
    // Si el campo no viene en el objeto, no avisamos (evita falsos positivos).
    if (!member || member.dni === undefined) return true;
    return member.dni != null && String(member.dni).trim() !== '';
  }

  function memberDniWarnLabel(member) {
    const name =
      member?.display_name ||
      [member?.first_name, member?.last_name].filter(Boolean).join(' ').trim() ||
      'Este socio';
    return String(name).trim() || 'Este socio';
  }

  function closeMemberDniWarnModal(accepted) {
    const modal = $('member-dni-warn-modal');
    if (modal) {
      modal.classList.add('is-hidden');
      modal.setAttribute('aria-hidden', 'true');
    }
    const resolve = memberDniWarnResolver;
    memberDniWarnResolver = null;
    if (resolve) resolve(Boolean(accepted));
  }

  function openMemberDniWarnModal(member) {
    return new Promise((resolve) => {
      const modal = $('member-dni-warn-modal');
      const nameEl = $('member-dni-warn-name');
      if (nameEl) nameEl.textContent = memberDniWarnLabel(member);
      if (!modal) {
        resolve(window.confirm('Este socio no tiene DNI / NIE. ¿Continuar de todos modos?'));
        return;
      }
      memberDniWarnResolver = resolve;
      window.scOpenShiftModal(modal);
      $('member-dni-warn-accept')?.focus();
    });
  }

  window.scConfirmMemberMissingDni = async function (member) {
    if (memberHasDni(member)) return true;
    return openMemberDniWarnModal(member);
  };

  function bindMemberDniWarnModal() {
    $('member-dni-warn-accept')?.addEventListener('click', () => closeMemberDniWarnModal(true));
    document.querySelectorAll('[data-member-dni-warn-cancel]').forEach((el) => {
      el.addEventListener('click', () => closeMemberDniWarnModal(false));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const modal = $('member-dni-warn-modal');
      if (!modal || modal.classList.contains('is-hidden')) return;
      closeMemberDniWarnModal(false);
    });
  }

  function renderWizardStockQuestion() {
    setShiftWizardPanelWide(false);
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
    setShiftWizardPanelWide(false);
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
      if (shiftWizard.closeCash != null || shiftWizard.closeFloat != null) {
        void finalizeShiftClose();
        return;
      }
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
      ? 'Cuadra con el efectivo esperado según el POS.'
      : `Diferencia: ${diff >= 0 ? '+' : ''}${formatMoneyEUR(diff)} (contado − esperado).`;
  }

  function renderWizardArqueo() {
    setShiftWizardPanelWide(true);
    const sym =
      typeof window.scGetCurrencySymbol === 'function' ? window.scGetCurrencySymbol() : '€';
    $('shift-wizard-title').textContent = 'Arqueo y cambio';
    $('shift-wizard-body').innerHTML = `
      <p class="hint" style="margin-top:0">Indica el efectivo contado y el cambio que dejas para el siguiente turno. Las ventas con <strong>monedero</strong> no suman al efectivo esperado. Opcionalmente desglosa billetes y monedas.</p>
      <p id="wiz-cash-expected" class="hint shift-arqueo-hint">Calculando efectivo esperado…</p>
      <div class="shift-arqueo-main">
        <div class="form__row">
          <label for="wiz-close-cash">Total efectivo contado en caja (${escapeHtml(sym)})</label>
          <input class="input" id="wiz-close-cash" inputmode="decimal" placeholder="Ej. 240,50" autocomplete="off" />
        </div>
        <div class="form__row">
          <label for="wiz-close-float">Cambio para el siguiente turno (${escapeHtml(sym)})</label>
          <input class="input" id="wiz-close-float" inputmode="decimal" placeholder="Ej. 80" autocomplete="off" />
        </div>
      </div>
      <p id="wiz-cash-diff" class="hint shift-arqueo-diff" role="status"></p>
      <p class="hint shift-arqueo-denoms-label">Desglose (opcional — cantidad de cada tipo)</p>
      <div class="shift-arqueo-denoms">
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
      let cardSales = 0;
      let opening = 0;
      let walletSales = 0;
      let walletCashNet = 0;
      let duesCashExtra = 0;
      let walletRecargas = 0;
      try {
        if (shiftId) {
          const info = await fetchShiftCashExpected(shiftId);
          opening = info.opening;
          cashSales = info.cashSales;
          cardSales = info.cardSales || 0;
          expectedCash = info.expectedCash;
          walletSales = info.walletSales || 0;
          walletCashNet = info.walletCashNet || 0;
          duesCashExtra = info.duesCashExtra || 0;
          const ledgerRows = await fetchShiftWalletLedger(shiftId, info.dispenseIds || []);
          const wSum = summarizeShiftWalletLedger(ledgerRows);
          walletRecargas = wSum.recargasCash;
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
        const cardLine =
          cardSales > 0.005 ? ` Ventas con tarjeta: ${formatMoneyEUR(cardSales)} (no en caja).` : '';
        const walletLine =
          walletSales > 0.005
            ? ` Ventas con monedero: ${formatMoneyEUR(walletSales)} (no en caja).`
            : '';
        const walletCashLine =
          Math.abs(walletCashNet) > 0.005
            ? ` Monedero en efectivo (neto): ${walletCashNet >= 0 ? '+' : ''}${formatMoneyEUR(walletCashNet)}.`
            : '';
        const duesLine =
          duesCashExtra > 0.005 ? ` Cuotas solo club: ${formatMoneyEUR(duesCashExtra)}.` : '';
        hintEl.textContent = `Efectivo esperado: ${formatMoneyEUR(expectedCash)} = cambio ${formatMoneyEUR(opening)} + ventas efectivo ${formatMoneyEUR(cashSales)}${walletCashLine}${duesLine}${cardLine}${walletLine}`;
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
    const note =
      shiftWizard.noteClose != null && shiftWizard.noteClose !== undefined
        ? String(shiftWizard.noteClose).trim()
        : ($('note-close')?.value || '').trim();
    const cash =
      shiftWizard.closeCash != null && !Number.isNaN(Number(shiftWizard.closeCash))
        ? Number(shiftWizard.closeCash)
        : parseDecimalLoose($('wiz-close-cash')?.value);
    const fl =
      shiftWizard.closeFloat != null && !Number.isNaN(Number(shiftWizard.closeFloat))
        ? Number(shiftWizard.closeFloat)
        : parseDecimalLoose($('wiz-close-float')?.value);
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
      if ($('note-close')) $('note-close').value = '';
      if ($('close-cash-eur')) $('close-cash-eur').value = '';
      if ($('close-float-eur')) $('close-float-eur').value = '';
      shiftWizard.closeCash = null;
      shiftWizard.closeFloat = null;
      shiftWizard.noteClose = '';
      shiftWizard.closeExpectedCash = null;
      closeShiftCloseModal();
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

  function closeShiftOpenModal() {
    const modal = $('shift-open-modal');
    if (!modal) return;
    modal.classList.add('is-hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  function openShiftOpenModal() {
    window.scOpenShiftModal($('shift-open-modal'));
    $('opening-float-eur')?.focus();
  }

  function closeShiftCloseModal() {
    const modal = $('shift-close-modal');
    if (!modal) return;
    modal.classList.add('is-hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  function updateShiftCloseDiff(expectedCash) {
    const diffEl = $('shift-close-diff');
    const counted = parseDecimalLoose($('close-cash-eur')?.value);
    if (!diffEl) return;
    if (Number.isNaN(counted) || expectedCash == null || Number.isNaN(Number(expectedCash))) {
      diffEl.textContent = '';
      diffEl.className = 'hint shift-arqueo-diff';
      return;
    }
    const diff = counted - Number(expectedCash);
    const ok = Math.abs(diff) < 0.005;
    diffEl.className = ok
      ? 'hint shift-arqueo-diff shift-arqueo-diff--ok'
      : 'hint shift-arqueo-diff shift-arqueo-diff--warn';
    diffEl.textContent = ok
      ? 'Cuadra con el efectivo esperado según el POS.'
      : `Diferencia: ${diff >= 0 ? '+' : ''}${formatMoneyEUR(diff)} (contado − esperado).`;
  }

  async function openShiftCloseModal(shiftId, ctx) {
    shiftWizard.shiftId = shiftId;
    shiftWizard.ctx = ctx;
    shiftWizard.logoutAfter = false;
    shiftWizard.closeCash = null;
    shiftWizard.closeFloat = null;
    shiftWizard.noteClose = '';
    shiftWizard.closeExpectedCash = null;
    if ($('close-cash-eur')) $('close-cash-eur').value = '';
    if ($('close-float-eur')) $('close-float-eur').value = '';
    if ($('note-close')) $('note-close').value = '';
    const hintEl = $('shift-close-expected');
    if (hintEl) {
      hintEl.textContent = 'Calculando efectivo esperado…';
      hintEl.className = 'hint shift-arqueo-hint';
    }
    if ($('shift-close-diff')) {
      $('shift-close-diff').textContent = '';
      $('shift-close-diff').className = 'hint shift-arqueo-diff';
    }
    window.scOpenShiftModal($('shift-close-modal'));
    $('close-cash-eur')?.focus();

    try {
      const info = await fetchShiftCashExpected(shiftId);
      shiftWizard.closeExpectedCash = info.expectedCash;
      if (hintEl) {
        const cardLine =
          (info.cardSales || 0) > 0.005
            ? ` Ventas con tarjeta: ${formatMoneyEUR(info.cardSales)} (no en caja).`
            : '';
        const walletLine =
          (info.walletSales || 0) > 0.005
            ? ` Ventas con monedero: ${formatMoneyEUR(info.walletSales)} (no en caja).`
            : '';
        const walletCashLine =
          Math.abs(info.walletCashNet || 0) > 0.005
            ? ` Monedero en efectivo (neto): ${info.walletCashNet >= 0 ? '+' : ''}${formatMoneyEUR(info.walletCashNet)}.`
            : '';
        const duesLine =
          (info.duesCashExtra || 0) > 0.005
            ? ` Cuotas solo club: ${formatMoneyEUR(info.duesCashExtra)}.`
            : '';
        hintEl.textContent = `Efectivo esperado: ${formatMoneyEUR(info.expectedCash)} = cambio ${formatMoneyEUR(info.opening)} + ventas efectivo ${formatMoneyEUR(info.cashSales)}${walletCashLine}${duesLine}${cardLine}${walletLine}`;
      }
      updateShiftCloseDiff(info.expectedCash);
    } catch (_) {
      if (hintEl) {
        hintEl.textContent = 'No se pudo calcular el efectivo esperado.';
        hintEl.classList.add('shift-arqueo-hint--warn');
      }
    }
  }

  function startCloseShiftFlow(shiftId, ctx) {
    void openShiftCloseModal(shiftId, ctx);
  }

  async function performOpenShift(ctx) {
    const note = ($('note-open')?.value || '').trim();
    const floatRaw = ($('opening-float-eur')?.value || '').trim();
    let opening_float_eur = 0;
    if (floatRaw) {
      const p = parseDecimalLoose(floatRaw);
      if (!Number.isNaN(p) && p >= 0) opening_float_eur = p;
    }
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
    if ($('note-open')) $('note-open').value = '';
    if ($('opening-float-eur')) $('opening-float-eur').value = '';
    closeShiftOpenModal();
    await refreshShiftsUI(ctx);
    setStatus('Turno abierto.', false);
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
    if (viewName === 'home' && typeof window.scClubRefreshHomeKpis === 'function') {
      void window.scClubRefreshHomeKpis();
    }
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
    if (viewName === 'membership' && typeof window.scClubRefreshMembership === 'function') {
      void window.scClubRefreshMembership();
    }
    if (viewName === 'settings' && ctxRef?.profile?.role === 'admin_club') {
      fillClubLegalForm(ctxRef.club);
      fillClubCurrencyForm(ctxRef.club);
      fillClubPayMethodsForm(ctxRef.club);
      fillClubDuesForm(ctxRef.club);
      void refreshClubTeamTable(ctxRef.club.id, ctxRef.profile.id);
    }
  }

  const PAGE_TITLES = {
    home: 'Inicio',
    tpv: 'POS',
    inventory: 'Catálogo',
    stock: 'Contaje',
    members: 'Socios',
    finance: 'Finanzas',
    membership: 'Membresía',
    settings: 'Ajustes',
  };

  function setPageTitle(viewName) {
    const el = $('app-page-title');
    if (el) el.textContent = PAGE_TITLES[viewName] || 'Panel';
  }

  function closeSidebar() {
    document.body.classList.remove('sidebar-open');
    const backdrop = $('app-sidebar-backdrop');
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.setAttribute('aria-hidden', 'true');
    }
  }

  function openSidebar() {
    document.body.classList.add('sidebar-open');
    const backdrop = $('app-sidebar-backdrop');
    if (backdrop) {
      backdrop.hidden = false;
      backdrop.setAttribute('aria-hidden', 'false');
    }
  }

  function initSidebarUi() {
    $('sidebar-toggle')?.addEventListener('click', () => openSidebar());
    $('sidebar-close')?.addEventListener('click', () => closeSidebar());
    $('app-sidebar-backdrop')?.addEventListener('click', () => closeSidebar());

    if (window.matchMedia('(min-width: 1024px) and (max-width: 1279px)').matches) {
      document.body.classList.add('sidebar-collapsed');
    }
  }

  const VIEW_IDS = ['home', 'tpv', 'inventory', 'stock', 'members', 'finance', 'membership', 'settings'];

  function viewFromHash() {
    const h = (location.hash || '').replace(/^#/, '').toLowerCase();
    return VIEW_IDS.includes(h) ? h : 'home';
  }

  function syncViewHash(viewName) {
    const target = viewName === 'home' ? '' : `#${viewName}`;
    const current = location.hash || '';
    if (target === current) return;
    const base = location.pathname + location.search;
    history.replaceState(null, '', target ? `${base}${target}` : base);
  }

  function initNav() {
    const tabs = document.querySelectorAll('.club-tab');
    const views = document.querySelectorAll('.club-view');
    function show(viewName) {
      if (!VIEW_IDS.includes(viewName)) viewName = 'home';
      if (
        viewName === 'membership' &&
        ctxRef?.profile?.role &&
        ctxRef.profile.role !== 'admin_club' &&
        !ctxRef.asSuperadmin
      ) {
        viewName = 'home';
      }
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
      setPageTitle(viewName);
      closeSidebar();
      refreshClubView(viewName);
      document.querySelectorAll('[data-quick-nav]').forEach((el) => {
        el.classList.toggle('is-active', el.dataset.quickNav === viewName);
      });
      syncViewHash(viewName);
    }
    tabs.forEach((t) => {
      t.addEventListener('click', () => show(t.dataset.view));
    });
    document.querySelectorAll('[data-quick-nav]').forEach((el) => {
      el.addEventListener('click', () => show(el.dataset.quickNav));
    });
    $('app-shift-pill')?.addEventListener('click', () => show('home'));
    window.addEventListener('hashchange', () => show(viewFromHash()));
    show(viewFromHash());
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
    ctxRef = ctx;

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
    initSidebarUi();
    initClubDarkMode();
    bindMemberDniWarnModal();

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
      initClubLegalSection(ctx);
      initClubCurrencySection(ctx);
      initClubPayMethodsSection(ctx);
      initClubDuesSection(ctx);
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

    if (typeof window.scInitClubMembership === 'function') {
      try {
        await window.scInitClubMembership(ctx);
      } catch (e) {
        console.error(e);
      }
    }

    if (typeof window.scClubRefreshHomeKpis === 'function') {
      void window.scClubRefreshHomeKpis();
    }

    $('logout-btn')?.addEventListener('click', async () => {
      if (ctx.asSuperadmin) {
        window.SCAuth.clearSuperadminClubContext();
        window.location.href = 'dashboard-superadmin.html';
        return;
      }
      await sb().auth.signOut();
      window.location.href = 'index.html';
    });

    $('superadmin-club-back')?.addEventListener('click', () => {
      window.SCAuth.clearSuperadminClubContext();
      window.location.href = 'dashboard-superadmin.html';
    });

    if (ctx.asSuperadmin) {
      const logoutBtn = $('logout-btn');
      if (logoutBtn) logoutBtn.textContent = 'Volver';
    }
    $('btn-open-shift')?.addEventListener('click', async () => {
      if ($('btn-open-shift')?.disabled) return;
      try {
        if (ctx?.club?.id) await refreshOpeningFloatHint(ctx.club.id);
      } catch (_) {
        /* ignore */
      }
      openShiftOpenModal();
    });

    $('shift-open-confirm')?.addEventListener('click', async () => {
      try {
        await performOpenShift(ctx);
      } catch (e) {
        setStatus(e.message || 'No se pudo abrir el turno.', true);
      }
    });

    document.querySelectorAll('[data-shift-open-close]').forEach((el) => {
      el.addEventListener('click', () => closeShiftOpenModal());
    });

    $('btn-close-shift')?.addEventListener('click', async () => {
      const id = $('btn-close-shift').dataset.shiftId;
      if (!id) return;
      startCloseShiftFlow(id, ctx);
    });

    $('shift-close-confirm')?.addEventListener('click', () => {
      const cash = parseDecimalLoose($('close-cash-eur')?.value);
      const fl = parseDecimalLoose($('close-float-eur')?.value);
      if (Number.isNaN(cash) || cash < 0) {
        setStatus('Indica el dinero contado en caja.', true);
        $('close-cash-eur')?.focus();
        return;
      }
      if (Number.isNaN(fl) || fl < 0) {
        setStatus('Indica el cambio que dejas para el siguiente turno (0 si no dejas).', true);
        $('close-float-eur')?.focus();
        return;
      }
      shiftWizard.closeCash = cash;
      shiftWizard.closeFloat = fl;
      shiftWizard.noteClose = ($('note-close')?.value || '').trim();
      closeShiftCloseModal();
      renderWizardStockQuestion();
      openShiftWizardModal();
    });

    document.querySelectorAll('[data-shift-close-close]').forEach((el) => {
      el.addEventListener('click', () => closeShiftCloseModal());
    });

    const onCloseCashInput = () => updateShiftCloseDiff(shiftWizard.closeExpectedCash);
    $('close-cash-eur')?.addEventListener('input', onCloseCashInput);
    $('close-cash-eur')?.addEventListener('change', onCloseCashInput);

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
