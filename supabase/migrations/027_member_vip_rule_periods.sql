-- VIP por regla: periodos de 7 días tras ganar/mantener VIP por TPV.
-- - Subida: gasto móvil últimos 7 días > 100 € → VIP y vip_rule_period_start = now() (solo si no era VIP manual: anchor NULL y ya VIP = manual).
-- - Bajada: si vip_rule_period_start IS NOT NULL (VIP por regla), cada ventana [anchor, anchor+7d) debe sumar >= 100 €; si no, pasa a standard.
-- - VIP manual: member_type = 'vip' y vip_rule_period_start IS NULL → no se toca por la regla.
-- Trigger en INSERT/DELETE de tpv_dispenses + RPC club_members_vip_rule_tick_club para caducar sin nuevas ventas.

alter table public.club_members
  add column if not exists vip_rule_period_start timestamptz;

comment on column public.club_members.vip_rule_period_start is
  'Inicio del periodo de 7 días para evaluar el VIP automático por TPV. NULL = VIP manual o no aplica.';

-- Ancla para socios que ya eran VIP por gasto pero sin columna (misma ventana que 026).
update public.club_members m
set vip_rule_period_start = now()
from (
  select
    d.member_id,
    d.club_id
  from public.tpv_dispenses d
  where d.member_id is not null
    and d.created_at >= (now() - interval '7 days')
  group by d.member_id, d.club_id
  having coalesce(sum(d.price_charged_eur), 0) > 100
) s
where m.id = s.member_id
  and m.club_id = s.club_id
  and m.is_active = true
  and m.member_type = 'vip'
  and m.vip_rule_period_start is null;

create or replace function public.club_members_vip_rule_after_dispense(p_club_id uuid, p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m_type text;
  m_anchor timestamptz;
  v_win_sum numeric;
  v_roll_sum numeric;
  v_next timestamptz;
  v_guard int := 0;
begin
  perform set_config('row_security', 'off', true);

  perform 1
  from public.club_members m
  where m.id = p_member_id
    and m.club_id = p_club_id
    and m.is_active = true
  for update;

  if not found then
    return;
  end if;

  <<down_loop>>
  loop
    select m.member_type, m.vip_rule_period_start
    into m_type, m_anchor
    from public.club_members m
    where m.id = p_member_id
      and m.club_id = p_club_id
      and m.is_active = true;

    if not found then
      return;
    end if;

    if m_type is distinct from 'vip' or m_anchor is null then
      exit down_loop;
    end if;

    exit down_loop when now() < m_anchor + interval '7 days';

    select coalesce(sum(d.price_charged_eur), 0)::numeric
    into v_win_sum
    from public.tpv_dispenses d
    where d.club_id = p_club_id
      and d.member_id = p_member_id
      and d.created_at >= m_anchor
      and d.created_at < m_anchor + interval '7 days';

    if v_win_sum < 100 then
      update public.club_members m
      set
        member_type = 'standard',
        member_type_valid_until = null,
        vip_rule_period_start = null
      where m.id = p_member_id
        and m.club_id = p_club_id;
      exit down_loop;
    end if;

    v_next := m_anchor + interval '7 days';
    update public.club_members m
    set vip_rule_period_start = v_next
    where m.id = p_member_id
      and m.club_id = p_club_id;

    v_guard := v_guard + 1;
    if v_guard > 520 then
      raise exception 'vip_rule_period: demasiados avances de ventana';
    end if;
  end loop;

  select m.member_type, m.vip_rule_period_start
  into m_type, m_anchor
  from public.club_members m
  where m.id = p_member_id
    and m.club_id = p_club_id
    and m.is_active = true;

  if not found then
    return;
  end if;

  select coalesce(sum(d.price_charged_eur), 0)::numeric
  into v_roll_sum
  from public.tpv_dispenses d
  where d.club_id = p_club_id
    and d.member_id = p_member_id
    and d.created_at >= (now() - interval '7 days');

  if v_roll_sum > 100 then
    if m_type is distinct from 'vip' then
      update public.club_members m
      set
        member_type = 'vip',
        member_type_valid_until = null,
        vip_rule_period_start = now()
      where m.id = p_member_id
        and m.club_id = p_club_id
        and m.is_active = true;
    end if;
  end if;
end;
$$;

alter function public.club_members_vip_rule_after_dispense(uuid, uuid) owner to postgres;

create or replace function public.club_members_vip_rule_tick_club(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.is_superadmin() then
    if not exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = p_club_id
    )
    and not exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = p_club_id
    ) then
      raise exception 'forbidden';
    end if;
  end if;

  for r in
    select m.id as mid
    from public.club_members m
    where m.club_id = p_club_id
      and m.is_active = true
      and m.member_type = 'vip'
      and m.vip_rule_period_start is not null
  loop
    perform public.club_members_vip_rule_after_dispense(p_club_id, r.mid);
  end loop;
end;
$$;

alter function public.club_members_vip_rule_tick_club(uuid) owner to postgres;

grant execute on function public.club_members_vip_rule_tick_club(uuid) to authenticated;

create or replace function public.club_members_tpv_weekly_vip_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('row_security', 'off', true);
  if tg_op = 'INSERT' and new.member_id is not null then
    perform public.club_members_vip_rule_after_dispense(new.club_id, new.member_id);
  elsif tg_op = 'DELETE' and old.member_id is not null then
    perform public.club_members_vip_rule_after_dispense(old.club_id, old.member_id);
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

alter function public.club_members_tpv_weekly_vip_trigger() owner to postgres;

drop trigger if exists tpv_dispenses_member_weekly_vip on public.tpv_dispenses;

create trigger tpv_dispenses_member_weekly_vip
  after insert or delete on public.tpv_dispenses
  for each row
  execute function public.club_members_tpv_weekly_vip_trigger();

comment on function public.club_members_vip_rule_after_dispense(uuid, uuid) is
  'Recalcula VIP por regla TPV para un socio (bajada por ventanas de 7 días, subida si gasto móvil 7d > 100).';

comment on function public.club_members_vip_rule_tick_club(uuid) is
  'Reevalúa todos los VIP por regla del club (p. ej. al abrir socios/TPV) para caducar sin nueva venta.';

comment on function public.club_members_tpv_weekly_vip_trigger() is
  'Tras insert/borrar dispensación TPV con socio: recalcula VIP por regla de gasto.';
