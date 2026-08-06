-- Fix guardado del menú tablet: "sin club asignado".
-- club_update_public_menu_settings solo resolvía el club con users.club_id y,
-- para superadmin, omitía el fallback a club_access (users.club_id es null en
-- superadmin) -> v_club vacío -> excepción. Ahora:
--   1) se acepta p_club_id opcional (el cliente pasa ctx.club.id),
--   2) se prueba club_access también para superadmin.

drop function if exists public.club_update_public_menu_settings(boolean, text);
drop function if exists public.club_update_public_menu_settings(boolean, text, uuid);

create function public.club_update_public_menu_settings(
  p_enabled boolean,
  p_slug text,
  p_club_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club uuid;
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  v_club := p_club_id;

  if v_club is null then
    select u.club_id into v_club
    from public.users u
    where u.id = auth.uid();
  end if;

  if v_club is null then
    select ca.club_id into v_club
    from public.club_access ca
    where ca.auth_user_id = auth.uid()
    limit 1;
  end if;

  if v_club is null then
    raise exception 'sin club asignado';
  end if;

  if not public.is_superadmin()
     and not exists (
       select 1 from public.users u
       where u.id = auth.uid() and u.club_id = v_club
     )
     and not exists (
       select 1 from public.club_access ca
       where ca.auth_user_id = auth.uid() and ca.club_id = v_club
     ) then
    raise exception 'no tienes acceso a este club';
  end if;

  v_slug := lower(trim(coalesce(p_slug, '')));
  if v_slug <> '' and v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'slug inválido: solo minúsculas, números y guiones';
  end if;

  if coalesce(p_enabled, false) and v_slug = '' then
    raise exception 'indica un slug para activar el menú';
  end if;

  update public.clubs
  set
    menu_enabled = coalesce(p_enabled, false),
    menu_slug = nullif(v_slug, '')
  where id = v_club;
end;
$$;

alter function public.club_update_public_menu_settings(boolean, text, uuid) owner to postgres;
grant execute on function public.club_update_public_menu_settings(boolean, text, uuid) to authenticated;