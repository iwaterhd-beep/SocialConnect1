-- Monedero: recargas/retiradas en efectivo vinculadas al turno (arqueo de caja).
-- Ejecutar después de 028_member_wallet.sql.

alter table public.club_member_wallet_ledger
  add column if not exists shift_id uuid references public.shifts (id) on delete set null;

alter table public.club_member_wallet_ledger
  add column if not exists cash_eur numeric(12, 2) not null default 0;

comment on column public.club_member_wallet_ledger.shift_id is
  'Turno de caja cuando el movimiento afecta al arqueo.';
comment on column public.club_member_wallet_ledger.cash_eur is
  'Impacto en caja física (+ recarga en efectivo, − retirada en efectivo). 0 si no afecta caja.';

create index if not exists club_member_wallet_ledger_shift_idx
  on public.club_member_wallet_ledger (shift_id, created_at desc)
  where shift_id is not null;

-- ---------------------------------------------------------------------------
-- Aplicar movimiento (con turno / caja opcional)
-- ---------------------------------------------------------------------------
drop function if exists public.club_member_wallet_apply_delta(uuid, numeric, text, text, uuid);

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
-- Ajuste manual / recarga / retirada
-- ---------------------------------------------------------------------------
drop function if exists public.club_member_wallet_adjust(uuid, numeric, text);
drop function if exists public.club_member_wallet_adjust(uuid, numeric, text, uuid, boolean);

create or replace function public.club_member_wallet_adjust(
  p_member_id uuid,
  p_delta_eur numeric,
  p_notes text default '',
  p_shift_id uuid default null,
  p_affects_cash boolean default false
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cash numeric(12, 2);
begin
  if p_delta_eur is null or p_delta_eur = 0 then
    raise exception 'indica un importe distinto de cero';
  end if;

  if coalesce(p_affects_cash, false) then
    v_cash := p_delta_eur;
  else
    v_cash := 0;
  end if;

  return public.club_member_wallet_apply_delta(
    p_member_id,
    p_delta_eur,
    'adjustment',
    coalesce(p_notes, 'Ajuste manual'),
    null,
    p_shift_id,
    v_cash
  );
end;
$$;

alter function public.club_member_wallet_adjust(uuid, numeric, text, uuid, boolean) owner to postgres;
grant execute on function public.club_member_wallet_adjust(uuid, numeric, text, uuid, boolean) to authenticated;
