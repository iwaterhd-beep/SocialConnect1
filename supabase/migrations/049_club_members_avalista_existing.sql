-- Avalista debe ser un socio existente del mismo club (salvo el primer alta).
-- Sustituye/estandariza la validación que devolvía:
-- "debe indicar un socio avalista (garante) existente."

create or replace function public.club_members_enforce_existing_avalista()
returns trigger
language plpgsql
as $$
declare
  v_other_count integer;
  v_ok boolean;
begin
  -- Conteo de otros socios del club (excluye la fila actual en updates).
  select count(*)::integer
    into v_other_count
  from public.club_members m
  where m.club_id = new.club_id
    and (tg_op = 'INSERT' or m.id is distinct from new.id)
    and coalesce(m.is_archived, false) = false;

  -- Primer socio del club: no exige avalista enlazado.
  if v_other_count = 0 then
    return new;
  end if;

  if new.avalista_member_id is null then
    raise exception 'Debes indicar un socio avalista (garante) existente.';
  end if;

  select exists (
    select 1
    from public.club_members a
    where a.id = new.avalista_member_id
      and a.club_id = new.club_id
      and coalesce(a.is_archived, false) = false
      and a.id is distinct from new.id
  )
  into v_ok;

  if not v_ok then
    raise exception 'Debes indicar un socio avalista (garante) existente.';
  end if;

  -- Rellenar nombre/dni desde el socio enlazado si vienen vacíos.
  if btrim(coalesce(new.avalista, '')) = '' then
    select coalesce(nullif(btrim(a.display_name), ''), 'Socio')
      into new.avalista
    from public.club_members a
    where a.id = new.avalista_member_id;
  end if;

  if btrim(coalesce(new.avalista_dni, '')) = '' then
    select coalesce(a.dni, '')
      into new.avalista_dni
    from public.club_members a
    where a.id = new.avalista_member_id;
  end if;

  return new;
end;
$$;

drop trigger if exists club_members_enforce_existing_avalista on public.club_members;
create trigger club_members_enforce_existing_avalista
  before insert or update of avalista_member_id, avalista, club_id, is_archived
  on public.club_members
  for each row
  execute function public.club_members_enforce_existing_avalista();

comment on function public.club_members_enforce_existing_avalista() is
  'Exige avalista_member_id de un socio activo del mismo club (excepto el primer socio).';
