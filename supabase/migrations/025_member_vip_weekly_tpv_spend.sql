-- VIP automático: si un socio acumula más de 100 € en dispensaciones TPV en los últimos 7 días
-- (ventana móvil), pasa a member_type = 'vip' y se anula vigencia manual (NULL = sin caducidad).
-- Solo sube a VIP; no baja de categoría si el gasto cae (p. ej. al borrar una venta).

create or replace function public.club_members_tpv_weekly_vip_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sum numeric;
begin
  perform set_config('row_security', 'off', true);

  if new.member_id is null then
    return new;
  end if;

  select coalesce(sum(d.price_charged_eur), 0)::numeric
  into v_sum
  from public.tpv_dispenses d
  where d.club_id = new.club_id
    and d.member_id = new.member_id
    and d.created_at >= (now() - interval '7 days');

  if v_sum > 100 then
    update public.club_members m
    set
      member_type = 'vip',
      member_type_valid_until = null
    where m.id = new.member_id
      and m.club_id = new.club_id
      and m.is_active = true
      and m.member_type is distinct from 'vip';
  end if;

  return new;
end;
$$;

alter function public.club_members_tpv_weekly_vip_trigger() owner to postgres;

drop trigger if exists tpv_dispenses_member_weekly_vip on public.tpv_dispenses;

create trigger tpv_dispenses_member_weekly_vip
  after insert on public.tpv_dispenses
  for each row
  execute function public.club_members_tpv_weekly_vip_trigger();

comment on function public.club_members_tpv_weekly_vip_trigger() is
  'Tras insertar una dispensación TPV con socio: si sum(price_charged_eur) últimos 7 días > 100, marca el socio como VIP.';
