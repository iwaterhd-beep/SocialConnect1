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
  let memberTermsUiBound = false;
  let memberSaving = false;
  let membersCache = [];
  /** Totales de POS por socio: member_id -> sum(price_charged_eur) */
  let memberDispensedById = Object.create(null);
  let membersSearch = '';
  let membersTypeFilter = '';
  let hasArchivedMemberColumn = false;
  let selectedMemberId = '';
  let financeVentasRange = '30d';
  let financeVentasFrom = '';
  let financeVentasTo = '';
  let financeVentasCategoryId = '';
  let financeVentasCategories = [];
  let financeVentasSearch = '';
  let financeVentasUiBound = false;
  const financeShiftsFilter = { range: 'all', from: '', to: '' };
  const financeAdjustFilter = { range: 'all', from: '', to: '' };
  const financeWalletFilter = { range: 'all', from: '', to: '', search: '' };
  let financeSectionFiltersBound = false;

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

  const memberCameraState = {
    slot: null,
    stream: null,
    devices: [],
    deviceIndex: 0,
    facingMode: 'environment',
    useFacingToggle: false,
  };

  let memberCameraUiBound = false;

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
  /** Avalista elegido en el buscador: { id, name, dni } */
  let avalistaSelection = null;
  let pendingSaveAvalista = null;

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
    return (
      m.includes('avatar_path') ||
      m.includes('doc_dni_') ||
      m.includes('doc_passport_path')
    );
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

  function memberCameraSlotLabel(slot) {
    if (slot === 'avatar') return 'Foto del socio';
    if (slot === 'dni_front') return 'DNI delante';
    if (slot === 'dni_back') return 'DNI detrás';
    if (slot === 'passport') return 'Pasaporte';
    return 'Tomar foto';
  }

  function setMemberCameraStatus(text) {
    const el = $('member-camera-status');
    if (el) el.textContent = text || '';
  }

  function stopMemberCameraStream() {
    if (memberCameraState.stream) {
      memberCameraState.stream.getTracks().forEach((track) => track.stop());
      memberCameraState.stream = null;
    }
    const video = $('member-camera-video');
    if (video) video.srcObject = null;
  }

  async function listMemberVideoDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    const seen = new Set();
    return devices.filter((device) => {
      if (device.kind !== 'videoinput') return false;
      const key = device.groupId || device.deviceId;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function defaultMemberFacingMode(slot) {
    return slot === 'avatar' ? 'user' : 'environment';
  }

  function memberFacingModeLabel(mode) {
    return mode === 'user' ? 'frontal' : 'trasera';
  }

  async function startMemberCameraStream(options = {}) {
    stopMemberCameraStream();
    const base = { audio: false };
    let constraints;
    if (options.deviceId) {
      constraints = { ...base, video: { deviceId: { ideal: options.deviceId } } };
    } else if (options.facingMode) {
      constraints = { ...base, video: { facingMode: { exact: options.facingMode } } };
    } else {
      const facing = defaultMemberFacingMode(memberCameraState.slot);
      constraints = { ...base, video: { facingMode: { ideal: facing } } };
    }
    try {
      memberCameraState.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (_) {
      if (options.facingMode) {
        try {
          memberCameraState.stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: options.facingMode },
          });
        } catch {
          memberCameraState.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
      } else if (options.deviceId) {
        memberCameraState.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: options.deviceId },
        });
      } else {
        memberCameraState.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
    }
    const video = $('member-camera-video');
    if (video) {
      video.srcObject = memberCameraState.stream;
      await video.play();
    }
    const track = memberCameraState.stream?.getVideoTracks?.()[0];
    const settings = track?.getSettings?.() || {};
    if (settings.facingMode === 'user' || settings.facingMode === 'environment') {
      memberCameraState.facingMode = settings.facingMode;
    }
  }

  function syncMemberCameraSwitchUi() {
    const switchBtn = $('member-camera-switch');
    if (!switchBtn) return;
    const count = memberCameraState.devices.length;
    switchBtn.hidden = false;
    if (count > 1) {
      const current = memberCameraState.devices[memberCameraState.deviceIndex];
      const label = (current?.label || `Cámara ${memberCameraState.deviceIndex + 1}`).trim();
      switchBtn.textContent = count > 2 ? `Cambiar cámara (${label})` : 'Cambiar cámara';
      return;
    }
    if (memberCameraState.facingMode === 'user') {
      switchBtn.textContent = 'Usar cámara trasera';
    } else {
      switchBtn.textContent = 'Usar cámara frontal';
    }
  }

  function preferredMemberCameraIndex(devices) {
    if (!devices.length) return 0;
    const backIdx = devices.findIndex((device) =>
      /back|rear|environment|trasera|posterior/i.test(device.label || ''),
    );
    if (backIdx >= 0) return backIdx;
    const frontIdx = devices.findIndex((device) =>
      /front|user|frontal|selfie/i.test(device.label || ''),
    );
    if (memberCameraState.slot === 'avatar' && frontIdx >= 0) return frontIdx;
    return 0;
  }

  async function refreshMemberCameraDevices() {
    memberCameraState.devices = await listMemberVideoDevices();
    if (!memberCameraState.devices.length) {
      memberCameraState.deviceIndex = 0;
      syncMemberCameraSwitchUi();
      return;
    }
    if (memberCameraState.deviceIndex >= memberCameraState.devices.length) {
      memberCameraState.deviceIndex = 0;
    }
    syncMemberCameraSwitchUi();
  }

  async function openMemberCamera(slot) {
    if (!slot) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      const input = $(slotToFileId(slot));
      if (input) {
        input.setAttribute('capture', slot === 'avatar' ? 'user' : 'environment');
        input.click();
      } else {
        setMemberMsg('Tu navegador no permite usar la cámara.', true);
      }
      return;
    }

    memberCameraState.slot = slot;
    memberCameraState.deviceIndex = 0;
    memberCameraState.devices = [];
    memberCameraState.facingMode = defaultMemberFacingMode(slot);
    memberCameraState.useFacingToggle = false;

    const modal = $('member-camera-modal');
    const title = $('member-camera-title');
    if (title) title.textContent = memberCameraSlotLabel(slot);
    setMemberCameraStatus('Preparando cámara…');
    if (modal) {
      window.scOpenShiftModal(modal);
    }

    try {
      await startMemberCameraStream({ facingMode: memberCameraState.facingMode });
      await refreshMemberCameraDevices();
      if (memberCameraState.devices.length > 1) {
        memberCameraState.useFacingToggle = false;
        memberCameraState.deviceIndex = preferredMemberCameraIndex(memberCameraState.devices);
        const device = memberCameraState.devices[memberCameraState.deviceIndex];
        if (device?.deviceId) {
          await startMemberCameraStream({ deviceId: device.deviceId });
        }
      } else {
        memberCameraState.useFacingToggle = true;
      }
      syncMemberCameraSwitchUi();
      setMemberCameraStatus('');
      $('member-camera-capture')?.focus();
    } catch (err) {
      closeMemberCamera();
      setMemberMsg(err?.message || 'No se pudo acceder a la cámara.', true);
    }
  }

  async function switchMemberCamera() {
    const count = memberCameraState.devices.length;
    try {
      if (count > 1) {
        memberCameraState.useFacingToggle = false;
        memberCameraState.deviceIndex = (memberCameraState.deviceIndex + 1) % count;
        const device = memberCameraState.devices[memberCameraState.deviceIndex];
        await startMemberCameraStream({ deviceId: device?.deviceId || null });
      } else {
        memberCameraState.useFacingToggle = true;
        memberCameraState.facingMode =
          memberCameraState.facingMode === 'user' ? 'environment' : 'user';
        await startMemberCameraStream({ facingMode: memberCameraState.facingMode });
      }
      syncMemberCameraSwitchUi();
      setMemberCameraStatus(
        count > 1
          ? ''
          : `Cámara ${memberFacingModeLabel(memberCameraState.facingMode)} activa.`,
      );
    } catch (err) {
      setMemberCameraStatus(
        err?.message ||
          (count > 1
            ? 'No se pudo cambiar de cámara.'
            : 'Este dispositivo no tiene otra cámara disponible.'),
      );
    }
  }

  function captureMemberPhoto() {
    const video = $('member-camera-video');
    const slot = memberCameraState.slot;
    if (!video || !slot) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      setMemberCameraStatus('Espera a que la cámara enfoque…');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setMemberCameraStatus('No se pudo capturar la foto.');
          return;
        }
        if (blob.size > MAX_FILE_BYTES) {
          setMemberCameraStatus('La foto supera 5 MB. Acerca o reduce la resolución.');
          return;
        }
        const file = new File([blob], `${slot}-${Date.now()}.jpg`, { type: 'image/jpeg' });
        memberPendingFiles[slot] = file;
        if (slot === 'avatar') void refreshAvatarPreview();
        else updateAllDocLabels();
        closeMemberCamera();
        setMemberMsg('', false);
      },
      'image/jpeg',
      0.9,
    );
  }

  function closeMemberCamera() {
    stopMemberCameraStream();
    memberCameraState.slot = null;
    memberCameraState.devices = [];
    memberCameraState.deviceIndex = 0;
    memberCameraState.facingMode = 'environment';
    memberCameraState.useFacingToggle = false;
    setMemberCameraStatus('');
    const modal = $('member-camera-modal');
    if (modal) {
      modal.classList.add('is-hidden');
      modal.setAttribute('aria-hidden', 'true');
    }
  }

  function bindMemberCameraUi() {
    if (memberCameraUiBound) return;
    memberCameraUiBound = true;
    $('member-camera-capture')?.addEventListener('click', () => captureMemberPhoto());
    $('member-camera-switch')?.addEventListener('click', () => {
      void switchMemberCamera();
    });
    document.querySelectorAll('[data-member-camera-close]').forEach((el) => {
      el.addEventListener('click', () => closeMemberCamera());
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const modal = $('member-camera-modal');
      if (!modal || modal.classList.contains('is-hidden')) return;
      closeMemberCamera();
    });
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
    if (typeof window.scFormatMoney === 'function') return window.scFormatMoney(n);
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
    if (el) {
      el.textContent = text || '';
      el.classList.toggle('msg--error', Boolean(isError));
      if (text) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    const profileEl = $('member-profile-status');
    if (profileEl) {
      const profileModal = $('member-profile-modal');
      const profileOpen =
        profileModal && !profileModal.classList.contains('is-hidden') && !profileModal.hidden;
      if (profileOpen && text) {
        profileEl.hidden = false;
        profileEl.textContent = text;
        profileEl.classList.toggle('msg--error', Boolean(isError));
      } else if (!text || !profileOpen) {
        profileEl.hidden = true;
        profileEl.textContent = '';
        profileEl.classList.remove('msg--error');
      }
    }
  }

  function setMemberSavingUi(saving) {
    memberSaving = saving;
    const saveBtn = $('member-save');
    const confirmBtn = $('member-terms-confirm');
    if (saveBtn) saveBtn.disabled = saving;
    if (confirmBtn && !saving) updateMemberTermsConfirmBtn();
    else if (confirmBtn && saving) confirmBtn.disabled = true;
  }

  function memberIdEquals(a, b) {
    return String(a || '') === String(b || '');
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

  function setFinanceEmptyVisible(emptyEl, visible) {
    if (!emptyEl) return;
    emptyEl.hidden = !visible;
    emptyEl.classList.toggle('is-hidden', !visible);
  }

  function setStatText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  async function refreshFinanceShiftClosures() {
    const tbody = $('finance-shifts-tbody');
    const emptyEl = $('finance-shifts-empty');
    const summaryEl = $('finance-shifts-summary');
    if (!tbody || !ctx) return;
    bindFinanceShiftClosuresUiOnce();

    const rangeLabel = financeDateRangeLabel(
      financeShiftsFilter.range,
      financeShiftsFilter.from,
      financeShiftsFilter.to,
    );
    setStatText('finance-shifts-stat-range', rangeLabel);

    const bounds = getFinanceDateBounds(
      financeShiftsFilter.range,
      financeShiftsFilter.from,
      financeShiftsFilter.to,
    );

    if (summaryEl && financeShiftsFilter.range === 'all') {
      summaryEl.textContent = 'Cargando todos los cierres…';
    }

    const pageResult = await fetchAllSupabasePages(
      (from, to) => {
        let q = sb()
          .from('shifts')
          .select('id, opened_at, closed_at, opened_by, closed_by')
          .eq('club_id', ctx.club.id)
          .not('closed_at', 'is', null)
          .order('closed_at', { ascending: false })
          .range(from, to);
        if (bounds.from) q = q.gte('closed_at', bounds.from.toISOString());
        if (bounds.to) q = q.lte('closed_at', bounds.to.toISOString());
        return q;
      },
      {
        pageSize: 1000,
        maxRows: financeShiftsFilter.range === 'all' ? 100000 : 5000,
      },
    );

    const { data: shifts, error, truncated } = pageResult;

    if (error) {
      tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
      setFinanceEmptyVisible(emptyEl, false);
      setStatText('finance-shifts-stat-count', '—');
      if (summaryEl) summaryEl.textContent = '';
      return;
    }

    const rows = shifts || [];
    let staffMap = {};
    try {
      const ids = rows.flatMap((row) => [row.opened_by, row.closed_by]);
      if (typeof window.SCAuth?.loadClubStaffEmailMap === 'function') {
        staffMap = await window.SCAuth.loadClubStaffEmailMap(ctx.club.id, ids);
      }
    } catch (e) {
      /* ignore */
    }
    const lab = (uid) => (uid && staffMap[uid] ? staffMap[uid] : '—');

    tbody.innerHTML = '';
    if (!rows.length) {
      setFinanceEmptyVisible(emptyEl, true);
      const title = emptyEl?.querySelector?.('.sc-finance-sales__empty-title');
      if (title) {
        title.textContent =
          financeShiftsFilter.range === 'all' && !financeShiftsFilter.from && !financeShiftsFilter.to
            ? 'No hay cierres registrados todavía'
            : 'Sin cierres en este periodo';
      }
      setStatText('finance-shifts-stat-count', '0');
      if (summaryEl) summaryEl.textContent = `0 cierres en ${rangeLabel}.`;
      return;
    }
    setFinanceEmptyVisible(emptyEl, false);
    setStatText('finance-shifts-stat-count', String(rows.length));
    if (summaryEl) {
      const truncNote = truncated ? ' · límite de carga alcanzado' : '';
      summaryEl.textContent = `${rows.length.toLocaleString('es-ES')} cierre(s) en ${rangeLabel}.${truncNote}`;
    }

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
    if (typeof window.scClubMembershipTierLabel === 'function') {
      return window.scClubMembershipTierLabel(t);
    }
    if (t === 'premium') return 'Premium';
    if (t === 'vip') return 'VIP';
    if (t === 'standard') return 'Estándar';
    return t || 'Estándar';
  }

  function getConfiguredMemberTiers() {
    const list = window.scClubMembershipTiers;
    if (Array.isArray(list) && list.length) {
      return list.filter((t) => t && t.tier_key && t.is_enabled !== false);
    }
    return [
      { tier_key: 'standard', display_name: 'Estándar' },
      { tier_key: 'premium', display_name: 'Premium' },
      { tier_key: 'vip', display_name: 'VIP' },
    ];
  }

  function isKnownMemberType(key) {
    const k = String(key || '').trim();
    if (!k) return false;
    return getConfiguredMemberTiers().some((t) => t.tier_key === k);
  }

  function isElevatedMemberType(key) {
    return String(key || 'standard') !== 'standard';
  }

  function isMemberTierExpired(m) {
    const t = m.member_type || 'standard';
    if (!isElevatedMemberType(t)) return false;
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

  function syncMemberProfileVipClass(m) {
    const on = isActiveVipMember(m);
    const isBday = isMemberBirthdayToday(m?.birth_date);
    const modal = $('member-profile-modal');
    const hero = document.querySelector('#member-profile-modal .member-profile-hero');
    if (modal) {
      modal.classList.toggle('is-vip-member', on);
      modal.classList.toggle('is-birthday-member', isBday);
    }
    if (hero) {
      hero.classList.toggle('member-profile-hero--vip', on);
      hero.classList.toggle('member-profile-hero--birthday', isBday);
    }
  }

  function isMemberBirthdayToday(iso) {
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

  function memberBirthdayTurningAge(iso) {
    if (!isMemberBirthdayToday(iso)) return null;
    return memberAgeFromBirthIso(iso);
  }

  function syncMemberProfileBirthdayUi(m) {
    const banner = $('member-profile-birthday');
    const title = $('member-profile-birthday-title');
    const ageEl = $('member-profile-birthday-age');
    const crown = $('member-profile-avatar-crown');
    const isBday = isMemberBirthdayToday(m?.birth_date);
    const age = memberBirthdayTurningAge(m?.birth_date);
    if (banner) {
      if (isBday) {
        banner.classList.remove('is-hidden');
        banner.hidden = false;
        if (title) title.textContent = '¡Feliz cumpleaños!';
        if (ageEl) {
          ageEl.textContent =
            age != null ? `Hoy cumple ${age} años` : 'Hoy es su cumpleaños';
        }
      } else {
        banner.classList.add('is-hidden');
        banner.hidden = true;
        if (title) title.textContent = '';
        if (ageEl) ageEl.textContent = '';
      }
    }
    if (crown) {
      if (isBday) {
        crown.classList.remove('is-hidden');
        crown.hidden = false;
      } else {
        crown.classList.add('is-hidden');
        crown.hidden = true;
      }
    }
  }

  function closeMemberModals() {
    closeMemberCamera();
    setEditModalInert(false);
    hideAvalistaDropdown();
    ['member-profile-modal', 'member-edit-modal'].forEach((id) => {
      const modal = $(id);
      if (!modal) return;
      modal.classList.add('is-hidden');
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
    });
  }

  function openMemberModal(kind) {
    const profileModal = $('member-profile-modal');
    const editModal = $('member-edit-modal');
    if (kind === 'profile') {
      if (editModal) {
        editModal.classList.add('is-hidden');
        editModal.hidden = true;
        editModal.setAttribute('aria-hidden', 'true');
      }
      if (profileModal) {
        window.scOpenShiftModal(profileModal);
      }
      return;
    }
    if (kind === 'edit') {
      if (profileModal) {
        profileModal.classList.add('is-hidden');
        profileModal.hidden = true;
        profileModal.setAttribute('aria-hidden', 'true');
      }
      if (editModal) {
        window.scOpenShiftModal(editModal);
      }
    }
  }

  function setMemberUiMode(mode) {
    if (mode === 'empty') {
      closeMemberModals();
      return;
    }
    if (mode === 'profile') {
      openMemberModal('profile');
      return;
    }
    if (mode === 'edit') {
      openMemberModal('edit');
    }
  }

  function getMemberNames(m) {
    let first = (m?.first_name || '').trim();
    let last = (m?.last_name || '').trim();
    if (!first && !last && m?.display_name) {
      const dn = String(m.display_name).trim();
      const sp = dn.indexOf(' ');
      if (sp > 0) {
        first = dn.slice(0, sp).trim();
        last = dn.slice(sp + 1).trim();
      } else {
        first = dn;
      }
    }
    return { first, last };
  }

  function formatMemberName(value) {
    return String(value || '').trim().toLocaleUpperCase('es-ES');
  }

  function splitMemberSurnames(lastName) {
    const parts = String(lastName || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return {
      first: parts[0] ? formatMemberName(parts[0]) : '',
      second: parts.length > 1 ? formatMemberName(parts.slice(1).join(' ')) : '',
    };
  }

  function combineMemberSurnames(firstSurname, secondSurname) {
    return [formatMemberName(firstSurname || ''), formatMemberName(secondSurname || '')]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function fillMemberNameFieldsFromRow(row) {
    let first = formatMemberName(row.first_name || '');
    let surnames = splitMemberSurnames(row.last_name || '');
    if (!first && !surnames.first && !surnames.second && row.display_name) {
      const parts = formatMemberName(row.display_name).split(/\s+/).filter(Boolean);
      first = parts[0] || '';
      surnames = {
        first: parts[1] ? formatMemberName(parts[1]) : '',
        second: parts.length > 2 ? formatMemberName(parts.slice(2).join(' ')) : '',
      };
    }
    if ($('member-first-name')) $('member-first-name').value = first;
    if ($('member-last-name')) $('member-last-name').value = surnames.first;
    if ($('member-second-last-name')) $('member-second-last-name').value = surnames.second;
  }

  function formatMemberDisplayName(m) {
    const { first, last } = getMemberNames(m);
    const combined = [first, last].filter(Boolean).join(' ').trim();
    if (combined) return formatMemberName(combined);
    return formatMemberName(m?.display_name || '');
  }

  function getClubMinAge() {
    if (typeof window.scClubGetLegalInfo === 'function') {
      const n = Number(window.scClubGetLegalInfo()?.member_min_age);
      if (Number.isFinite(n) && n >= 1) return Math.trunc(n);
    }
    const n = Number(ctx?.club?.member_min_age);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 18;
  }

  function memberAgeFromBirthIso(iso) {
    if (!iso) return null;
    const raw = String(iso).slice(0, 10);
    const parts = raw.split('-');
    if (parts.length !== 3) return null;
    const y = Number(parts[0]);
    const mo = Number(parts[1]) - 1;
    const d = Number(parts[2]);
    const birth = new Date(y, mo, d);
    if (Number.isNaN(birth.getTime())) return null;
    if (birth.getFullYear() !== y || birth.getMonth() !== mo || birth.getDate() !== d) return null;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const mDiff = today.getMonth() - birth.getMonth();
    if (mDiff < 0 || (mDiff === 0 && today.getDate() < birth.getDate())) age--;
    return age;
  }

  const BIRTH_MONTHS = [
    'Enero',
    'Febrero',
    'Marzo',
    'Abril',
    'Mayo',
    'Junio',
    'Julio',
    'Agosto',
    'Septiembre',
    'Octubre',
    'Noviembre',
    'Diciembre',
  ];
  let memberBirthUiBound = false;

  function daysInMonth(year, month1to12) {
    const y = Number(year);
    const m = Number(month1to12);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 31;
    return new Date(y, m, 0).getDate();
  }

  function ensureMemberBirthSelectOptions() {
    const daySel = $('member-birth-day');
    const monthSel = $('member-birth-month');
    const yearSel = $('member-birth-year');
    if (!daySel || !monthSel || !yearSel) return;

    if (monthSel.options.length <= 1) {
      BIRTH_MONTHS.forEach((label, i) => {
        const opt = document.createElement('option');
        opt.value = String(i + 1);
        opt.textContent = label;
        monthSel.appendChild(opt);
      });
    }

    const minAge = getClubMinAge();
    const nowY = new Date().getFullYear();
    const maxY = nowY - Math.max(1, minAge);
    const minY = nowY - 110;
    const prevYear = yearSel.value;
    yearSel.innerHTML = '<option value="">Año</option>';
    for (let y = maxY; y >= minY; y--) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      yearSel.appendChild(opt);
    }
    if (prevYear && [...yearSel.options].some((o) => o.value === prevYear)) {
      yearSel.value = prevYear;
    }

    refreshMemberBirthDayOptions(false);
  }

  function refreshMemberBirthDayOptions(keepSelection) {
    const daySel = $('member-birth-day');
    const monthSel = $('member-birth-month');
    const yearSel = $('member-birth-year');
    if (!daySel) return;
    const prev = keepSelection === false ? '' : daySel.value;
    const month = Number(monthSel?.value || 0);
    const year = Number(yearSel?.value || 0);
    const maxDay = daysInMonth(year || 2000, month || 1);
    daySel.innerHTML = '<option value="">Día</option>';
    for (let d = 1; d <= maxDay; d++) {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = String(d);
      daySel.appendChild(opt);
    }
    if (prev && Number(prev) <= maxDay) daySel.value = prev;
  }

  function syncMemberBirthHiddenFromSelects() {
    const day = Number(($('member-birth-day')?.value || '').trim());
    const month = Number(($('member-birth-month')?.value || '').trim());
    const year = Number(($('member-birth-year')?.value || '').trim());
    const hidden = $('member-birth');
    const hint = $('member-birth-hint');
    if (!day || !month || !year) {
      if (hidden) hidden.value = '';
      if (hint) hint.textContent = '';
      return '';
    }
    const maxDay = daysInMonth(year, month);
    if (day > maxDay) {
      if (hidden) hidden.value = '';
      if (hint) hint.textContent = 'Fecha no válida.';
      return '';
    }
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (hidden) hidden.value = iso;
    const age = memberAgeFromBirthIso(iso);
    if (hint) {
      if (age == null) hint.textContent = '';
      else hint.textContent = `${age} años`;
    }
    return iso;
  }

  function setMemberBirthIso(iso) {
    ensureMemberBirthSelectOptions();
    const daySel = $('member-birth-day');
    const monthSel = $('member-birth-month');
    const yearSel = $('member-birth-year');
    const hidden = $('member-birth');
    const hint = $('member-birth-hint');
    const raw = iso ? String(iso).slice(0, 10) : '';
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      if (daySel) daySel.value = '';
      if (monthSel) monthSel.value = '';
      if (yearSel) yearSel.value = '';
      if (hidden) hidden.value = '';
      if (hint) hint.textContent = '';
      refreshMemberBirthDayOptions(false);
      return;
    }
    const [ys, ms, ds] = raw.split('-');
    const y = Number(ys);
    const m = Number(ms);
    const d = Number(ds);
    if (yearSel && ![...yearSel.options].some((o) => o.value === String(y))) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      yearSel.appendChild(opt);
    }
    if (yearSel) yearSel.value = String(y);
    if (monthSel) monthSel.value = String(m);
    refreshMemberBirthDayOptions(false);
    if (daySel) daySel.value = String(d);
    if (hidden) hidden.value = raw;
    const age = memberAgeFromBirthIso(raw);
    if (hint) hint.textContent = age != null ? `${age} años` : '';
  }

  function bindMemberBirthUiOnce() {
    if (memberBirthUiBound) return;
    memberBirthUiBound = true;
    const onChange = () => {
      refreshMemberBirthDayOptions(true);
      syncMemberBirthHiddenFromSelects();
    };
    $('member-birth-day')?.addEventListener('change', () => syncMemberBirthHiddenFromSelects());
    $('member-birth-month')?.addEventListener('change', onChange);
    $('member-birth-year')?.addEventListener('change', onChange);
  }

  function formatMemberCode(m) {
    if (!m) return '—';
    const num = m.member_number != null ? Number(m.member_number) : NaN;
    if (!Number.isNaN(num) && num > 0) {
      return `#${String(Math.trunc(num)).padStart(5, '0')}`;
    }
    const t = String(m.member_code || '').trim();
    if (!t) return '—';
    if (t.startsWith('#')) return t;
    if (/^\d+$/.test(t)) return `#${t.padStart(5, '0')}`;
    return t;
  }

  function memberNumberSortKey(m) {
    const num = m?.member_number != null ? Number(m.member_number) : NaN;
    if (!Number.isNaN(num) && num > 0) return num;
    const code = String(m?.member_code || '').trim().replace(/^#/, '');
    const parsed = /^\d+$/.test(code) ? Number(code) : NaN;
    return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
  }

  function resolveAvalistaInfo(m) {
    if (!m) return { label: '', memberId: '' };
    const avName = m.avalista != null ? String(m.avalista).trim() : '';
    const avDni = m.avalista_dni != null ? String(m.avalista_dni).trim() : '';
    let memberId = m.avalista_member_id != null ? String(m.avalista_member_id).trim() : '';

    if (memberId) {
      const linked = (membersCache || []).find((x) => memberIdEquals(x.id, memberId));
      if (linked) {
        const linkedName = formatMemberDisplayName(linked) || avName;
        let label = linkedName;
        const dniPart = avDni || (linked.dni != null ? String(linked.dni).trim() : '');
        if (dniPart) label = `${linkedName} · ${dniPart}`;
        return { label: label || linkedName, memberId };
      }
    }

    if (!memberId && (avName || avDni)) {
      const byDni = avDni
        ? (membersCache || []).find(
            (x) => String(x.dni || '').trim().toLowerCase() === avDni.toLowerCase(),
          )
        : null;
      const byName =
        !byDni && avName
          ? (membersCache || []).find(
              (x) => formatMemberDisplayName(x).toLowerCase() === avName.toLowerCase(),
            )
          : null;
      const found = byDni || byName;
      if (found?.id) memberId = found.id;
    }

    let label = '';
    if (avName && avDni) label = `${avName} · ${avDni}`;
    else if (avName) label = avName;
    else if (avDni) label = avDni;

    return { label, memberId };
  }

  function renderMemberViewAvalista(m) {
    const el = $('member-view-avalista');
    if (!el) return;
    const { label, memberId } = resolveAvalistaInfo(m);
    el.replaceChildren();
    if (!label) {
      el.textContent = '—';
      return;
    }
    if (memberId && !memberIdEquals(memberId, m.id)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'member-view-avalista-link';
      btn.textContent = label;
      btn.setAttribute('data-avalista-member-id', memberId);
      el.appendChild(btn);
      return;
    }
    el.textContent = label;
  }

  function fillMemberViewSummary(m) {
    const { first, last } = getMemberNames(m);
    const title = $('member-profile-view-title');
    if (title) title.textContent = formatMemberDisplayName(m) || 'Perfil del socio';
    if ($('member-view-first-name')) $('member-view-first-name').textContent = formatMemberName(first) || '—';
    if ($('member-view-last-name')) $('member-view-last-name').textContent = formatMemberName(last) || '—';
    if ($('member-view-dni')) {
      $('member-view-dni').textContent = m.dni != null && String(m.dni).trim() !== '' ? formatMemberName(m.dni) : '—';
    }
    renderMemberViewAvalista(m);
    if ($('member-view-code')) {
      $('member-view-code').textContent = formatMemberCode(m);
    }
    const typeEl = $('member-view-type');
    if (typeEl) typeEl.innerHTML = memberTypePillHtml(m);
    const statusEl = $('member-view-status');
    if (statusEl) {
      if (isMemberArchived(m)) {
        statusEl.textContent = 'Archivado';
        statusEl.classList.add('member-view-status--inactive');
      } else {
        statusEl.textContent = m.is_active ? 'Activo' : 'Inactivo';
        statusEl.classList.toggle('member-view-status--inactive', !m.is_active);
      }
    }
    updateMemberArchiveButtons(m);
    syncMemberProfileBirthdayUi(m);
    void renderMemberViewDocuments(m);
  }

  async function renderMemberViewDocuments(m) {
    const list = $('member-view-docs-list');
    const wrap = $('member-view-docs');
    if (!list || !wrap) return;
    list.replaceChildren();
    const items = [
      { label: 'DNI delante', path: m?.doc_dni_front_path },
      { label: 'DNI detrás', path: m?.doc_dni_back_path },
      { label: 'Pasaporte', path: m?.doc_passport_path },
    ];
    for (const item of items) {
      const path = item.path ? String(item.path).trim() : '';
      const li = document.createElement('li');
      li.className = 'member-view-docs__item';
      const title = document.createElement('span');
      title.className = 'member-view-docs__label';
      title.textContent = item.label;
      li.appendChild(title);
      if (!path) {
        const empty = document.createElement('span');
        empty.className = 'hint member-view-docs__empty';
        empty.textContent = 'Sin archivo';
        li.appendChild(empty);
      } else {
        const { data, error } = await sb().storage.from(BUCKET).createSignedUrl(path, 3600);
        if (error || !data?.signedUrl) {
          const err = document.createElement('span');
          err.className = 'hint member-view-docs__empty';
          err.textContent = 'Archivo guardado';
          li.appendChild(err);
        } else {
          const link = document.createElement('a');
          link.className = 'btn btn--ghost btn--small';
          link.href = data.signedUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Ver';
          li.appendChild(link);
        }
      }
      list.appendChild(li);
    }
  }

  function memberTypeShortSuffix(m) {
    const t = m.member_type || 'standard';
    if (!isElevatedMemberType(t)) return '';
    const name = memberTypeLabel(t);
    return isMemberTierExpired(m) ? ` · ${name} cad.` : ` · ${name}`;
  }

  function memberTypePillHtml(m) {
    const t = m.member_type || 'standard';
    const expired = isMemberTierExpired(m);
    const base = memberTypeLabel(t);
    const label = expired ? `${base} caducado` : base;
    let cls = 'member-type-pill';
    if (t === 'vip') cls += ' member-type-pill--vip';
    else if (t === 'premium') cls += ' member-type-pill--premium';
    else if (t === 'standard') cls += ' member-type-pill--standard';
    else cls += ' member-type-pill--custom';
    if (expired) cls += ' member-type-pill--expired';
    const color =
      typeof window.scClubMembershipTierColor === 'function'
        ? window.scClubMembershipTierColor(t)
        : '';
    const style = color ? ` style="--pill-color:${escapeHtml(color)}"` : '';
    return `<span class="${cls}"${style}>${escapeHtml(label)}</span>`;
  }

  function memberTierDetailLine(m) {
    const t = m.member_type || 'standard';
    const parts = [];
    if (isElevatedMemberType(t)) {
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

  function isMemberArchived(m) {
    return !!(m && m.is_archived);
  }

  function updateMemberArchiveButtons(memberOrId) {
    const id =
      typeof memberOrId === 'string' ? memberOrId : memberOrId?.id ? String(memberOrId.id) : '';
    const m =
      typeof memberOrId === 'object' && memberOrId
        ? memberOrId
        : membersCache.find((x) => memberIdEquals(x.id, id));
    const canArchive = Boolean(id) && m && !isMemberArchived(m);
    $('member-profile-archive-btn')?.classList.toggle('is-hidden', !canArchive);
    $('member-archive')?.classList.toggle('is-hidden', !canArchive);
  }

  function memberMatchesType(m) {
    if (membersTypeFilter === 'archived') {
      return isMemberArchived(m);
    }
    if (isMemberArchived(m)) return false;
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
      m.member_number != null ? String(m.member_number) : '',
      formatMemberCode(m) !== '—' ? formatMemberCode(m) : '',
      m.email,
      m.rfid_uid,
    ];
    return fields.some((x) => String(x || '').toLowerCase().includes(t));
  }

  function normalizeRfidUid(raw) {
    return String(raw || '').trim();
  }

  function findMemberByExactRfid(query) {
    const t = normalizeRfidUid(query).toLowerCase();
    if (!t) return null;
    return (
      (membersCache || []).find(
        (m) => !isMemberArchived(m) && normalizeRfidUid(m.rfid_uid).toLowerCase() === t,
      ) || null
    );
  }

  function setMemberProfilePlaceholder(text) {
    const meta = $('member-profile-meta');
    const tbody = $('member-dispenses-tbody');
    const c = $('member-profile-kpi-count');
    const t = $('member-profile-kpi-total');
    if (meta) meta.textContent = text || '';
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
    if (ledgerTbody) ledgerTbody.innerHTML = '<tr><td colspan="6">Sin datos.</td></tr>';
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
    syncMemberProfileVipClass(null);
    setMemberUiMode('empty');
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
    if (typeof window.scConfirmMemberMissingDni === 'function') {
      const ok = await window.scConfirmMemberMissingDni(row);
      if (!ok) return;
    }
    selectedMemberId = memberId || '';
    setMemberUiMode('edit');
    $('member-edit-id').value = row.id;
    fillMemberNameFieldsFromRow(row);
    $('member-dni').value = formatMemberName(row.dni || '');
    const avName = row.avalista != null ? String(row.avalista).trim() : '';
    const avId = row.avalista_member_id != null ? String(row.avalista_member_id) : '';
    avalistaSelection = avId
      ? {
          id: avId,
          name: avName,
          dni: row.avalista_dni != null ? String(row.avalista_dni).trim() : '',
        }
      : null;
    pendingSaveAvalista = avalistaSelection
      ? { name: avalistaSelection.name, dni: avalistaSelection.dni, memberId: avalistaSelection.id }
      : null;
    if ($('member-avalista-name')) $('member-avalista-name').value = avName;
    if ($('member-avalista-dni')) {
      $('member-avalista-dni').value = row.avalista_dni != null ? String(row.avalista_dni).trim() : '';
    }
    if ($('member-avalista-member-id')) {
      $('member-avalista-member-id').value = avId;
    }
    if ($('member-avalista-search')) $('member-avalista-search').value = avName;
    fillAvalistaSelectOptions(avId);
    updateAvalistaPickedUi();
    setMemberBirthIso(row.birth_date ? String(row.birth_date).slice(0, 10) : '');
    $('member-phone').value = row.phone || '';
    $('member-email').value = row.email || '';
    $('member-code').value = (() => {
      const fc = formatMemberCode(row);
      return fc === '—' ? '' : fc;
    })();
    if ($('member-rfid')) $('member-rfid').value = normalizeRfidUid(row.rfid_uid);
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
    updateMemberArchiveButtons(row);
    renderMembersTable();
    document.querySelector('.sc-members-list tr.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  async function showMemberProfile(memberId, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    let m = membersCache.find((x) => memberIdEquals(x.id, memberId));
    try {
      if (ctx?.club?.id) {
        const { data: fresh, error } = await sb()
          .from('club_members')
          .select('*')
          .eq('id', memberId)
          .eq('club_id', ctx.club.id)
          .maybeSingle();
        if (!error && fresh) {
          m = fresh;
          const idx = membersCache.findIndex((x) => memberIdEquals(x.id, memberId));
          if (idx >= 0) membersCache[idx] = fresh;
        }
      }
    } catch (_) {
      /* usar caché si falla la recarga puntual */
    }
    if (!m) {
      selectedMemberId = '';
      closeMemberModals();
      return;
    }
    if (!options.skipDniWarn && typeof window.scConfirmMemberMissingDni === 'function') {
      const ok = await window.scConfirmMemberMissingDni(m);
      if (!ok) return;
    }
    selectedMemberId = memberId;
    setMemberUiMode('profile');
    syncMemberProfileVipClass(m);
    fillMemberViewSummary(m);
    const meta = $('member-profile-meta');
    const tbody = $('member-dispenses-tbody');
    if (!meta || !tbody) return;

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
    if (memberId) memberDispensedById[String(memberId)] = totalSpent;
    const ids = [...new Set(rows.map((r) => r.product_id).filter(Boolean))];
    let prodMap = {};
    if (ids.length) {
      const { data: prods } = await sb().from('inventory_products').select('id, name, emoji').in('id', ids);
      if (prods) prodMap = Object.fromEntries(prods.map((p) => [p.id, p]));
    }

    const extra = [];
    if (isElevatedMemberType(m.member_type)) {
      const te = memberTierDetailLine(m);
      if (te) extra.push(te);
    }
    if (m.phone) extra.push(`Tel: ${m.phone}`);
    if (m.email) extra.push(`Email: ${m.email}`);
    meta.textContent = extra.length ? extra.join(' · ') : `${rows.length} dispensación(es) registrada(s).`;
    await renderMemberProfileHero(m, rows.length, totalSpent);

    await ledgerPromise;

    renderMembersTable();
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
    const raw = String(value || 'standard').trim() || 'standard';
    const v = isKnownMemberType(raw) ? raw : 'standard';
    const hidden = $('member-type-value');
    if (hidden) hidden.value = v;
    document.querySelectorAll('#member-type-seg [data-member-type], .member-type-seg [data-member-type]').forEach((btn) => {
      const on = btn.getAttribute('data-member-type') === v;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const key = btn.getAttribute('data-member-type') || 'standard';
      btn.textContent = memberTypeLabel(key);
    });
    const wrap = $('member-type-valid-wrap');
    const show = isElevatedMemberType(v);
    if (wrap) {
      wrap.hidden = !show;
      wrap.classList.toggle('is-hidden', !show);
    }
    if (!show && $('member-type-valid-until')) $('member-type-valid-until').value = '';
  }

  function rebuildMemberTypeControls() {
    const tiers = getConfiguredMemberTiers();
    const seg =
      document.querySelector('#member-type-seg') ||
      document.querySelector('.member-form-sc .member-type-seg') ||
      document.querySelector('.member-type-seg[aria-labelledby="member-type-label"]');
    if (seg) {
      if (!seg.id) seg.id = 'member-type-seg';
      const current = $('member-type-value')?.value || 'standard';
      seg.innerHTML = tiers
        .map((t) => {
          const key = escapeHtml(t.tier_key);
          const label = escapeHtml(t.display_name || memberTypeLabel(t.tier_key));
          return `<button type="button" class="member-type-seg__btn" data-member-type="${key}" aria-pressed="false">${label}</button>`;
        })
        .join('');
      setMemberTypeUi(current);
    }

    const filter = $('members-type-filter');
    if (filter) {
      const keep = membersTypeFilter;
      const chips = [
        { key: '', label: 'Todos' },
        ...tiers.map((t) => ({
          key: t.tier_key,
          label: t.display_name || memberTypeLabel(t.tier_key),
        })),
        { key: 'expired', label: 'Caducados' },
        { key: 'archived', label: 'Archivados' },
      ];
      filter.innerHTML = chips
        .map((c) => {
          const on = (c.key || '') === (keep || '');
          return `<button type="button" class="chip${on ? ' is-active' : ''}" data-members-type-filter="${escapeHtml(c.key)}">${escapeHtml(c.label)}</button>`;
        })
        .join('');
    }
  }

  function syncMembershipLabelsInUi() {
    rebuildMemberTypeControls();
    try {
      if ($('members-tbody')) renderMembersTable();
    } catch (_) {
      /* socios aún no listos */
    }
  }

  window.scClubOnMembershipUpdated = function () {
    try {
      syncMembershipLabelsInUi();
    } catch (_) {
      /* no bloquear Membresía */
    }
  };

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

  function hideAvalistaDropdown() {
    const dd = $('member-avalista-dropdown');
    if (!dd) return;
    dd.innerHTML = '';
    dd.hidden = true;
    dd.classList.add('is-hidden');
  }

  function updateAvalistaPickedUi() {
    const el = $('member-avalista-picked');
    if (!el) return;
    if (avalistaSelection?.id) {
      el.textContent = `Avalista seleccionado: ${avalistaSelection.name || 'Socio'}`;
      el.classList.remove('is-hidden');
      el.hidden = false;
    } else {
      el.textContent = '';
      el.classList.add('is-hidden');
      el.hidden = true;
    }
  }

  function fillAvalistaSelectOptions(preferredId) {
    const sel = $('member-avalista-select');
    if (!sel) return;
    const current = String(sel.value || '').trim();
    const fromArg =
      preferredId != null && String(preferredId).trim() !== '' ? String(preferredId).trim() : '';
    const keep = fromArg || current || String(avalistaSelection?.id || '').trim();
    const editingId = ($('member-edit-id')?.value || '').trim();
    const options = (membersCache || [])
      .filter((m) => !isMemberArchived(m) && !(editingId && memberIdEquals(m.id, editingId)))
      .slice()
      .sort((a, b) =>
        String(formatMemberDisplayName(a) || a.display_name || '').localeCompare(
          String(formatMemberDisplayName(b) || b.display_name || ''),
          'es',
        ),
      );
    sel.innerHTML = '<option value="">— Elige un socio existente —</option>';
    options.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = String(m.id);
      const label = formatMemberDisplayName(m) || m.display_name || 'Socio';
      const code = formatMemberCode(m);
      const dni = m.dni != null ? String(m.dni).trim() : '';
      opt.textContent = `${label}${code !== '—' ? ` · ${code}` : ''}${dni ? ` · ${dni}` : ''}`;
      sel.appendChild(opt);
    });
    if (keep && [...sel.options].some((o) => o.value === keep)) {
      sel.value = keep;
    } else if (!keep) {
      sel.value = '';
    } else {
      // Conservar el id elegido aunque no esté en caché (p. ej. recarga).
      const orphan = document.createElement('option');
      orphan.value = keep;
      orphan.textContent = avalistaSelection?.name || 'Avalista seleccionado';
      sel.appendChild(orphan);
      sel.value = keep;
    }
  }

  function syncAvalistaFromSelect() {
    const sel = $('member-avalista-select');
    const id = (sel?.value || '').trim();
    if (!id) {
      avalistaSelection = null;
      pendingSaveAvalista = null;
      if ($('member-avalista-member-id')) $('member-avalista-member-id').value = '';
      if ($('member-avalista-name')) $('member-avalista-name').value = '';
      if ($('member-avalista-dni')) $('member-avalista-dni').value = '';
      updateAvalistaPickedUi();
      return null;
    }
    const m = (membersCache || []).find((x) => memberIdEquals(x.id, id));
    // Usar el display_name tal cual en BD (sin reformatear) para no romper triggers antiguos por acentos.
    const name = m
      ? String(m.display_name || '').trim() ||
        [m.first_name, m.last_name].filter(Boolean).join(' ').trim() ||
        formatMemberDisplayName(m) ||
        'Socio'
      : String(avalistaSelection?.name || (sel.selectedOptions?.[0]?.textContent || '').split('·')[0] || 'Socio').trim();
    const dni =
      (m && m.dni != null ? String(m.dni).trim() : '') ||
      (avalistaSelection?.dni || '');
    avalistaSelection = { id, name: name || 'Socio', dni };
    pendingSaveAvalista = {
      memberId: id,
      name: avalistaSelection.name,
      dni: avalistaSelection.dni,
    };
    if ($('member-avalista-member-id')) $('member-avalista-member-id').value = id;
    if ($('member-avalista-name')) $('member-avalista-name').value = avalistaSelection.name;
    if ($('member-avalista-dni')) $('member-avalista-dni').value = avalistaSelection.dni;
    if ($('member-avalista-search')) $('member-avalista-search').value = avalistaSelection.name;
    updateAvalistaPickedUi();
    return pendingSaveAvalista;
  }

  function pickAvalistaMember(m) {
    if (!m || !m.id) return;
    const name =
      String(m.display_name || '').trim() ||
      [m.first_name, m.last_name].filter(Boolean).join(' ').trim() ||
      formatMemberDisplayName(m) ||
      (m.member_code ? String(m.member_code) : '') ||
      'Socio';
    const dni = m.dni != null ? String(m.dni).trim() : '';
    const id = String(m.id);
    avalistaSelection = { id, name, dni };
    pendingSaveAvalista = { name, dni, memberId: id };
    if ($('member-avalista-name')) $('member-avalista-name').value = name;
    if ($('member-avalista-dni')) $('member-avalista-dni').value = dni;
    if ($('member-avalista-member-id')) $('member-avalista-member-id').value = id;
    if ($('member-avalista-search')) $('member-avalista-search').value = name;
    const sel = $('member-avalista-select');
    if (sel) {
      if (![...sel.options].some((o) => o.value === id)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      sel.value = id;
    }
    updateAvalistaPickedUi();
    hideAvalistaDropdown();
  }

  function clearAvalistaForm() {
    avalistaSelection = null;
    pendingSaveAvalista = null;
    if ($('member-avalista-select')) $('member-avalista-select').value = '';
    if ($('member-avalista-search')) $('member-avalista-search').value = '';
    if ($('member-avalista-name')) $('member-avalista-name').value = '';
    if ($('member-avalista-dni')) $('member-avalista-dni').value = '';
    if ($('member-avalista-member-id')) $('member-avalista-member-id').value = '';
    updateAvalistaPickedUi();
    hideAvalistaDropdown();
  }

  function countActiveMembersForAvalista() {
    const editingId = ($('member-edit-id')?.value || '').trim();
    return (membersCache || []).filter(
      (m) => !isMemberArchived(m) && !(editingId && memberIdEquals(m.id, editingId)),
    ).length;
  }

  function getAvalistaForSave() {
    const synced = syncAvalistaFromSelect();
    if (synced?.memberId) return synced;
    if (pendingSaveAvalista?.memberId) return pendingSaveAvalista;
    if (avalistaSelection?.id) {
      return {
        name: String(avalistaSelection.name || 'Socio').trim(),
        dni: String(avalistaSelection.dni || '').trim(),
        memberId: String(avalistaSelection.id).trim(),
      };
    }
    if (countActiveMembersForAvalista() === 0) {
      return { name: '', dni: '', memberId: null };
    }
    return { name: '', dni: '', memberId: null };
  }

  function setEditModalInert(on) {
    const edit = $('member-edit-modal');
    if (!edit) return;
    if (on) {
      edit.setAttribute('inert', '');
      edit.setAttribute('aria-hidden', 'true');
      edit.style.pointerEvents = 'none';
    } else {
      edit.removeAttribute('inert');
      if (!edit.classList.contains('is-hidden')) {
        edit.setAttribute('aria-hidden', 'false');
      }
      edit.style.pointerEvents = '';
    }
  }

  function clearMemberForm() {
    memberEditInitialType = 'standard';
    updateMemberArchiveButtons('');
    $('member-edit-id').value = '';
    $('member-first-name').value = '';
    $('member-last-name').value = '';
    if ($('member-second-last-name')) $('member-second-last-name').value = '';
    $('member-dni').value = '';
    clearAvalistaForm();
    fillAvalistaSelectOptions(null);
    setMemberBirthIso('');
    $('member-phone').value = '';
    $('member-email').value = '';
    $('member-code').value = '';
    if ($('member-rfid')) $('member-rfid').value = '';
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
    renderMembersTable();
  }

  function renderMembersTable() {
    const tbody = $('members-tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    const filtered = membersCache
      .slice()
      .sort((a, b) => {
        const diff = memberNumberSortKey(a) - memberNumberSortKey(b);
        if (diff !== 0) return diff;
        return String(a.display_name || '').localeCompare(String(b.display_name || ''), 'es');
      })
      .filter((m) => memberMatchesSearch(m, membersSearch) && memberMatchesType(m));

    const emptyEl = $('members-empty');
    const tableWrap = tbody.closest('.table-wrap');
    if (!filtered.length) {
      if (emptyEl) {
        const title = $('members-empty-title');
        const hint = $('members-empty-hint');
        const hasFilters =
          Boolean((membersSearch || '').trim()) ||
          Boolean(membersTypeFilter && membersTypeFilter !== '');
        if (title) {
          title.textContent = hasFilters
            ? 'Ningún resultado'
            : membersCache.length
              ? 'Ningún resultado'
              : 'Sin socios';
        }
        if (hint) {
          hint.textContent = hasFilters
            ? 'Prueba otra búsqueda o quita el filtro de tipo.'
            : 'Crea el primero con «Nuevo socio».';
        }
        emptyEl.hidden = false;
        emptyEl.classList.remove('is-hidden');
      }
      if (tableWrap) tableWrap.hidden = true;
      return;
    }

    if (emptyEl) {
      emptyEl.hidden = true;
      emptyEl.classList.add('is-hidden');
    }
    if (tableWrap) tableWrap.hidden = false;

    filtered.forEach((m) => {
      const tr = document.createElement('tr');
      if (isActiveVipMember(m)) tr.classList.add('member-row--vip');
      if (selectedMemberId === m.id) tr.classList.add('is-selected');
      const dni =
        m.dni != null && String(m.dni).trim() !== ''
          ? formatMemberName(m.dni)
          : '—';
      const wallet =
        m.wallet_balance_eur != null && !Number.isNaN(Number(m.wallet_balance_eur))
          ? formatMoney(Number(m.wallet_balance_eur))
          : '—';
      const walletNeg =
        m.wallet_balance_eur != null && Number(m.wallet_balance_eur) < 0 ? ' member-wallet-cell--neg' : '';
      const dispensedRaw = memberDispensedById[String(m.id)];
      const dispensed =
        dispensedRaw != null && !Number.isNaN(Number(dispensedRaw))
          ? formatMoney(Number(dispensedRaw))
          : formatMoney(0);
      tr.innerHTML = `
        <td class="member-code-cell">${escapeHtml(formatMemberCode(m))}</td>
        <td>${escapeHtml(formatMemberDisplayName(m))}</td>
        <td>${escapeHtml(dni)}</td>
        <td>${memberTypePillHtml(m)}</td>
        <td class="member-wallet-cell member-wallet-cell--btn${walletNeg}" data-profile-member="${m.id}" title="Abrir perfil y monedero">${escapeHtml(wallet)}</td>
        <td class="member-dispensed-cell" title="Total cobrado en POS">${escapeHtml(dispensed)}</td>
        <td>${escapeHtml(m.phone || '—')}</td>
        <td>${isMemberArchived(m) ? '<span class="badge-stock badge-stock--out">Archivado</span>' : m.is_active ? '<span class="badge-stock badge-stock--ok">Activo</span>' : '<span class="badge-stock badge-stock--out">Inactivo</span>'}</td>
        <td class="actions">
          <button type="button" class="btn btn--ghost btn--small" data-profile-member="${m.id}">Perfil</button>
          <button type="button" class="btn btn--ghost btn--small" data-edit-member="${m.id}">Editar</button>
        </td>
      `;
      tr.querySelectorAll('[data-profile-member]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          void showMemberProfile(m.id);
        });
      });
      tr.querySelector('[data-edit-member]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        void editMemberFromRow(m.id);
      });
      tbody.appendChild(tr);
    });
  }

  async function loadMemberDispensedTotals() {
    memberDispensedById = Object.create(null);
    if (!ctx?.club?.id || !sb()) return;
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      let { data, error } = await sb()
        .from('tpv_dispenses')
        .select('member_id, price_charged_eur')
        .eq('club_id', ctx.club.id)
        .not('member_id', 'is', null)
        .range(from, from + pageSize - 1);
      if (
        error &&
        (error.code === '42703' ||
          String(error.message || '').toLowerCase().includes('member_id') ||
          String(error.message || '').toLowerCase().includes('price_charged'))
      ) {
        memberDispensedById = Object.create(null);
        return;
      }
      if (error) {
        console.warn('loadMemberDispensedTotals', error);
        return;
      }
      const rows = data || [];
      for (const r of rows) {
        if (!r.member_id) continue;
        const key = String(r.member_id);
        memberDispensedById[key] =
          (memberDispensedById[key] || 0) + (Number(r.price_charged_eur) || 0);
      }
      if (rows.length < pageSize) break;
      from += pageSize;
    }
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

    const archiveProbe = await sb().from('club_members').select('is_archived').limit(1);
    hasArchivedMemberColumn = !archiveProbe.error;

    let { data, error } = await sb()
      .from('club_members')
      .select('*')
      .eq('club_id', ctx.club.id)
      .order('member_number', { ascending: true });

    if (
      error &&
      (error.code === '42703' || String(error.message || '').toLowerCase().includes('member_number'))
    ) {
      ({ data, error } = await sb()
        .from('club_members')
        .select('*')
        .eq('club_id', ctx.club.id)
        .order('display_name', { ascending: true }));
    }

    if (error) throw error;
    membersCache = data || [];
    await loadMemberDispensedTotals();
    fillAvalistaSelectOptions(avalistaSelection?.id || pendingSaveAvalista?.memberId || null);
    renderMembersTable();

    // Mantener el KPI de inicio alineado con la lista real de socios.
    const homeMembersEl = $('home-kpi-members');
    if (homeMembersEl) {
      const activeCount = (membersCache || []).filter(
        (m) => m && m.is_active !== false && !isMemberArchived(m),
      ).length;
      homeMembersEl.textContent = String(activeCount);
    }

    if (selectedMemberId) {
      if (membersCache.some((m) => memberIdEquals(m.id, selectedMemberId))) {
        /* Mantener selección en tabla; no reabrir modal automáticamente */
      } else {
        selectedMemberId = '';
        closeMemberModals();
      }
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
      const oldPath = memberLoadedPaths[col];
      if (oldPath && oldPath !== objectPath) {
        const { error: remErr } = await sb().storage.from(BUCKET).remove([oldPath]);
        if (remErr && !String(remErr.message || '').toLowerCase().includes('not found')) {
          void remErr;
        }
      }
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
    return { ok: true, pathUpdates, uploadedCount: Object.keys(pathUpdates).length };
  }

  function setMemberWalletAdjustStatus(text, isError) {
    const el = $('member-wallet-adjust-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (isError ? ' msg--error' : text ? ' msg--ok' : '');
  }

  function walletLedgerKindLabel(kind) {
    const k = String(kind || '').toLowerCase();
    if (k === 'tpv_sale') return 'Venta POS';
    if (k === 'tpv_void') return 'Anulación POS';
    return 'Ajuste';
  }

  function formatWalletProductLabel(prod) {
    if (!prod) return '';
    const em = (prod.emoji || '').trim();
    const name = (prod.name || '').trim() || 'Producto';
    return em ? `${em} ${name}` : name;
  }

  function walletLedgerNoteFromDispense(disp) {
    if (!disp) return '';
    const stored = (disp.notes || '').trim();
    if (stored && !/^(venta (tpv|pos))$/i.test(stored)) return stored;
    const prod = Array.isArray(disp.inventory_products)
      ? disp.inventory_products[0]
      : disp.inventory_products;
    if (!prod) return stored;
    const label = formatWalletProductLabel(prod);
    const us = prod.sale_unit === 'unit' ? 'ud' : 'g';
    const qty = disp.grams_charged ?? disp.grams_dispensed;
    if (qty == null || qty === '') return label;
    const x = Number(qty);
    const qtyTxt = Number.isNaN(x)
      ? String(qty)
      : x.toLocaleString('es-ES', { maximumFractionDigits: 3 });
    return `${label} · ${qtyTxt} ${us}`;
  }

  function walletLedgerNoteLabel(row) {
    const notes = (row.notes || '').trim();
    const generic = /^(venta (tpv|pos)|anulación venta (tpv|pos)|anulación (tpv|pos))$/i;
    if (notes && !generic.test(notes)) return notes;
    const disp = row._dispense || row.tpv_dispenses;
    const dispRow = Array.isArray(disp) ? disp[0] : disp;
    if (dispRow) {
      const fromDisp = walletLedgerNoteFromDispense(dispRow);
      if (fromDisp) {
        if (String(row.kind || '').toLowerCase() === 'tpv_void') {
          return fromDisp.startsWith('Anulación') ? fromDisp : `Anulación: ${fromDisp}`;
        }
        return fromDisp;
      }
    }
    return notes || '—';
  }

  async function enrichWalletLedgerRows(rows) {
    const list = rows || [];
    const dispIds = [...new Set(list.map((r) => r.tpv_dispense_id).filter(Boolean))];
    if (!dispIds.length) return list;
    const { data: disps, error } = await sb()
      .from('tpv_dispenses')
      .select(
        'id, grams_charged, grams_dispensed, notes, inventory_products ( name, emoji, sale_unit )',
      )
      .in('id', dispIds);
    if (error || !disps) return list;
    const dispMap = Object.fromEntries(disps.map((d) => [d.id, d]));
    return list.map((r) => ({ ...r, _dispense: dispMap[r.tpv_dispense_id] || null }));
  }

  window.scClubWalletLedgerNoteLabel = walletLedgerNoteLabel;
  window.scClubEnrichWalletLedgerRows = enrichWalletLedgerRows;

  function paymentMethodLabel(method) {
    return String(method || 'cash').toLowerCase() === 'wallet' ? 'Monedero' : 'Efectivo';
  }

  async function getClubOpenShiftId() {
    if (!ctx?.club?.id) return null;
    const { data, error } = await sb()
      .from('shifts')
      .select('id')
      .eq('club_id', ctx.club.id)
      .is('closed_at', null)
      .maybeSingle();
    if (error) return null;
    return data?.id || null;
  }

  async function rpcMemberWalletAdjust(memberId, delta, notes, shiftId, affectsCash) {
    const payload = {
      p_member_id: memberId,
      p_delta_eur: delta,
      p_notes: notes,
      p_shift_id: affectsCash && shiftId ? shiftId : null,
      p_affects_cash: !!affectsCash,
    };
    let res = await sb().rpc('club_member_wallet_adjust', payload);
    if (
      res.error &&
      affectsCash &&
      (res.error.code === 'PGRST202' ||
        res.error.code === '42883' ||
        /p_shift_id|p_affects_cash/i.test(res.error.message || ''))
    ) {
      return {
        error: {
          message: 'Ejecuta la migración 029_wallet_cash_shift.sql en Supabase para caja y monedero.',
        },
        data: null,
      };
    }
    if (
      res.error &&
      (res.error.code === 'PGRST202' ||
        res.error.code === '42883' ||
        /club_member_wallet_adjust/i.test(res.error.message || ''))
    ) {
      if (affectsCash) {
        return { error: { message: 'Ejecuta la migración 028_member_wallet.sql en Supabase.' }, data: null };
      }
      res = await sb().rpc('club_member_wallet_adjust', {
        p_member_id: memberId,
        p_delta_eur: delta,
        p_notes: notes,
      });
    }
    return res;
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
      .select('created_at, amount_eur, balance_after_eur, cash_eur, kind, notes, tpv_dispense_id')
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
      tbody.innerHTML = `<tr><td colspan="6">${escapeHtml(msg)}</td></tr>`;
      return;
    }

    let rows = data || [];
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

    rows = await enrichWalletLedgerRows(rows);

    tbody.innerHTML = '';
    rows.forEach((r) => {
      const amt = Number(r.amount_eur);
      const bal = Number(r.balance_after_eur);
      const cash = Number(r.cash_eur);
      const amtClass = !Number.isNaN(amt) && amt < 0 ? ' member-wallet-ledger-amt--neg' : '';
      const balClass = !Number.isNaN(bal) && bal < 0 ? ' member-wallet-ledger-bal--neg' : '';
      const cashTxt =
        r.cash_eur != null && !Number.isNaN(cash) && Math.abs(cash) > 0.0001
          ? formatWalletLedgerAmount(cash)
          : '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
        <td>${escapeHtml(walletLedgerKindLabel(r.kind))}</td>
        <td class="member-wallet-ledger-amt${amtClass}">${escapeHtml(formatWalletLedgerAmount(amt))}</td>
        <td>${escapeHtml(cashTxt)}</td>
        <td class="member-wallet-ledger-bal${balClass}">${escapeHtml(formatMoney(Number.isNaN(bal) ? 0 : bal))}</td>
        <td>${escapeHtml(walletLedgerNoteLabel(r).slice(0, 120))}</td>
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
    const { error } = await rpcMemberWalletAdjust(memberId, delta, 'Ajuste desde ficha socio', null, false);
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') {
        return { ok: false, message: 'Ejecuta la migración 028_member_wallet.sql en Supabase.' };
      }
      return { ok: false, message: error.message || 'No se pudo actualizar el monedero.' };
    }
    memberWalletLoadedBalance = newBal;
    return { ok: true };
  }

  async function applyMemberWalletAdjust(sign) {
    if (!selectedMemberId) {
      setMemberWalletAdjustStatus('Abre el perfil de un socio primero.', true);
      return;
    }
    const amtRaw = ($('member-wallet-adjust-amount')?.value || '').trim().replace(',', '.');
    const notes = ($('member-wallet-adjust-notes')?.value || '').trim();
    const amt = amtRaw === '' ? NaN : Number(amtRaw);
    if (Number.isNaN(amt) || amt <= 0) {
      setMemberWalletAdjustStatus('Indica un importe mayor que cero.', true);
      return;
    }
    const delta = sign < 0 ? -amt : amt;
    const defaultNote = sign < 0 ? 'Retirada desde perfil' : 'Recarga desde perfil';
    const affectsCash = $('member-wallet-adjust-cash')?.checked === true;
    const shiftId = affectsCash ? await getClubOpenShiftId() : null;
    if (affectsCash && !shiftId) {
      setMemberWalletAdjustStatus('Abre un turno de caja para movimientos en efectivo.', true);
      return;
    }
    setMemberWalletAdjustStatus('Aplicando…', false);
    const { data, error } = await rpcMemberWalletAdjust(
      selectedMemberId,
      delta,
      notes || defaultNote,
      shiftId,
      affectsCash,
    );
    if (error) {
      setMemberWalletAdjustStatus(error.message || 'No se pudo aplicar.', true);
      return;
    }
    const newBal = data != null && !Number.isNaN(Number(data)) ? Number(data) : null;
    if ($('member-wallet-adjust-amount')) $('member-wallet-adjust-amount').value = '';
    if ($('member-wallet-adjust-notes')) $('member-wallet-adjust-notes').value = '';
    const verb = sign < 0 ? 'Retirados' : 'Ingresados';
    setMemberWalletAdjustStatus(
      `${verb} ${formatMoney(amt)}${affectsCash ? ' (en caja del turno)' : ''}. Saldo: ${newBal != null ? formatMoney(newBal) : 'actualizado'}.`,
      false,
    );
    if (typeof window.scClubRefreshFinance === 'function') {
      await window.scClubRefreshFinance();
    }
    await loadMembersTable();
    if (typeof window.scClubInventoryReloadMembers === 'function') {
      await window.scClubInventoryReloadMembers();
    }
    await showMemberProfile(selectedMemberId);
  }

  function readMemberFormFields() {
    syncMemberBirthHiddenFromSelects();
    const id = ($('member-edit-id')?.value || '').trim();
    const first = formatMemberName($('member-first-name')?.value || '');
    const firstSurname = formatMemberName($('member-last-name')?.value || '');
    const secondSurname = formatMemberName($('member-second-last-name')?.value || '');
    const last = combineMemberSurnames(firstSurname, secondSurname);
    const display_name = [first, last].filter(Boolean).join(' ').trim();
    const dni = formatMemberName($('member-dni')?.value || '');
    const phone = ($('member-phone')?.value || '').trim();
    const email = ($('member-email')?.value || '').trim();
    const birthRaw = ($('member-birth')?.value || '').trim();
    const notes = ($('member-notes')?.value || '').trim();
    const is_active = $('member-active')?.checked !== false;
    const mtRaw = ($('member-type-value')?.value || 'standard').trim();
    const member_type = isKnownMemberType(mtRaw) ? mtRaw : 'standard';
    const validRaw = ($('member-type-valid-until')?.value || '').trim();
    let member_type_valid_until = null;
    if (isElevatedMemberType(member_type)) {
      member_type_valid_until = validRaw === '' ? null : validRaw;
    }
    const feeRaw = ($('member-enrollment-fee')?.value || '').trim();
    let enrollment_fee_eur = feeRaw === '' ? 0 : Number(feeRaw);
    const rfid_uid = normalizeRfidUid($('member-rfid')?.value || '');
    return {
      id,
      first,
      firstSurname,
      secondSurname,
      last,
      display_name,
      dni,
      phone,
      email,
      birthRaw,
      notes,
      is_active,
      member_type,
      member_type_valid_until,
      enrollment_fee_eur,
      rfid_uid,
    };
  }

  function validateMemberFormFields() {
    const f = readMemberFormFields();
    if (Number.isNaN(f.enrollment_fee_eur) || f.enrollment_fee_eur < 0) {
      return { ok: false, message: 'Cuota de inscripción no válida.' };
    }
    if (!f.first) {
      return { ok: false, message: 'Indica el nombre.' };
    }
    if (!f.firstSurname) {
      return { ok: false, message: 'Indica el primer apellido.' };
    }
    if (!f.dni) {
      return { ok: false, message: 'El DNI / NIE es obligatorio.' };
    }
    const daySel = ($('member-birth-day')?.value || '').trim();
    const monthSel = ($('member-birth-month')?.value || '').trim();
    const yearSel = ($('member-birth-year')?.value || '').trim();
    if (!daySel || !monthSel || !yearSel || !f.birthRaw) {
      return { ok: false, message: 'La fecha de nacimiento es obligatoria.' };
    }
    const age = memberAgeFromBirthIso(f.birthRaw);
    const minAge = getClubMinAge();
    if (age == null) {
      return { ok: false, message: 'Fecha de nacimiento no válida.' };
    }
    if (age < minAge) {
      return { ok: false, message: `El socio debe tener al menos ${minAge} años cumplidos.` };
    }
    const avalistaInfo = getAvalistaForSave();
    if (countActiveMembersForAvalista() > 0 && !avalistaInfo.memberId) {
      return {
        ok: false,
        message:
          'Debes elegir un socio avalista existente en el desplegable «Socio avalista (garante)».',
      };
    }
    if (!avalistaInfo.name && !avalistaInfo.memberId) {
      return {
        ok: false,
        message: 'Debes indicar un socio avalista (garante) existente.',
      };
    }
    return { ok: true, fields: f };
  }

  function setMemberTermsStatus(text, isError) {
    const el = $('member-terms-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('msg--error', Boolean(isError));
  }

  function getClubLegalInfoForTerms() {
    if (typeof window.scClubGetLegalInfo === 'function') {
      return window.scClubGetLegalInfo();
    }
    return {
      name: ctx?.club?.name || '',
      cif: ctx?.club?.cif || '',
      email: ctx?.club?.email || '',
      address: ctx?.club?.address || '',
      member_min_age: getClubMinAge(),
    };
  }

  function legalDisplay(value, fallback) {
    const t = String(value || '').trim();
    return t || fallback || '—';
  }

  function fillMemberTermsClubInfo() {
    const legal = getClubLegalInfoForTerms();
    const name = legalDisplay(legal.name, 'Nombre del club');
    const cif = legalDisplay(legal.cif, 'pendiente de indicar');
    const email = legalDisplay(legal.email, 'pendiente de indicar');
    const address = legalDisplay(legal.address, 'pendiente de indicar');
    ['member-terms-club-name-1', 'member-terms-club-name-2'].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = name;
    });
    if ($('member-terms-club-cif')) $('member-terms-club-cif').textContent = cif;
    if ($('member-terms-club-email')) $('member-terms-club-email').textContent = email;
    if ($('member-terms-club-address')) $('member-terms-club-address').textContent = address;
    const minAge = String(getClubMinAge());
    ['member-terms-min-age-privacy', 'member-terms-min-age-statutes', 'member-terms-min-age-conduct', 'member-terms-chk2-age'].forEach(
      (id) => {
        const el = $(id);
        if (el) el.textContent = minAge;
      },
    );
  }

  function updateMemberTermsConfirmBtn() {
    const btn = $('member-terms-confirm');
    if (!btn) return;
    const ok = ['member-terms-chk1', 'member-terms-chk2', 'member-terms-chk3'].every(
      (id) => $(id)?.checked,
    );
    btn.disabled = !ok;
  }

  function updateMemberTermsReadBar(pct) {
    const fill = $('member-terms-read-fill');
    const label = $('member-terms-read-pct');
    const n = Math.max(0, Math.min(100, Math.round(pct)));
    if (fill) fill.style.width = `${n}%`;
    if (label) label.textContent = `${n}%`;
  }

  function resetMemberTermsModal() {
    ['member-terms-chk1', 'member-terms-chk2', 'member-terms-chk3'].forEach((id) => {
      const el = $(id);
      if (el) el.checked = false;
    });
    setMemberTermsStatus('', false);
    updateMemberTermsConfirmBtn();
    const scroll = $('member-terms-scroll');
    if (scroll) scroll.scrollTop = 0;
    updateMemberTermsReadBar(0);
    document.querySelectorAll('[data-member-terms-tab]').forEach((btn, i) => {
      const tab = btn.getAttribute('data-member-terms-tab') || '';
      const on = i === 0;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      const panel = $('member-terms-panel-' + tab);
      if (panel) {
        panel.classList.toggle('is-active', on);
        panel.hidden = !on;
      }
    });
  }

  function openMemberTermsModal() {
    const modal = $('member-terms-modal');
    if (!modal) {
      setMemberMsg('No se pudo abrir el aviso legal. Recarga la página e inténtalo de nuevo.', true);
      return;
    }
    fillMemberTermsClubInfo();
    resetMemberTermsModal();
    setEditModalInert(true);
    document.body.appendChild(modal);
    if (typeof window.scOpenShiftModal === 'function') {
      window.scOpenShiftModal(modal);
    } else {
      modal.classList.remove('is-hidden', 'is-leaving');
      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
    }
    window.setTimeout(() => {
      $('member-terms-chk1')?.focus?.();
      updateMemberTermsConfirmBtn();
    }, 50);
  }

  function closeMemberTermsModal() {
    const modal = $('member-terms-modal');
    setEditModalInert(false);
    if (!modal || modal.classList.contains('is-hidden')) return;
    modal.classList.add('is-leaving');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      modal.classList.remove('is-leaving');
      modal.classList.add('is-hidden');
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      if (typeof window.scSyncClubModalOpenClass === 'function') {
        window.scSyncClubModalOpenClass();
      }
    };
    modal.addEventListener('animationend', finish, { once: true });
    window.setTimeout(finish, 280);
  }

  async function confirmMemberTermsAndSave() {
    if (memberSaving) return;
    if (!pendingSaveAvalista?.memberId) {
      syncAvalistaFromSelect();
    }
    const validation = validateMemberFormFields();
    if (!validation.ok) {
      setMemberTermsStatus(validation.message, true);
      setMemberMsg(validation.message, true);
      return;
    }
    if (!pendingSaveAvalista?.memberId) {
      pendingSaveAvalista = getAvalistaForSave();
    }
    setMemberTermsStatus('Creando socio…', false);
    await saveMember({ skipDniWarn: true, fromTerms: true });
  }

  function bindMemberTermsUi() {
    if (memberTermsUiBound) return;
    memberTermsUiBound = true;

    document.querySelectorAll('[data-member-terms-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-member-terms-tab') || '';
        document.querySelectorAll('[data-member-terms-tab]').forEach((b) => {
          const on = b === btn;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        document.querySelectorAll('.member-terms-panel').forEach((panel) => {
          const on = panel.id === 'member-terms-panel-' + tab;
          panel.classList.toggle('is-active', on);
          panel.hidden = !on;
        });
        const scroll = $('member-terms-scroll');
        if (scroll) {
          scroll.scrollTop = 0;
          updateMemberTermsReadBar(0);
        }
      });
    });

    $('member-terms-scroll')?.addEventListener('scroll', function () {
      const max = this.scrollHeight - this.clientHeight;
      const pct = max > 0 ? (this.scrollTop / max) * 100 : 100;
      updateMemberTermsReadBar(pct);
    });

    ['member-terms-chk1', 'member-terms-chk2', 'member-terms-chk3'].forEach((id) => {
      $(id)?.addEventListener('change', updateMemberTermsConfirmBtn);
    });

    $('member-terms-confirm')?.addEventListener('click', () => {
      void confirmMemberTermsAndSave();
    });

    document.querySelectorAll('[data-member-terms-close]').forEach((el) => {
      el.addEventListener('click', closeMemberTermsModal);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const modal = $('member-terms-modal');
      if (modal && !modal.classList.contains('is-hidden')) closeMemberTermsModal();
    });
  }

  async function requestSaveMember() {
    if (memberSaving) return;
    const avalistaSnap = syncAvalistaFromSelect();
    const validation = validateMemberFormFields();
    if (!validation.ok) {
      setMemberMsg(validation.message, true);
      return;
    }
    pendingSaveAvalista = avalistaSnap || getAvalistaForSave();
    if (countActiveMembersForAvalista() > 0 && !pendingSaveAvalista?.memberId) {
      setMemberMsg(
        'Debes elegir un socio avalista existente en el desplegable «Socio avalista (garante)».',
        true,
      );
      $('member-avalista-select')?.focus?.();
      return;
    }
    const id = validation.fields.id;
    if (id) {
      await saveMember();
      return;
    }
    openMemberTermsModal();
  }

  async function saveMember(opts) {
    if (memberSaving) return;
    const options = opts && typeof opts === 'object' ? opts : {};
    const fromTerms = options.fromTerms === true;
    const validation = validateMemberFormFields();
    if (!validation.ok) {
      if (fromTerms) setMemberTermsStatus(validation.message, true);
      setMemberMsg(validation.message, true);
      return;
    }
    const isNew = !validation.fields.id;
    setMemberSavingUi(true);
    try {
    const {
      id,
      first,
      last,
      display_name,
      dni,
      phone,
      email,
      birthRaw,
      notes,
      is_active,
      member_type,
      member_type_valid_until,
      enrollment_fee_eur,
      rfid_uid,
    } = validation.fields;

    const avalistaInfo = pendingSaveAvalista?.memberId
      ? pendingSaveAvalista
      : getAvalistaForSave();
    const avalista = String(avalistaInfo.name || '').trim() || 'Socio';
    const avalista_dni = String(avalistaInfo.dni || '').trim();
    const avalistaMemberRaw = String(avalistaInfo.memberId || '').trim();
    if (countActiveMembersForAvalista() > 0 && !avalistaMemberRaw) {
      const msg =
        'Debes elegir un socio avalista existente en el desplegable «Socio avalista (garante)».';
      if (fromTerms) setMemberTermsStatus(msg, true);
      setMemberMsg(msg, true);
      return;
    }
    if (!avalistaMemberRaw && countActiveMembersForAvalista() > 0) {
      const msg = 'Debes indicar un socio avalista (garante) existente.';
      if (fromTerms) setMemberTermsStatus(msg, true);
      setMemberMsg(msg, true);
      return;
    }

    // Comprobar en vivo que el avalista existe en este club antes del insert.
    if (avalistaMemberRaw) {
      let avCheck = await sb()
        .from('club_members')
        .select('id, display_name, club_id')
        .eq('id', avalistaMemberRaw)
        .eq('club_id', ctx.club.id)
        .maybeSingle();
      if (avCheck.error && String(avCheck.error.message || '').toLowerCase().includes('column')) {
        avCheck = await sb()
          .from('club_members')
          .select('id, display_name, club_id')
          .eq('id', avalistaMemberRaw)
          .maybeSingle();
      }
      if (avCheck.error) {
        const msg = `No se pudo comprobar el avalista: ${avCheck.error.message || 'error'}`;
        if (fromTerms) setMemberTermsStatus(msg, true);
        setMemberMsg(msg, true);
        return;
      }
      if (!avCheck.data) {
        const msg = `El avalista elegido no está en este club (ID ${avalistaMemberRaw}). Vuelve a elegirlo en el desplegable.`;
        if (fromTerms) setMemberTermsStatus(msg, true);
        setMemberMsg(msg, true);
        return;
      }
      if (
        avCheck.data.club_id != null &&
        String(avCheck.data.club_id) !== String(ctx.club.id)
      ) {
        const msg =
          'El avalista pertenece a otro club. Elige un socio de este club en el desplegable.';
        if (fromTerms) setMemberTermsStatus(msg, true);
        setMemberMsg(msg, true);
        return;
      }
    }

    if (fromTerms) setMemberTermsStatus('Creando socio…', false);
    setMemberMsg('Guardando…', false);
    const row = {
      club_id: ctx.club.id,
      display_name,
      first_name: first,
      last_name: last,
      dni,
      phone,
      email,
      birth_date: birthRaw === '' ? null : birthRaw,
      notes,
      is_active,
      member_type,
      member_type_valid_until,
      enrollment_fee_eur,
      rfid_uid,
      avalista,
      avalista_dni,
      avalista_member_id: avalistaMemberRaw || null,
    };

    if (member_type !== 'vip') {
      row.vip_rule_period_start = null;
    } else if (!id || memberEditInitialType !== 'vip') {
      row.vip_rule_period_start = null;
    }

    let memberId = id;
    let error;
    let savedWithoutRfidColumn = false;

    async function tryPersist(payload) {
      if (id) return sb().from('club_members').update(payload).eq('id', id);
      return sb().from('club_members').insert([payload]).select('id').single();
    }

    let r = await tryPersist(row);
    error = r.error;
    let savedWithoutValidUntilColumn = false;
    let savedWithoutAvalistaColumn = false;
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
    if (
      error &&
      (error.code === '42703' || String(error.message || '').toLowerCase().includes('rfid_uid'))
    ) {
      const row4 = { ...row };
      delete row4.rfid_uid;
      delete row4.vip_rule_period_start;
      r = await tryPersist(row4);
      error = r.error;
      if (!error) savedWithoutRfidColumn = true;
    }
    if (
      error &&
      (error.code === '42703' || error.code === 'PGRST204') &&
      String(error.message || '').toLowerCase().includes('avalista_member_id')
    ) {
      // Falta solo la columna de enlace; conservar nombre/dni.
      const rowAv = { ...row };
      delete rowAv.avalista_member_id;
      r = await tryPersist(rowAv);
      error = r.error;
      if (!error) savedWithoutAvalistaColumn = true;
    } else if (
      error &&
      (error.code === '42703' || error.code === 'PGRST204') &&
      String(error.message || '').toLowerCase().includes('avalista')
    ) {
      const rowAv = { ...row };
      delete rowAv.avalista;
      delete rowAv.avalista_dni;
      delete rowAv.avalista_member_id;
      r = await tryPersist(rowAv);
      error = r.error;
      if (!error) savedWithoutAvalistaColumn = true;
    }

    if (!error) {
      if (id) memberId = id;
      else memberId = r.data?.id ? String(r.data.id) : '';
    }

    if (error) {
      let msg = error.message || 'No se pudo guardar.';
      if (
        error.code === '42703' ||
        (error.message &&
          (error.message.includes('first_name') ||
            error.message.includes('column')))
      ) {
        msg =
          'Ejecuta la migración 011_club_members_profile.sql en Supabase para guardar el perfil completo.';
      } else if (
        error.code === '23505' &&
        String(error.message || '').toLowerCase().includes('rfid')
      ) {
        msg = 'Esa chapa RFID ya está asignada a otro socio de este club.';
      } else if (
        /garante|avalista.*existente|socio avalista/i.test(String(error.message || ''))
      ) {
        msg = avalistaMemberRaw
          ? `La base de datos sigue bloqueando el avalista (${avalista}). Ejecuta en Supabase el archivo 051_drop_avalista_db_enforcement.sql (SQL Editor → Run) y vuelve a guardar.`
          : 'Debes elegir un socio avalista en el desplegable «Socio avalista (garante)» antes de guardar.';
      } else if (
        String(error.message || '').toLowerCase().includes('club_member_counters') ||
        String(error.message || '').toLowerCase().includes('row-level security')
      ) {
        msg =
          'No se pudo crear el socio (permisos / contador). Ejecuta en Supabase la migración 044_club_member_counters_rls.sql.';
      }
      if (fromTerms) setMemberTermsStatus(msg, true);
      setMemberMsg(msg, true);
      return;
    }

    if (!memberId) {
      const msg = 'No se pudo obtener el identificador del socio guardado.';
      if (fromTerms) setMemberTermsStatus(msg, true);
      setMemberMsg(msg, true);
      return;
    }

    // Evita altas duplicadas si falla algo después del insert.
    if ($('member-edit-id')) $('member-edit-id').value = memberId;
    selectedMemberId = memberId;

    const hadPending = Object.keys(SLOT_TO_COL).some((s) => memberPendingFiles[s]);
    let uploadedCount = 0;
    if (memberId && hadPending) {
      const up = await uploadPendingAssets(memberId);
      if (!up.ok) {
        const msg =
          ($('member-status')?.textContent || '').trim() ||
          'Socio creado, pero falló la subida de archivos.';
        if (fromTerms) setMemberTermsStatus(msg, true);
        setMemberMsg(msg, true);
        closeMemberTermsModal();
        await loadMembersTable();
        return;
      }
      const keys = Object.keys(up.pathUpdates || {});
      uploadedCount = up.uploadedCount || keys.length;
      if (keys.length) {
        const { error: pe } = await sb()
          .from('club_members')
          .update(up.pathUpdates)
          .eq('id', memberId);
        if (pe) {
          if (isMissingStorageColErr(pe)) {
            const msg =
              'Socio guardado; ejecuta 012_club_member_storage.sql para enlazar archivos.';
            if (fromTerms) setMemberTermsStatus(msg, true);
            setMemberMsg(msg, true);
          } else {
            const msg = pe.message || 'No se pudieron guardar las rutas de archivos.';
            if (fromTerms) setMemberTermsStatus(msg, true);
            setMemberMsg(msg, true);
          }
          closeMemberTermsModal();
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
        const msg = `${id ? 'Socio guardado' : 'Socio creado'}, pero el monedero no se actualizó: ${walletSync.message}`;
        if (fromTerms) setMemberTermsStatus(msg, true);
        setMemberMsg(msg, true);
        closeMemberTermsModal();
        await loadMembersTable();
        if (typeof window.scClubInventoryReloadMembers === 'function') {
          await window.scClubInventoryReloadMembers();
        }
        return;
      }
    }

    const filesNote =
      uploadedCount > 0
        ? ` ${uploadedCount} archivo${uploadedCount === 1 ? '' : 's'} guardado${uploadedCount === 1 ? '' : 's'}.`
        : '';
    const okMsg =
      (savedWithoutRfidColumn
        ? 'Socio guardado. Ejecuta en Supabase 045_club_members_rfid.sql para poder guardar la chapa RFID.'
        : savedWithoutAvalistaColumn
          ? 'Socio guardado. Ejecuta en Supabase la migración 040_club_members_avalista.sql para guardar el avalista.'
          : savedWithoutValidUntilColumn
            ? 'Socio guardado. Ejecuta en Supabase la migración 021_club_members_tier_valid_until.sql para poder guardar la vigencia Premium/VIP.'
            : isNew
              ? 'Socio creado.'
              : 'Socio actualizado.') + filesNote;
    setMemberMsg(
      okMsg,
      savedWithoutRfidColumn || savedWithoutAvalistaColumn || savedWithoutValidUntilColumn,
    );
    selectedMemberId = memberId;
    pendingSaveAvalista = null;

    if (
      !isNew &&
      memberId &&
      member_type &&
      memberEditInitialType !== member_type &&
      typeof window.scMembershipGrantOnTierUpgrade === 'function'
    ) {
      try {
        await window.scMembershipGrantOnTierUpgrade(
          memberId,
          memberEditInitialType || 'standard',
          member_type,
        );
      } catch (_) {
        /* opcional hasta migración 052 */
      }
    }

    closeMemberTermsModal();
    closeMemberModals();
    await loadMembersTable();
    if (typeof window.scClubInventoryReloadMembers === 'function') {
      await window.scClubInventoryReloadMembers();
    }
    if (typeof window.scClubRefreshHomeKpis === 'function') {
      void window.scClubRefreshHomeKpis();
    }
    const savedMember = membersCache.find((m) => memberIdEquals(m.id, memberId));
    if (savedMember) {
      await showMemberProfile(memberId, { skipDniWarn: options.skipDniWarn === true || isNew });
    } else if (isNew) {
      clearMemberForm();
      setMemberMsg(okMsg, false);
    }
    } catch (err) {
      const msg = err?.message || 'Error inesperado al guardar el socio.';
      if (fromTerms) setMemberTermsStatus(msg, true);
      setMemberMsg(msg, true);
    } finally {
      setMemberSavingUi(false);
      // Mantener pendingSaveAvalista si falló, para reintentar Confirmar alta.
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

  function getFinanceDateBounds(range, fromStr, toStr) {
    const now = new Date();
    if (range === 'today') {
      return { from: startOfDay(now), to: null };
    }
    if (range === 'week') {
      return { from: mondayStartOfWeek(now), to: null };
    }
    if (range === '30d') {
      const from = startOfDay(now);
      from.setDate(from.getDate() - 30);
      return { from, to: null };
    }
    if (range === 'custom') {
      const from = parseFinanceDateInput(fromStr, false);
      const to = parseFinanceDateInput(toStr, true);
      return { from, to };
    }
    return { from: null, to: null };
  }

  function financeDateRangeLabel(range, fromStr, toStr) {
    if (range === 'today') return 'hoy';
    if (range === 'week') return 'esta semana';
    if (range === '30d') return 'los últimos 30 días';
    if (range === 'all') return 'todo el historial';
    if (fromStr && toStr) return `del ${fromStr} al ${toStr}`;
    if (fromStr) return `desde ${fromStr}`;
    if (toStr) return `hasta ${toStr}`;
    return 'el rango elegido';
  }

  function getFinanceVentasBounds() {
    return getFinanceDateBounds(financeVentasRange, financeVentasFrom, financeVentasTo);
  }

  function financeVentasRangeLabel() {
    return financeDateRangeLabel(financeVentasRange, financeVentasFrom, financeVentasTo);
  }

  function financeVentasCategoryLabel() {
    if (!financeVentasCategoryId) return '';
    const c = financeVentasCategories.find((x) => x.id === financeVentasCategoryId);
    return c ? c.name : 'la categoría elegida';
  }

  function financeVentasSearchLabel() {
    const q = financeVentasSearch.trim();
    return q ? `«${q}»` : '';
  }

  function financeVentasFilterSummaryParts() {
    const parts = [financeVentasRangeLabel()];
    const cat = financeVentasCategoryLabel();
    if (cat) parts.push(`categoría ${cat}`);
    const search = financeVentasSearchLabel();
    if (search) parts.push(search);
    return parts.join(' · ');
  }

  function isFinanceGiftDispense(row) {
    const notes = String(row?.notes || '').toLowerCase();
    if (notes.includes('regalo')) return true;
    const price = Number(row?.price_charged_eur);
    return Number.isFinite(price) && Math.abs(price) < 0.0005 && notes.includes('membres');
  }

  function setFinanceVentasStats({ count, total, cash, wallet, gifts }) {
    const set = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text;
    };
    set('finance-ventas-stat-count', count == null ? '—' : String(count));
    set('finance-ventas-stat-total', total == null ? '—' : formatMoney(total));
    set('finance-ventas-stat-cash', cash == null ? '—' : formatMoney(cash));
    set('finance-ventas-stat-wallet', wallet == null ? '—' : formatMoney(wallet));
    set('finance-ventas-stat-gifts', gifts == null ? '—' : String(gifts));
  }

  /**
   * PostgREST/Supabase suele cortar en 1000 filas. Pagina con .range() hasta agotar.
   * @param {(from:number,to:number)=>Promise<{data:any[]|null,error:any}>} fetchPage
   */
  async function fetchAllSupabasePages(fetchPage, options = {}) {
    const pageSize = Math.max(100, Number(options.pageSize) || 1000);
    const maxRows = Math.max(pageSize, Number(options.maxRows) || 100000);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const all = [];
    let from = 0;
    let lastError = null;

    while (from < maxRows) {
      const to = Math.min(from + pageSize - 1, maxRows - 1);
      const { data, error } = await fetchPage(from, to);
      if (error) {
        lastError = error;
        break;
      }
      const chunk = data || [];
      if (!chunk.length) break;
      all.push(...chunk);
      if (onProgress) onProgress(all.length);
      if (chunk.length < pageSize) break;
      from += pageSize;
    }

    return { data: all, error: lastError, truncated: all.length >= maxRows };
  }

  async function resolveFinanceVentasProductFilterIds() {
    if (!financeVentasCategoryId) return null;

    const build = (withArchivedFilter) => {
      let query = sb().from('inventory_products').select('id').eq('club_id', ctx.club.id);
      if (withArchivedFilter) query = query.eq('is_archived', false);
      query = query.eq('category_id', financeVentasCategoryId);
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

  async function resolveFinanceVentasMemberSearchIds(search) {
    const q = String(search || '').trim();
    if (!q) return [];
    const { data, error } = await sb()
      .from('club_members')
      .select('id')
      .eq('club_id', ctx.club.id)
      .ilike('display_name', `%${q}%`)
      .limit(200);
    if (error) return [];
    return (data || []).map((m) => m.id).filter(Boolean);
  }

  async function resolveFinanceVentasProductSearchIds(search) {
    const q = String(search || '').trim();
    if (!q) return [];
    const build = (withArchivedFilter) => {
      let query = sb()
        .from('inventory_products')
        .select('id')
        .eq('club_id', ctx.club.id)
        .ilike('name', `%${q}%`)
        .limit(200);
      if (withArchivedFilter) query = query.eq('is_archived', false);
      return query;
    };
    let { data, error } = await build(true);
    if (
      error &&
      (error.code === '42703' || String(error.message || '').toLowerCase().includes('is_archived'))
    ) {
      ({ data, error } = await build(false));
    }
    if (error) return [];
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
        void refreshFinance();
      });
      row.appendChild(b);
    };
    mk('Todas', '', financeVentasCategoryId === '');
    financeVentasCategories.forEach((c) => mk(c.name, c.id, financeVentasCategoryId === c.id));
  }

  function renderFinanceDateFilterUi(section, range) {
    document.querySelectorAll(`[data-finance-${section}-range]`).forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute(`data-finance-${section}-range`) === range);
    });
    const customWrap = $(`finance-${section}-custom`);
    if (customWrap) {
      const showCustom = range === 'custom';
      customWrap.hidden = !showCustom;
      customWrap.classList.toggle('is-hidden', !showCustom);
    }
  }

  function bindFinanceDateFilter(section, filter, refreshFn) {
    if (filter._bound) return;
    filter._bound = true;
    const attr = `data-finance-${section}-range`;

    document.querySelectorAll(`[${attr}]`).forEach((btn) => {
      btn.addEventListener('click', () => {
        filter.range = btn.getAttribute(attr) || '30d';
        renderFinanceDateFilterUi(section, filter.range);
        if (filter.range !== 'custom') void refreshFn();
      });
    });

    $(`finance-${section}-apply`)?.addEventListener('click', () => {
      filter.from = ($(`finance-${section}-from`)?.value || '').trim();
      filter.to = ($(`finance-${section}-to`)?.value || '').trim();
      filter.range = 'custom';
      renderFinanceDateFilterUi(section, 'custom');
      void refreshFn();
    });

    renderFinanceDateFilterUi(section, filter.range);
  }

  function bindFinanceSectionFiltersOnce() {
    if (financeSectionFiltersBound) return;
    if (!$('finance-shifts-tbody') && !$('finance-inventory-adjust-tbody') && !$('finance-wallet-tbody')) return;
    financeSectionFiltersBound = true;
    bindFinanceDateFilter('shifts', financeShiftsFilter, refreshFinanceShiftClosures);
    bindFinanceDateFilter('adjust', financeAdjustFilter, refreshFinanceStockAdjustments);
    bindFinanceDateFilter('wallet', financeWalletFilter, refreshFinanceWalletMovements);

    $('finance-shifts-empty-all')?.addEventListener('click', () => {
      financeShiftsFilter.range = 'all';
      renderFinanceDateFilterUi('shifts', 'all');
      void refreshFinanceShiftClosures();
    });
    $('finance-adjust-empty-all')?.addEventListener('click', () => {
      financeAdjustFilter.range = 'all';
      renderFinanceDateFilterUi('adjust', 'all');
      void refreshFinanceStockAdjustments();
    });
    $('finance-wallet-empty-all')?.addEventListener('click', () => {
      financeWalletFilter.range = 'all';
      renderFinanceDateFilterUi('wallet', 'all');
      void refreshFinanceWalletMovements();
    });
    $('finance-wallet-search')?.addEventListener('input', () => {
      financeWalletFilter.search = $('finance-wallet-search')?.value || '';
      void refreshFinanceWalletMovements();
    });
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
          void refreshFinance();
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

    $('finance-ventas-empty-all')?.addEventListener('click', () => {
      financeVentasRange = 'all';
      renderFinanceVentasRangeChips();
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

    let { data: rows, error } = await sb()
      .from('tpv_dispenses')
      .select('price_charged_eur, created_at, payment_method')
      .eq('club_id', clubId)
      .gte('created_at', d30.toISOString())
      .order('created_at', { ascending: false })
      .limit(500);

    if (
      error &&
      (error.code === '42703' ||
        String(error.message || '')
          .toLowerCase()
          .includes('payment_method'))
    ) {
      const retry = await sb()
        .from('tpv_dispenses')
        .select('price_charged_eur, created_at')
        .eq('club_id', clubId)
        .gte('created_at', d30.toISOString())
        .order('created_at', { ascending: false })
        .limit(500);
      rows = retry.data;
      error = retry.error;
    }

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

    if ($('finance-kpi-today')) $('finance-kpi-today').textContent = formatMoney(sumToday);
    if ($('finance-kpi-7d')) $('finance-kpi-7d').textContent = formatMoney(sum7);
    if ($('finance-kpi-30d')) $('finance-kpi-30d').textContent = formatMoney(sum30);
    return true;
  }

  async function refreshHomeKpis() {
    if (!ctx) return;
    const clubId = ctx.club.id;
    const salesEl = $('home-kpi-sales');
    const membersEl = $('home-kpi-members');
    const alertsEl = $('home-kpi-alerts');
    if (!salesEl && !membersEl && !alertsEl) return;

    const now = new Date();
    const d0 = startOfDay(now);

    const tasks = [];

    if (salesEl) {
      tasks.push(
        (async () => {
          let { data: rows, error } = await sb()
            .from('tpv_dispenses')
            .select('price_charged_eur, created_at')
            .eq('club_id', clubId)
            .gte('created_at', d0.toISOString())
            .limit(300);
          if (error) {
            salesEl.textContent = '—';
            return;
          }
          let sumToday = 0;
          (rows || []).forEach((r) => {
            sumToday += Number(r.price_charged_eur) || 0;
          });
          salesEl.textContent = formatMoney(sumToday);
        })(),
      );
    }

    if (membersEl) {
      tasks.push(
        (async () => {
          async function countActiveMembers(includeArchivedFilter) {
            let q = sb()
              .from('club_members')
              .select('id', { count: 'exact', head: true })
              .eq('club_id', clubId)
              .eq('is_active', true);
            if (includeArchivedFilter) q = q.eq('is_archived', false);
            return q;
          }

          // Preferir el flag ya detectado al cargar socios.
          const tryArchivedFirst = hasArchivedMemberColumn !== false;
          let { count, error } = await countActiveMembers(tryArchivedFirst);

          if (
            error &&
            (error.code === '42703' ||
              error.code === 'PGRST204' ||
              String(error.message || '').toLowerCase().includes('is_archived'))
          ) {
            hasArchivedMemberColumn = false;
            ({ count, error } = await countActiveMembers(false));
          }

          // Si el head/count falla (RLS/API), contar filas visibles.
          if (error) {
            let listQ = sb()
              .from('club_members')
              .select('id, is_active, is_archived')
              .eq('club_id', clubId)
              .eq('is_active', true)
              .limit(5000);
            let list = await listQ;
            if (
              list.error &&
              (list.error.code === '42703' ||
                list.error.code === 'PGRST204' ||
                String(list.error.message || '').toLowerCase().includes('is_archived'))
            ) {
              hasArchivedMemberColumn = false;
              list = await sb()
                .from('club_members')
                .select('id, is_active')
                .eq('club_id', clubId)
                .eq('is_active', true)
                .limit(5000);
            }
            if (list.error) {
              // Último recurso: caché en memoria de la vista Socios.
              const fromCache = (membersCache || []).filter(
                (m) => m && m.is_active !== false && !isMemberArchived(m),
              ).length;
              membersEl.textContent = String(fromCache);
              return;
            }
            const rows = list.data || [];
            const n = rows.filter((m) => !isMemberArchived(m)).length;
            membersEl.textContent = String(n);
            return;
          }

          membersEl.textContent = String(count ?? 0);
        })(),
      );
    }

    if (alertsEl) {
      tasks.push(
        (async () => {
          let { data: products, error } = await sb()
            .from('inventory_products')
            .select('stock_grams, stock_alert_grams')
            .eq('club_id', clubId);
          if (
            error &&
            (error.code === '42703' ||
              String(error.message || '').toLowerCase().includes('stock_alert'))
          ) {
            const retry = await sb()
              .from('inventory_products')
              .select('stock_grams')
              .eq('club_id', clubId);
            products = retry.data;
            error = retry.error;
          }
          if (error) {
            alertsEl.textContent = '—';
            return;
          }
          let lowCount = 0;
          (products || []).forEach((p) => {
            const min = Number(p.stock_alert_grams) || 0;
            if (min <= 0) return;
            const stock = Number(p.stock_grams) || 0;
            if (stock <= min) lowCount += 1;
          });
          alertsEl.textContent = String(lowCount);
          alertsEl.classList.toggle('is-alert', lowCount > 0);
        })(),
      );
    }

    await Promise.all(tasks);
  }

  async function refreshFinanceVentasTpv() {
    const ventasBody = $('finance-ventas-tbody');
    const summaryEl = $('finance-ventas-summary');
    const emptyEl = $('finance-ventas-empty');
    if (!ventasBody || !ctx) return;

    bindFinanceVentasUiOnce();
    await loadFinanceVentasCategories();

    const showEmpty = (msg) => {
      ventasBody.innerHTML = '';
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.classList.remove('is-hidden');
        const title = emptyEl.querySelector('.sc-finance-sales__empty-title');
        if (title && msg) title.textContent = msg;
      }
      if (summaryEl) summaryEl.textContent = '';
      setFinanceVentasStats({ count: 0, total: 0, cash: 0, wallet: 0, gifts: 0 });
    };

    if (financeVentasRange === 'custom' && !financeVentasFrom && !financeVentasTo) {
      ventasBody.innerHTML = '';
      if (summaryEl) {
        summaryEl.textContent = 'Indica al menos una fecha y pulsa «Aplicar».';
      }
      if (emptyEl) {
        emptyEl.hidden = true;
        emptyEl.classList.add('is-hidden');
      }
      setFinanceVentasStats({});
      return;
    }

    const bounds = getFinanceVentasBounds();
    if (financeVentasRange === 'custom' && !bounds.from && !bounds.to) {
      ventasBody.innerHTML = '';
      if (summaryEl) summaryEl.textContent = 'Las fechas indicadas no son válidas.';
      if (emptyEl) {
        emptyEl.hidden = true;
        emptyEl.classList.add('is-hidden');
      }
      setFinanceVentasStats({});
      return;
    }

    let productFilterIds = null;
    try {
      productFilterIds = await resolveFinanceVentasProductFilterIds();
    } catch (prodErr) {
      ventasBody.innerHTML = `<tr><td colspan="6">${escapeHtml(prodErr.message)}</td></tr>`;
      if (summaryEl) summaryEl.textContent = '';
      if (emptyEl) {
        emptyEl.hidden = true;
        emptyEl.classList.add('is-hidden');
      }
      setFinanceVentasStats({});
      return;
    }
    if (productFilterIds && !productFilterIds.length) {
      showEmpty('Sin productos en esa categoría');
      if (summaryEl) {
        summaryEl.textContent = `0 ventas en ${financeVentasFilterSummaryParts()}.`;
      }
      return;
    }

    const search = financeVentasSearch.trim();
    let searchProductIds = [];
    let searchMemberIds = [];
    if (search) {
      [searchProductIds, searchMemberIds] = await Promise.all([
        resolveFinanceVentasProductSearchIds(search),
        resolveFinanceVentasMemberSearchIds(search),
      ]);
      if (!searchProductIds.length && !searchMemberIds.length) {
        showEmpty('Sin coincidencias para la búsqueda');
        if (summaryEl) {
          summaryEl.textContent = `0 ventas en ${financeVentasFilterSummaryParts()}.`;
        }
        return;
      }
    }

    const selectColsFull =
      'price_charged_eur, created_at, product_id, member_id, payment_method, grams_charged, grams_dispensed, notes';
    const selectColsPay =
      'price_charged_eur, created_at, product_id, member_id, payment_method';
    const selectColsBasic = 'price_charged_eur, created_at, product_id, member_id';

    const buildDispensePageQuery = (cols, from, to) => {
      let q = sb()
        .from('tpv_dispenses')
        .select(cols)
        .eq('club_id', ctx.club.id)
        .order('created_at', { ascending: false })
        .range(from, to);
      if (bounds.from) q = q.gte('created_at', bounds.from.toISOString());
      if (bounds.to) q = q.lte('created_at', bounds.to.toISOString());
      if (productFilterIds) q = q.in('product_id', productFilterIds);
      return q;
    };

    if (summaryEl) {
      summaryEl.textContent =
        financeVentasRange === 'all'
          ? 'Cargando todo el historial de ventas…'
          : 'Cargando ventas…';
    }

    let selectCols = selectColsFull;
    let pageResult = await fetchAllSupabasePages(
      (from, to) => buildDispensePageQuery(selectCols, from, to),
      {
        pageSize: 1000,
        maxRows: financeVentasRange === 'all' ? 100000 : 5000,
        onProgress: (n) => {
          if (summaryEl && financeVentasRange === 'all') {
            summaryEl.textContent = `Cargando historial… ${n.toLocaleString('es-ES')} líneas`;
          }
        },
      },
    );

    if (
      pageResult.error &&
      (pageResult.error.code === '42703' ||
        String(pageResult.error.message || '')
          .toLowerCase()
          .includes('payment_method') ||
        String(pageResult.error.message || '')
          .toLowerCase()
          .includes('notes') ||
        String(pageResult.error.message || '')
          .toLowerCase()
          .includes('grams_'))
    ) {
      selectCols = selectColsPay;
      pageResult = await fetchAllSupabasePages(
        (from, to) => buildDispensePageQuery(selectCols, from, to),
        {
          pageSize: 1000,
          maxRows: financeVentasRange === 'all' ? 100000 : 5000,
        },
      );
      if (
        pageResult.error &&
        (pageResult.error.code === '42703' ||
          String(pageResult.error.message || '')
            .toLowerCase()
            .includes('payment_method'))
      ) {
        selectCols = selectColsBasic;
        pageResult = await fetchAllSupabasePages(
          (from, to) => buildDispensePageQuery(selectCols, from, to),
          {
            pageSize: 1000,
            maxRows: financeVentasRange === 'all' ? 100000 : 5000,
          },
        );
      }
    }

    const { data: rows, error, truncated } = pageResult;
    if (error) {
      ventasBody.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;
      if (summaryEl) summaryEl.textContent = '';
      if (emptyEl) {
        emptyEl.hidden = true;
        emptyEl.classList.add('is-hidden');
      }
      setFinanceVentasStats({});
      return;
    }

    let list = rows || [];
    const pids = [...new Set(list.map((r) => r.product_id).filter(Boolean))];
    const mids = [...new Set(list.map((r) => r.member_id).filter(Boolean))];

    let prodMap = {};
    let memMap = {};
    if (pids.length) {
      const { data: pr } = await sb()
        .from('inventory_products')
        .select('id, name, emoji, sale_unit')
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

    if (search) {
      const prodSet = new Set(searchProductIds.map(String));
      const memSet = new Set(searchMemberIds.map(String));
      const qLower = search.toLowerCase();
      list = list.filter((r) => {
        if (r.product_id && prodSet.has(String(r.product_id))) return true;
        if (r.member_id && memSet.has(String(r.member_id))) return true;
        const pr = prodMap[r.product_id];
        if (pr?.name && String(pr.name).toLowerCase().includes(qLower)) return true;
        const mb = r.member_id ? memMap[r.member_id] : null;
        if (mb?.display_name && String(mb.display_name).toLowerCase().includes(qLower)) return true;
        const notes = String(r.notes || '').toLowerCase();
        if (notes.includes(qLower)) return true;
        return false;
      });
    }

    ventasBody.innerHTML = '';
    if (!list.length) {
      showEmpty('Sin movimientos en este periodo');
      if (summaryEl) {
        summaryEl.textContent = `0 ventas en ${financeVentasFilterSummaryParts()}.`;
      }
      return;
    }
    if (emptyEl) {
      emptyEl.hidden = true;
      emptyEl.classList.add('is-hidden');
    }

    let total = 0;
    let totalCash = 0;
    let totalWallet = 0;
    let giftCount = 0;
    list.forEach((r) => {
      const p = Number(r.price_charged_eur) || 0;
      total += p;
      const isGift = isFinanceGiftDispense(r);
      if (isGift) giftCount += 1;
      if (String(r.payment_method || 'cash').toLowerCase() === 'wallet') totalWallet += p;
      else totalCash += p;
      const pr = prodMap[r.product_id] || {};
      const em = (pr.emoji || '').trim();
      const prodLabel = `${em ? em + ' ' : ''}${pr.name || '—'}`;
      const mb = r.member_id ? memMap[r.member_id] : null;
      const socio = mb ? mb.display_name : '—';
      const unit = pr.sale_unit === 'unit' ? 'ud' : 'g';
      const qtyRaw = r.grams_charged != null ? r.grams_charged : r.grams_dispensed;
      const qtyText =
        qtyRaw != null && qtyRaw !== ''
          ? `${formatQty(qtyRaw)} ${unit}`
          : '—';
      const giftBadge = isGift
        ? '<span class="sc-finance-sales__gift">Regalo</span>'
        : '';
      const tr = document.createElement('tr');
      if (isGift) tr.classList.add('is-gift');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
        <td>${escapeHtml(prodLabel)}${giftBadge}</td>
        <td>${escapeHtml(qtyText)}</td>
        <td>${escapeHtml(socio)}</td>
        <td>${escapeHtml(isGift ? 'Regalo' : paymentMethodLabel(r.payment_method))}</td>
        <td>${escapeHtml(formatMoney(r.price_charged_eur))}</td>
      `;
      ventasBody.appendChild(tr);
    });

    setFinanceVentasStats({
      count: list.length,
      total,
      cash: totalCash,
      wallet: totalWallet,
      gifts: giftCount,
    });

    if (summaryEl) {
      const truncNote = truncated
        ? ' · se alcanzó el límite de carga (100.000); afina el periodo si faltan'
        : '';
      summaryEl.textContent = `${list.length.toLocaleString('es-ES')} línea(s) en ${financeVentasFilterSummaryParts()}${truncNote}`;
    }
  }

  async function loadCurrentMemberWalletBalanceTotals() {
    if (!ctx?.club?.id || !sb()) return { pos: 0, neg: 0, ok: false };
    const pageResult = await fetchAllSupabasePages(
      (from, to) => {
        let q = sb()
          .from('club_members')
          .select('wallet_balance_eur, is_archived')
          .eq('club_id', ctx.club.id)
          .order('id', { ascending: true })
          .range(from, to);
        return q;
      },
      { pageSize: 1000, maxRows: 100000 },
    );

    // Fallback si no existe is_archived
    let rows = pageResult.data || [];
    let ok = !pageResult.error;
    if (
      pageResult.error &&
      (pageResult.error.code === '42703' ||
        String(pageResult.error.message || '').toLowerCase().includes('is_archived') ||
        String(pageResult.error.message || '').toLowerCase().includes('wallet_balance'))
    ) {
      const retry = await fetchAllSupabasePages(
        (from, to) =>
          sb()
            .from('club_members')
            .select('wallet_balance_eur')
            .eq('club_id', ctx.club.id)
            .order('id', { ascending: true })
            .range(from, to),
        { pageSize: 1000, maxRows: 100000 },
      );
      if (retry.error && String(retry.error.message || '').toLowerCase().includes('wallet_balance')) {
        return { pos: 0, neg: 0, ok: false };
      }
      rows = retry.data || [];
      ok = !retry.error;
    } else if (pageResult.error) {
      return { pos: 0, neg: 0, ok: false };
    }

    let pos = 0;
    let neg = 0;
    rows.forEach((m) => {
      if (m && m.is_archived) return;
      const bal = Number(m.wallet_balance_eur);
      if (!Number.isFinite(bal) || Math.abs(bal) < 0.0005) return;
      if (bal > 0) pos += bal;
      else neg += Math.abs(bal);
    });
    return { pos, neg, ok };
  }

  async function refreshFinanceWalletMovements() {
    const tbody = $('finance-wallet-tbody');
    const summaryEl = $('finance-wallet-summary');
    const emptyEl = $('finance-wallet-empty');
    if (!tbody || !ctx) return;

    const rangeLabel = financeDateRangeLabel(
      financeWalletFilter.range,
      financeWalletFilter.from,
      financeWalletFilter.to,
    );
    const bounds = getFinanceDateBounds(
      financeWalletFilter.range,
      financeWalletFilter.from,
      financeWalletFilter.to,
    );

    // Saldos actuales de todos los socios (independiente del periodo de la tabla)
    const balTotals = await loadCurrentMemberWalletBalanceTotals();
    if (balTotals.ok) {
      setStatText(
        'finance-wallet-stat-pos',
        balTotals.pos > 0 ? `+${formatMoney(balTotals.pos)}` : formatMoney(0),
      );
      setStatText(
        'finance-wallet-stat-neg',
        balTotals.neg > 0 ? `−${formatMoney(balTotals.neg)}` : formatMoney(0),
      );
    } else {
      setStatText('finance-wallet-stat-pos', '—');
      setStatText('finance-wallet-stat-neg', '—');
    }

    if (summaryEl && financeWalletFilter.range === 'all') {
      summaryEl.textContent = 'Cargando todos los movimientos…';
    }

    const pageResult = await fetchAllSupabasePages(
      (from, to) => {
        let q = sb()
          .from('club_member_wallet_ledger')
          .select('created_at, amount_eur, balance_after_eur, cash_eur, kind, notes, member_id')
          .eq('club_id', ctx.club.id)
          .eq('kind', 'adjustment')
          .order('created_at', { ascending: false })
          .range(from, to);
        if (bounds.from) q = q.gte('created_at', bounds.from.toISOString());
        if (bounds.to) q = q.lte('created_at', bounds.to.toISOString());
        return q;
      },
      {
        pageSize: 1000,
        maxRows: financeWalletFilter.range === 'all' ? 100000 : 5000,
      },
    );

    const { data: rows, error, truncated } = pageResult;
    if (error) {
      const msg =
        error.code === '42P01' ||
        String(error.message || '').toLowerCase().includes('club_member_wallet_ledger')
          ? 'Ejecuta la migración 028_member_wallet.sql en Supabase.'
          : error.message || 'Error cargando monedero.';
      tbody.innerHTML = `<tr><td colspan="7">${escapeHtml(msg)}</td></tr>`;
      if (summaryEl) summaryEl.textContent = '';
      setFinanceEmptyVisible(emptyEl, false);
      setStatText('finance-wallet-stat-count', '—');
      return;
    }

    let list = rows || [];
    const mids = [...new Set(list.map((r) => r.member_id).filter(Boolean))];
    let memMap = {};
    if (mids.length) {
      const { data: mm } = await sb().from('club_members').select('id, display_name').in('id', mids);
      if (mm) memMap = Object.fromEntries(mm.map((x) => [x.id, x]));
    }

    const search = String(financeWalletFilter.search || '').trim().toLowerCase();
    if (search) {
      list = list.filter((r) => {
        const mb = r.member_id ? memMap[r.member_id] : null;
        const name = String(mb?.display_name || '').toLowerCase();
        const notes = String(r.notes || '').toLowerCase();
        return name.includes(search) || notes.includes(search);
      });
    }

    tbody.innerHTML = '';
    if (!list.length) {
      setFinanceEmptyVisible(emptyEl, true);
      setStatText('finance-wallet-stat-count', '0');
      if (summaryEl) {
        summaryEl.textContent = `Sin movimientos de monedero en ${rangeLabel}.`;
      }
      return;
    }
    setFinanceEmptyVisible(emptyEl, false);

    list.forEach((r) => {
      const amt = Number(r.amount_eur) || 0;
      const cash = Number(r.cash_eur) || 0;
      const mb = r.member_id ? memMap[r.member_id] : null;
      const tipo =
        amt >= 0 ? (Math.abs(cash) > 0.005 ? 'Recarga (efectivo)' : 'Ingreso monedero') : Math.abs(cash) > 0.005
          ? 'Retirada (efectivo)'
          : 'Retirada monedero';
      const tr = document.createElement('tr');
      if (amt < 0) tr.classList.add('is-out');
      else tr.classList.add('is-in');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
        <td>${escapeHtml(mb ? mb.display_name : '—')}</td>
        <td>${escapeHtml(tipo)}</td>
        <td>${escapeHtml(formatWalletLedgerAmount(amt))}</td>
        <td>${escapeHtml(Math.abs(cash) > 0.005 ? formatWalletLedgerAmount(cash) : '—')}</td>
        <td>${escapeHtml(formatMoney(Number(r.balance_after_eur) || 0))}</td>
        <td>${escapeHtml((r.notes || '').slice(0, 60))}</td>
      `;
      tbody.appendChild(tr);
    });

    setStatText('finance-wallet-stat-count', String(list.length));
    if (summaryEl) {
      const truncNote = truncated ? ' · límite de carga alcanzado' : '';
      summaryEl.textContent = `${list.length.toLocaleString('es-ES')} movimiento(s) en ${rangeLabel}.${truncNote}`;
    }
  }

  async function refreshFinanceStockAdjustments() {
    const tbody = $('finance-inventory-adjust-tbody');
    const emptyEl = $('finance-inventory-adjust-empty');
    const summaryEl = $('finance-inventory-adjust-summary');
    const section = $('finance-inventory-adjust-section');
    if (!tbody || !ctx) return;

    const rangeLabel = financeDateRangeLabel(
      financeAdjustFilter.range,
      financeAdjustFilter.from,
      financeAdjustFilter.to,
    );
    const bounds = getFinanceDateBounds(
      financeAdjustFilter.range,
      financeAdjustFilter.from,
      financeAdjustFilter.to,
    );

    if (summaryEl && financeAdjustFilter.range === 'all') {
      summaryEl.textContent = 'Cargando todos los ajustes…';
    }

    const pageResult = await fetchAllSupabasePages(
      (from, to) => {
        let q = sb()
          .from('inventory_stock_adjustments')
          .select(
            'id, created_at, delta_grams, previous_stock_grams, new_stock_grams, notes, product_id, created_by',
          )
          .eq('club_id', ctx.club.id)
          .order('created_at', { ascending: false })
          .range(from, to);
        if (bounds.from) q = q.gte('created_at', bounds.from.toISOString());
        if (bounds.to) q = q.lte('created_at', bounds.to.toISOString());
        return q;
      },
      {
        pageSize: 1000,
        maxRows: financeAdjustFilter.range === 'all' ? 100000 : 5000,
      },
    );

    const { data: rows, error, truncated } = pageResult;

    if (error) {
      if (
        error.code === '42P01' ||
        (error.message && error.message.includes('inventory_stock_adjustments'))
      ) {
        if (section) section.hidden = true;
        return;
      }
      tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
      setFinanceEmptyVisible(emptyEl, false);
      if (section) section.hidden = false;
      setStatText('finance-adjust-stat-count', '—');
      setStatText('finance-adjust-stat-in', '—');
      setStatText('finance-adjust-stat-out', '—');
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
      const ids = list.map((r) => r.created_by);
      if (typeof window.SCAuth?.loadClubStaffEmailMap === 'function') {
        staffMap = await window.SCAuth.loadClubStaffEmailMap(ctx.club.id, ids);
      }
    } catch (e) {
      /* ignore */
    }

    tbody.innerHTML = '';
    if (!list.length) {
      setFinanceEmptyVisible(emptyEl, true);
      setStatText('finance-adjust-stat-count', '0');
      setStatText('finance-adjust-stat-in', '0');
      setStatText('finance-adjust-stat-out', '0');
      if (summaryEl) summaryEl.textContent = `0 ajustes en ${rangeLabel}.`;
      return;
    }
    setFinanceEmptyVisible(emptyEl, false);

    let inCount = 0;
    let outCount = 0;
    list.forEach((r) => {
      const pr = prodMap[r.product_id] || {};
      const em = (pr.emoji || '').trim();
      const prodLabel = `${em ? em + ' ' : ''}${pr.name || '—'}`;
      const u = pr.sale_unit === 'unit' ? 'ud' : 'g';
      const delta = Number(r.delta_grams);
      if (delta > 0) inCount += 1;
      else if (delta < 0) outCount += 1;
      const sign = delta > 0 ? '+' : '';
      const mov = `${sign}${formatQty(delta)} ${u}`;
      const who = r.created_by && staffMap[r.created_by] ? staffMap[r.created_by] : '—';
      const note = (r.notes || '').trim() || '—';
      const tr = document.createElement('tr');
      if (delta > 0) tr.classList.add('is-in');
      else if (delta < 0) tr.classList.add('is-out');
      tr.innerHTML = `
        <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
        <td>${escapeHtml(prodLabel)}</td>
        <td>${escapeHtml(who)}</td>
        <td>${escapeHtml(mov)}</td>
        <td>${escapeHtml(note)}</td>
      `;
      tbody.appendChild(tr);
    });

    setStatText('finance-adjust-stat-count', String(list.length));
    setStatText('finance-adjust-stat-in', String(inCount));
    setStatText('finance-adjust-stat-out', String(outCount));
    if (summaryEl) {
      const truncNote = truncated ? ' · límite de carga alcanzado' : '';
      summaryEl.textContent = `${list.length.toLocaleString('es-ES')} ajuste(s) en ${rangeLabel}.${truncNote}`;
    }
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
    bindFinanceSectionFiltersOnce();
    setFinanceMsg('Cargando…', false);

    const kpiOk = await refreshFinanceKpis();
    if (!kpiOk) return;

    await refreshFinanceInventoryCostAdmin();
    await refreshFinanceWalletMovements();
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
      else if (k === 'avalista' || k === 'aval' || k === 'socio_avalista') idx.avalista = i;
      else if (
        k === 'avalista_dni' ||
        kn === 'avalistadni' ||
        k === 'dni_avalista' ||
        kn === 'dniavalista'
      ) {
        idx.avalista_dni = i;
      }
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
    return memberTypeLabel(member_type || 'standard');
  }

  function normalizeTipoImport(s) {
    const raw = String(s || '').trim();
    if (!raw) return 'standard';
    const t = raw
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const tiers = getConfiguredMemberTiers();
    const byKey = tiers.find((x) => x.tier_key === t || x.tier_key === raw);
    if (byKey) return byKey.tier_key;
    const byName = tiers.find((x) => {
      const n = String(x.display_name || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      return n === t || n.includes(t) || t.includes(n);
    });
    if (byName) return byName.tier_key;
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
    const t = formatMemberName(full);
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
    let { data, error } = await sb()
      .from('club_members')
      .select('*')
      .eq('club_id', ctx.club.id)
      .order('member_number', { ascending: true });

    if (
      error &&
      (error.code === '42703' || String(error.message || '').toLowerCase().includes('member_number'))
    ) {
      ({ data, error } = await sb()
        .from('club_members')
        .select('*')
        .eq('club_id', ctx.club.id)
        .order('display_name', { ascending: true }));
    }
    if (error) {
      setMemberMsg(error.message || 'No se pudo exportar.', true);
      return;
    }
    const headers = [
      'numero_socio',
      'nombre',
      'email',
      'telefono',
      'tipo',
      'tipo_vigencia',
      'estado',
      'alta',
      'consumo',
      'dni',
      'avalista',
      'avalista_dni',
      'fecha_nacimiento',
      'monedero',
      'cuota',
      'uuid',
    ];
    const lines = [headers.join(',')];
    (data || []).forEach((m) => {
      const nombre =
        formatMemberDisplayName(m) ||
        formatMemberName(
          (m.display_name && String(m.display_name).trim()) ||
            [m.first_name, m.last_name].filter(Boolean).join(' ').trim(),
        );
      const birthIso =
        m.birth_date != null && String(m.birth_date).trim() !== ''
          ? String(m.birth_date).slice(0, 10)
          : '';
      const vigIso =
        m.member_type_valid_until != null && String(m.member_type_valid_until).trim() !== ''
          ? String(m.member_type_valid_until).slice(0, 10)
          : '';
      const row = [
        csvEscapeField(formatMemberCode(m) !== '—' ? formatMemberCode(m) : ''),
        csvEscapeField(nombre),
        csvEscapeField(m.email != null ? String(m.email) : ''),
        csvEscapeField(m.phone != null ? String(m.phone) : ''),
        csvEscapeField(tipoExportEs(m.member_type)),
        csvEscapeField(vigIso),
        csvEscapeField(m.is_active !== false ? 'activo' : 'inactivo'),
        csvEscapeField(formatAltaExport(m.created_at)),
        csvEscapeField(''),
        csvEscapeField(m.dni != null ? String(m.dni) : ''),
        csvEscapeField(m.avalista != null ? String(m.avalista) : ''),
        csvEscapeField(m.avalista_dni != null ? String(m.avalista_dni) : ''),
        csvEscapeField(birthIso),
        csvEscapeField(''),
        csvEscapeField(
          Number(m.enrollment_fee_eur) > 0
            ? `${typeof window.scGetCurrencySymbol === 'function' ? window.scGetCurrencySymbol() : '€'}${Number(m.enrollment_fee_eur).toFixed(2)}/mes`
            : `${typeof window.scGetCurrencySymbol === 'function' ? window.scGetCurrencySymbol() : '€'}0.00/mes`,
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
      if (tipo !== 'standard' && tipoVigRaw) {
        member_type_valid_until = parseBirthDateCsv(tipoVigRaw);
      }
      const activo = normalizeEstadoImport(csvCell(row, idx, 'estado'));
      const dni = formatMemberName(csvCell(row, idx, 'dni').trim());
      const avalista = csvCell(row, idx, 'avalista').trim();
      const avalista_dni = csvCell(row, idx, 'avalista_dni').trim();
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
        avalista,
        avalista_dni,
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

  function isMissingArchivedColErr(error) {
    if (!error) return false;
    const msg = String(error.message || '').toLowerCase();
    return (
      error.code === '42703' ||
      error.code === 'PGRST204' ||
      msg.includes('is_archived') ||
      msg.includes('archived_at')
    );
  }

  async function archiveMember(memberId) {
    if (!memberId || !ctx?.club?.id) {
      setMemberMsg('No hay socio seleccionado para eliminar.', true);
      return;
    }
    const m = membersCache.find((x) => memberIdEquals(x.id, memberId));
    const label = formatMemberDisplayName(m) || 'este socio';
    const msg =
      `¿Eliminar a ${label}?\n\n` +
      'Dejará de aparecer en la lista y en el POS, pero se conservará su historial (ventas, monedero y documentos).';
    if (!window.confirm(msg)) return;

    setMemberMsg('Eliminando socio…', false);

    // Re-probar columnas por si el listado se cargó antes de aplicar la migración 047.
    const archiveProbe = await sb().from('club_members').select('is_archived').limit(1);
    hasArchivedMemberColumn = !archiveProbe.error;

    let archivedOk = false;

    if (hasArchivedMemberColumn) {
      const payload = {
        is_archived: true,
        is_active: false,
        archived_at: new Date().toISOString(),
        rfid_uid: '',
      };
      let { data, error } = await sb()
        .from('club_members')
        .update(payload)
        .eq('id', memberId)
        .eq('club_id', ctx.club.id)
        .select('id')
        .maybeSingle();

      if (error && isMissingArchivedColErr(error)) {
        const payload2 = { is_archived: true, is_active: false, rfid_uid: '' };
        ({ data, error } = await sb()
          .from('club_members')
          .update(payload2)
          .eq('id', memberId)
          .eq('club_id', ctx.club.id)
          .select('id')
          .maybeSingle());
      }

      if (error) {
        setMemberMsg(error.message || 'No se pudo eliminar el socio.', true);
        window.alert(error.message || 'No se pudo eliminar el socio.');
        return;
      }
      if (!data?.id) {
        const fail =
          'No se pudo eliminar el socio (sin permiso de actualización o el socio ya no existe).';
        setMemberMsg(fail, true);
        window.alert(fail);
        return;
      }
      archivedOk = true;
    }

    if (!archivedOk) {
      // Sin columnas de archivo: intentar borrado real (si no hay FKs que lo impidan).
      const { data: delData, error: delErr } = await sb()
        .from('club_members')
        .delete()
        .eq('id', memberId)
        .eq('club_id', ctx.club.id)
        .select('id')
        .maybeSingle();
      if (delErr) {
        const fail =
          delErr.message ||
          'No se pudo eliminar. Ejecuta en Supabase supabase/migrations/047_club_members_archived.sql y reintenta.';
        setMemberMsg(fail, true);
        window.alert(fail);
        return;
      }
      if (!delData?.id) {
        const fail =
          'No se pudo eliminar el socio. Ejecuta en Supabase la migración 047_club_members_archived.sql.';
        setMemberMsg(fail, true);
        window.alert(fail);
        return;
      }
    }

    selectedMemberId = '';
    closeMemberModals();
    clearMemberForm();
    setMemberMsg('Socio eliminado. El historial se ha conservado.', false);
    await loadMembersTable();
    if (typeof window.scClubInventoryReloadMembers === 'function') {
      await window.scClubInventoryReloadMembers();
    }
  }

  async function deleteAllClubMembers() {
    if (!ctx?.club?.id) return;
    const msg =
      '¿Eliminar TODOS los socios activos de este club?\n\n' +
      'Dejarán de mostrarse en la lista y en el POS, pero se conservará el historial.\n' +
      'Los socios ya archivados no se tocan.';
    if (!window.confirm(msg)) return;
    if (!window.confirm('Confirma de nuevo: eliminar todos los socios activos.')) return;

    if (!hasArchivedMemberColumn) {
      setMemberMsg(
        'Ejecuta supabase/migrations/047_club_members_archived.sql en Supabase para eliminar socios conservando el historial.',
        true,
      );
      return;
    }

    setMemberMsg('Eliminando socios…', false);
    const payload = {
      is_archived: true,
      is_active: false,
      archived_at: new Date().toISOString(),
      rfid_uid: '',
    };
    const { error } = await sb()
      .from('club_members')
      .update(payload)
      .eq('club_id', ctx.club.id)
      .eq('is_archived', false);
    if (error) {
      setMemberMsg(error.message || 'No se pudo eliminar el listado.', true);
      return;
    }
    clearMemberForm();
    setMemberMsg('Socios eliminados. El historial se ha conservado.', false);
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

    $('member-save')?.addEventListener('click', () => void requestSaveMember());
    $('members-new')?.addEventListener('click', () => {
      selectedMemberId = '';
      clearMemberForm();
      setMemberMsg('', false);
      setMemberUiMode('edit');
      renderMembersTable();
    });
    $('members-empty-new')?.addEventListener('click', () => {
      $('members-new')?.click();
    });
    $('member-profile-edit-btn')?.addEventListener('click', () => {
      if (selectedMemberId) void editMemberFromRow(selectedMemberId);
    });
    $('member-profile-archive-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = String(selectedMemberId || '').trim();
      if (!id) {
        setMemberMsg('Abre de nuevo el perfil del socio e inténtalo otra vez.', true);
        window.alert('No hay socio seleccionado. Cierra el perfil, ábrelo de nuevo e inténtalo.');
        return;
      }
      void archiveMember(id);
    });
    $('member-archive')?.addEventListener('click', (e) => {
      e.preventDefault();
      const id = ($('member-edit-id')?.value || selectedMemberId || '').trim();
      if (!id) {
        setMemberMsg('No hay socio seleccionado para eliminar.', true);
        return;
      }
      void archiveMember(id);
    });
    $('member-wallet-adjust-add')?.addEventListener('click', () => {
      void applyMemberWalletAdjust(1);
    });
    $('member-wallet-adjust-sub')?.addEventListener('click', () => {
      void applyMemberWalletAdjust(-1);
    });
    $('member-cancel')?.addEventListener('click', () => {
      const id = ($('member-edit-id')?.value || '').trim();
      setMemberMsg('', false);
      if (id) {
        closeMemberModals();
        void showMemberProfile(id);
        return;
      }
      selectedMemberId = '';
      clearMemberForm();
      closeMemberModals();
    });

    document.querySelectorAll('[data-member-close-modal]').forEach((el) => {
      el.addEventListener('click', () => {
        closeMemberModals();
      });
    });
    $('member-view-avalista')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-avalista-member-id]');
      if (!btn) return;
      e.preventDefault();
      const id = btn.getAttribute('data-avalista-member-id');
      if (id) void showMemberProfile(id);
    });
    $('members-search')?.addEventListener('input', () => {
      membersSearch = $('members-search')?.value || '';
      renderMembersTable();
    });
    $('members-search')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = $('members-search')?.value || '';
      membersSearch = q;
      renderMembersTable();
      const byRfid = findMemberByExactRfid(q);
      if (byRfid) {
        void showMemberProfile(byRfid.id);
        return;
      }
      const matches = (membersCache || []).filter(
        (m) => memberMatchesSearch(m, q) && memberMatchesType(m),
      );
      if (matches.length === 1) void showMemberProfile(matches[0].id);
    });

    // Delegación: filtros y tipos se regeneran al cambiar membresías
    document.body.addEventListener('click', (e) => {
      const filterBtn = e.target?.closest?.('[data-members-type-filter]');
      if (filterBtn && filterBtn.closest('#members-type-filter')) {
        membersTypeFilter = filterBtn.getAttribute('data-members-type-filter') || '';
        document.querySelectorAll('#members-type-filter [data-members-type-filter]').forEach((b) => {
          const on =
            (b.getAttribute('data-members-type-filter') || '') === membersTypeFilter;
          b.classList.toggle('is-active', on);
        });
        renderMembersTable();
        return;
      }
      const typeBtn = e.target?.closest?.('[data-member-type]');
      if (typeBtn && typeBtn.closest('.member-type-seg')) {
        const v = typeBtn.getAttribute('data-member-type') || 'standard';
        setMemberTypeUi(v);
      }
    });


    ['member-first-name', 'member-last-name', 'member-second-last-name', 'member-dni'].forEach((id) => {
      $(id)?.addEventListener('input', function () {
        const start = this.selectionStart;
        const end = this.selectionEnd;
        const upper = formatMemberName(this.value);
        if (this.value !== upper) {
          this.value = upper;
          if (start != null && end != null) this.setSelectionRange(start, end);
        }
        if (id === 'member-first-name' || id === 'member-last-name') updateMemberAvatarInitials();
      });
    });

    ['member-first-name', 'member-last-name', 'member-second-last-name'].forEach((id) => {
      $(id)?.addEventListener('blur', () => {
        const el = $(id);
        if (el) el.value = formatMemberName(el.value);
      });
    });
    $('member-dni')?.addEventListener('blur', function () {
      this.value = formatMemberName(this.value);
    });

    $('member-avalista-select')?.addEventListener('change', () => {
      syncAvalistaFromSelect();
    });
    $('member-avalista-clear')?.addEventListener('click', () => {
      clearAvalistaForm();
      fillAvalistaSelectOptions(null);
    });

    document.querySelectorAll('[data-member-slot][data-member-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slot = btn.getAttribute('data-member-slot');
        const mode = btn.getAttribute('data-member-mode');
        if (!slot) return;
        const input = $(slotToFileId(slot));
        if (!input) return;
        if (mode === 'cam') {
          void openMemberCamera(slot);
          return;
        }
        input.removeAttribute('capture');
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
    bindMemberTermsUi();
    bindMemberCameraUi();
    bindMemberBirthUiOnce();
    ensureMemberBirthSelectOptions();
    bindMembersUi();
    bindMembersCsvUi();
    try {
      rebuildMemberTypeControls();
    } catch (_) {
      /* ok */
    }
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
      await refreshHomeKpis();
    } catch (e) {
      /* ignore refresh errors from external triggers */
    }
  };

  window.scClubRefreshHomeKpis = async function () {
    if (!ctx) return;
    try {
      await refreshHomeKpis();
    } catch (e) {
      /* ignore */
    }
  };
})();
