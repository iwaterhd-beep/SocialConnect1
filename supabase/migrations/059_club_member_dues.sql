-- Cuota de socios configurable (Ajustes) + cobro con reparto club / monedero.

alter table public.clubs
  add column if not exists member_dues_amount_eur numeric(12, 2) not null default 0;

alter table public.clubs
  add column if not exists member_dues_wallet_eur numeric(12, 2) not null default 0;

comment on column public.clubs.member_dues_amount_eur is
  'Importe de la cuota de socio (en la moneda del club). 0 = desactivada.';
comment on column public.clubs.member_dues_wallet_eur is
  'Parte de la cuota que se acredita al monedero para dispensar. El resto (amount − wallet) es para el club.';

alter table public.clubs
  drop constraint if exists clubs_member_dues_amount_check;
alter table public.clubs
  add constraint clubs_member_dues_amount_check
  check (member_dues_amount_eur >= 0);

alter table public.clubs
  drop constraint if exists clubs_member_dues_wallet_check;
alter table public.clubs
  add constraint clubs_member_dues_wallet_check
  check (
    member_dues_wallet_eur >= 0
    and member_dues_wallet_eur <= member_dues_amount_eur
  );

-- ---------------------------------------------------------------------------
-- Historial de cobros de cuota
-- ---------------------------------------------------------------------------
create table if not exists public.club_member_dues_payments (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  member_id uuid not null references public.club_members (id) on delete cascade,
  total_eur numeric(12, 2) not null check (total_eur >= 0),
  wallet_eur numeric(12, 2) not null default 0 check (wallet_eur >= 0),
  club_eur numeric(12, 2) not null default 0 check (club_eur >= 0),
  payment_method text not null default 'cash'
    check (payment_method in ('cash', 'card')),
  shift_id uuid references public.shifts (id) on delete set null,
  notes text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Por si la tabla quedó a medias de un intento anterior.
alter table public.club_member_dues_payments
  add column if not exists total_eur numeric(12, 2);
alter table public.club_member_dues_payments
  add column if not exists wallet_eur numeric(12, 2) not null default 0;
alter table public.club_member_dues_payments
  add column if not exists club_eur numeric(12, 2) not null default 0;
alter table public.club_member_dues_payments
  add column if not exists payment_method text not null default 'cash';
alter table public.club_member_dues_payments
  add column if not exists shift_id uuid references public.shifts (id) on delete set null;
alter table public.club_member_dues_payments
  add column if not exists notes text not null default '';
alter table public.club_member_dues_payments
  add column if not exists created_by uuid references auth.users (id) on delete set null;
alter table public.club_member_dues_payments
  add column if not exists created_at timestamptz not null default now();

alter table public.club_member_dues_payments
  drop constraint if exists club_member_dues_payments_split_check;
alter table public.club_member_dues_payments
  add constraint club_member_dues_payments_split_check
  check (abs((wallet_eur + club_eur) - total_eur) < 0.005);

create index if not exists club_member_dues_payments_member_idx
  on public.club_member_dues_payments (member_id, created_at desc);

create index if not exists club_member_dues_payments_club_idx
  on public.club_member_dues_payments (club_id, created_at desc);

create index if not exists club_member_dues_payments_shift_idx
  on public.club_member_dues_payments (shift_id, created_at desc)
  where shift_id is not null;

alter table public.club_member_dues_payments enable row level security;

drop policy if exists "club_member_dues_payments_select" on public.club_member_dues_payments;
create policy "club_member_dues_payments_select"
  on public.club_member_dues_payments for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.club_id = club_member_dues_payments.club_id
    )
    or exists (
      select 1 from public.club_access ca
      where ca.auth_user_id = auth.uid() and ca.club_id = club_member_dues_payments.club_id
    )
  );

grant select on public.club_member_dues_payments to authenticated;

-- ---------------------------------------------------------------------------
-- Ampliar kinds del ledger de monedero
-- ---------------------------------------------------------------------------
alter table public.club_member_wallet_ledger
  drop constraint if exists club_member_wallet_ledger_kind_check;

alter table public.club_member_wallet_ledger
  add constraint club_member_wallet_ledger_kind_check
  check (kind in ('adjustment', 'tpv_sale', 'tpv_void', 'membership_dues'));

create or replace function public.club_member_wallet_apply_delta(
  p_member_id uuid,
  p_delta_eur numeric,
  p_kind text,
  p_notes text default '',
  p_dispense_id uuid default null,
  p_shift_id uuid default null,
  p_cash_eur numeric default 0
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
  v_cash numeric(12, 2);
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_member_id is null then
    raise exception 'socio obligatorio para monedero';
  end if;

  v_cash := coalesce(p_cash_eur, 0);

  if p_delta_eur is null or p_delta_eur = 0 then
    select wallet_balance_eur into v_new_balance
    from public.club_members
    where id = p_member_id;
    return coalesce(v_new_balance, 0);
  end if;

  if p_kind not in ('adjustment', 'tpv_sale', 'tpv_void', 'membership_dues') then
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

  if v_cash <> 0 then
    if p_shift_id is null then
      raise exception 'para movimiento en efectivo debes tener un turno abierto';
    end if;
    if not exists (
      select 1
      from public.shifts s
      where s.id = p_shift_id
        and s.club_id = v_member.club_id
        and s.closed_at is null
    ) then
      raise exception 'turno no válido o ya cerrado';
    end if;
    if sign(v_cash) <> sign(p_delta_eur) then
      raise exception 'el signo del efectivo debe coincidir con el del monedero';
    end if;
  elsif p_shift_id is not null then
    if not exists (
      select 1
      from public.shifts s
      where s.id = p_shift_id
        and s.club_id = v_member.club_id
    ) then
      raise exception 'turno no válido';
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
    shift_id,
    cash_eur,
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
    p_shift_id,
    v_cash,
    auth.uid()
  );

  return v_new_balance;
end;
$$;

alter function public.club_member_wallet_apply_delta(
  uuid, numeric, text, text, uuid, uuid, numeric
) owner to postgres;

-- ---------------------------------------------------------------------------
-- Cobrar cuota
-- ---------------------------------------------------------------------------
create or replace function public.club_member_pay_dues(
  p_member_id uuid,
  p_payment_method text default 'cash',
  p_shift_id uuid default null,
  p_notes text default '',
  p_total_eur numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.club_members%rowtype;
  v_club public.clubs%rowtype;
  v_auth_club uuid;
  v_pay text;
  v_total numeric(12, 2);
  v_wallet numeric(12, 2);
  v_club_part numeric(12, 2);
  v_shift uuid;
  v_payment_id uuid;
  v_new_balance numeric(12, 2);
  v_note text;
  v_cash numeric(12, 2);
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_member_id is null then
    raise exception 'socio obligatorio';
  end if;

  v_pay := lower(trim(coalesce(p_payment_method, 'cash')));
  if v_pay not in ('cash', 'card') then
    raise exception 'forma de cobro inválida (efectivo o tarjeta)';
  end if;

  select * into v_member
  from public.club_members
  where id = p_member_id
  for update;

  if not found then
    raise exception 'socio no encontrado';
  end if;

  if not coalesce(v_member.is_active, true) then
    raise exception 'el socio está inactivo';
  end if;

  select * into v_club
  from public.clubs
  where id = v_member.club_id;

  if not found then
    raise exception 'club no encontrado';
  end if;

  if public.is_superadmin() then
    null;
  else
    select u.club_id into v_auth_club
    from public.users u
    where u.id = auth.uid();

    if v_auth_club is null or v_auth_club <> v_member.club_id then
      raise exception 'forbidden';
    end if;
  end if;

  if p_total_eur is null then
    v_total := coalesce(v_club.member_dues_amount_eur, 0);
  else
    v_total := round(p_total_eur::numeric, 2);
  end if;

  if v_total is null or v_total <= 0 then
    raise exception 'configura la cuota en Ajustes (importe mayor que cero)';
  end if;

  v_wallet := least(
    greatest(coalesce(v_club.member_dues_wallet_eur, 0), 0),
    v_total
  );
  -- Si el admin cobró un total distinto al de ajustes, prorratear el monedero.
  if p_total_eur is not null
     and coalesce(v_club.member_dues_amount_eur, 0) > 0
     and abs(v_total - v_club.member_dues_amount_eur) > 0.005 then
    v_wallet := round(
      v_total * (coalesce(v_club.member_dues_wallet_eur, 0) / v_club.member_dues_amount_eur),
      2
    );
    if v_wallet > v_total then
      v_wallet := v_total;
    end if;
  end if;

  v_club_part := round(v_total - v_wallet, 2);
  if v_club_part < 0 then
    v_club_part := 0;
    v_wallet := v_total;
  end if;

  v_shift := p_shift_id;
  if v_pay = 'cash' then
    if v_shift is null then
      raise exception 'abre un turno de caja para cobrar la cuota en efectivo';
    end if;
    if not exists (
      select 1
      from public.shifts s
      where s.id = v_shift
        and s.club_id = v_member.club_id
        and s.closed_at is null
    ) then
      raise exception 'turno no válido o ya cerrado';
    end if;
  end if;

  v_note := trim(coalesce(p_notes, ''));
  if v_note = '' then
    v_note := 'Cuota de socio';
  end if;

  insert into public.club_member_dues_payments (
    club_id,
    member_id,
    total_eur,
    wallet_eur,
    club_eur,
    payment_method,
    shift_id,
    notes,
    created_by
  )
  values (
    v_member.club_id,
    p_member_id,
    v_total,
    v_wallet,
    v_club_part,
    v_pay,
    case when v_pay = 'cash' then v_shift else null end,
    v_note,
    auth.uid()
  )
  returning id into v_payment_id;

  v_new_balance := coalesce(v_member.wallet_balance_eur, 0);

  if v_wallet > 0 then
    -- En efectivo, el total entra en caja (wallet + parte club) vía cash_eur.
    v_cash := case when v_pay = 'cash' then v_total else 0 end;
    v_new_balance := public.club_member_wallet_apply_delta(
      p_member_id,
      v_wallet,
      'membership_dues',
      v_note,
      null,
      case when v_pay = 'cash' then v_shift else null end,
      v_cash
    );
  end if;
  -- Si wallet = 0 y pago en efectivo, el impacto de caja se suma en el cierre
  -- desde club_member_dues_payments (ver fetchShiftCashExpected).

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'total_eur', v_total,
    'wallet_eur', v_wallet,
    'club_eur', v_club_part,
    'payment_method', v_pay,
    'new_balance', v_new_balance
  );
end;
$$;

alter function public.club_member_pay_dues(uuid, text, uuid, text, numeric) owner to postgres;
grant execute on function public.club_member_pay_dues(uuid, text, uuid, text, numeric) to authenticated;
