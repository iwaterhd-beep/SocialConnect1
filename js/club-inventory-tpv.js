/**
 * Inventario + TPV (estilo rejilla / ticket, alertas, búsqueda, chips).
 */
(function () {
  const sb = () => window.scSupabase;
  const MEMBER_AVATAR_BUCKET = 'club_member_docs';
  const PRODUCT_IMAGE_BUCKET = 'club_product_images';
  const PRODUCT_MEDIA_MAX_IMAGE_BYTES = 2097152;
  const PRODUCT_MEDIA_MAX_VIDEO_BYTES = 15728640;
  const PRODUCT_VIDEO_MIME = /^video\/(mp4|webm|quicktime|x-m4v)$/i;

  const PRODUCT_SELECT_FULL =
    'id, name, emoji, bottle_weight_grams, stock_grams, category_id, sale_unit, stock_alert_grams, default_sale_grams, default_price_eur, default_price_per_gram_eur, purchase_cost_eur, retail_price_eur, cannabis_strain, menu_price_eur, image_path';
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
    hasCannabisStrainColumn: true,
    hasMenuPriceColumn: true,
    hasProductImageColumn: true,
    pendingProductImage: null,
    productImageRemove: false,
    productLoadedImagePath: '',
    productImageObjectUrl: null,
    hasCategoryMenuStrainColumn: true,
    menuSettings: { enabled: false, slug: '' },
    menuUiBound: false,
    canEditInventory: false,
    adjustProductId: null,
    adjustDirection: 'add',
    editingOriginalStock: null,
  };
  const EMOJI_RECENT_KEY = 'sc_inv_recent_emojis';

  function isProductVideoFile(f) {
    if (!f) return false;
    if (PRODUCT_VIDEO_MIME.test(f.type || '')) return true;
    return /\.(mp4|webm|mov|m4v)$/i.test(f.name || '');
  }

  function isProductVideoPath(path) {
    return /\.(mp4|webm|mov|m4v)$/i.test((path || '').trim());
  }

  function isAllowedProductMediaFile(f) {
    if (!f) return false;
    if (/^image\/(jpeg|png|webp)$/i.test(f.type || '')) return true;
    if (isProductVideoFile(f)) return true;
    return /\.(jpe?g|png|webp|mp4|webm|mov|m4v)$/i.test(f.name || '');
  }

  function maxBytesForProductMedia(file) {
    return isProductVideoFile(file) ? PRODUCT_MEDIA_MAX_VIDEO_BYTES : PRODUCT_MEDIA_MAX_IMAGE_BYTES;
  }

  function mediaExtFromFile(f) {
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
    if (f.type === 'image/webp') return 'webp';
    if (f.type === 'video/webm') return 'webm';
    if (f.type === 'video/quicktime') return 'mov';
    if (/video\/mp4|video\/x-m4v/i.test(f.type || '')) return 'mp4';
    return isProductVideoFile(f) ? 'mp4' : 'jpg';
  }

  function hideProductMediaPreviewElements() {
    const img = $('inv-product-image-preview');
    const video = $('inv-product-image-preview-video');
    if (img) {
      img.classList.add('is-hidden');
      img.removeAttribute('src');
    }
    if (video) {
      video.pause();
      video.classList.add('is-hidden');
      video.removeAttribute('src');
      if (typeof video.load === 'function') video.load();
    }
  }

  function showProductMediaPreview(url, isVideo) {
    const img = $('inv-product-image-preview');
    const video = $('inv-product-image-preview-video');
    const placeholder = $('inv-product-image-placeholder');
    const clearBtn = $('inv-product-image-clear');
    hideProductMediaPreviewElements();
    if (isVideo && video) {
      video.src = url;
      video.muted = true;
      video.loop = false;
      video.playsInline = true;
      video.controls = true;
      video.classList.remove('is-hidden');
      void video.play().catch(() => {});
    } else if (img) {
      img.src = url;
      img.classList.remove('is-hidden');
    }
    if (placeholder) placeholder.style.display = 'none';
    if (clearBtn) clearBtn.hidden = false;
  }

  function revokeProductImageObjectUrl() {
    if (state.productImageObjectUrl) {
      URL.revokeObjectURL(state.productImageObjectUrl);
      state.productImageObjectUrl = null;
    }
  }

  function productImagePublicUrl(path) {
    const p = (path || '').trim();
    if (!p) return '';
    const { data } = sb().storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(p);
    return data?.publicUrl || '';
  }

  function resetProductImageUiState() {
    state.pendingProductImage = null;
    state.productImageRemove = false;
    state.productLoadedImagePath = '';
    revokeProductImageObjectUrl();
    const fileEl = $('inv-product-image-file');
    if (fileEl) fileEl.value = '';
  }

  async function refreshProductImagePreview() {
    const placeholder = $('inv-product-image-placeholder');
    const clearBtn = $('inv-product-image-clear');
    if (!placeholder) return;

    if (state.pendingProductImage) {
      revokeProductImageObjectUrl();
      state.productImageObjectUrl = URL.createObjectURL(state.pendingProductImage);
      showProductMediaPreview(
        state.productImageObjectUrl,
        isProductVideoFile(state.pendingProductImage),
      );
      return;
    }

    if (!state.productImageRemove && state.productLoadedImagePath) {
      const url = productImagePublicUrl(state.productLoadedImagePath);
      if (url) {
        showProductMediaPreview(url, isProductVideoPath(state.productLoadedImagePath));
        return;
      }
    }

    revokeProductImageObjectUrl();
    hideProductMediaPreviewElements();
    placeholder.style.display = '';
    if (clearBtn) {
      clearBtn.hidden = !state.productLoadedImagePath && !state.pendingProductImage;
    }
  }

  async function removeProductImageAtPath(path) {
    const p = (path || '').trim();
    if (!p) return { ok: true };
    const { error } = await sb().storage.from(PRODUCT_IMAGE_BUCKET).remove([p]);
    if (error && !String(error.message || '').toLowerCase().includes('not found')) {
      return { ok: false, message: error.message || 'No se pudo borrar la imagen.' };
    }
    return { ok: true };
  }

  async function applyProductImageChanges(productId) {
    if (!state.hasProductImageColumn || !state.ctx?.club?.id) return { ok: true };

    if (state.productImageRemove) {
      const old = state.productLoadedImagePath;
      if (old) {
        const rem = await removeProductImageAtPath(old);
        if (!rem.ok) return rem;
      }
      const { error } = await sb()
        .from('inventory_products')
        .update({ image_path: '' })
        .eq('id', productId);
      if (error) {
        if ((error.message || '').toLowerCase().includes('image_path')) {
          state.hasProductImageColumn = false;
          return { ok: true };
        }
        return { ok: false, message: error.message || 'No se pudo quitar el archivo.' };
      }
      state.productLoadedImagePath = '';
      state.productImageRemove = false;
      return { ok: true };
    }

    if (!state.pendingProductImage) return { ok: true };

    const file = state.pendingProductImage;
    const maxBytes = maxBytesForProductMedia(file);
    if (file.size > maxBytes) {
      return {
        ok: false,
        message: isProductVideoFile(file)
          ? 'El vídeo supera 15 MB.'
          : 'La imagen supera 2 MB.',
      };
    }
    const ext = mediaExtFromFile(file);
    const objectPath = `${state.ctx.club.id}/${productId}.${ext}`;
    const defaultType = isProductVideoFile(file) ? 'video/mp4' : 'image/jpeg';
    const { error: upErr } = await sb().storage.from(PRODUCT_IMAGE_BUCKET).upload(objectPath, file, {
      contentType: file.type || defaultType,
      upsert: true,
    });
    if (upErr) {
      const needsMigration =
        /club_product_images|bucket/i.test(upErr.message || '') || upErr.message?.includes('not found');
      return {
        ok: false,
        message: needsMigration
          ? 'Ejecuta las migraciones 037 y 038 en Supabase.'
          : upErr.message || 'No se pudo subir el archivo.',
      };
    }

    const old = state.productLoadedImagePath;
    if (old && old !== objectPath) {
      await removeProductImageAtPath(old);
    }

    const { error: dbErr } = await sb()
      .from('inventory_products')
      .update({ image_path: objectPath })
      .eq('id', productId);
    if (dbErr) {
      if ((dbErr.message || '').toLowerCase().includes('image_path')) {
        state.hasProductImageColumn = false;
        return { ok: true };
      }
      return { ok: false, message: dbErr.message || 'No se pudo guardar la ruta del archivo.' };
    }

    state.productLoadedImagePath = objectPath;
    state.pendingProductImage = null;
    const fileEl = $('inv-product-image-file');
    if (fileEl) fileEl.value = '';
    return { ok: true };
  }

  function bindProductImageUi() {
    $('inv-product-image-pick')?.addEventListener('click', () => {
      $('inv-product-image-file')?.click();
    });
    $('inv-product-image-file')?.addEventListener('change', () => {
      const file = $('inv-product-image-file')?.files?.[0];
      if (!file) return;
      if (!isAllowedProductMediaFile(file)) {
        setMsg(
          'inv-status',
          'Formato no válido. Imagen: JPG, PNG o WebP. Vídeo: MP4, WebM o MOV.',
          true,
        );
        return;
      }
      const maxBytes = maxBytesForProductMedia(file);
      if (file.size > maxBytes) {
        setMsg(
          'inv-status',
          isProductVideoFile(file) ? 'El vídeo supera 15 MB.' : 'La imagen supera 2 MB.',
          true,
        );
        return;
      }
      state.pendingProductImage = file;
      state.productImageRemove = false;
      void refreshProductImagePreview();
    });
    $('inv-product-image-clear')?.addEventListener('click', () => {
      state.pendingProductImage = null;
      state.productImageRemove = true;
      const fileEl = $('inv-product-image-file');
      if (fileEl) fileEl.value = '';
      void refreshProductImagePreview();
    });
  }

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

  function unitShortForLine(line) {
    return line && line.sale_unit === 'unit' ? 'ud' : 'g';
  }

  /** Nota para historial monedero / dispensación (producto, cantidad, precio). */
  function buildTpvDispenseNote(line) {
    const name = (line.product_name || '').trim() || 'Producto';
    const em = (line.product_emoji || '').trim();
    const label = em ? `${em} ${name}` : name;
    const us = unitShortForLine(line);
    const qty = line.grams_charged ?? line.grams_dispensed ?? 0;
    const price = formatMoney(line.price_charged_eur);
    const extra = (line.notes || '').trim();
    let note = `${label} · ${formatNum(qty)} ${us} · ${price}`;
    if (extra && extra !== note && !note.includes(extra)) note += ` — ${extra}`;
    return note;
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
      banner.classList.toggle('tpv-pos__shift--warn', !state.tpvOpenShiftId);
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
    document.querySelectorAll('#tpv-cat-nav .tpv-cat-nav__btn').forEach((b) => {
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
    document.querySelectorAll('input[name="tpv-payment-method"]').forEach((el) => {
      el.disabled = !on;
    });
    ['tpv-wallet-funds-amount', 'tpv-wallet-funds-notes', 'tpv-wallet-funds-add', 'tpv-wallet-funds-sub', 'tpv-wallet-funds-cash'].forEach(
      (id) => {
        const el = $(id);
        if (el) el.disabled = !on;
      },
    );
  }

  function setTpvWalletFundsStatus(text, isError) {
    const el = $('tpv-wallet-funds-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg tpv-wallet-funds-status' + (isError ? ' msg--error' : text ? ' msg--ok' : '');
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
        return {
          error: { message: 'Ejecuta la migración 028_member_wallet.sql en Supabase.' },
          data: null,
        };
      }
      res = await sb().rpc('club_member_wallet_adjust', {
        p_member_id: memberId,
        p_delta_eur: delta,
        p_notes: notes,
      });
    }
    return res;
  }

  function updateTpvWalletFundsUi() {
    const wrap = $('tpv-wallet-funds');
    const balLine = $('tpv-wallet-funds-balance');
    if (!wrap) return;
    const memberId = ($('tpv-selected-member')?.value || '').trim();
    if (!memberId) {
      wrap.classList.add('is-hidden');
      wrap.hidden = true;
      setTpvWalletFundsStatus('', false);
      return;
    }
    wrap.classList.remove('is-hidden');
    wrap.hidden = false;
    const balance = getTpvMemberWalletBalance();
    if (balLine) {
      if (balance != null) {
        balLine.textContent = `Saldo actual: ${formatMoney(balance)}`;
        balLine.classList.toggle('tpv-wallet-funds-balance--neg', balance < 0);
      } else {
        balLine.textContent = 'Saldo: — (migración 028 en Supabase)';
        balLine.classList.remove('tpv-wallet-funds-balance--neg');
      }
    }
  }

  async function applyTpvWalletFunds(sign) {
    const memberId = ($('tpv-selected-member')?.value || '').trim();
    if (!memberId) {
      setTpvWalletFundsStatus('Selecciona un socio primero.', true);
      return;
    }
    const raw = ($('tpv-wallet-funds-amount')?.value || '').trim().replace(',', '.');
    const amt = raw === '' ? NaN : Number(raw);
    if (Number.isNaN(amt) || amt <= 0) {
      setTpvWalletFundsStatus('Indica un importe mayor que cero.', true);
      return;
    }
    const affectsCash = $('tpv-wallet-funds-cash')?.checked === true;
    const shiftId = state.tpvOpenShiftId || null;
    if (affectsCash && !shiftId) {
      setTpvWalletFundsStatus('Abre un turno de caja para movimientos en efectivo.', true);
      return;
    }
    const delta = sign < 0 ? -amt : amt;
    const notesRaw = ($('tpv-wallet-funds-notes')?.value || '').trim();
    const defaultNote = sign < 0 ? 'Retirada desde TPV' : 'Recarga desde TPV';
    setTpvWalletFundsStatus('Aplicando…', false);
    const { data, error } = await rpcMemberWalletAdjust(
      memberId,
      delta,
      notesRaw || defaultNote,
      shiftId,
      affectsCash,
    );
    if (error) {
      setTpvWalletFundsStatus(error.message || 'No se pudo actualizar el monedero.', true);
      return;
    }
    const newBal = data != null && !Number.isNaN(Number(data)) ? Number(data) : null;
    if ($('tpv-wallet-funds-amount')) $('tpv-wallet-funds-amount').value = '';
    if ($('tpv-wallet-funds-notes')) $('tpv-wallet-funds-notes').value = '';
    const verb = sign < 0 ? 'Retirados' : 'Ingresados';
    setTpvWalletFundsStatus(
      `${verb} ${formatMoney(amt)}${affectsCash ? ' (en caja del turno)' : ''}. Saldo: ${newBal != null ? formatMoney(newBal) : 'actualizado'}.`,
      false,
    );
    await loadMembersForTpv();
    updateTpvWalletFundsUi();
    updateTpvWalletUi();
    if (typeof window.scClubRefreshFinance === 'function') {
      await window.scClubRefreshFinance();
    }
  }

  function getTpvPaymentMethod() {
    const el = document.querySelector('input[name="tpv-payment-method"]:checked');
    return el && el.value === 'wallet' ? 'wallet' : 'cash';
  }

  function getTpvCartTotalEur() {
    const lines = state.tpvCart || [];
    if (lines.length) {
      return lines.reduce((acc, x) => acc + (Number(x.price_charged_eur) || 0), 0);
    }
    const built = buildCurrentTpvLine();
    if (!built.error && built.line) return Number(built.line.price_charged_eur) || 0;
    const p = parseDecimal($('tpv-price')?.value);
    return Number.isNaN(p) ? 0 : p;
  }

  function getTpvMemberWalletBalance() {
    const id = ($('tpv-selected-member')?.value || '').trim();
    if (!id) return null;
    const m = (state.tpvMembers || []).find((x) => tpvIdsEqual(x.id, id));
    if (!m || m.wallet_balance_eur == null || m.wallet_balance_eur === '') return null;
    const n = Number(m.wallet_balance_eur);
    return Number.isNaN(n) ? null : n;
  }

  function updateTpvWalletUi() {
    const balEl = $('tpv-wallet-balance');
    const prevEl = $('tpv-wallet-preview');
    if (!balEl || !prevEl) return;
    updateTpvWalletFundsUi();

    const isWallet = getTpvPaymentMethod() === 'wallet';
    const memberId = ($('tpv-selected-member')?.value || '').trim();

    if (!isWallet) {
      balEl.classList.add('is-hidden');
      balEl.hidden = true;
      prevEl.classList.add('is-hidden');
      prevEl.hidden = true;
      return;
    }

    balEl.classList.remove('is-hidden');
    balEl.hidden = false;

    if (!memberId) {
      balEl.textContent = 'Selecciona un socio para cobrar con monedero.';
      balEl.classList.remove('tpv-wallet-balance--neg');
      prevEl.classList.add('is-hidden');
      prevEl.hidden = true;
      return;
    }

    const balance = getTpvMemberWalletBalance();
    const total = getTpvCartTotalEur();
    const after = balance != null ? balance - total : null;

    if (balance != null) {
      balEl.textContent = `Saldo monedero: ${formatMoney(balance)}`;
      balEl.classList.toggle('tpv-wallet-balance--neg', balance < 0);
    } else {
      balEl.textContent = 'Saldo monedero: — (aplica migración 028 en Supabase)';
      balEl.classList.remove('tpv-wallet-balance--neg');
    }

    if (total > 0 && after != null && !Number.isNaN(after)) {
      prevEl.classList.remove('is-hidden');
      prevEl.hidden = false;
      prevEl.textContent = `Tras cobrar (${formatMoney(total)}): ${formatMoney(after)}`;
      prevEl.classList.toggle('tpv-wallet-preview--neg', after < 0);
    } else {
      prevEl.classList.add('is-hidden');
      prevEl.hidden = true;
    }
  }

  /** Precio €/g: explícito, o precio ÷ gramos sugeridos; si no hay gramos de referencia, el precio sugerido cuenta como €/g (TPV por peso). */
  function computeAutoMenuPrice(saleUnit, defPrice, defPerGram, defSale, retailPrice) {
    if (saleUnit === 'unit') {
      if (retailPrice != null && !Number.isNaN(retailPrice) && retailPrice >= 0) return retailPrice;
      if (defPrice != null && !Number.isNaN(defPrice) && defPrice >= 0) return defPrice;
      return null;
    }
    if (defPerGram != null && !Number.isNaN(defPerGram) && defPerGram >= 0) return defPerGram;
    if (retailPrice != null && !Number.isNaN(retailPrice) && retailPrice >= 0) return retailPrice;
    if (defPrice != null && !Number.isNaN(defPrice) && defPrice >= 0) {
      const g = Number(defSale);
      if (!Number.isNaN(g) && g > 0) return defPrice / g;
      return defPrice;
    }
    return null;
  }

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

  function categoryShowsStrain(catId) {
    if (!catId) return false;
    const c = state.categories.find((x) => x.id === catId);
    return Boolean(c && c.menu_show_strain);
  }

  function syncProductStrainRowVisibility() {
    const row = $('inv-product-strain-row');
    if (!row) return;
    const catId = ($('inv-product-category')?.value || '').trim();
    const show = state.hasCannabisStrainColumn && categoryShowsStrain(catId);
    row.hidden = !show;
  }

  function getPublicMenuBaseUrl() {
    const cfg = window.SC_CONFIG || {};
    const fromCfg = (cfg.publicSiteOrigin || '').trim();
    if (fromCfg) return fromCfg.replace(/\/?$/, '/');
    const path = window.location.pathname || '/';
    const slash = path.lastIndexOf('/');
    const dir = slash > 0 ? path.slice(0, slash + 1) : '/';
    return `${window.location.origin}${dir}`;
  }

  function buildPublicMenuUrl(slug) {
    const s = (slug || '').trim().toLowerCase();
    if (!s) return '';
    return `${getPublicMenuBaseUrl()}menu/?club=${encodeURIComponent(s)}`;
  }

  function setMenuStatus(text, isError) {
    const el = $('inv-menu-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (isError ? ' msg--error' : text ? ' msg--ok' : '');
  }

  function updateMenuUrlPreview() {
    const slug = ($('inv-menu-slug')?.value || '').trim().toLowerCase();
    const preview = $('inv-menu-url-preview');
    const link = $('inv-menu-open-link');
    const url = buildPublicMenuUrl(slug);
    if (preview) {
      preview.textContent = url || 'Escribe una ruta (ej. tfp) y guarda para activar el enlace.';
    }
    if (link) {
      link.disabled = !url;
      link.setAttribute('aria-disabled', url ? 'false' : 'true');
    }
  }

  function bindMenuUi() {
    if (state.menuUiBound) return;
    const saveBtn = $('inv-menu-save');
    const slugInput = $('inv-menu-slug');
    const openLink = $('inv-menu-open-link');
    if (!saveBtn && !slugInput && !openLink) return;

    state.menuUiBound = true;

    saveBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      void saveMenuSettings();
    });
    slugInput?.addEventListener('input', updateMenuUrlPreview);
    openLink?.addEventListener('click', (e) => {
      const url = buildPublicMenuUrl(($('inv-menu-slug')?.value || '').trim());
      if (!url) {
        e.preventDefault();
        setMenuStatus('Indica una ruta y pulsa Guardar menú antes de abrir.', true);
        return;
      }
      e.preventDefault();
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    $('inv-menu-sync-prices')?.addEventListener('click', () => void syncMenuPrices());
  }

  async function syncMenuPrices() {
    if (!state.ctx?.club?.id) {
      setMenuStatus('Sesión del club no cargada.', true);
      return;
    }
    setMenuStatus('Rellenando precios del menú…', false);
    const { data, error } = await sb().rpc('club_sync_menu_prices', {
      p_club_id: state.ctx.club.id,
    });
    if (error) {
      const needsMigration =
        error.code === 'PGRST202' ||
        /club_sync_menu_prices|menu_price_eur/i.test(error.message || '');
      setMenuStatus(
        needsMigration
          ? 'Ejecuta las migraciones 035 y 036 en Supabase.'
          : error.message || 'No se pudo rellenar.',
        true,
      );
      return;
    }
    const n = Number(data) || 0;
    setMenuStatus(
      n > 0
        ? `Precios actualizados en ${n} producto(s). Recarga el menú en la tablet.`
        : 'No había productos nuevos que rellenar (revisa precio TPV o ventas).',
      false,
    );
  }

  async function loadMenuSettings() {
    const { data, error } = await sb()
      .from('clubs')
      .select('menu_enabled, menu_slug')
      .eq('id', state.ctx.club.id)
      .maybeSingle();
    if (error) {
      if (error.code === '42703') {
        setMenuStatus('Ejecuta 033_public_menu.sql en Supabase para activar el menú tablet.', true);
        return;
      }
      throw error;
    }
    state.menuSettings = {
      enabled: Boolean(data?.menu_enabled),
      slug: (data?.menu_slug || '').trim(),
    };
    if ($('inv-menu-enabled')) $('inv-menu-enabled').checked = state.menuSettings.enabled;
    if ($('inv-menu-slug')) $('inv-menu-slug').value = state.menuSettings.slug;
    updateMenuUrlPreview();
    bindMenuUi();
  }

  async function saveMenuSettings() {
    if (!state.ctx?.club?.id) {
      setMenuStatus('Sesión del club no cargada. Recarga la página.', true);
      return;
    }
    const enabled = $('inv-menu-enabled')?.checked === true;
    const slug = ($('inv-menu-slug')?.value || '').trim().toLowerCase();
    if (enabled && !slug) {
      setMenuStatus('Escribe una ruta del menú (ej. tfp) para activarlo.', true);
      return;
    }
    if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      setMenuStatus('Ruta inválida: solo minúsculas, números y guiones.', true);
      return;
    }

    setMenuStatus('Guardando menú…', false);
    const { error } = await sb().rpc('club_update_public_menu_settings', {
      p_enabled: enabled,
      p_slug: slug,
    });
    if (error) {
      const needsMigration =
        error.code === 'PGRST202' ||
        error.code === '42883' ||
        /club_update_public_menu_settings/i.test(error.message || '');
      setMenuStatus(
        needsMigration
          ? 'Ejecuta la migración 033_public_menu.sql en Supabase y vuelve a intentar.'
          : error.message || 'No se pudo guardar.',
        true,
      );
      return;
    }
    state.menuSettings = { enabled, slug };
    setMenuStatus(
      enabled
        ? `Menú guardado. Enlace: ${buildPublicMenuUrl(slug)}`
        : 'Menú desactivado.',
      false,
    );
    updateMenuUrlPreview();
  }

  async function loadCategories() {
    let { data, error } = await sb()
      .from('inventory_categories')
      .select('id, name, sort_order, menu_show_strain')
      .eq('club_id', state.ctx.club.id)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error && error.code === '42703') {
      state.hasCategoryMenuStrainColumn = false;
      ({ data, error } = await sb()
        .from('inventory_categories')
        .select('id, name, sort_order')
        .eq('club_id', state.ctx.club.id)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }));
    }
    if (error) throw error;
    state.categories = (data || []).map((c) => ({
      ...c,
      menu_show_strain: Boolean(c.menu_show_strain),
    }));
    renderCategoryList();
    fillCategorySelects();
    renderTpvCategoryChips();
    renderInvCategoryChips();
    syncProductStrainRowVisibility();
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
      li.className = 'inv-cat-list__item inv-cat-list__item--edit';
      const strainChk =
        state.hasCategoryMenuStrainColumn
          ? `<label class="checkbox-label inv-cat-strain-label">
          <input type="checkbox" class="inv-cat-strain-cb" data-cat-id="${c.id}"${c.menu_show_strain ? ' checked' : ''} />
          Sativa/Indica
        </label>`
          : '';
      li.innerHTML = `
        <input type="text" class="input input--small inv-cat-edit-name" data-cat-id="${c.id}" value="${escapeHtml(c.name)}" style="flex:1;min-width:0" />
        ${strainChk}
        <button type="button" class="btn btn--ghost btn--small" data-cat-save="${c.id}">Guardar</button>
        <button type="button" class="btn btn--ghost btn--small" data-cat-del="${c.id}">Eliminar</button>
      `;
      li.querySelector('[data-cat-save]')?.addEventListener('click', () => void saveCategoryRow(c.id));
      li.querySelector('[data-cat-del]')?.addEventListener('click', () => void deleteCategory(c.id));
      ul.appendChild(li);
    });
  }

  async function saveCategoryRow(catId) {
    const li = document.querySelector(`[data-cat-save="${catId}"]`)?.closest('.inv-cat-list__item');
    const name = (li?.querySelector('.inv-cat-edit-name')?.value || '').trim();
    if (!name) {
      setMsg('inv-status', 'El nombre de la categoría no puede estar vacío.', true);
      return;
    }
    const strainCb = li?.querySelector('.inv-cat-strain-cb');
    const row = { name };
    if (state.hasCategoryMenuStrainColumn && strainCb) {
      row.menu_show_strain = strainCb.checked;
    }
    setMsg('inv-status', 'Guardando categoría…', false);
    const { error } = await sb().from('inventory_categories').update(row).eq('id', catId);
    if (error) {
      setMsg('inv-status', error.message || 'No se pudo guardar.', true);
      return;
    }
    setMsg('inv-status', 'Categoría actualizada.', false);
    await loadCategories();
    await loadProducts();
  }

  async function deleteCategory(catId) {
    if (!confirm('¿Eliminar esta categoría? Los productos quedarán sin categoría.')) return;
    setMsg('inv-status', 'Eliminando…', false);
    const { error } = await sb().from('inventory_categories').delete().eq('id', catId);
    if (error) {
      setMsg('inv-status', error.message || 'No se pudo eliminar.', true);
      return;
    }
    setMsg('inv-status', 'Categoría eliminada.', false);
    await loadCategories();
    await loadProducts();
    await refreshStockUi();
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
      if (msg.includes('image_path')) {
        state.hasProductImageColumn = false;
        let selImg = PRODUCT_SELECT_FULL.replace(', image_path', '');
        const rImg = await inventoryProductListQuery(selImg);
        if (!rImg.error) {
          data = rImg.data;
          error = null;
        } else {
          error = rImg.error;
          msg = (error.message || '').toLowerCase();
        }
      }
      if (msg.includes('menu_price_eur')) {
        state.hasMenuPriceColumn = false;
        let selMp = PRODUCT_SELECT_FULL.replace(', menu_price_eur', '');
        if (!state.hasProductImageColumn) selMp = selMp.replace(', image_path', '');
        const rMp = await inventoryProductListQuery(selMp);
        if (!rMp.error) {
          data = rMp.data;
          error = null;
        } else {
          error = rMp.error;
          msg = (error.message || '').toLowerCase();
        }
      }
      if (msg.includes('cannabis_strain')) {
        state.hasCannabisStrainColumn = false;
        let sel = PRODUCT_SELECT_FULL.replace(', cannabis_strain', '');
        if (!state.hasMenuPriceColumn) sel = sel.replace(', menu_price_eur', '');
        if (!state.hasProductImageColumn) sel = sel.replace(', image_path', '');
        const rCs = await inventoryProductListQuery(sel);
        if (!rCs.error) {
          data = rCs.data;
          error = null;
        } else {
          error = rCs.error;
          msg = (error.message || '').toLowerCase();
        }
      }
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

  function categoryInitial(name) {
    const t = String(name || '').trim();
    return t ? t.charAt(0).toUpperCase() : '?';
  }

  function pulseTpvCard(productId) {
    if (!productId) return;
    const grid = $('tpv-product-grid');
    if (!grid) return;
    grid.querySelectorAll('.tpv-card').forEach((card) => {
      card.classList.remove('tpv-card--pulse');
    });
    const cards = grid.querySelectorAll('.tpv-card');
    for (const card of cards) {
      if (card.dataset.productId === String(productId)) {
        card.classList.add('tpv-card--pulse');
        card.addEventListener(
          'animationend',
          () => card.classList.remove('tpv-card--pulse'),
          { once: true },
        );
        break;
      }
    }
  }

  function pulseTpvTicket() {
    const paper = $('tpv-ticket-paper');
    if (!paper) return;
    paper.classList.remove('tpv-ticket-paper--pulse');
    void paper.offsetWidth;
    paper.classList.add('tpv-ticket-paper--pulse');
    paper.addEventListener(
      'animationend',
      () => paper.classList.remove('tpv-ticket-paper--pulse'),
      { once: true },
    );
  }

  function categoryName(id) {
    if (!id) return '—';
    const c = state.categories.find((x) => x.id === id);
    return c ? c.name : '—';
  }

  function renderTpvCategoryChips() {
    const nav = $('tpv-cat-nav');
    if (!nav) return;
    nav.innerHTML = '';
    const mk = (label, val, icon) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tpv-cat-nav__btn' + (state.tpvCatFilter === val ? ' is-active' : '');
      b.innerHTML = `<span class="tpv-cat-nav__icon" aria-hidden="true">${escapeHtml(icon)}</span><span class="tpv-cat-nav__label">${escapeHtml(label)}</span>`;
      b.addEventListener('click', () => {
        state.tpvCatFilter = val;
        renderTpvCategoryChips();
        renderTpvGrid();
      });
      return b;
    };
    nav.appendChild(mk('Todas', '', '▦'));
    state.categories.forEach((c) => {
      nav.appendChild(mk(c.name, c.id, categoryInitial(c.name)));
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
    const countEl = $('tpv-product-count');
    if (countEl) {
      countEl.textContent = list.length ? `${list.length} producto${list.length === 1 ? '' : 's'}` : '';
    }
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = '<p class="hint tpv-pos__empty" style="grid-column:1/-1">No hay productos con este filtro.</p>';
      return;
    }
    list.forEach((p) => {
      const stock = Number(p.stock_grams) || 0;
      const empty = stock <= 0;
      const selected = tpvIdsEqual(p.id, state.tpvSelectedId);
      const card = document.createElement('button');
      card.type = 'button';
      card.dataset.productId = String(p.id);
      card.className =
        'tpv-card' + (empty ? ' is-empty-stock' : '') + (selected ? ' is-selected' : '');
      card.setAttribute('role', 'listitem');
      const em = (p.emoji || '').trim();
      const rate = state.hasProductExtras ? getPricePerGramForProduct(p) : null;
      const rateLabel = unitShort(p);
      const priceHtml =
        rate != null && !Number.isNaN(rate)
          ? `<span class="tpv-card__price">${escapeHtml(formatMoney(rate))}/${escapeHtml(rateLabel)}</span>`
          : p.default_price_eur != null && !Number.isNaN(p.default_price_eur)
            ? `<span class="tpv-card__price">${escapeHtml(formatMoney(p.default_price_eur))}</span>`
            : '';
      const catLabel = categoryName(p.category_id);
      card.innerHTML = `
        <span class="tpv-card__visual">
          <span class="tpv-card__emoji">${escapeHtml(em || '📦')}</span>
        </span>
        <span class="tpv-card__content">
          <span class="tpv-card__cat">${escapeHtml(catLabel)}</span>
          <span class="tpv-card__name">${escapeHtml(p.name)}</span>
          <span class="tpv-card__row">
            <span class="tpv-card__stock">${escapeHtml(formatNum(stock))} ${escapeHtml(unitShort(p))}</span>
            ${priceHtml}
          </span>
        </span>
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

  function clearTpvProductSelection() {
    cancelScheduledAutoTpvLine();
    state.tpvPendingCartRowId = null;
    state.tpvSelectedId = '';
    if ($('tpv-selected-product')) $('tpv-selected-product').value = '';
    if ($('tpv-selected-label')) $('tpv-selected-label').textContent = 'Selecciona un producto';
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
      const pendingId = state.tpvPendingCartRowId;
      const pendingStillInCart =
        Boolean(pendingId) && state.tpvCart.some((line) => line.cart_row_id === pendingId);
      if (pendingStillInCart) {
        syncAutoTpvLine({ silent: true });
      }
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
      hint.textContent = `Stock: ${formatNum(p.stock_grams)} ${unitShort(p)}`;
    }
    syncTpvStockWrapVisibility();
    updateTpvUnitLabels(p);
    applyTpvStepPreset(p);
    updateTpvMarginHint();
    updatePriceFromTicketGrams();
    ensureTpvPriceForCurrentLine();
    syncAutoTpvLine({ silent: true });
    pulseTpvCard(idNorm);
    pulseTpvTicket();
    renderTpvGrid();
    const ae = document.activeElement;
    if (ae && typeof ae.closest === 'function' && ae.closest('#tpv-product-grid') && typeof ae.blur === 'function') {
      ae.blur();
    }
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
      $('tpv-stock-hint').textContent = `Stock: ${formatNum(p.stock_grams)} ${unitShort(p)}`;
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
    if ($('inv-product-menu-price')) $('inv-product-menu-price').value = '';
    if ($('inv-product-strain')) $('inv-product-strain').value = '';
    resetProductImageUiState();
    state.editingOriginalStock = null;
    void refreshProductImagePreview();
    setInvSaleUnitUi('grams');
    syncProductStrainRowVisibility();
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
    const menuEl = $('inv-product-menu-price');
    if (menuEl) {
      if (p.menu_price_eur != null && !Number.isNaN(Number(p.menu_price_eur))) {
        menuEl.value = String(p.menu_price_eur).replace('.', ',');
      } else {
        menuEl.value = '';
      }
    }
    if ($('inv-product-strain')) {
      $('inv-product-strain').value =
        p.cannabis_strain === 'indica' ? 'indica' : p.cannabis_strain === 'sativa' ? 'sativa' : '';
    }
    state.editingOriginalStock = Number(p.stock_grams) || 0;
    resetProductImageUiState();
    state.productLoadedImagePath = (p.image_path || '').trim();
    void refreshProductImagePreview();
    syncProductStrainRowVisibility();
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

    let stockUpdatedViaShiftRpc = false;
    if (id && !Number.isNaN(stock)) {
      const origStock = state.editingOriginalStock;
      if (origStock !== null && origStock !== undefined && Math.abs(stock - origStock) > 0.0001) {
        const { error: stockRpcErr } = await sb().rpc('club_register_manual_stock_count', {
          p_product_id: id,
          p_new_stock_grams: stock,
        });
        if (!stockRpcErr) {
          stockUpdatedViaShiftRpc = true;
        } else if (!/no hay turno abierto/i.test(stockRpcErr.message || '')) {
          setMsg('inv-status', stockRpcErr.message || 'No se pudo actualizar el stock.', true);
          return;
        }
      }
    }

    const baseRow = {
      club_id: state.ctx.club.id,
      name,
      emoji,
      category_id: categoryId,
      sale_unit: saleUnit,
      bottle_weight_grams: saleUnit === 'unit' ? 0 : bottle,
      stock_grams: stock,
    };
    if (stockUpdatedViaShiftRpc) {
      delete baseRow.stock_grams;
    }
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

    let menuPriceField = null;
    const menuRaw = ($('inv-product-menu-price')?.value || '').trim();
    if (menuRaw !== '') {
      menuPriceField = parseDecimal(menuRaw);
      if (Number.isNaN(menuPriceField) || menuPriceField < 0) {
        setMsg('inv-status', 'Precio en menú no válido.', true);
        return;
      }
    } else if (state.hasMenuPriceColumn) {
      menuPriceField = computeAutoMenuPrice(
        saleUnit,
        defPrice,
        defPerGram,
        defSale,
        retailPriceField,
      );
    }

    const row = { ...baseRow, ...extraRow };
    if (state.hasMenuPriceColumn && menuPriceField != null) {
      row.menu_price_eur = menuPriceField;
    }
    if (state.hasCannabisStrainColumn) {
      if (categoryShowsStrain(categoryId)) {
        const s = ($('inv-product-strain')?.value || '').trim();
        row.cannabis_strain = s === 'sativa' || s === 'indica' ? s : null;
      } else {
        row.cannabis_strain = null;
      }
    }

    async function trySave(insert) {
      if (insert) {
        return sb().from('inventory_products').insert([row]).select('id').single();
      }
      return sb().from('inventory_products').update(row).eq('id', id).select('id').single();
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
        msg = (res.error?.message || '').toLowerCase();
      }
      if (msg.includes('menu_price_eur') && 'menu_price_eur' in row) {
        delete row.menu_price_eur;
        state.hasMenuPriceColumn = false;
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

    const savedId = id || res.data?.id;
    if (savedId && (state.pendingProductImage || state.productImageRemove)) {
      const imgRes = await applyProductImageChanges(savedId);
      if (!imgRes.ok) {
        setMsg(
          'inv-status',
          (id ? 'Producto actualizado' : 'Producto creado') +
            ', pero el archivo no se guardó: ' +
            (imgRes.message || 'error'),
          true,
        );
        await loadProducts();
        await refreshStockUi();
        return;
      }
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
    const showStrain = $('inv-cat-menu-strain')?.checked === true;
    const row = {
      club_id: state.ctx.club.id,
      name,
      sort_order: state.categories.length,
    };
    if (state.hasCategoryMenuStrainColumn) row.menu_show_strain = showStrain;
    const { error } = await sb().from('inventory_categories').insert([row]);
    if (error) {
      setMsg('inv-status', error.message || 'No se pudo crear.', true);
      return;
    }
    $('inv-cat-name').value = '';
    if ($('inv-cat-menu-strain')) $('inv-cat-menu-strain').checked = false;
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
      .select(
        'id, display_name, member_code, member_type, member_type_valid_until, avatar_path, wallet_balance_eur',
      )
      .eq('club_id', state.ctx.club.id)
      .eq('is_active', true)
      .order('display_name', { ascending: true });
    let { data, error } = await query;
    if (
      error &&
      (error.code === '42703' ||
        String(error.message || '').toLowerCase().includes('wallet_balance_eur') ||
        String(error.message || '').toLowerCase().includes('avatar_path'))
    ) {
      const r0 = await sb()
        .from('club_members')
        .select('id, display_name, member_code, member_type, member_type_valid_until, avatar_path')
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
    updateTpvWalletUi();
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
    updateTpvWalletUi();
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
    updateTpvWalletUi();
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
    if (!h) return;
    const has = Boolean(h.textContent && h.textContent.trim());
    h.hidden = !has;
    h.classList.toggle('is-empty', !has);
  }

  function syncTpvCobrarAmount(total) {
    const el = $('tpv-cobrar-amount');
    if (el) el.textContent = formatMoney(total);
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
      pulseTpvTicket();
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
    totalEl.textContent = formatMoney(total);
    syncTpvCobrarAmount(total);
    wrap.innerHTML = '';
    if (!lines.length) {
      wrap.innerHTML = '<p class="tpv-receipt__empty">Añade productos desde la rejilla</p>';
      return;
    }
    lines.forEach((line) => {
      const row = document.createElement('div');
      row.className = 'tpv-receipt__line tpv-cart-line';
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
    updateTpvWalletUi();
  }

  function addCurrentLineToCart() {
    return syncAutoTpvLine({ silent: false, forceNew: true });
  }

  async function registerTpvDispenseLine(line, shiftId, memberId) {
    const paymentMethod = getTpvPaymentMethod();
    const payloadWithMember = {
      p_product_id: line.product_id,
      p_grams_charged: line.grams_charged,
      p_grams_dispensed: line.grams_dispensed,
      p_price_charged_eur: line.price_charged_eur,
      p_shift_id: shiftId,
      p_notes: buildTpvDispenseNote(line),
      p_member_id: memberId || null,
      p_payment_method: paymentMethod,
    };
    let rpcRes = await sb().rpc('club_register_tpv_dispense', payloadWithMember);
    let { error } = rpcRes;
    const maybeLegacyRpc =
      error &&
      (error.code === 'PGRST202' ||
        error.code === '42883' ||
        /p_member_id|p_payment_method|function\s+public\.club_register_tpv_dispense/i.test(
          error.message || '',
        ));
    if (maybeLegacyRpc) {
      if (paymentMethod === 'wallet') {
        return {
          error: {
            message:
              'Monedero no disponible: ejecuta la migración 028_member_wallet.sql en Supabase.',
          },
          rpcRes,
        };
      }
      const payloadLegacy = {
        p_product_id: line.product_id,
        p_grams_charged: line.grams_charged,
        p_grams_dispensed: line.grams_dispensed,
        p_price_charged_eur: line.price_charged_eur,
        p_shift_id: shiftId,
        p_notes: buildTpvDispenseNote(line),
        p_member_id: memberId || null,
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
      notes: buildTpvDispenseNote(line),
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
    if (getTpvPaymentMethod() === 'wallet' && !memberRaw) {
      setMsg('tpv-status', 'Para cobrar con monedero debes seleccionar un socio.', true);
      return;
    }
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
    await loadMembersForTpv();
    updateTpvWalletUi();
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
    const isWallet = String(row.payment_method || 'cash').toLowerCase() === 'wallet';
    const ok = confirm(
      isWallet
        ? '¿Seguro que quieres eliminar esta venta? Se devolverá el stock y el importe al monedero del socio.'
        : '¿Seguro que quieres eliminar esta venta? Se devolverá el stock y se restará el importe del efectivo del turno.',
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
      isWallet
        ? `Venta eliminada. Repuestos ${formatNum(row.grams_dispensed)} g y devueltos ${formatMoney(row.price_charged_eur)} al monedero.`
        : `Venta eliminada. Repuestos ${formatNum(row.grams_dispensed)} g y descontados ${formatMoney(row.price_charged_eur)} del efectivo del turno.`,
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
      'id, created_at, grams_charged, grams_dispensed, price_charged_eur, notes, product_id, member_id, created_by, payment_method';
    let { data, error } = await sb()
      .from('tpv_dispenses')
      .select(sel)
      .eq('club_id', state.ctx.club.id)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error && error.message?.includes('payment_method')) {
      sel =
        'id, created_at, grams_charged, grams_dispensed, price_charged_eur, notes, product_id, member_id, created_by';
      const rPay = await sb()
        .from('tpv_dispenses')
        .select(sel)
        .eq('club_id', state.ctx.club.id)
        .order('created_at', { ascending: false })
        .limit(5);
      data = rPay.data;
      error = rPay.error;
    }

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
    bindMenuUi();
    bindProductImageUi();
    $('inv-product-category')?.addEventListener('change', syncProductStrainRowVisibility);
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
    $('tpv-price')?.addEventListener('input', () => {
      updateTicketGramsFromPrice();
      updateTpvWalletUi();
    });
    $('tpv-notes')?.addEventListener('input', () => scheduleAutoTpvLine());
    document.querySelectorAll('input[name="tpv-payment-method"]').forEach((el) => {
      el.addEventListener('change', () => updateTpvWalletUi());
    });
    $('tpv-wallet-funds-add')?.addEventListener('click', () => {
      void applyTpvWalletFunds(1);
    });
    $('tpv-wallet-funds-sub')?.addEventListener('click', () => {
      void applyTpvWalletFunds(-1);
    });
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
      bindMenuUi();
      await loadMenuSettings();
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
