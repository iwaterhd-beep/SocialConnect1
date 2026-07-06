-- Caja por turno, deltas en contajes, RPC de stock con turno obligatorio,
-- directorio staff para TPV, y TPV que exige turno abierto (no superadmin).
-- Ejecutar después de 010_club_members_finance.sql y 013_shift_stock_events.sql.

-- ---------------------------------------------------------------------------
-- Columnas de caja / cambio en turnos
-- ---------------------------------------------------------------------------
alter table public.shifts
  add column if not exists opening_float_eur numeric(14, 2) not null default 0;

alter table public.shifts
  add column if not exists closing_cash_total_eur numeric(14, 2);

alter table public.shifts
  add column if not exists closing_float_forward_eur numeric(14, 2);

alter table public.shifts
  add column if not exists closing_denominations jsonb;

comment on column public.shifts.opening_float_eur is 'Efectivo de cambio al abrir (normalmente el float del cierre anterior).';
comment on column public.shifts.closing_cash_total_eur is 'Total contado en caja al cerrar.';
comment on column public.shifts.closing_float_forward_eur is 'Cambio que queda para el siguiente turno.';
comment on column public.shifts.closing_denominations is 'Desglose opcional { "50": n, "20": n, ... } cantidades por denominación en EUR.';

-- ---------------------------------------------------------------------------
-- Deltas en eventos de stock
-- ---------------------------------------------------------------------------
alter table public.shift_stock_events
  add column if not exists previous_stock_grams numeric(16, 3);

alter table public.shift_stock_events
  add column if not exists delta_grams numeric(16, 3);

-- ---------------------------------------------------------------------------
-- Emails del personal del mismo club (para columnas «quién» en TPV)
-- ---------------------------------------------------------------------------
create or replace function public.club_staff_directory()
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.email
  from public.users u
  where u.club_id = (select u2.club_id from public.users u2 where u2.id = auth.uid())
    and u.club_id is not null;
$$;

alter function public.club_staff_directory() owner to postgres;
grant execute on function public.club_staff_directory() to authenticated;

-- ---------------------------------------------------------------------------
-- Báscula: exige turno (club), registra evento con delta
-- ---------------------------------------------------------------------------
create or replace function public.club_set_stock_from_gross_weight(
  p_product_id uuid,
  p_gross_grams numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_products%rowtype;
  v_club uuid;
  v_net numeric(16, 3);
  v_shift_id uuid;
  v_prev numeric(16, 3);
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_gross_grams is null or p_gross_grams < 0 then
    raise exception 'peso bruto inválido';
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
  end if;

  v_prev := coalesce(v_row.stock_grams, 0);
  v_net := greatest(0::numeric, p_gross_grams - coalesce(v_row.bottle_weight_grams, 0));

  select s.id into v_shift_id
  from public.shifts s
  where s.club_id = v_row.club_id
    and s.closed_at is null
  limit 1;

  if not public.is_superadmin() then
    if v_shift_id is null then
      raise exception 'no hay turno abierto';
    end if;
  end if;

  update public.inventory_products
  set stock_grams = v_net,
      updated_at = now()
  where id = p_product_id;

  if v_shift_id is not null then
    insert into public.shift_stock_events (
      club_id,
      shift_id,
      product_id,
      stock_net_grams,
      source,
      created_by,
      previous_stock_grams,
      delta_grams
    )
    values (
      v_row.club_id,
      v_shift_id,
      p_product_id,
      v_net,
      'scale',
      auth.uid(),
      v_prev,
      v_net - v_prev
    );
  end if;

  return v_net;
end;
$$;

-- ---------------------------------------------------------------------------
-- Contaje manual: un solo RPC (turno obligatorio para club)
-- ---------------------------------------------------------------------------
create or replace function public.club_register_manual_stock_count(
  p_product_id uuid,
  p_new_stock_grams numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_products%rowtype;
  v_club uuid;
  v_shift_id uuid;
  v_prev numeric(16, 3);
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_new_stock_grams is null or p_new_stock_grams < 0 then
    raise exception 'stock inválido';
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
  end if;

  select s.id into v_shift_id
  from public.shifts s
  where s.club_id = v_row.club_id
    and s.closed_at is null
  limit 1;

  if not public.is_superadmin() then
    if v_shift_id is null then
      raise exception 'no hay turno abierto';
    end if;
  end if;

  v_prev := coalesce(v_row.stock_grams, 0);

  update public.inventory_products
  set stock_grams = p_new_stock_grams,
      updated_at = now()
  where id = p_product_id;

  if v_shift_id is not null then
    insert into public.shift_stock_events (
      club_id,
      shift_id,
      product_id,
      stock_net_grams,
      source,
      created_by,
      previous_stock_grams,
      delta_grams
    )
    values (
      v_row.club_id,
      v_shift_id,
      p_product_id,
      p_new_stock_grams,
      'manual',
      auth.uid(),
      v_prev,
      p_new_stock_grams - v_prev
    );
  end if;

  return p_new_stock_grams;
end;
$$;

alter function public.club_register_manual_stock_count(uuid, numeric) owner to postgres;
grant execute on function public.club_register_manual_stock_count(uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- TPV: turno obligatorio si no eres superadmin
-- ---------------------------------------------------------------------------
drop function if exists public.club_register_tpv_dispense(uuid, numeric, numeric, numeric, uuid, text, uuid);

create or replace function public.club_register_tpv_dispense(
  p_product_id uuid,
  p_grams_charged numeric,
  p_grams_dispensed numeric,
  p_price_charged_eur numeric,
  p_shift_id uuid default null,
  p_notes text default '',
  p_member_id uuid default null
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
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
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
    created_by
  )
  values (
    v_row.club_id,
    p_product_id,
    p_shift_id,
    p_member_id,
    p_grams_charged,
    p_grams_dispensed,
    p_price_charged_eur,
    coalesce(p_notes, ''),
    auth.uid()
  )
  returning id into v_dispense_id;

  return v_dispense_id;
end;
$$;

alter function public.club_register_tpv_dispense(uuid, numeric, numeric, numeric, uuid, text, uuid) owner to postgres;
grant execute on function public.club_register_tpv_dispense(uuid, numeric, numeric, numeric, uuid, text, uuid) to authenticated;
