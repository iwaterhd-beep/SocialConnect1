/**
 * Socios del club + resumen financiero desde ventas TPV (sin importación de datos).
 */
(function () {
  const sb = () => window.scSupabase;

  function $(id) {
    return document.getElementById(id);
  }

  let ctx = null;
  let membersUiBound = false;
  let membersCache = [];
  let membersSearch = '';
  let membersTypeFilter = '';
  let selectedMemberId = '';
  let financeVentasRange = '30d';
  let financeVentasFrom = '';
  let financeVentasTo = '';
  let financeVentasCategoryId = '';
  let financeVentasCategories = [];
  let financeVentasSearch = '';
  let financeVentasUiBound = false;

  const BUCKET = 'club_member_docs';
  const MAX_FILE_BYTES = 5242880;

  const SLOT_TO_COL = {
    avatar: 'avatar_path',
    dni_front: 'doc_dni_front_path',
    dni_back: 'doc_dni_back_path',
    passport: 'doc_passport_path',
  };
  const COL_TO_SLOT = Object.fromEntries(
    Object.entries(SLOT_TO_COL).map(([k, v]) => [v, k]),
  );

  const memberPendingFiles = {
    avatar: null,
    dni_front: null,
    dni_back: null,
    passport: null,
  };

  let memberLoadedPaths = {
    avatar_path: '',
    doc_dni_front_path: '',
    doc_dni_back_path: '',
    doc_passport_path: '',
  };

  let memberAvatarObjectUrl = null;
  /** Tipo al abrir el formulario (para no borrar vip_rule_period_start del VIP automático al guardar). */
  let memberEditInitialType = 'standard';
  let memberWalletLoadedBalance = 0;

  function extFromFile(f) {
    const n = f.name || '';
    const i = n.lastIndexOf('.');
    if (i >= 0) {
      const e = n
        .slice(i + 1)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (e) return e.slice(0, 8);
    }
    if (f.type === 'image/png') return 'png';
    if (f.type === 'image/jpeg' || f.type === 'image/jpg') return 'jpg';
    if (f.type === 'image/webp') return 'webp';
    if (f.type === 'application/pdf') return 'pdf';
    return 'bin';
  }

  function isMissingStorageColErr(e) {
    if (!e) return false;
    if (e.code === '42703') return true;
    const m = e.message || '';
    return m.includes('avatar_path') || m.includes('doc_dni_');
  }

  function slotToFileId(slot) {
    if (slot === 'avatar') return 'member-file-avatar';
    if (slot === 'dni_front') return 'member-file-dni-front';
    if (slot === 'dni_back') return 'member-file-dni-back';
    return 'member-file-passport';
  }

  function fileIdToSlot(fid) {
    if (fid === 'member-file-avatar') return 'avatar';
    if (fid === 'member-file-dni-front') return 'dni_front';
    if (fid === 'member-file-dni-back') return 'dni_back';
    return 'passport';
  }

  function revokeAvatarObjectUrl() {
    if (memberAvatarObjectUrl) {
      URL.revokeObjectURL(memberAvatarObjectUrl);
      memberAvatarObjectUrl = null;
    }
  }

  function docLabelText(slot) {
    const col = SLOT_TO_COL[slot];
    const pending = memberPendingFiles[slot];
    if (pending) return pending.name;
    const path = memberLoadedPaths[col];
    if (path) {
      const leaf = path.split('/').pop();
      return leaf || 'Archivo guardado';
    }
    return 'Sin archivo';
  }

  function updateAllDocLabels() {
    const f = $('member-doc-front-label');
    const b = $('member-doc-back-label');
    const p = $('member-doc-pass-label');
    if (f) f.textContent = docLabelText('dni_front');
    if (b) b.textContent = docLabelText('dni_back');
    if (p) p.textContent = docLabelText('passport');
  }

  async function refreshAvatarPreview() {
    const img = $('member-avatar-img');
    const initials = $('member-avatar-initials');
    if (!img || !initials) return;
    revokeAvatarObjectUrl();
    img.classList.add('is-hidden');
    img.removeAttribute('src');

    if (memberPendingFiles.avatar) {
      memberAvatarObjectUrl = URL.createObjectURL(memberPendingFiles.avatar);
      img.src = memberAvatarObjectUrl;
      img.classList.remove('is-hidden');
      initials.style.display = 'none';
      return;
    }

    const p = memberLoadedPaths.avatar_path;
    if (p) {
      const { data, error } = await sb()
        .storage.from(BUCKET)
        .createSignedUrl(p, 3600);
      if (!error && data?.signedUrl) {
        img.src = data.signedUrl;
        img.classList.remove('is-hidden');
        initials.style.display = 'none';
        return;
      }
    }

    initials.style.display = '';
    updateMemberAvatarInitials();
  }

  async function clearMemberSlot(slot) {
    if (!SLOT_TO_COL[slot]) return;
    memberPendingFiles[slot] = null;
    const col = SLOT_TO_COL[slot];
    const mid = ($('member-edit-id')?.value || '').trim();

    if (mid && memberLoadedPaths[col]) {
      const oldPath = memberLoadedPaths[col];
      const { error: remErr } = await sb().storage.from(BUCKET).remove([oldPath]);
      if (remErr && !String(remErr.message || '').toLowerCase().includes('not found')) {
        setMemberMsg(remErr.message || 'No se pudo borrar el archivo en Storage.', true);
        return;
      }
      const { error: upErr } = await sb()
        .from('club_members')
        .update({ [col]: '' })
        .eq('id', mid);
      if (upErr) {
        if (isMissingStorageColErr(upErr)) {
          setMemberMsg(
            'Ejecuta la migración 012_club_member_storage.sql en Supabase.',
            true,
          );
        } else {
          setMemberMsg(upErr.message || 'No se pudo actualizar el socio.', true);
        }
        return;
      }
    }
    memberLoadedPaths[col] = '';

    if (slot === 'avatar') await refreshAvatarPreview();
    else updateAllDocLabels();
    setMemberMsg('', false);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMoney(n) {
    const x = Number(n);
    if (Number.isNaN(x)) return '—';
    return x.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
  }

  function formatQty(n) {
    const x = Number(n);
    if (Number.isNaN(x)) return '—';
    return x.toLocaleString('es-ES', { maximumFractionDigits: 3 });
  }

  function setMemberMsg(text, isError) {
    const el = $('member-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  function setFinanceMsg(text, isError) {
    const el = $('finance-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  function bindFinanceShiftClosuresUiOnce() {
    const tbody = $('finance-shifts-tbody');
    if (!tbody || tbody.dataset.scFinanceShiftsBound === '1') return;
    tbody.dataset.scFinanceShiftsBound = '1';
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-shift-detail]');
      if (!btn || !ctx) return;
      const sid = btn.getAttribute('data-shift-detail');
      if (!sid) return;
      if (
        typeof window.scClubGetShiftSummaryHtml !== 'function' ||
        typeof window.scClubShowShiftSummaryModal !== 'function'
      ) {
        setFinanceMsg('Abre primero la pestaña Inicio para cargar el panel de turnos, o recarga la página.', true);
        return;
      }
      try {
        setFinanceMsg('Cargando detalle del cierre…', false);
        const html = await window.scClubGetShiftSummaryHtml(ctx.club.id, sid);
        window.scClubShowShiftSummaryModal(html);
        setFinanceMsg('', false);
      } catch (err) {
        setFinanceMsg(err.message || 'No se pudo cargar el resumen del turno.', true);
      }
    });
  }

  async function refreshFinanceShiftClosures() {
    const tbody = $('finance-shifts-tbody');
    const emptyEl = $('finance-shifts-empty');
    if (!tbody || !ctx) return;
    bindFinanceShiftClosuresUiOnce();

    const { data: shifts, error } = await sb()
      .from('shifts')
      .select('id, opened_at, closed_at, opened_by, closed_by')
      .eq('club_id', ctx.club.id)
      .not('closed_at', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(50);

    if (error) {
      tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
      if (emptyEl) emptyEl.hidden = true;
      return;
    }

    const rows = shifts || [];
    let staffMap = {};
    try {
      const { data: sd } = await sb().rpc('club_staff_directory');
      (sd || []).forEach((row) => {
        const id = row.user_id ?? row.userId;
        if (id && row.email) staffMap[id] = row.email;
      });
    } catch (e) {
      /* ignore */
    }
    const lab = (uid) => (uid && staffMap[uid] ? staffMap[uid] : '—');

    tbody.innerHTML = '';
    if (!rows.length) {
      if (emptyEl) {
        emptyEl.hidden = false;
      }
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(row.closed_at).toLocaleString())}</td>
        <td>${escapeHtml(new Date(row.opened_at).toLocaleString())}</td>
        <td>${escapeHtml(lab(row.opened_by))}</td>
        <td>${escapeHtml(lab(row.closed_by))}</td>
        <td class="actions"><button type="button" class="btn btn--ghost btn--small" data-shift-detail="${row.id}">Ver cierre</button></td>
      `;
      tbody.appendChild(tr);
    });
  }

  function memberTypeLabel(t) {
    if (t === 'premium') return 'Premium';
    if (t === 'vip') return 'VIP';
    return 'Estándar';
  }

  function isMemberTierExpired(m) {
    const t = m.member_type || 'standard';
    if (t !== 'premium' && t !== 'vip') return false;
    const vu = m.member_type_valid_until;
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

  function isActiveVipMember(m) {
    if (!m || (m.member_type || 'standard') !== 'vip') return false;
    return !isMemberTierExpired(m);
  }

  function syncMemberProfileModalVipClass(m) {
    const on = isActiveVipMember(m);
    const modal = $('member-profile-modal');
    const hero = document.querySelector('#member-profile-modal .member-profile-hero');
    if (modal) modal.classList.toggle('is-vip-member', on);
    if (hero) hero.classList.toggle('member-profile-hero--vip', on);
  }

  function memberTypeShortSuffix(m) {
    const t = m.member_type || 'standard';
    if (t === 'vip') return isMemberTierExpired(m) ? ' · VIP cad.' : ' · VIP';
    if (t === 'premium') return isMemberTierExpired(m) ? ' · Prem. cad.' : ' · Premium';
    return '';
  }

  function memberTypePillHtml(m) {
    const t = m.member_type || 'standard';
    const expired = isMemberTierExpired(m);
    const base = memberTypeLabel(t);
    const label = expired ? `${base} caducado` : base;
    let cls = 'member-type-pill';
    if (t === 'vip') cls += ' member-type-pill--vip';
    else if (t === 'premium') cls += ' member-type-pill--premium';
    else cls += ' member-type-pill--standard';
    if (expired) cls += ' member-type-pill--expired';
    return `<span class="${cls}">${escapeHtml(label)}</span>`;
  }

  function memberTierDetailLine(m) {
    const t = m.member_type || 'standard';
    const parts = [];
    if (t === 'premium' || t === 'vip') {
      const vu = m.member_type_valid_until;
      if (vu != null && String(vu).trim() !== '') {
        const iso = String(vu).slice(0, 10);
        try {
          const d = new Date(iso + 'T12:00:00');
          parts.push(`Vigencia tipo: hasta ${d.toLocaleDateString('es-ES')}`);
        } catch (e) {
          parts.push(`Vigencia tipo: hasta ${iso}`);
        }
      } else {
        parts.push('Vigencia tipo: sin fecha de caducidad');
      }
      if (isMemberTierExpired(m)) parts.push('Estado: caducado (revisar o renovar)');
    }
    return parts.join(' · ');
  }

  function memberMatchesType(m) {
    if (!membersTypeFilter) return true;
    if (membersTypeFilter === 'expired') {
      return isMemberTierExpired(m);
    }
    return (m.member_type || 'standard') === membersTypeFilter;
  }
  function memberMatchesSearch(m, q) {
    const t = String(q || '')
      .trim()
      .toLowerCase();
    if (!t) return true;
    const fields = [
      m.display_name,
      m.first_name,
      m.last_name,
      m.dni,
      m.phone,
      m.member_code,
      m.email,
    ];
    return fields.some((x) => String(x || '').toLowerCase().includes(t));
  }

  function setMemberProfilePlaceholder(text) {
    const sum = $('member-profile-summary');
    const meta = $('member-profile-meta');
    const tbody = $('member-dispenses-tbody');
    const c = $('member-profile-kpi-count');
    const t = $('member-profile-kpi-total');
    if (sum) sum.textContent = text || '';
    if (meta) meta.textContent = '';
    if (c) c.textContent = '0';
    if (t) t.textContent = formatMoney(0);
    const w = $('member-profile-kpi-wallet');
    if (w) {
      w.textContent = formatMoney(0);
      w.classList.remove('member-profile-kpi__value--neg');
    }
    const adjustWrap = $('member-wallet-adjust');
    if (adjustWrap) {
      adjustWrap.classList.add('is-hidden');
      adjustWrap.hidden = true;
    }
    const ledgerWrap = $('member-wallet-ledger-wrap');
    if (ledgerWrap) {
      ledgerWrap.classList.add('is-hidden');
      ledgerWrap.hidden = true;
    }
    const ledgerTbody = $('member-wallet-ledger-tbody');
    if (ledgerTbody) ledgerTbody.innerHTML = '<tr><td colspan="5">Sin datos.</td></tr>';
    const ledgerEmpty = $('member-wallet-ledger-empty');
    if (ledgerEmpty) {
      ledgerEmpty.classList.add('is-hidden');
      ledgerEmpty.hidden = true;
    }
    if (tbody) tbody.innerHTML = '<tr><td colspan="5">Sin datos.</td></tr>';
    const img = $('member-profile-avatar-img');
    const initials = $('member-profile-avatar-initials');
    if (img) {
      img.onload = null;
      img.onerror = null;
      img.classList.add('is-hidden');
      img.removeAttribute('src');
      img.alt = '';
    }
    if (initials) {
      initials.textContent = '?';
      initials.setAttribute('aria-hidden', 'false');
    }
    syncMemberProfileModalVipClass(null);
  }

  function getInitialsFromDisplayName(name) {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return '?';
    const a = parts[0]?.[0] || '';
    const b = parts.length > 1 ? parts[1]?.[0] || '' : '';
    return (a + b).toUpperCase();
  }

  async function renderMemberProfileHero(m, dispenseCount, totalSpent) {
    const img = $('member-profile-avatar-img');
    const initials = $('member-profile-avatar-initials');
    const c = $('member-profile-kpi-count');
    const t = $('member-profile-kpi-total');
    const w = $('member-profile-kpi-wallet');
    if (c) c.textContent = String(dispenseCount || 0);
    if (t) t.textContent = formatMoney(totalSpent || 0);
    if (w) {
      const bal = m?.wallet_balance_eur != null ? Number(m.wallet_balance_eur) : 0;
      w.textContent = formatMoney(Number.isNaN(bal) ? 0 : bal);
      w.classList.toggle('member-profile-kpi__value--neg', !Number.isNaN(bal) && bal < 0);
    }
    if (!img || !initials) return;

    img.onload = null;
    img.onerror = null;
    img.classList.add('is-hidden');
    img.removeAttribute('src');
    img.alt = '';
    initials.textContent = getInitialsFromDisplayName(m?.display_name);
    initials.setAttribute('aria-hidden', 'false');

    const showInitialsOnly = () => {
      img.classList.add('is-hidden');
      img.removeAttribute('src');
      img.alt = '';
      initials.setAttribute('aria-hidden', 'false');
    };

    const avatarPath = m?.avatar_path ? String(m.avatar_path) : '';
    if (!avatarPath) return;

    const { data, error } = await sb().storage.from(BUCKET).createSignedUrl(avatarPath, 3600);
    if (error || !data?.signedUrl) {
      showInitialsOnly();
      return;
    }

    img.onload = () => {
      img.classList.remove('is-hidden');
      initials.setAttribute('aria-hidden', 'true');
    };
    img.onerror = () => {
      showInitialsOnly();
    };
    img.alt = m?.display_name ? `Foto de ${String(m.display_name)}` : 'Avatar del socio';
    img.src = data.signedUrl;
    if (img.complete && img.naturalWidth > 0) {
      img.classList.remove('is-hidden');
      initials.setAttribute('aria-hidden', 'true');
    }
  }

  function openMemberProfileModal() {
    const modal = $('member-profile-modal');
    if (!modal) return;
    modal.classList.remove('is-hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeMemberProfileModal() {
    const modal = $('member-profile-modal');
    if (!modal) return;
    modal.classList.add('is-hidden');
    modal.setAttribute('aria-hidden', 'true');
    syncMemberProfileModalVipClass(null);
  }

  async function editMemberFromRow(memberId) {
    const { data: row, error: e2 } = await sb()
      .from('club_members')
      .select('*')
      .eq('id', memberId)
      .maybeSingle();
    if (e2 || !row) {
      setMemberMsg(e2?.message || 'No se pudo cargar.', true);
      return;
    }
    $('member-edit-id').value = row.id;
    $('member-first-name').value = row.first_name || '';
    $('member-last-name').value = row.last_name || '';
    if (
      !($('member-first-name').value || '').trim() &&
      !($('member-last-name').value || '').trim() &&
      row.display_name
    ) {
      const dn = String(row.display_name).trim();
      const sp = dn.indexOf(' ');
      if (sp > 0) {
        $('member-first-name').value = dn.slice(0, sp).trim();
        $('member-last-name').value = dn.slice(sp + 1).trim();
      } else {
        $('member-first-name').value = dn;
      }
    }
    $('member-dni').value = row.dni || '';
    $('member-birth').value = row.birth_date ? String(row.birth_date).slice(0, 10) : '';
    $('member-phone').value = row.phone || '';
    $('member-email').value = row.email || '';
    $('member-code').value = row.member_code || '';
    $('member-enrollment-fee').value =
      row.enrollment_fee_eur != null && row.enrollment_fee_eur !== '' ? String(row.enrollment_fee_eur) : '';
    if ($('member-wallet-balance')) {
      $('member-wallet-balance').value =
        row.wallet_balance_eur != null && row.wallet_balance_eur !== ''
          ? String(row.wallet_balance_eur)
          : '0';
    }
    memberWalletLoadedBalance =
      row.wallet_balance_eur != null && !Number.isNaN(Number(row.wallet_balance_eur))
        ? Number(row.wallet_balance_eur)
        : 0;
    $('member-notes').value = row.notes || '';
    $('member-active').checked = !!row.is_active;
    setMemberTypeUi(row.member_type || 'standard');
    if ($('member-type-valid-until')) {
      $('member-type-valid-until').value =
        row.member_type_valid_until != null && String(row.member_type_valid_until).trim() !== ''
          ? String(row.member_type_valid_until).slice(0, 10)
          : '';
    }
    const title = $('members-form-title');
    if (title) title.textContent = 'Editar socio';
    memberLoadedPaths = {
      avatar_path: row.avatar_path || '',
      doc_dni_front_path: row.doc_dni_front_path || '',
      doc_dni_back_path: row.doc_dni_back_path || '',
      doc_passport_path: row.doc_passport_path || '',
    };
    memberPendingFiles.avatar = null;
    memberPendingFiles.dni_front = null;
    memberPendingFiles.dni_back = null;
    memberPendingFiles.passport = null;
    revokeAvatarObjectUrl();
    await refreshAvatarPreview();
    updateAllDocLabels();
    setMemberMsg('Editando socio.', false);
    memberEditInitialType = row.member_type || 'standard';
  }

  async function showMemberProfile(memberId) {
    const m = membersCache.find((x) => x.id === memberId);
    if (!m) {
      setMemberProfilePlaceholder('Selecciona un socio para ver su detalle.');
      return;
    }
    selectedMemberId = memberId;
    openMemberProfileModal();
    syncMemberProfileModalVipClass(m);
    const sum = $('member-profile-summary');
    const meta = $('member-profile-meta');
    const tbody = $('member-dispenses-tbody');
    if (!sum || !meta || !tbody) return;

    const type = memberTypeLabel(m.member_type || 'standard');
    sum.textContent = `${m.display_name} · ${m.is_active ? 'Activo' : 'Inactivo'} · ${type}${
      isMemberTierExpired(m) ? ' (caducado)' : ''
    }`;
    meta.textContent = 'Cargando dispensaciones…';
    tbody.innerHTML = '<tr><td colspan="5">Cargando…</td></tr>';
    const adjustWrap = $('member-wallet-adjust');
    if (adjustWrap) {
      adjustWrap.classList.remove('is-hidden');
      adjustWrap.hidden = false;
    }
    const adjustStatus = $('member-wallet-adjust-status');
    if (adjustStatus) adjustStatus.textContent = '';
    await renderMemberProfileHero(m, 0, 0);
    const ledgerPromise = renderMemberWalletLedger(memberId);

    let { data: allRows, error: allErr } = await sb()
      .from('tpv_dispenses')
      .select('id, created_at, product_id, grams_charged, grams_dispensed, price_charged_eur, notes')
      .eq('club_id', ctx.club.id)
      .eq('member_id', memberId)
      .order('created_at', { ascending: false })
      .limit(5000);

    if (allErr && (allErr.code === '42703' || String(allErr.message || '').includes('member_id'))) {
      meta.textContent = '';
      tbody.innerHTML =
        '<tr><td colspan="5">Ejecuta la migración 010_club_members_finance.sql para ver historial por socio.</td></tr>';
      await ledgerPromise;
      return;
    }
    if (allErr) {
      meta.textContent = '';
      tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(allErr.message || 'Error cargando historial.')}</td></tr>`;
      await ledgerPromise;
      return;
    }

    const rows = allRows || [];
    const totalSpent = rows.reduce((acc, r) => acc + (Number(r.price_charged_eur) || 0), 0);
    const ids = [...new Set(rows.map((r) => r.product_id).filter(Boolean))];
    let prodMap = {};
    if (ids.length) {
      const { data: prods } = await sb().from('inventory_products').select('id, name, emoji').in('id', ids);
      if (prods) prodMap = Object.fromEntries(prods.map((p) => [p.id, p]));
    }

    const extra = [];
    if (m.member_type === 'premium' || m.member_type === 'vip') {
      const te = memberTierDetailLine(m);
      if (te) extra.push(te);
    }
    if (m.member_code) extra.push(`Código: ${m.member_code}`);
    if (m.dni) extra.push(`DNI: ${m.dni}`);
    if (m.phone) extra.push(`Tel: ${m.phone}`);
    if (m.email) extra.push(`Email: ${m.email}`);
    meta.textContent = extra.join(' · ');
    await renderMemberProfileHero(m, rows.length, totalSpent);

    await ledgerPromise;

    const recent = rows.slice(0, 100);
    tbody.innerHTML = '';
    if (!recent.length) {
      tbody.innerHTML = '<tr><td colspan="5">Este socio no tiene dispensaciones todavía.</td></tr>';
      return;
    }
    recent.forEach((r) => {
      const pr = prodMap[r.product_id] || {};
      const em = (pr.emoji || '').trim();
      const label = `${em ? em + ' ' : ''}${pr.name || '—'}`;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
        <td>${escapeHtml(label)}</td>
        <td>${escapeHtml(formatQty(r.grams_charged))} / ${escapeHtml(formatQty(r.grams_dispensed))}</td>
        <td>${escapeHtml(formatMoney(r.price_charged_eur))}</td>
        <td>${escapeHtml((r.notes || '').slice(0, 40))}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function setMemberTypeUi(value) {
    const v = value === 'premium' || value === 'vip' ? value : 'standard';
    const hidden = $('member-type-value');
    if (hidden) hidden.value = v;
    document.querySelectorAll('[data-member-type]').forEach((btn) => {
      const on = btn.getAttribute('data-member-type') === v;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const wrap = $('member-type-valid-wrap');
    const show = v === 'premium' || v === 'vip';
    if (wrap) {
      wrap.hidden = !show;
      wrap.classList.toggle('is-hidden', !show);
    }
    if (!show && $('member-type-valid-until')) $('member-type-valid-until').value = '';
  }

  function updateMemberAvatarInitials() {
    const el = $('member-avatar-initials');
    if (!el) return;
    const a = ($('member-first-name')?.value || '').trim();
    const b = ($('member-last-name')?.value || '').slice(0, 1).trim();
    const ca = a ? a.slice(0, 1).toUpperCase() : '';
    const cb = b ? b.toUpperCase() : '';
    const t = (ca + cb).trim();
    el.textContent = t || '?';
  }

  function clearMemberForm() {
    memberEditInitialType = 'standard';
    $('member-edit-id').value = '';
    $('member-first-name').value = '';
    $('member-last-name').value = '';
    $('member-dni').value = '';
    $('member-birth').value = '';
    $('member-phone').value = '';
    $('member-email').value = '';
    $('member-code').value = '';
    $('member-enrollment-fee').value = '';
    if ($('member-wallet-balance')) $('member-wallet-balance').value = '0';
    memberWalletLoadedBalance = 0;
    $('member-notes').value = '';
    $('member-active').checked = true;
    setMemberTypeUi('standard');
    if ($('member-type-valid-until')) $('member-type-valid-until').value = '';
    const title = $('members-form-title');
    if (title) title.textContent = 'Nuevo socio';
    memberPendingFiles.avatar = null;
    memberPendingFiles.dni_front = null;
    memberPendingFiles.dni_back = null;
    memberPendingFiles.passport = null;
    memberLoadedPaths = {
      avatar_path: '',
      doc_dni_front_path: '',
      doc_dni_back_path: '',
      doc_passport_path: '',
    };
    revokeAvatarObjectUrl();
    const img = $('member-avatar-img');
    const initials = $('member-avatar-initials');
    if (img) {
      img.classList.add('is-hidden');
      img.removeAttribute('src');
    }
    if (initials) initials.style.display = '';
    updateMemberAvatarInitials();
    updateAllDocLabels();
  }

  function renderMembersTable() {
    const tbody = $('members-tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    membersCache
      .filter((m) => memberMatchesSearch(m, membersSearch) && memberMatchesType(m))
      .forEach((m) => {
      const tr = document.createElement('tr');
      if (isActiveVipMember(m)) tr.classList.add('member-row--vip');
      const dni =
        m.dni != null && String(m.dni).trim() !== ''
          ? String(m.dni).trim()
          : '—';
      const wallet =
        m.wallet_balance_eur != null && !Number.isNaN(Number(m.wallet_balance_eur))
          ? formatMoney(Number(m.wallet_balance_eur))
          : '—';
      const walletNeg =
        m.wallet_balance_eur != null && Number(m.wallet_balance_eur) < 0 ? ' member-wallet-cell--neg' : '';
      tr.innerHTML = `
        <td>${escapeHtml(m.display_name)}</td>
        <td>${escapeHtml(dni)}</td>
        <td>${memberTypePillHtml(m)}</td>
        <td class="member-wallet-cell${walletNeg}">${escapeHtml(wallet)}</td>
        <td>${escapeHtml(m.phone || '—')}</td>
        <td>${m.is_active ? '<span class="badge-stock badge-stock--ok">Activo</span>' : '<span class="badge-stock badge-stock--out">Inactivo</span>'}</td>
        <td class="actions">
          <button type="button" class="btn btn--ghost btn--small" data-profile-member="${m.id}">Perfil</button>
          <button type="button" class="btn btn--ghost btn--small" data-edit-member="${m.id}">Editar</button>
        </td>
      `;
      tr.querySelector('[data-profile-member]')?.addEventListener('click', () => {
        showMemberProfile(m.id);
      });
      tr.querySelector('[data-edit-member]')?.addEventListener('click', () => {
        void editMemberFromRow(m.id);
      });
      tbody.appendChild(tr);
    });
  }

  async function loadMembersTable() {
    const tbody = $('members-tbody');
    if (!tbody || !ctx) return;

    try {
      const { error: tickErr } = await sb().rpc('club_members_vip_rule_tick_club', {
        p_club_id: ctx.club.id,
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
      /* RPC opcional hasta aplicar migración 027 */
    }

    const { data, error } = await sb()
      .from('club_members')
      .select('*')
      .eq('club_id', ctx.club.id)
      .order('display_name', { ascending: true });

    if (error) throw error;
    membersCache = data || [];
    renderMembersTable();
    if (selectedMemberId) {
      if (membersCache.some((m) => m.id === selectedMemberId)) {
        await showMemberProfile(selectedMemberId);
      } else {
        selectedMemberId = '';
        setMemberProfilePlaceholder('Selecciona un socio para ver su detalle.');
      }
    } else {
      setMemberProfilePlaceholder('Selecciona un socio para ver su detalle.');
    }

    if (typeof window.scClubInventoryReloadMembers === 'function') {
      await window.scClubInventoryReloadMembers();
    }
  }

  async function uploadPendingAssets(memberId) {
    const pathUpdates = {};
    for (const slot of Object.keys(SLOT_TO_COL)) {
      const file = memberPendingFiles[slot];
      if (!file) continue;
      if (file.size > MAX_FILE_BYTES) {
        setMemberMsg('Algún archivo supera 5 MB.', true);
        return { ok: false };
      }
      const ext = extFromFile(file);
      const col = SLOT_TO_COL[slot];
      const objectPath = `${ctx.club.id}/${memberId}/${slot}.${ext}`;
      const { error: upErr } = await sb().storage.from(BUCKET).upload(objectPath, file, {
        contentType: file.type || 'application/octet-stream',
        upsert: true,
      });
      if (upErr) {
        setMemberMsg(
          upErr.message ||
            'Error en Storage: ejecuta 012_club_member_storage.sql (bucket club_member_docs).',
          true,
        );
        return { ok: false };
      }
      pathUpdates[col] = objectPath;
    }
    return { ok: true, pathUpdates };
  }

  function setMemberWalletAdjustStatus(text, isError) {
    const el = $('member-wallet-adjust-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (isError ? ' msg--error' : text ? ' msg--ok' : '');
  }

  function walletLedgerKindLabel(kind) {
    const k = String(kind || '').toLowerCase();
    if (k === 'tpv_sale') return 'Venta TPV';
    if (k === 'tpv_void') return 'Anulación TPV';
    return 'Ajuste';
  }

  function formatWalletLedgerAmount(amt) {
    const n = Number(amt);
    if (Number.isNaN(n)) return '—';
    const abs = formatMoney(Math.abs(n));
    if (n > 0.0001) return `+${abs}`;
    if (n < -0.0001) return `−${abs}`;
    return formatMoney(0);
  }

  async function renderMemberWalletLedger(memberId) {
    const wrap = $('member-wallet-ledger-wrap');
    const tbody = $('member-wallet-ledger-tbody');
    const emptyEl = $('member-wallet-ledger-empty');
    const tableWrap = wrap?.querySelector('.member-wallet-ledger__table');
    if (!wrap || !tbody) return;

    wrap.classList.remove('is-hidden');
    wrap.hidden = false;
    tbody.innerHTML = '<tr><td colspan="5">Cargando…</td></tr>';
    if (emptyEl) {
      emptyEl.classList.add('is-hidden');
      emptyEl.hidden = true;
    }
    if (tableWrap) {
      tableWrap.classList.remove('is-hidden');
      tableWrap.hidden = false;
    }

    const { data, error } = await sb()
      .from('club_member_wallet_ledger')
      .select('created_at, amount_eur, balance_after_eur, kind, notes')
      .eq('member_id', memberId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      const msg =
        error.code === 'PGRST205' ||
        error.code === '42P01' ||
        String(error.message || '').toLowerCase().includes('club_member_wallet_ledger')
          ? 'Ejecuta la migración 028_member_wallet.sql en Supabase.'
          : error.message || 'No se pudo cargar el historial.';
      tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(msg)}</td></tr>`;
      return;
    }

    const rows = data || [];
    if (!rows.length) {
      tbody.innerHTML = '';
      if (tableWrap) {
        tableWrap.classList.add('is-hidden');
        tableWrap.hidden = true;
      }
      if (emptyEl) {
        emptyEl.classList.remove('is-hidden');
        emptyEl.hidden = false;
      }
      return;
    }

    tbody.innerHTML = '';
    rows.forEach((r) => {
      const amt = Number(r.amount_eur);
      const bal = Number(r.balance_after_eur);
      const amtClass = !Number.isNaN(amt) && amt < 0 ? ' member-wallet-ledger-amt--neg' : '';
      const balClass = !Number.isNaN(bal) && bal < 0 ? ' member-wallet-ledger-bal--neg' : '';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
        <td>${escapeHtml(walletLedgerKindLabel(r.kind))}</td>
        <td class="member-wallet-ledger-amt${amtClass}">${escapeHtml(formatWalletLedgerAmount(amt))}</td>
        <td class="member-wallet-ledger-bal${balClass}">${escapeHtml(formatMoney(Number.isNaN(bal) ? 0 : bal))}</td>
        <td>${escapeHtml((r.notes || '').slice(0, 80))}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  async function syncMemberWalletFromForm(memberId) {
    const walletEl = $('member-wallet-balance');
    if (!walletEl || !memberId) return { ok: true };
    const raw = (walletEl.value || '').trim().replace(',', '.');
    const newBal = raw === '' ? 0 : Number(raw);
    if (Number.isNaN(newBal)) {
      return { ok: false, message: 'Saldo de monedero no válido.' };
    }
    const delta = Math.round((newBal - memberWalletLoadedBalance) * 100) / 100;
    if (Math.abs(delta) < 0.0001) return { ok: true };
    const { error } = await sb().rpc('club_member_wallet_adjust', {
      p_member_id: memberId,
      p_delta_eur: delta,
      p_notes: 'Ajuste desde ficha socio',
    });
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') {
        return { ok: false, message: 'Ejecuta la migración 028_member_wallet.sql en Supabase.' };
      }
      return { ok: false, message: error.message || 'No se pudo actualizar el monedero.' };
    }
    memberWalletLoadedBalance = newBal;
    return { ok: true };
  }

  async function applyMemberWalletAdjust() {
    if (!selectedMemberId) {
      setMemberWalletAdjustStatus('Abre el perfil de un socio primero.', true);
      return;
    }
    const amtRaw = ($('member-wallet-adjust-amount')?.value || '').trim().replace(',', '.');
    const notes = ($('member-wallet-adjust-notes')?.value || '').trim();
    const amt = amtRaw === '' ? NaN : Number(amtRaw);
    if (Number.isNaN(amt) || Math.abs(amt) < 0.0001) {
      setMemberWalletAdjustStatus('Indica un importe distinto de cero (positivo = recarga).', true);
      return;
    }
    setMemberWalletAdjustStatus('Aplicando…', false);
    const { error } = await sb().rpc('club_member_wallet_adjust', {
      p_member_id: selectedMemberId,
      p_delta_eur: amt,
      p_notes: notes || 'Ajuste manual',
    });
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') {
        setMemberWalletAdjustStatus('Ejecuta la migración 028_member_wallet.sql en Supabase.', true);
      } else {
        setMemberWalletAdjustStatus(error.message || 'No se pudo aplicar.', true);
      }
      return;
    }
    if ($('member-wallet-adjust-amount')) $('member-wallet-adjust-amount').value = '';
    if ($('member-wallet-adjust-notes')) $('member-wallet-adjust-notes').value = '';
    setMemberWalletAdjustStatus('Monedero actualizado.', false);
    await loadMembersTable();
    if (typeof window.scClubInventoryReloadMembers === 'function') {
      await window.scClubInventoryReloadMembers();
    }
    await showMemberProfile(selectedMemberId);
  }

  async function saveMember() {
    const id = ($('member-edit-id')?.value || '').trim();
    const first = ($('member-first-name')?.value || '').trim();
    const last = ($('member-last-name')?.value || '').trim();
    const display_name = [first, last].filter(Boolean).join(' ').trim();
    const member_code = ($('member-code')?.value || '').trim();
    const dni = ($('member-dni')?.value || '').trim();
    const phone = ($('member-phone')?.value || '').trim();
    const email = ($('member-email')?.value || '').trim();
    const birthRaw = ($('member-birth')?.value || '').trim();
    const notes = ($('member-notes')?.value || '').trim();
    const is_active = $('member-active')?.checked !== false;
    const mtRaw = ($('member-type-value')?.value || 'standard').trim();
    const member_type = mtRaw === 'premium' || mtRaw === 'vip' ? mtRaw : 'standard';
    const validRaw = ($('member-type-valid-until')?.value || '').trim();
    let member_type_valid_until = null;
    if (member_type === 'premium' || member_type === 'vip') {
      member_type_valid_until = validRaw === '' ? null : validRaw;
    }
    const feeRaw = ($('member-enrollment-fee')?.value || '').trim();
    let enrollment_fee_eur = feeRaw === '' ? 0 : Number(feeRaw);
    if (Number.isNaN(enrollment_fee_eur) || enrollment_fee_eur < 0) {
      setMemberMsg('Cuota de inscripción no válida.', true);
      return;
    }

    if (!display_name) {
      setMemberMsg('Indica al menos nombre o apellidos.', true);
      return;
    }

    setMemberMsg('Guardando…', false);
    const row = {
      club_id: ctx.club.id,
      display_name,
      first_name: first,
      last_name: last,
      dni,
      member_code,
      phone,
      email,
      birth_date: birthRaw === '' ? null : birthRaw,
      notes,
      is_active,
      member_type,
      member_type_valid_until,
      enrollment_fee_eur,
    };

    if (member_type !== 'vip') {
      row.vip_rule_period_start = null;
    } else if (!id || memberEditInitialType !== 'vip') {
      row.vip_rule_period_start = null;
    }

    let memberId = id;
    let error;

    async function tryPersist(payload) {
      if (id) return sb().from('club_members').update(payload).eq('id', id);
      return sb().from('club_members').insert([payload]).select('id').single();
    }

    let r = await tryPersist(row);
    error = r.error;
    let savedWithoutValidUntilColumn = false;
    if (error && String(error.message || '').toLowerCase().includes('member_type_valid_until')) {
      const row2 = { ...row };
      delete row2.member_type_valid_until;
      r = await tryPersist(row2);
      error = r.error;
      if (!error) savedWithoutValidUntilColumn = true;
    }
    if (
      error &&
      (error.code === '42703' || String(error.message || '').toLowerCase().includes('vip_rule_period_start'))
    ) {
      const row3 = { ...row };
      delete row3.vip_rule_period_start;
      r = await tryPersist(row3);
      error = r.error;
    }

    if (!error) {
      if (id) memberId = id;
      else memberId = r.data?.id ? String(r.data.id) : '';
    }

    if (error) {
      if (
        error.code === '42703' ||
        (error.message &&
          (error.message.includes('first_name') ||
            error.message.includes('column')))
      ) {
        setMemberMsg(
          'Ejecuta la migración 011_club_members_profile.sql en Supabase para guardar el perfil completo.',
          true,
        );
      } else {
        setMemberMsg(error.message || 'No se pudo guardar.', true);
      }
      return;
    }

    const hadPending = Object.keys(SLOT_TO_COL).some((s) => memberPendingFiles[s]);
    if (memberId && hadPending) {
      const up = await uploadPendingAssets(memberId);
      if (!up.ok) return;
      const keys = Object.keys(up.pathUpdates || {});
      if (keys.length) {
        const { error: pe } = await sb()
          .from('club_members')
          .update(up.pathUpdates)
          .eq('id', memberId);
        if (pe) {
          if (isMissingStorageColErr(pe)) {
            setMemberMsg(
              'Socio guardado; ejecuta 012_club_member_storage.sql para enlazar archivos.',
              true,
            );
          } else {
            setMemberMsg(pe.message || 'No se pudieron guardar las rutas de archivos.', true);
          }
          await loadMembersTable();
          return;
        }
        Object.assign(memberLoadedPaths, up.pathUpdates);
        keys.forEach((col) => {
          const sl = COL_TO_SLOT[col];
          if (sl) memberPendingFiles[sl] = null;
        });
        await refreshAvatarPreview();
        updateAllDocLabels();
      }
    }

    if (memberId) {
      const walletSync = await syncMemberWalletFromForm(memberId);
      if (!walletSync.ok) {
        setMemberMsg(
          `${id ? 'Socio guardado' : 'Socio creado'}, pero el monedero no se actualizó: ${walletSync.message}`,
          true,
        );
        await loadMembersTable();
        if (typeof window.scClubInventoryReloadMembers === 'function') {
          await window.scClubInventoryReloadMembers();
        }
        return;
      }
    }

    setMemberMsg(
      savedWithoutValidUntilColumn
        ? 'Socio guardado. Ejecuta en Supabase la migración 021_club_members_tier_valid_until.sql para poder guardar la vigencia Premium/VIP.'
        : id
          ? 'Socio actualizado.'
          : 'Socio creado.',
      false,
    );
    clearMemberForm();
    await loadMembersTable();
    if (typeof window.scClubInventoryReloadMembers === 'function') {
      await window.scClubInventoryReloadMembers();
    }
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function endOfDay(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }

  function parseFinanceDateInput(str, asEnd) {
    const t = String(str || '').trim();
    if (!t) return null;
    const parts = t.split('-');
    if (parts.length !== 3) return null;
    const y = Number(parts[0]);
    const m = Number(parts[1]) - 1;
    const day = Number(parts[2]);
    if (!y || m < 0 || m > 11 || !day) return null;
    const dt = new Date(y, m, day);
    if (Number.isNaN(dt.getTime())) return null;
    return asEnd ? endOfDay(dt) : startOfDay(dt);
  }

  function mondayStartOfWeek(d) {
    const x = startOfDay(d);
    const day = x.getDay();
    const mondayOffset = (day + 6) % 7;
    x.setDate(x.getDate() - mondayOffset);
    return x;
  }

  function getFinanceVentasBounds() {
    const now = new Date();
    if (financeVentasRange === 'today') {
      return { from: startOfDay(now), to: null };
    }
    if (financeVentasRange === 'week') {
      return { from: mondayStartOfWeek(now), to: null };
    }
    if (financeVentasRange === '30d') {
      const from = startOfDay(now);
      from.setDate(from.getDate() - 30);
      return { from, to: null };
    }
    if (financeVentasRange === 'custom') {
      const from = parseFinanceDateInput(financeVentasFrom, false);
      const to = parseFinanceDateInput(financeVentasTo, true);
      return { from, to };
    }
    return { from: null, to: null };
  }

  function financeVentasRangeLabel() {
    if (financeVentasRange === 'today') return 'hoy';
    if (financeVentasRange === 'week') return 'esta semana';
    if (financeVentasRange === '30d') return 'los últimos 30 días';
    if (financeVentasRange === 'all') return 'todo el historial';
    if (financeVentasFrom && financeVentasTo) {
      return `del ${financeVentasFrom} al ${financeVentasTo}`;
    }
    if (financeVentasFrom) return `desde ${financeVentasFrom}`;
    if (financeVentasTo) return `hasta ${financeVentasTo}`;
    return 'el rango elegido';
  }

  function financeVentasCategoryLabel() {
    if (!financeVentasCategoryId) return '';
    const c = financeVentasCategories.find((x) => x.id === financeVentasCategoryId);
    return c ? c.name : 'la categoría elegida';
  }

  function financeVentasSearchLabel() {
    const q = financeVentasSearch.trim();
    return q ? `producto «${q}»` : '';
  }

  function financeVentasFilterSummaryParts() {
    const parts = [financeVentasRangeLabel()];
    const cat = financeVentasCategoryLabel();
    if (cat) parts.push(`categoría ${cat}`);
    const search = financeVentasSearchLabel();
    if (search) parts.push(search);
    return parts.join(' · ');
  }

  async function resolveFinanceVentasProductFilterIds() {
    const search = financeVentasSearch.trim();
    if (!financeVentasCategoryId && !search) return null;

    const build = (withArchivedFilter) => {
      let query = sb().from('inventory_products').select('id').eq('club_id', ctx.club.id);
      if (withArchivedFilter) query = query.eq('is_archived', false);
      if (financeVentasCategoryId) query = query.eq('category_id', financeVentasCategoryId);
      if (search) query = query.ilike('name', `%${search}%`);
      return query;
    };

    let { data, error } = await build(true);
    if (
      error &&
      (error.code === '42703' ||
        (error.message && String(error.message).toLowerCase().includes('column'))) &&
      String(error.message || '')
        .toLowerCase()
        .includes('is_archived')
    ) {
      ({ data, error } = await build(false));
    }
    if (error) throw error;
    return (data || []).map((p) => p.id).filter(Boolean);
  }

  async function loadFinanceVentasCategories() {
    if (!ctx) return;
    const { data, error } = await sb()
      .from('inventory_categories')
      .select('id, name, sort_order')
      .eq('club_id', ctx.club.id)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) {
      financeVentasCategories = [];
      return;
    }
    financeVentasCategories = data || [];
    renderFinanceVentasCategoryControls();
  }

  function renderFinanceVentasCategoryControls() {
    const select = $('finance-sales-category');
    if (select) {
      const current = financeVentasCategoryId || '';
      select.innerHTML = '<option value="">Todas las categorías</option>';
      financeVentasCategories.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        select.appendChild(opt);
      });
      select.value = current;
      if (select.value !== current) {
        financeVentasCategoryId = '';
        select.value = '';
      }
    }

    const row = $('finance-sales-cat-chips');
    if (!row) return;
    row.innerHTML = '';
    const mk = (label, val, active) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (active ? ' is-active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        financeVentasCategoryId = val;
        if ($('finance-sales-category')) $('finance-sales-category').value = val;
        renderFinanceVentasCategoryControls();
        void refreshFinanceVentasTpv();
      });
      row.appendChild(b);
    };
    mk('Todas', '', financeVentasCategoryId === '');
    financeVentasCategories.forEach((c) => mk(c.name, c.id, financeVentasCategoryId === c.id));
  }

  function renderFinanceVentasRangeChips() {
    document.querySelectorAll('[data-finance-sales-range]').forEach((btn) => {
      const active = btn.getAttribute('data-finance-sales-range') === financeVentasRange;
      btn.classList.toggle('is-active', active);
    });
    const customWrap = $('finance-ventas-custom');
    const showCustom = financeVentasRange === 'custom';
    if (customWrap) {
      customWrap.hidden = !showCustom;
      customWrap.classList.toggle('is-hidden', !showCustom);
    }
  }

  function bindFinanceVentasUiOnce() {
    if (financeVentasUiBound) return;
    financeVentasUiBound = true;

    document.querySelectorAll('[data-finance-sales-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-finance-sales-range') || '30d';
        financeVentasRange = next;
        renderFinanceVentasRangeChips();
        if (next !== 'custom') {
          void refreshFinanceVentasTpv();
        }
      });
    });

    $('finance-sales-apply')?.addEventListener('click', () => {
      financeVentasFrom = ($('finance-sales-from')?.value || '').trim();
      financeVentasTo = ($('finance-sales-to')?.value || '').trim();
      financeVentasRange = 'custom';
      renderFinanceVentasRangeChips();
      void refreshFinanceVentasTpv();
    });

    $('finance-sales-category')?.addEventListener('change', () => {
      financeVentasCategoryId = ($('finance-sales-category')?.value || '').trim();
      renderFinanceVentasCategoryControls();
      void refreshFinanceVentasTpv();
    });

    $('finance-sales-search')?.addEventListener('input', () => {
      financeVentasSearch = $('finance-sales-search')?.value || '';
      void refreshFinanceVentasTpv();
    });

    renderFinanceVentasRangeChips();
  }

  async function refreshFinanceKpis() {
    if (!ctx) return;
    const clubId = ctx.club.id;
    const now = new Date();
    const d0 = startOfDay(now);
    const d7 = startOfDay(now);
    d7.setDate(d7.getDate() - 7);
    const d30 = startOfDay(now);
    d30.setDate(d30.getDate() - 30);

    const { data: rows, error } = await sb()
      .from('tpv_dispenses')
      .select('price_charged_eur, created_at')
      .eq('club_id', clubId)
      .gte('created_at', d30.toISOString())
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      if (
        error.message &&
        (error.message.includes('member_id') || error.code === '42703')
      ) {
        setFinanceMsg(
          'Ejecuta la migración 010_club_members_finance.sql para enlazar socios y KPI completos.',
          true,
        );
      } else {
        setFinanceMsg(error.message || 'Error cargando ventas.', true);
      }
      return false;
    }

    const list = rows || [];
    let sumToday = 0;
    let sum7 = 0;
    let sum30 = 0;

    list.forEach((r) => {
      const t = new Date(r.created_at).getTime();
      const p = Number(r.price_charged_eur) || 0;
      if (t >= d0.getTime()) sumToday += p;
      if (t >= d7.getTime()) sum7 += p;
      sum30 += p;
    });

    $('finance-kpi-today').textContent = formatMoney(sumToday);
    $('finance-kpi-7d').textContent = formatMoney(sum7);
    $('finance-kpi-30d').textContent = formatMoney(sum30);
    return true;
  }

  async function refreshFinanceVentasTpv() {
    const ventasBody = $('finance-ventas-tbody');
    const summaryEl = $('finance-ventas-summary');
    const emptyEl = $('finance-ventas-empty');
    if (!ventasBody || !ctx) return;

    bindFinanceVentasUiOnce();
    await loadFinanceVentasCategories();

    if (financeVentasRange === 'custom' && !financeVentasFrom && !financeVentasTo) {
      ventasBody.innerHTML = '';
      if (summaryEl) {
        summaryEl.textContent = 'Indica al menos una fecha y pulsa «Aplicar fechas».';
      }
      if (emptyEl) emptyEl.hidden = true;
      return;
    }

    const bounds = getFinanceVentasBounds();
    if (financeVentasRange === 'custom' && !bounds.from && !bounds.to) {
      ventasBody.innerHTML = '';
      if (summaryEl) {
        summaryEl.textContent = 'Las fechas indicadas no son válidas.';
      }
      if (emptyEl) emptyEl.hidden = true;
      return;
    }

    let productFilterIds = null;
    try {
      productFilterIds = await resolveFinanceVentasProductFilterIds();
    } catch (prodErr) {
      ventasBody.innerHTML = `<tr><td colspan="4">${escapeHtml(prodErr.message)}</td></tr>`;
      if (summaryEl) summaryEl.textContent = '';
      if (emptyEl) emptyEl.hidden = true;
      return;
    }
    if (productFilterIds && !productFilterIds.length) {
      ventasBody.innerHTML = '';
      if (emptyEl) emptyEl.hidden = false;
      if (summaryEl) {
        summaryEl.textContent = `0 ventas en ${financeVentasFilterSummaryParts()}.`;
      }
      return;
    }

    let query = sb()
      .from('tpv_dispenses')
      .select('price_charged_eur, created_at, product_id, member_id')
      .eq('club_id', ctx.club.id)
      .order('created_at', { ascending: false });

    if (bounds.from) query = query.gte('created_at', bounds.from.toISOString());
    if (bounds.to) query = query.lte('created_at', bounds.to.toISOString());
    if (productFilterIds) query = query.in('product_id', productFilterIds);
    query = query.limit(financeVentasRange === 'all' ? 5000 : 2000);

    const { data: rows, error } = await query;
    if (error) {
      ventasBody.innerHTML = `<tr><td colspan="4">${escapeHtml(error.message)}</td></tr>`;
      if (summaryEl) summaryEl.textContent = '';
      if (emptyEl) emptyEl.hidden = true;
      return;
    }

    const list = rows || [];
    const pids = [...new Set(list.map((r) => r.product_id).filter(Boolean))];
    const mids = [...new Set(list.map((r) => r.member_id).filter(Boolean))];

    let prodMap = {};
    let memMap = {};
    if (pids.length) {
      const { data: pr } = await sb()
        .from('inventory_products')
        .select('id, name, emoji')
        .in('id', pids);
      if (pr) prodMap = Object.fromEntries(pr.map((x) => [x.id, x]));
    }
    if (mids.length) {
      const { data: mm } = await sb()
        .from('club_members')
        .select('id, display_name')
        .in('id', mids);
      if (mm) memMap = Object.fromEntries(mm.map((x) => [x.id, x]));
    }

    ventasBody.innerHTML = '';
    if (!list.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (summaryEl) {
        summaryEl.textContent = `0 ventas en ${financeVentasFilterSummaryParts()}.`;
      }
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    let total = 0;
    list.forEach((r) => {
      total += Number(r.price_charged_eur) || 0;
      const pr = prodMap[r.product_id] || {};
      const em = (pr.emoji || '').trim();
      const prodLabel = `${em ? em + ' ' : ''}${pr.name || '—'}`;
      const mb = r.member_id ? memMap[r.member_id] : null;
      const socio = mb ? mb.display_name : '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
        <td>${escapeHtml(prodLabel)}</td>
        <td>${escapeHtml(socio)}</td>
        <td>${escapeHtml(formatMoney(r.price_charged_eur))}</td>
      `;
      ventasBody.appendChild(tr);
    });

    if (summaryEl) {
      const limit = financeVentasRange === 'all' ? 5000 : 2000;
      const truncated = list.length >= limit ? ` · mostrando las ${limit} más recientes` : '';
      summaryEl.textContent = `${list.length} venta(s) en ${financeVentasFilterSummaryParts()} · total ${formatMoney(total)}${truncated}`;
    }
  }

  async function refreshFinanceStockAdjustments() {
    const tbody = $('finance-inventory-adjust-tbody');
    const emptyEl = $('finance-inventory-adjust-empty');
    const section = $('finance-inventory-adjust-section');
    if (!tbody || !ctx) return;

    const d30 = startOfDay(new Date());
    d30.setDate(d30.getDate() - 30);

    const { data: rows, error } = await sb()
      .from('inventory_stock_adjustments')
      .select(
        'id, created_at, delta_grams, previous_stock_grams, new_stock_grams, notes, product_id, created_by',
      )
      .eq('club_id', ctx.club.id)
      .gte('created_at', d30.toISOString())
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      if (
        error.code === '42P01' ||
        (error.message && error.message.includes('inventory_stock_adjustments'))
      ) {
        if (section) section.hidden = true;
        return;
      }
      tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
      if (emptyEl) emptyEl.hidden = true;
      if (section) section.hidden = false;
      return;
    }

    if (section) section.hidden = false;

    const list = rows || [];
    const pids = [...new Set(list.map((r) => r.product_id).filter(Boolean))];
    let prodMap = {};
    if (pids.length) {
      const { data: pr } = await sb()
        .from('inventory_products')
        .select('id, name, emoji, sale_unit')
        .in('id', pids);
      if (pr) prodMap = Object.fromEntries(pr.map((x) => [x.id, x]));
    }

    let staffMap = {};
    try {
      const { data: sd } = await sb().rpc('club_staff_directory');
      (sd || []).forEach((row) => {
        const id = row.user_id ?? row.userId;
        if (id && row.email) staffMap[id] = row.email;
      });
    } catch (e) {
      /* ignore */
    }

    tbody.innerHTML = '';
    if (!list.length) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    list.forEach((r) => {
      const pr = prodMap[r.product_id] || {};
      const em = (pr.emoji || '').trim();
      const prodLabel = `${em ? em + ' ' : ''}${pr.name || '—'}`;
      const u = pr.sale_unit === 'unit' ? 'ud' : 'g';
      const delta = Number(r.delta_grams);
      const sign = delta > 0 ? '+' : '';
      const mov = `${sign}${formatQty(delta)} ${u}`;
      const who = r.created_by && staffMap[r.created_by] ? staffMap[r.created_by] : '—';
      const note = (r.notes || '').trim() || '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
        <td>${escapeHtml(prodLabel)}</td>
        <td>${escapeHtml(who)}</td>
        <td>${escapeHtml(mov)}</td>
        <td>${escapeHtml(note)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function financeInventoryColFail(e) {
    return (
      e &&
      (e.code === '42703' ||
        (e.message && String(e.message).toLowerCase().includes('column')))
    );
  }

  /**
   * €/g o €/ud por unidad de stock (igual que tarifa TPV): precio ref. explícito o campos sugeridos del producto.
   */
  function financeEffectiveRetailEurPerStockUnit(p, hasRetailPriceColumn) {
    if (hasRetailPriceColumn && p.retail_price_eur != null && p.retail_price_eur !== '') {
      const rp = Number(p.retail_price_eur);
      if (!Number.isNaN(rp) && rp >= 0) return rp;
    }
    const saleUnit = p.sale_unit === 'unit' ? 'unit' : 'grams';
    if (saleUnit === 'unit') {
      if (p.default_price_eur == null || p.default_price_eur === '') return null;
      const pr = Number(p.default_price_eur);
      if (!Number.isNaN(pr) && pr >= 0) return pr;
      return null;
    }
    if (p.default_price_per_gram_eur != null && p.default_price_per_gram_eur !== '') {
      const perG = Number(p.default_price_per_gram_eur);
      if (!Number.isNaN(perG) && perG >= 0) return perG;
    }
    const baseG = Number(p.default_sale_grams);
    const basePrice =
      p.default_price_eur != null && p.default_price_eur !== '' ? Number(p.default_price_eur) : NaN;
    if (Number.isNaN(basePrice) || basePrice < 0) return null;
    if (Number.isNaN(baseG) || baseG <= 0) return basePrice;
    return basePrice / baseG;
  }

  function financeEffectivePurchaseEurPerStockUnit(p, hasPurchaseCostColumn) {
    if (!hasPurchaseCostColumn) return null;
    if (p.purchase_cost_eur == null || p.purchase_cost_eur === '') return null;
    const c = Number(p.purchase_cost_eur);
    if (!Number.isNaN(c) && c >= 0) return c;
    return null;
  }

  async function financeFetchInventoryValuationRows(clubId) {
    let fields = [
      'stock_grams',
      'sale_unit',
      'purchase_cost_eur',
      'retail_price_eur',
      'default_price_eur',
      'default_sale_grams',
      'default_price_per_gram_eur',
    ];
    let useArchiveFilter = true;
    for (let attempt = 0; attempt < 14; attempt++) {
      const sel = fields.join(', ');
      let q = sb().from('inventory_products').select(sel).eq('club_id', clubId);
      if (useArchiveFilter) q = q.eq('is_archived', false);
      const { data, error } = await q;
      if (!error) return { data, fields, error: null };
      if (!financeInventoryColFail(error)) return { data: null, fields: [], error };
      const m = (String(error.message || '')).toLowerCase();
      if (useArchiveFilter && m.includes('is_archived')) {
        useArchiveFilter = false;
        continue;
      }
      const before = fields.length;
      if (m.includes('purchase_cost_eur')) fields = fields.filter((f) => f !== 'purchase_cost_eur');
      else if (m.includes('retail_price_eur')) fields = fields.filter((f) => f !== 'retail_price_eur');
      else if (m.includes('default_price_per_gram')) fields = fields.filter((f) => f !== 'default_price_per_gram_eur');
      else if (m.includes('default_sale_grams')) fields = fields.filter((f) => f !== 'default_sale_grams');
      else if (m.includes('default_price_eur')) fields = fields.filter((f) => f !== 'default_price_eur');
      else if (m.includes('sale_unit')) fields = fields.filter((f) => f !== 'sale_unit');
      else return { data: null, fields: [], error };
      if (!fields.length) return { data: null, fields: [], error };
      if (fields.length === before) return { data: null, fields: [], error };
    }
    return { data: null, fields: [], error: null };
  }

  async function refreshFinanceInventoryCostAdmin() {
    const wrap = $('finance-admin-inventory-cost');
    const costVal = $('finance-kpi-inventory-cost');
    const retailVal = $('finance-kpi-inventory-retail');
    const costWrap = $('finance-kpi-inventory-cost-wrap');
    const retailWrap = $('finance-kpi-inventory-retail-wrap');
    if (!wrap || !ctx) return;
    if (ctx.profile.role !== 'admin_club') {
      wrap.hidden = true;
      wrap.classList.add('is-hidden');
      return;
    }
    wrap.hidden = false;
    wrap.classList.remove('is-hidden');
    if (costWrap) {
      costWrap.hidden = false;
      costWrap.classList.remove('is-hidden');
    }
    if (retailWrap) {
      retailWrap.hidden = false;
      retailWrap.classList.remove('is-hidden');
    }
    if (costVal) costVal.textContent = '…';
    if (retailVal) retailVal.textContent = '…';

    const { data, fields, error } = await financeFetchInventoryValuationRows(ctx.club.id);

    if (error) {
      if (costVal) costVal.textContent = '—';
      if (retailVal) retailVal.textContent = '—';
      return;
    }

    const hasPurchaseCol = fields.includes('purchase_cost_eur');
    const hasRetailPriceCol = fields.includes('retail_price_eur');
    const hasTpvPricingCol = ['default_price_eur', 'default_sale_grams', 'default_price_per_gram_eur'].some((f) =>
      fields.includes(f),
    );
    const showCostKpi = hasPurchaseCol;
    const showRetailKpi = hasRetailPriceCol || hasTpvPricingCol;

    if (!showCostKpi && !showRetailKpi) {
      wrap.hidden = true;
      wrap.classList.add('is-hidden');
      return;
    }

    if (costWrap) {
      costWrap.classList.toggle('is-hidden', !showCostKpi);
      costWrap.hidden = !showCostKpi;
    }
    if (retailWrap) {
      retailWrap.classList.toggle('is-hidden', !showRetailKpi);
      retailWrap.hidden = !showRetailKpi;
    }

    let totalCost = 0;
    let totalRetail = 0;
    (data || []).forEach((p) => {
      const s = Number(p.stock_grams) || 0;
      if (s <= 0) return;
      if (showCostKpi) {
        const rate = financeEffectivePurchaseEurPerStockUnit(p, hasPurchaseCol);
        if (rate != null) totalCost += rate * s;
      }
      if (showRetailKpi) {
        const rate = financeEffectiveRetailEurPerStockUnit(p, hasRetailPriceCol);
        if (rate != null) totalRetail += rate * s;
      }
    });

    if (costVal && showCostKpi) costVal.textContent = formatMoney(totalCost);
    if (retailVal && showRetailKpi) retailVal.textContent = formatMoney(totalRetail);
  }

  async function refreshFinance() {
    if (!ctx) return;
    setFinanceMsg('Cargando…', false);

    const kpiOk = await refreshFinanceKpis();
    if (!kpiOk) return;

    await refreshFinanceInventoryCostAdmin();
    await refreshFinanceVentasTpv();
    await refreshFinanceShiftClosures();
    await refreshFinanceStockAdjustments();

    setFinanceMsg('', false);
  }

  const CSV_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function csvFirstLine(t) {
    const s = String(t || '').replace(/^\uFEFF/, '');
    const ix = s.search(/\r?\n/);
    return ix >= 0 ? s.slice(0, ix) : s;
  }

  function csvColumnCountFirstRow(line, delim) {
    const rows = parseCSV(String(line).replace(/^\uFEFF/, '') + '\n', delim);
    return rows[0] ? rows[0].length : 0;
  }

  /**
   * Elige el separador que produce más columnas en la cabecera (Excel EU usa `;`
   * y si contamos `,` en la línea sin parsear, los decimales pueden confundir).
   */
  function detectCsvDelimiter(text) {
    const line = csvFirstLine(text);
    const nComma = csvColumnCountFirstRow(line, ',');
    const nSemi = csvColumnCountFirstRow(line, ';');
    const nTab = csvColumnCountFirstRow(line, '\t');
    const max = Math.max(nComma, nSemi, nTab);
    if (max <= 1) return ',';
    if (max === nTab && nTab >= nSemi && nTab >= nComma) return '\t';
    if (max === nSemi && nSemi >= nComma) return ';';
    return ',';
  }

  function parseCSV(text, delim) {
    const separator = delim || ',';
    const rows = [];
    let i = 0;
    const len = text.length;
    let row = [];
    let cell = '';
    let inQ = false;
    while (i < len) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          inQ = false;
          i++;
          continue;
        }
        cell += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQ = true;
        i++;
        continue;
      }
      if (c === separator) {
        row.push(cell);
        cell = '';
        i++;
        continue;
      }
      if (c === '\r') {
        i++;
        continue;
      }
      if (c === '\n') {
        row.push(cell);
        cell = '';
        if (row.some((x) => String(x).trim() !== '')) rows.push(row);
        row = [];
        i++;
        continue;
      }
      cell += c;
      i++;
    }
    row.push(cell);
    if (row.some((x) => String(x).trim() !== '')) rows.push(row);
    return rows;
  }

  function csvEscapeField(val) {
    const s = val == null ? '' : String(val);
    if (/[",\n\r;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function headerNorm(h) {
    return String(h || '')
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function buildCsvColumnIndex(headerRow) {
    const idx = {};
    headerRow.forEach((raw, i) => {
      const k = headerNorm(raw);
      const kn = k.replace(/\s+/g, '');
      if (k === 'nombre') idx.nombre = i;
      else if (k === 'email') idx.email = i;
      else if (k === 'telefono' || k === 'teléfono' || k === 'telefono movil' || kn === 'telefonomovil') idx.telefono = i;
      else if (k === 'tipo') idx.tipo = i;
      else if (
        k === 'tipo_vigencia' ||
        k === 'vigencia_tipo' ||
        kn === 'tipovigencia' ||
        k === 'vip_hasta' ||
        k === 'member_type_valid_until'
      ) {
        idx.tipo_vigencia = i;
      }
      else if (k === 'estado') idx.estado = i;
      else if (k === 'alta') idx.alta = i;
      else if (k === 'consumo') idx.consumo = i;
      else if (k === 'dni' || k === 'nie' || k === 'documento' || kn === 'dni/nie') idx.dni = i;
      else if (k === 'monedero') idx.monedero = i;
      else if (k === 'cuota') idx.cuota = i;
      else if (k === 'uuid' || k === 'id_interno') idx.uuid = i;
      else if (k === 'id') idx.id_legacy = i;
      else if (
        k === 'fecha_nacimiento' ||
        kn === 'fechanacimiento' ||
        k === 'nacimiento' ||
        k === 'birth_date' ||
        k === 'birth' ||
        kn === 'birthdate'
      ) {
        idx.fecha_nacimiento = i;
      }
    });
    return idx;
  }

  function csvCell(row, idx, key) {
    const j = idx[key];
    if (j === undefined || j < 0) return '';
    const raw = row[j] != null ? String(row[j]) : '';
    return raw.replace(/^\uFEFF/, '').replace(/\u00a0/g, ' ').trim();
  }

  function formatAltaExport(isoOrDate) {
    if (!isoOrDate) return '';
    const dt = new Date(isoOrDate);
    if (Number.isNaN(dt.getTime())) return '';
    const months = 'ene feb mar abr may jun jul ago sep oct nov dic'.split(' ');
    return `${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear()}`;
  }

  function tipoExportEs(member_type) {
    if (member_type === 'premium') return 'Premium';
    if (member_type === 'vip') return 'VIP';
    return 'Estándar';
  }

  function normalizeTipoImport(s) {
    const t = String(s || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (t.includes('premium')) return 'premium';
    if (t.includes('vip')) return 'vip';
    return 'standard';
  }

  function normalizeEstadoImport(s) {
    const t = String(s || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (t.includes('inactiv') || t.includes('suspend')) return false;
    return true;
  }

  function parseCuotaEuros(s) {
    if (!s || !String(s).trim()) return 0;
    let x = String(s)
      .replace(/€/g, '')
      .replace(/\/mes/gi, '')
      .replace(/\s/g, '')
      .replace(',', '.');
    const n = parseFloat(x);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function parseBirthDateCsv(s) {
    if (!s || !String(s).trim()) return null;
    const raw = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const dmy = raw.match(/^(\d{1,2})[\\/.\-](\d{1,2})[\\/.\-](\d{4})$/);
    if (dmy) {
      const dd = String(parseInt(dmy[1], 10)).padStart(2, '0');
      const mm = String(parseInt(dmy[2], 10)).padStart(2, '0');
      const yyyy = dmy[3];
      return `${yyyy}-${mm}-${dd}`;
    }
    const tryNum = Date.parse(raw);
    if (!Number.isNaN(tryNum)) return new Date(tryNum).toISOString().slice(0, 10);
    return null;
  }

  function memberCodeFromLegacyId(s) {
    const t = String(s || '').trim();
    if (!t) return '';
    return t.replace(/^#/, '').trim();
  }

  function splitNombreDisplay(full) {
    const t = full.trim();
    if (!t) return { first_name: '', last_name: '', display_name: '' };
    const sp = t.indexOf(' ');
    if (sp <= 0) return { first_name: t, last_name: '', display_name: t };
    return {
      first_name: t.slice(0, sp).trim(),
      last_name: t.slice(sp + 1).trim(),
      display_name: t,
    };
  }

  /** PostgREST no debe recibir claves con `undefined` (pueden omitirse campos). */
  function compactMemberRow(obj) {
    const o = {};
    if (!obj || typeof obj !== 'object') return o;
    Object.keys(obj).forEach((k) => {
      if (obj[k] !== undefined) o[k] = obj[k];
    });
    return o;
  }

  async function exportMembersCsv() {
    if (!ctx?.club?.id) return;
    setMemberMsg('Generando CSV…', false);
    const { data, error } = await sb()
      .from('club_members')
      .select('*')
      .eq('club_id', ctx.club.id)
      .order('display_name', { ascending: true });
    if (error) {
      setMemberMsg(error.message || 'No se pudo exportar.', true);
      return;
    }
    const headers = [
      'nombre',
      'email',
      'telefono',
      'tipo',
      'tipo_vigencia',
      'estado',
      'alta',
      'consumo',
      'dni',
      'fecha_nacimiento',
      'monedero',
      'cuota',
      'uuid',
    ];
    const lines = [headers.join(',')];
    (data || []).forEach((m) => {
      const nombre =
        (m.display_name && String(m.display_name).trim()) ||
        [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
      const birthIso =
        m.birth_date != null && String(m.birth_date).trim() !== ''
          ? String(m.birth_date).slice(0, 10)
          : '';
      const vigIso =
        m.member_type_valid_until != null && String(m.member_type_valid_until).trim() !== ''
          ? String(m.member_type_valid_until).slice(0, 10)
          : '';
      const row = [
        csvEscapeField(nombre),
        csvEscapeField(m.email != null ? String(m.email) : ''),
        csvEscapeField(m.phone != null ? String(m.phone) : ''),
        csvEscapeField(tipoExportEs(m.member_type)),
        csvEscapeField(vigIso),
        csvEscapeField(m.is_active !== false ? 'activo' : 'inactivo'),
        csvEscapeField(formatAltaExport(m.created_at)),
        csvEscapeField(''),
        csvEscapeField(m.dni != null ? String(m.dni) : ''),
        csvEscapeField(birthIso),
        csvEscapeField(''),
        csvEscapeField(
          Number(m.enrollment_fee_eur) > 0
            ? `€${Number(m.enrollment_fee_eur).toFixed(2)}/mes`
            : '€0.00/mes',
        ),
        csvEscapeField(m.id),
      ];
      lines.push(row.join(','));
    });
    const slug = String(ctx.club.name || 'club')
      .replace(/[^\w\-]+/g, '_')
      .slice(0, 40);
    const d = new Date().toISOString().slice(0, 10);
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `socios_${slug}_${d}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setMemberMsg(`Exportados ${(data || []).length} socios.`, false);
  }

  async function importMembersCsvFromText(text) {
    if (!ctx?.club?.id) return;
    const delim = detectCsvDelimiter(text);
    const rows = parseCSV(text, delim);
    if (!rows.length) {
      setMemberMsg('CSV vacío o no válido.', true);
      return;
    }
    const idx = buildCsvColumnIndex(rows[0]);
    if (idx.nombre === undefined) {
      setMemberMsg('El CSV debe incluir la columna «nombre».', true);
      return;
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let firstErrDetail = '';
    const dataRows = rows.slice(1);

    for (let r = 0; r < dataRows.length; r++) {
      const row = dataRows[r];
      const nombre = csvCell(row, idx, 'nombre').trim();
      if (!nombre) {
        skipped++;
        continue;
      }

      const email = csvCell(row, idx, 'email').trim();
      const telefono = csvCell(row, idx, 'telefono').trim();
      const tipo = normalizeTipoImport(csvCell(row, idx, 'tipo'));
      const tipoVigRaw = csvCell(row, idx, 'tipo_vigencia').trim();
      let member_type_valid_until = null;
      if ((tipo === 'premium' || tipo === 'vip') && tipoVigRaw) {
        member_type_valid_until = parseBirthDateCsv(tipoVigRaw);
      }
      const activo = normalizeEstadoImport(csvCell(row, idx, 'estado'));
      const dni = csvCell(row, idx, 'dni').trim();
      const cuota = parseCuotaEuros(csvCell(row, idx, 'cuota'));
      const rawAlta = csvCell(row, idx, 'alta').trim();
      const rawFechaNac = csvCell(row, idx, 'fecha_nacimiento').trim();
      const legacyId = memberCodeFromLegacyId(csvCell(row, idx, 'id_legacy'));
      const uuidRaw = csvCell(row, idx, 'uuid').trim();

      const sp = splitNombreDisplay(nombre);
      const notesAlta =
        rawAlta && String(rawAlta).trim()
          ? `Alta (CSV): ${String(rawAlta).trim()}`
          : '';
      const birth_date = parseBirthDateCsv(rawFechaNac);
      const baseRow = {
        club_id: ctx.club.id,
        display_name: sp.display_name,
        first_name: sp.first_name,
        last_name: sp.last_name,
        email,
        phone: telefono,
        dni,
        member_code: legacyId,
        member_type: tipo,
        member_type_valid_until,
        is_active: activo,
        enrollment_fee_eur: cuota,
        birth_date,
        notes: notesAlta,
      };

      let targetId = null;
      if (uuidRaw && CSV_UUID_RE.test(uuidRaw)) {
        const { data: ex } = await sb()
          .from('club_members')
          .select('id')
          .eq('club_id', ctx.club.id)
          .eq('id', uuidRaw)
          .maybeSingle();
        if (ex?.id) targetId = ex.id;
      }
      if (!targetId && dni) {
        const { data: ex2 } = await sb()
          .from('club_members')
          .select('id')
          .eq('club_id', ctx.club.id)
          .eq('dni', dni)
          .maybeSingle();
        if (ex2?.id) targetId = ex2.id;
      }

      const payload = { ...baseRow };
      delete payload.club_id;
      if (targetId) {
        delete payload.notes;
        if (birth_date == null) delete payload.birth_date;
      }

      let err;
      if (targetId) {
        const rup = await sb()
          .from('club_members')
          .update(compactMemberRow(payload))
          .eq('id', targetId);
        err = rup.error;
        if (!err) updated++;
      } else {
        const rin = await sb()
          .from('club_members')
          .insert([compactMemberRow(baseRow)]);
        err = rin.error;
        if (!err) inserted++;
      }

      if (err) {
        if (
          err.code === '42703' ||
          (err.message &&
            (err.message.includes('first_name') ||
              err.message.includes('email') ||
              err.message.includes('column')))
        ) {
          setMemberMsg(
            'Ejecuta la migración 011_club_members_profile.sql en Supabase (columnas email, dni, teléfono, fecha de nacimiento, etc.).',
            true,
          );
          return;
        }
        if (!firstErrDetail) {
          firstErrDetail =
            err.code === '23505'
              ? 'Código de socio duplicado (columna id): cada fila debe tener un id distinto o vacío.'
              : err.message || String(err);
        }
        errors++;
      }

      if ((r + 1) % 25 === 0) {
        setMemberMsg(`Importando… ${r + 1}/${dataRows.length}`, false);
      }
    }

    const parts = [
      `${inserted + updated} filas correctas (${inserted} nuevas, ${updated} actualizadas)`,
    ];
    if (skipped) parts.push(`${skipped} vacías omitidas`);
    if (errors) {
      parts.push(`${errors} con error`);
      if (firstErrDetail) parts.push(`→ ${firstErrDetail}`);
    }
    setMemberMsg(parts.join(' · ') + '.', errors > 0);
    await loadMembersTable();
    if (typeof window.scClubInventoryReloadMembers === 'function') {
      await window.scClubInventoryReloadMembers();
    }
  }

  async function deleteAllClubMembers() {
    if (!ctx?.club?.id) return;
    const msg =
      '¿Eliminar TODOS los socios de este club?\n\n' +
      'Las ventas del TPV no se borran, pero quedarán sin socio vinculado.\n' +
      'No se puede deshacer.';
    if (!window.confirm(msg)) return;
    if (!window.confirm('Confirma de nuevo: borrar todos los socios.')) return;
    setMemberMsg('Borrando socios…', false);
    const { error } = await sb()
      .from('club_members')
      .delete()
      .eq('club_id', ctx.club.id);
    if (error) {
      setMemberMsg(error.message || 'No se pudo borrar el listado.', true);
      return;
    }
    clearMemberForm();
    setMemberMsg('Socios eliminados. Puedes importar el CSV de nuevo.', false);
    await loadMembersTable();
    if (typeof window.scClubInventoryReloadMembers === 'function') {
      await window.scClubInventoryReloadMembers();
    }
  }

  let membersCsvUiBound = false;
  function bindMembersCsvUi() {
    if (membersCsvUiBound) return;
    membersCsvUiBound = true;
    $('members-export-csv')?.addEventListener('click', () => void exportMembersCsv());
    $('members-import-csv')?.addEventListener('click', () => $('members-import-file')?.click());
    $('members-delete-all')?.addEventListener('click', () => void deleteAllClubMembers());
    $('members-import-file')?.addEventListener('change', function () {
      const f = this.files && this.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : '';
        void importMembersCsvFromText(text);
      };
      reader.readAsText(f, 'UTF-8');
      this.value = '';
    });
  }

  function bindMembersUi() {
    if (membersUiBound) return;
    membersUiBound = true;

    $('member-save')?.addEventListener('click', () => saveMember());
    $('member-wallet-adjust-btn')?.addEventListener('click', () => {
      void applyMemberWalletAdjust();
    });
    $('member-cancel')?.addEventListener('click', () => {
      clearMemberForm();
      setMemberMsg('', false);
    });
    document.querySelectorAll('[data-member-profile-close]').forEach((el) => {
      el.addEventListener('click', () => closeMemberProfileModal());
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const modal = $('member-profile-modal');
      if (modal && !modal.classList.contains('is-hidden')) closeMemberProfileModal();
    });
    $('members-search')?.addEventListener('input', () => {
      membersSearch = $('members-search')?.value || '';
      renderMembersTable();
    });

    document.querySelectorAll('[data-members-type-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        membersTypeFilter = btn.getAttribute('data-members-type-filter') || '';
        document.querySelectorAll('[data-members-type-filter]').forEach((b) => {
          const on = (b.getAttribute('data-members-type-filter') || '') === membersTypeFilter;
          b.classList.toggle('is-active', on);
        });
        renderMembersTable();
      });
    });
    document.querySelectorAll('[data-member-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-member-type') || 'standard';
        setMemberTypeUi(v);
      });
    });

    ['member-first-name', 'member-last-name'].forEach((id) => {
      $(id)?.addEventListener('input', () => updateMemberAvatarInitials());
    });

    document.querySelectorAll('[data-member-slot][data-member-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slot = btn.getAttribute('data-member-slot');
        const mode = btn.getAttribute('data-member-mode');
        if (!slot) return;
        const input = $(slotToFileId(slot));
        if (!input) return;
        if (mode === 'cam') {
          input.setAttribute('capture', 'environment');
        } else {
          input.removeAttribute('capture');
        }
        input.click();
      });
    });

    ['member-file-avatar', 'member-file-dni-front', 'member-file-dni-back', 'member-file-passport'].forEach(
      (fid) => {
        $(fid)?.addEventListener('change', function () {
          const slot = fileIdToSlot(fid);
          const file = this.files && this.files[0];
          if (!file) return;
          if (file.size > MAX_FILE_BYTES) {
            setMemberMsg('El archivo supera 5 MB.', true);
            this.value = '';
            return;
          }
          memberPendingFiles[slot] = file;
          if (slot === 'avatar') void refreshAvatarPreview();
          else updateAllDocLabels();
          this.value = '';
          setMemberMsg('', false);
        });
      },
    );

    document.querySelectorAll('[data-member-clear]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slot = btn.getAttribute('data-member-clear');
        if (slot) void clearMemberSlot(slot);
      });
    });

    $('finance-refresh')?.addEventListener('click', () => refreshFinance());
  }

  window.scInitClubSociosFinance = async function (c) {
    ctx = c;
    bindMembersUi();
    bindMembersCsvUi();
    try {
      await loadMembersTable();
      await refreshFinance();
    } catch (e) {
      const msg =
        e.message && (e.message.includes('club_members') || e.code === '42P01')
          ? 'Ejecuta la migración 010_club_members_finance.sql en Supabase.'
          : e.message || 'Error cargando socios / finanzas.';
      setMemberMsg(msg, true);
      setFinanceMsg(msg, true);
    }
  };

  window.scClubRefreshFinance = async function () {
    if (!ctx) return;
    try {
      await refreshFinance();
    } catch (e) {
      /* ignore refresh errors from external triggers */
    }
  };
})();
