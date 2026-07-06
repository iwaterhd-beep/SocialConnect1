-- Monedero de socio: saldo almacenado (puede ser negativo) + historial + cobro TPV.
-- Ejecutar después de 027_member_vip_rule_periods.sql.

alter table public.club_members
  add column if not exists wallet_balance_eur numeric(12, 2) not null default 0;

comment on column public.club_members.wallet_balance_eur is
  'Saldo del monedero del socio en €. Puede ser negativo (crédito / deuda).';

-- ---------------------------------------------------------------------------
-- Historial de movimientos
-- ---------------------------------------------------------------------------
create table if not exists public.club_member_wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  member_id uuid not null references public.club_members (id) on delete cascade,
  amount_eur numeric(12, 2) not null,
  balance_after_eur numeric(12, 2) not null,
  kind text not null
    check (kind in ('adjustment', 'tpv_sale', 'tpv_void')),
  notes text not null default '',
  tpv_dispense_id uuid references public.tpv_dispenses (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists club_member_wallet_ledger_member_idx
  on public.club_member_wallet_ledger (member_id, created_at desc);

create index if not exists club_member_wallet_ledger_club_idx
  on public.club_member_wallet_ledger (club_id, created_at desc);

alter table public.club_member_wallet_ledger enable row level security;

drop policy if exists "club_member_wallet_ledger_select" on public.club_member_wallet_ledger;

create policy "club_member_wallet_ledger_select"
  on public.club_member_wallet_ledger for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.club_id = club_member_wallet_ledger.club_id
    )
    or exists (
      select 1 from public.club_access ca
      where ca.auth_user_id = auth.uid() and ca.club_id = club_member_wallet_ledger.club_id
    )
  );

grant select on public.club_member_wallet_ledger to authenticated;

-- ---------------------------------------------------------------------------
-- Método de cobro en dispensación TPV
-- ---------------------------------------------------------------------------
alter table public.tpv_dispenses
  add column if not exists payment_method text not null default 'cash';

alter table public.tpv_dispenses
  drop constraint if exists tpv_dispenses_payment_method_check;

alter table public.tpv_dispenses
  add constraint tpv_dispenses_payment_method_check
  check (payment_method in ('cash', 'wallet'));

-- ---------------------------------------------------------------------------
-- Aplicar movimiento al monedero (interno)
-- ---------------------------------------------------------------------------
create or replace function public.club_member_wallet_apply_delta(
  p_member_id uuid,
  p_delta_eur numeric,
  p_kind text,
  p_notes text default '',
  p_dispense_id uuid default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.club_members%rowtype;
  v_club uuid;
  v_new_balance numeric(12, 2);
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_member_id is null then
    raise exception 'socio obligatorio para monedero';
  end if;

  if p_delta_eur is null or p_delta_eur = 0 then
    select wallet_balance_eur into v_new_balance
    from public.club_members
    where id = p_member_id;
    return coalesce(v_new_balance, 0);
  end if;

  if p_kind not in ('adjustment', 'tpv_sale', 'tpv_void') then
    raise exception 'tipo de movimiento inválido';
  end if;

  select * into v_member
  from public.club_members
  where id = p_member_id
  for update;

  if not found then
    raise exception 'socio no encontrado';
  end if;

  if public.is_superadmin() then
    null;
  else
    select u.club_id into v_club
    from public.users u
    where u.id = auth.uid();

    if v_club is null or v_club <> v_member.club_id then
      raise exception 'forbidden';
    end if;
  end if;

  v_new_balance := coalesce(v_member.wallet_balance_eur, 0) + p_delta_eur;

  update public.club_members
  set wallet_balance_eur = v_new_balance
  where id = p_member_id;

  insert into public.club_member_wallet_ledger (
    club_id,
    member_id,
    amount_eur,
    balance_after_eur,
    kind,
    notes,
    tpv_dispense_id,
    created_by
  )
  values (
    v_member.club_id,
    p_member_id,
    p_delta_eur,
    v_new_balance,
    p_kind,
    coalesce(p_notes, ''),
    p_dispense_id,
    auth.uid()
  );

  return v_new_balance;
end;
$$;

alter function public.club_member_wallet_apply_delta(uuid, numeric, text, text, uuid) owner to postgres;

-- Ajuste manual / recarga (delta positivo = ingreso al monedero)
create or replace function public.club_member_wallet_adjust(
  p_member_id uuid,
  p_delta_eur numeric,
  p_notes text default ''
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_delta_eur is null or p_delta_eur = 0 then
    raise exception 'indica un importe distinto de cero';
  end if;

  return public.club_member_wallet_apply_delta(
    p_member_id,
    p_delta_eur,
    'adjustment',
    coalesce(p_notes, 'Ajuste manual'),
    null
  );
end;
$$;

alter function public.club_member_wallet_adjust(uuid, numeric, text) owner to postgres;
grant execute on function public.club_member_wallet_adjust(uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- TPV: cobro en efectivo o monedero (monedero permite saldo negativo)
-- ---------------------------------------------------------------------------
drop function if exists public.club_register_tpv_dispense(uuid, numeric, numeric, numeric, uuid, text, uuid);

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
    coalesce(p_notes, ''),
    auth.uid(),
    v_pay
  )
  returning id into v_dispense_id;

  if v_pay = 'wallet' and p_price_charged_eur > 0 then
    perform public.club_member_wallet_apply_delta(
      p_member_id,
      -p_price_charged_eur,
      'tpv_sale',
      coalesce(p_notes, 'Venta TPV'),
      v_dispense_id
    );
  end if;

  return v_dispense_id;
end;
$$;

alter function public.club_register_tpv_dispense(
  uuid, numeric, numeric, numeric, uuid, text, uuid, text
) owner to postgres;

grant execute on function public.club_register_tpv_dispense(
  uuid, numeric, numeric, numeric, uuid, text, uuid, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Borrar venta: devolver stock y reembolsar monedero si aplica
-- ---------------------------------------------------------------------------
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

  if coalesce(v_disp.payment_method, 'cash') = 'wallet'
     and v_disp.member_id is not null
     and coalesce(v_disp.price_charged_eur, 0) > 0 then
    perform public.club_member_wallet_apply_delta(
      v_disp.member_id,
      v_disp.price_charged_eur,
      'tpv_void',
      'Anulación venta TPV',
      v_disp.id
    );
  end if;

  select * into v_prod
  from public.inventory_products
  where id = v_disp.product_id
  for update;

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

alter function public.club_delete_tpv_dispense(uuid) owner to postgres;
