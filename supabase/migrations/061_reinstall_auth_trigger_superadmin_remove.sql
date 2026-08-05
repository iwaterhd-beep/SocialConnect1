-- =============================================================================
-- 061: Reinstalar trigger on_auth_user_created + RPC de superadmin para eliminar perfiles
--
-- Causa raíz del bug: la función handle_new_user() existe pero el trigger
-- sobre auth.users NO está instalado en producción. Por eso crear perfiles desde
-- el panel no creaba filas en users / club_access y había que insertarlas a mano.
-- =============================================================================

-- 1) Corregir handle_new_user: esta versión de Supabase ya no expone
--    la columna 'user_metadata' en auth.users (solo raw_user_meta_data).
--    El trigger fallaba en cada alta ("record new has no field user_metadata"),
--    por eso se quedaba sin instalar en producción.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  meta_role text;
  meta_club text;
  resolved_role public.user_role;
  resolved_club uuid;
begin
  perform set_config('row_security', 'off', true);

  meta_role := coalesce(
    nullif((coalesce(new.raw_app_meta_data, '{}'::jsonb))->>'role', ''),
    nullif((coalesce(new.raw_user_meta_data, '{}'::jsonb))->>'role', ''),
    'empleado'
  );

  meta_club := coalesce(
    nullif((coalesce(new.raw_app_meta_data, '{}'::jsonb))->>'club_id', ''),
    nullif((coalesce(new.raw_user_meta_data, '{}'::jsonb))->>'club_id', '')
  );

  begin
    resolved_role := meta_role::public.user_role;
  exception when others then
    resolved_role := 'empleado';
  end;

  if resolved_role = 'superadmin' then
    resolved_role := 'empleado';
    resolved_club := null;
  end if;

  if resolved_role not in ('admin_club', 'empleado') then
    resolved_role := 'empleado';
  end if;

  if meta_club is not null and meta_club <> '' and resolved_role in ('admin_club', 'empleado') then
    begin
      resolved_club := meta_club::uuid;
    exception when others then
      resolved_club := null;
    end;
  else
    resolved_club := null;
  end if;

  insert into public.users (id, email, role, club_id)
  values (new.id, new.email, resolved_role, resolved_club)
  on conflict (id) do update
    set email = excluded.email;

  if resolved_club is not null and resolved_role in ('admin_club', 'empleado') then
    insert into public.club_access (club_id, email, role, auth_user_id)
    values (resolved_club, new.email, resolved_role, new.id)
    on conflict (email) do update
      set auth_user_id = coalesce(club_access.auth_user_id, excluded.auth_user_id);
  end if;

  return new;
end;
$$;

-- 2) Fijar propietario de la función (seguridad: ejecutarla como postgres)
alter function public.handle_new_user() owner to postgres;

-- 3) Reinstalar el trigger (idempotente)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4) RPC: el superadmin elimina un perfil del club (users + club_access + cuenta Auth)
drop function if exists public.superadmin_remove_user(uuid);
create function public.superadmin_remove_user(p_access_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_row public.club_access%rowtype;
  v_auth_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sesión no válida.';
  end if;

  if not public.is_superadmin() then
    raise exception 'Solo el superadministrador puede eliminar perfiles.';
  end if;

  select * into v_row
  from public.club_access
  where id = p_access_id;

  if not found then
    raise exception 'Perfil no encontrado.';
  end if;

  v_auth_id := v_row.auth_user_id;

  delete from public.club_access where id = p_access_id;

  if v_auth_id is not null then
    delete from public.users where id = v_auth_id;
    delete from auth.users where id = v_auth_id;
  end if;
end;
$$;

alter function public.superadmin_remove_user(uuid) owner to postgres;
grant execute on function public.superadmin_remove_user(uuid) to authenticated;