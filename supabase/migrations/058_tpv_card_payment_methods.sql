-- Pago con tarjeta en POS + flags de métodos de cobro por club (Ajustes).

alter table public.clubs
  add column if not exists pay_cash_enabled boolean not null default true;

alter table public.clubs
  add column if not exists pay_card_enabled boolean not null default true;

alter table public.clubs
  add column if not exists pay_wallet_enabled boolean not null default true;

comment on column public.clubs.pay_cash_enabled is
  'Si false, el POS no ofrece cobro en efectivo.';
comment on column public.clubs.pay_card_enabled is
  'Si false, el POS no ofrece cobro con tarjeta.';
comment on column public.clubs.pay_wallet_enabled is
  'Si false, el POS no ofrece cobro con monedero.';

alter table public.tpv_dispenses
  drop constraint if exists tpv_dispenses_payment_method_check;

alter table public.tpv_dispenses
  add constraint tpv_dispenses_payment_method_check
  check (payment_method in ('cash', 'card', 'wallet'));

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
  v_pay_cash boolean;
  v_pay_card boolean;
  v_pay_wallet boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  v_pay := lower(trim(coalesce(p_payment_method, 'cash')));
  if v_pay not in ('cash', 'card', 'wallet') then
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

  select
    coalesce(c.pay_cash_enabled, true),
    coalesce(c.pay_card_enabled, true),
    coalesce(c.pay_wallet_enabled, true)
  into v_pay_cash, v_pay_card, v_pay_wallet
  from public.clubs c
  where c.id = v_row.club_id;

  if v_pay = 'cash' and v_pay_cash is false then
    raise exception 'el cobro en efectivo está desactivado en Ajustes';
  end if;
  if v_pay = 'card' and v_pay_card is false then
    raise exception 'el cobro con tarjeta está desactivado en Ajustes';
  end if;
  if v_pay = 'wallet' and v_pay_wallet is false then
    raise exception 'el cobro con monedero está desactivado en Ajustes';
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
  if v_note = '' or lower(v_note) in ('venta tpv', 'venta tpv (monedero)', 'venta tpv (tarjeta)') then
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

alter function public.club_register_tpv_dispense(
  uuid, numeric, numeric, numeric, uuid, text, uuid, text
) owner to postgres;

grant execute on function public.club_register_tpv_dispense(
  uuid, numeric, numeric, numeric, uuid, text, uuid, text
) to authenticated;
