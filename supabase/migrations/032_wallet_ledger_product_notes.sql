-- Notas del monedero en ventas TPV: incluir producto (emoji, nombre, cantidad).

create or replace function public.club_register_tpv_dispense(
  p_product_id uuid,
  p_grams_charged numeric,
  p_grams_dispensed numeric,
  p_price_charged_eur numeric,
  p_shift_id uuid default null,
  p_notes text default '',
  p_member_id uuid default null,
  p_payment_method text default 'cash'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_products%rowtype;
  v_club uuid;
  v_dispense_id uuid;
  v_pay text;
  v_note text;
  v_unit text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  v_pay := lower(trim(coalesce(p_payment_method, 'cash')));
  if v_pay not in ('cash', 'wallet') then
    raise exception 'forma de cobro inválida';
  end if;

  if v_pay = 'wallet' and p_member_id is null then
    raise exception 'para cobrar con monedero debes seleccionar un socio';
  end if;

  if p_grams_charged is null or p_grams_charged < 0
     or p_grams_dispensed is null or p_grams_dispensed < 0 then
    raise exception 'gramos inválidos';
  end if;

  if p_price_charged_eur is null or p_price_charged_eur < 0 then
    raise exception 'precio inválido';
  end if;

  select * into v_row
  from public.inventory_products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'producto no encontrado';
  end if;

  if public.is_superadmin() then
    null;
  else
    select u.club_id into v_club
    from public.users u
    where u.id = auth.uid();

    if v_club is null or v_club <> v_row.club_id then
      raise exception 'forbidden';
    end if;

    if p_shift_id is null then
      raise exception 'debes tener un turno abierto para dispensar';
    end if;
  end if;

  if v_row.stock_grams < p_grams_dispensed then
    raise exception 'stock insuficiente (disponible: % g)', v_row.stock_grams;
  end if;

  if p_shift_id is not null then
    if not exists (
      select 1
      from public.shifts s
      where s.id = p_shift_id
        and s.club_id = v_row.club_id
        and s.closed_at is null
    ) then
      raise exception 'turno no válido o ya cerrado';
    end if;
  end if;

  if p_member_id is not null then
    if not exists (
      select 1
      from public.club_members m
      where m.id = p_member_id
        and m.club_id = v_row.club_id
        and m.is_active = true
    ) then
      raise exception 'socio no válido o inactivo';
    end if;
  end if;

  v_unit := case when v_row.sale_unit = 'unit' then 'ud' else 'g' end;
  v_note := trim(coalesce(p_notes, ''));
  if v_note = '' or lower(v_note) in ('venta tpv', 'venta tpv (monedero)') then
    v_note := trim(coalesce(v_row.emoji, '') || ' ' || coalesce(v_row.name, 'Producto'))
      || ' · '
      || trim(to_char(p_grams_charged, 'FM999999990.###'))
      || ' '
      || v_unit;
  end if;

  update public.inventory_products
  set stock_grams = stock_grams - p_grams_dispensed,
      updated_at = now()
  where id = p_product_id;

  insert into public.tpv_dispenses (
    club_id,
    product_id,
    shift_id,
    member_id,
    grams_charged,
    grams_dispensed,
    price_charged_eur,
    notes,
    created_by,
    payment_method
  )
  values (
    v_row.club_id,
    p_product_id,
    p_shift_id,
    p_member_id,
    p_grams_charged,
    p_grams_dispensed,
    p_price_charged_eur,
    v_note,
    auth.uid(),
    v_pay
  )
  returning id into v_dispense_id;

  if v_pay = 'wallet' and p_price_charged_eur > 0 then
    perform public.club_member_wallet_apply_delta(
      p_member_id,
      -p_price_charged_eur,
      'tpv_sale',
      v_note,
      v_dispense_id,
      p_shift_id,
      0
    );
  end if;

  return v_dispense_id;
end;
$$;

create or replace function public.club_delete_tpv_dispense(
  p_dispense_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_disp public.tpv_dispenses%rowtype;
  v_prod public.inventory_products%rowtype;
  v_club uuid;
  v_void_note text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_disp
  from public.tpv_dispenses
  where id = p_dispense_id
  for update;

  if not found then
    raise exception 'dispensación no encontrada';
  end if;

  if not public.is_superadmin() then
    select u.club_id into v_club
    from public.users u
    where u.id = auth.uid();

    if v_club is null or v_club <> v_disp.club_id then
      raise exception 'forbidden';
    end if;
  end if;

  select * into v_prod
  from public.inventory_products
  where id = v_disp.product_id;

  v_void_note := 'Anulación: '
    || trim(coalesce(v_prod.emoji, '') || ' ' || coalesce(v_prod.name, 'Producto'));

  if coalesce(v_disp.payment_method, 'cash') = 'wallet'
     and v_disp.member_id is not null
     and coalesce(v_disp.price_charged_eur, 0) > 0 then
    perform public.club_member_wallet_apply_delta(
      v_disp.member_id,
      v_disp.price_charged_eur,
      'tpv_void',
      v_void_note,
      v_disp.id,
      v_disp.shift_id,
      0
    );
  end if;

  if found then
    update public.inventory_products
    set stock_grams = coalesce(stock_grams, 0) + coalesce(v_disp.grams_dispensed, 0),
        updated_at = now()
    where id = v_disp.product_id;
  end if;

  delete from public.tpv_dispenses
  where id = p_dispense_id;
end;
$$;

-- Historial antiguo sin nota útil: copiar desde la venta TPV si existe
update public.club_member_wallet_ledger l
set notes = coalesce(nullif(trim(d.notes), ''), l.notes)
from public.tpv_dispenses d
where l.tpv_dispense_id = d.id
  and l.kind in ('tpv_sale', 'tpv_void')
  and (
    trim(coalesce(l.notes, '')) = ''
    or lower(trim(l.notes)) in ('venta tpv', 'anulación venta tpv', 'anulación tpv')
  )
  and coalesce(nullif(trim(d.notes), ''), '') <> '';
